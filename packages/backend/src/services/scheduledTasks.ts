// RFC-159 — scheduled-task CRUD + fire logic.
//
// Shape mirrors services/mcp.ts (DB is source of truth; JSON columns marshaled
// at this boundary + re-validated with Zod on read). The launch gate
// (assertWorkflowLaunchable) runs at CREATE/UPDATE time AND again at fire time —
// access can be revoked in between (design.md §3/§5, R2-b/R3-1).
import type {
  CreateScheduledTask,
  ScheduledTask,
  ScheduleSpec,
  UpdateScheduledTask,
} from '@agent-workflow/shared'
import {
  ScheduleSpecSchema,
  ScheduledLaunchKindSchema,
  ScheduledTaskSchema,
  computeNextRunAt,
  rejectRetiredStartTaskKeys,
  scheduledPayloadSchemaFor,
  type ScheduledLaunchKind,
  wallClockAt,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ulid } from 'ulid'

import { buildActor, SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { scheduledTasks, users } from '@/db/schema'
import { assertWorkflowLaunchable } from '@/services/taskLaunchGate'
import { canViewResource } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { dbTxSync } from '@/db/txSync'
import { runGit } from '@/util/git'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'

/** Injected launch — `(body) => startTask(body, deps)`, closed over owner + scheduledTaskId. */
/**
 * RFC-165 §9b: the launch closure now dispatches by launch kind. `payload` is
 * the kind-enveloped body ALREADY validated via scheduledPayloadSchemaFor;
 * `actor` is the owner actor fireSchedule rebuilt (agent/workgroup launches
 * run their own ACL gates against it).
 */
export type ScheduleLaunch = (
  kind: ScheduledLaunchKind,
  payload: Record<string, unknown>,
  actor: Actor,
) => Promise<{ id: string }>
export type BuildScheduleLaunch = (ownerUserId: string, scheduledTaskId: string) => ScheduleLaunch

type Row = typeof scheduledTasks.$inferSelect
type LaunchableWorkflow = Awaited<ReturnType<typeof assertWorkflowLaunchable>>

/**
 * RFC-165 (F18/N3): per-field tolerant JSON parsing. One legacy / corrupt row
 * must never take down the whole list (the old mapper threw
 * `scheduled-task-row-corrupt` for ANY parse failure). Three states per field:
 * ok(value) / legacy(null + migrationNeeded — retired path-mode keys the user
 * can repair by re-saving) / degraded(null + migrationError). Auth, delete,
 * disable and name-only edits read only the plain columns, so they keep
 * working on broken rows.
 */
function parseJsonField<T>(
  raw: string,
  schema: {
    safeParse: (
      v: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message: string }> } }
  },
  isLegacyShape?: (json: unknown) => boolean,
): { value: T | null; legacy: boolean; error: string | null } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { value: null, legacy: false, error: `invalid-json: ${(err as Error).message}` }
  }
  const parsed = schema.safeParse(json)
  if (parsed.success) return { value: parsed.data, legacy: false, error: null }
  if (isLegacyShape?.(json) === true) return { value: null, legacy: true, error: null }
  return {
    value: null,
    legacy: false,
    error: `invalid-shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
  }
}

function rowToScheduledTask(row: Row): ScheduledTask {
  const kind = (row.launchKind ?? 'workflow') as ScheduledLaunchKind
  const payload = parseJsonField(
    row.launchPayload,
    scheduledPayloadSchemaFor(kind),
    (json) => rejectRetiredStartTaskKeys(json) !== null,
  )
  const spec = parseJsonField(row.scheduleSpec, ScheduleSpecSchema)
  const hasError = payload.error !== null || spec.error !== null
  // RFC-165 (implementation-gate P2): even a degraded payload usually still
  // carries a readable workflowId — surface it so the detail page can keep
  // the edit-config (full-repair) entry routable. Corrupt JSON → null.
  let workflowIdHint: string | null = null
  try {
    const raw: unknown = JSON.parse(row.launchPayload)
    if (typeof raw === 'object' && raw !== null) {
      const wf = (raw as Record<string, unknown>)['workflowId']
      if (typeof wf === 'string' && wf.length > 0) workflowIdHint = wf
    }
  } catch {
    /* corrupt JSON — no hint */
  }
  const parsed = ScheduledTaskSchema.safeParse({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    launchKind: kind,
    launchPayload: payload.value,
    scheduleSpec: spec.value,
    migrationNeeded: payload.legacy,
    migrationError: hasError ? { launchPayload: payload.error, scheduleSpec: spec.error } : null,
    launchPayloadWorkflowId: workflowIdHint,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastTaskId: row.lastTaskId,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) {
    // Only non-JSON column corruption lands here now (e.g. a hand-edited enum)
    // — genuinely exceptional, keep the loud failure.
    throw new ValidationError(
      'scheduled-task-row-corrupt',
      `scheduled task '${row.id}' row is corrupt`,
      { issues: parsed.error.issues },
    )
  }
  return parsed.data
}

/** RFC-159: reject workflows that REQUIRE a blob-upload input (can't be replayed). */
function assertNoRequiredUploadInput(wf: LaunchableWorkflow): void {
  const requiresUpload = wf.definition.inputs.some(
    (i) => i.kind === 'upload' && i.required === true,
  )
  if (requiresUpload) {
    throw new ValidationError(
      'scheduled-task-upload-required',
      `workflow '${wf.id}' has a required file-upload input, which a scheduled task cannot supply`,
    )
  }
}

export async function listScheduledTasks(db: DbClient): Promise<ScheduledTask[]> {
  const rows = await db.select().from(scheduledTasks)
  return rows.map(rowToScheduledTask)
}

/**
 * Read visibility: admins (tasks:read:all) see all; otherwise owner only.
 * Single source shared by the list/detail routes and /api/overview counting
 * (RFC-190) — scheduled tasks are member-based-private like tasks, NOT the
 * RFC-099 five-type ACL.
 */
export function canViewScheduledTask(actor: Actor, row: ScheduledTask): boolean {
  if (actor.permissions.has('tasks:read:all')) return true
  if (row.ownerUserId === actor.user.id) return true
  if (row.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) return true
  return false
}

export async function getScheduledTask(db: DbClient, id: string): Promise<ScheduledTask | null> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1)
  return rows[0] ? rowToScheduledTask(rows[0]) : null
}

/** Raw DB row (unparsed JSON columns) — `fireSchedule` / run-now need it. */
export async function getScheduledTaskRow(db: DbClient, id: string): Promise<Row | null> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * RFC-165 §9b create/repair-time LIGHT gate per kind: the target must exist,
 * be visible to the actor, and not be builtin. Full launch validation
 * (host snapshot / readiness / space rules) runs at fire time via the
 * kind's launch service.
 */
async function assertScheduledTargetUsable(
  db: DbClient,
  actor: Actor,
  kind: ScheduledLaunchKind,
  body: Record<string, unknown>,
): Promise<void> {
  if (kind === 'workflow') {
    const wf = await assertWorkflowLaunchable(db, actor, body['workflowId'] as string)
    assertNoRequiredUploadInput(wf)
    return
  }
  if (kind === 'agent') {
    const { getAgent } = await import('@/services/agent')
    const agent = await getAgent(db, body['agentName'] as string)
    if (agent === null || !(await canViewResource(db, actor, 'agent', agent))) {
      throw new NotFoundError('agent-not-found', `agent '${String(body['agentName'])}' not found`)
    }
    assertNotBuiltin('agent', agent)
    return
  }
  const { getWorkgroup } = await import('@/services/workgroups')
  const group = await getWorkgroup(db, body['workgroupName'] as string)
  if (group === null || !(await canViewResource(db, actor, 'workgroup', group))) {
    throw new NotFoundError(
      'workgroup-not-found',
      `workgroup '${String(body['workgroupName'])}' not found`,
    )
  }
}

export async function createScheduledTask(
  db: DbClient,
  input: CreateScheduledTask,
  opts: { actor: Actor },
): Promise<ScheduledTask> {
  const kind = input.launchKind
  // RFC-165 §9b: kind-enveloped validation — the ONE selector shared by
  // save/edit/fire/run-now. Guarantees the stored payload is replayable.
  const body = scheduledPayloadSchemaFor(kind).parse(input.launchPayload)
  // Create-time gate (R2-b): invisible / built-in / deleted target → 404 now,
  // not silently at fire time. Fire still re-checks (access can be revoked);
  // agent/workgroup rows get the LIGHT existence/visibility check here and
  // the full launch validation (host snapshot, readiness) at fire time.
  await assertScheduledTargetUsable(
    db,
    opts.actor,
    kind,
    body as unknown as Record<string, unknown>,
  )
  const spec = ScheduleSpecSchema.parse(input.scheduleSpec)
  const now = Date.now()
  const id = ulid()
  await db.insert(scheduledTasks).values({
    id,
    name: input.name,
    ownerUserId: opts.actor.user.id,
    launchKind: kind,
    launchPayload: JSON.stringify(body),
    scheduleSpec: JSON.stringify(spec),
    enabled: input.enabled,
    nextRunAt: input.enabled ? computeNextRunAt(spec, now, now) : null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  })
  const created = await getScheduledTask(db, id)
  if (created === null) throw new Error('scheduled task disappeared right after insert')
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.created',
    id: created.id,
    ownerUserId: created.ownerUserId,
  })
  return created
}

export async function updateScheduledTask(
  db: DbClient,
  id: string,
  patch: UpdateScheduledTask,
  opts: { actor: Actor },
): Promise<ScheduledTask> {
  const existing = await getScheduledTask(db, id)
  if (existing === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  // RFC-165 (N3, narrowed per implementation-gate review): a legacy/degraded
  // row has null JSON fields — a partial PUT that keeps such a field would
  // persist garbage, so repair (a full replacement value) is required ONLY
  // when this update actually CONSUMES the degraded field: the result being
  // enabled needs a valid payload (workflow gate) and a valid spec
  // (next_run_at). Plain rename / disable of a degraded row must stay
  // possible — otherwise a corrupt schedule can't even be stopped.
  // RFC-165 §9b: the subject kind is immutable — repointing a schedule at a
  // different face is a delete+recreate, not a PUT.
  if (patch.launchKind !== undefined && patch.launchKind !== existing.launchKind) {
    throw new ValidationError(
      'scheduled-kind-immutable',
      `launchKind is immutable (existing '${existing.launchKind}'); delete and recreate to change the subject`,
    )
  }
  // 实现门 P1 修复：Update 的封套校验只能在服务层（kind 来自 existing 行）
  // ——safeParse + ValidationError，绝不让裸 ZodError 逃逸成 500。
  let patchedPayload: typeof existing.launchPayload
  if (patch.launchPayload !== undefined) {
    const parsedPayload = scheduledPayloadSchemaFor(existing.launchKind).safeParse(
      patch.launchPayload,
    )
    if (!parsedPayload.success) {
      throw new ValidationError('scheduled-task-invalid', 'invalid launchPayload for this kind', {
        issues: parsedPayload.error.issues,
      })
    }
    patchedPayload = parsedPayload.data
  } else {
    patchedPayload = existing.launchPayload
  }
  const patchedSpec =
    patch.scheduleSpec !== undefined
      ? ScheduleSpecSchema.parse(patch.scheduleSpec)
      : existing.scheduleSpec
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled

  if (enabled) {
    if (patchedPayload === null) {
      throw new ValidationError(
        'scheduled-task-needs-repair',
        `scheduled task '${id}' has an unreadable launchPayload — supply a full launchPayload to repair it`,
      )
    }
    if (patchedSpec === null) {
      throw new ValidationError(
        'scheduled-task-needs-repair',
        `scheduled task '${id}' has an unreadable scheduleSpec — supply a full scheduleSpec to repair it`,
      )
    }
  }

  // RFC-165 (N1-r3) — tasks:launch is required for every operation that arms
  // or re-arms future launches: payload replacement, enabling, and changing
  // the cadence WHILE enabled (a narrow PAT turning a monthly schedule into
  // every-minute is the same delegation escalation as launching). Plain
  // rename / disable / disabled-state spec edits stay open.
  // Preliminary arming check off the pre-read snapshot: fail obviously-
  // unauthorized requests BEFORE the (async) target validation below. The
  // AUTHORITATIVE check re-runs inside the transaction against a fresh row.
  const armsLaunchAgainst = (rowEnabled: boolean): boolean =>
    patch.launchPayload !== undefined ||
    (patch.enabled === true && !rowEnabled) ||
    (patch.scheduleSpec !== undefined && (patch.enabled ?? rowEnabled))
  if (armsLaunchAgainst(existing.enabled) && !opts.actor.permissions.has('tasks:launch')) {
    throw new ForbiddenError('forbidden', 'missing permission: tasks:launch', {
      requiredPermission: 'tasks:launch',
    })
  }

  // R3-1: re-gate whenever the RESULT is enabled (spec-only / re-enable / payload
  // change). Skip when the result is disabled so a user can still stop/clean up a
  // schedule whose target vanished.
  if (enabled && patchedPayload !== null) {
    await assertScheduledTargetUsable(
      db,
      opts.actor,
      existing.launchKind,
      patchedPayload as unknown as Record<string, unknown>,
    )
  }

  const now = Date.now()
  // 实现门 P1 修复（arming TOCTOU）：权限判定若基于 stale 的 existing.enabled，
  // 与写入之间的窗口里另一请求可以先把行 enable——窄 PAT 的 spec-only 更新就
  // 顺着旧快照绕过了 tasks:launch。判定 + 组 set + 写入收进 dbTxSync：对
  // FRESH 行重算 arming，越权即回滚整个更新。
  dbTxSync(db, (tx) => {
    const fresh = tx
      .select({ enabled: scheduledTasks.enabled })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, id))
      .get()
    if (fresh === undefined) {
      throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
    }
    if (armsLaunchAgainst(fresh.enabled) && !opts.actor.permissions.has('tasks:launch')) {
      throw new ForbiddenError('forbidden', 'missing permission: tasks:launch', {
        requiredPermission: 'tasks:launch',
      })
    }
    const resultEnabled = patch.enabled !== undefined ? patch.enabled : fresh.enabled
    const set: Partial<typeof scheduledTasks.$inferInsert> = { updatedAt: now }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.launchPayload !== undefined && patchedPayload !== null) {
      set.launchPayload = JSON.stringify(patchedPayload)
      // A successful full repair also clears the RFC-165 migration lastError
      // breadcrumb (best-effort UX; harmless when it was never set).
      if (existing.launchPayload === null || existing.migrationNeeded) set.lastError = null
    }
    if (patch.scheduleSpec !== undefined && patchedSpec !== null) {
      set.scheduleSpec = JSON.stringify(patchedSpec)
    }
    if (patch.enabled !== undefined) set.enabled = resultEnabled
    if (!resultEnabled) {
      set.nextRunAt = null
    } else if (patch.scheduleSpec !== undefined || (resultEnabled && !fresh.enabled)) {
      // resultEnabled ⇒ patchedSpec non-null (guarded above via `enabled`;
      // a fresh row can only have flipped enabled, not nulled the spec).
      set.nextRunAt = computeNextRunAt(patchedSpec as ScheduleSpec, now, now)
      set.consecutiveFailures = 0
    }
    tx.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id)).run()
  })
  const updated = await getScheduledTask(db, id)
  if (updated === null) throw new Error('scheduled task disappeared right after update')
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.updated',
    id: updated.id,
    ownerUserId: updated.ownerUserId,
  })
  return updated
}

export async function deleteScheduledTask(db: DbClient, id: string): Promise<void> {
  const existing = await getScheduledTask(db, id)
  if (existing === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id))
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.deleted',
    id,
    ownerUserId: existing.ownerUserId,
  })
}

/** `${base} · <fire time>` — disambiguates the many tasks a recurring schedule spawns. ≤255. */
export function decorateTaskName(base: string, spec: ScheduleSpec, now: number): string {
  const tz = spec.kind === 'interval' ? 'UTC' : spec.timezone
  const wc = wallClockAt(now, tz)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const suffix = ` · ${wc.year}-${p2(wc.month)}-${p2(wc.day)} ${p2(wc.hour)}:${p2(wc.minute)}`
  const room = Math.max(0, 255 - suffix.length)
  return `${base.length > room ? base.slice(0, room) : base}${suffix}`
}

/**
 * Fire one schedule: synthesize the owner actor, re-check launchability (RFC-099
 * D3 — access may have been revoked since create), then replay via the injected
 * launch (which stamps tasks.scheduled_task_id). Throws on any pre-launch failure
 * (owner inactive / workflow gone / invisible / built-in); the caller records it.
 */
export async function fireSchedule(
  db: DbClient,
  row: Row,
  buildLaunch: BuildScheduleLaunch,
  now: number,
): Promise<{ taskId: string }> {
  const parsedKind = ScheduledLaunchKindSchema.safeParse(row.launchKind ?? 'workflow')
  if (!parsedKind.success) {
    throw new ValidationError(
      'schedule-kind-invalid',
      `scheduled task '${row.id}' has an invalid launch kind`,
      { launchKind: row.launchKind },
    )
  }
  const kind = parsedKind.data
  let launchPayload: unknown
  try {
    launchPayload = JSON.parse(row.launchPayload)
  } catch {
    throw new ValidationError(
      'schedule-payload-invalid',
      `scheduled task '${row.id}' has invalid launch-payload JSON`,
      { reason: 'invalid-json' },
    )
  }
  const parsedBody = scheduledPayloadSchemaFor(kind).safeParse(launchPayload)
  if (!parsedBody.success) {
    throw new ValidationError(
      'schedule-payload-invalid',
      `scheduled task '${row.id}' has an invalid launch payload`,
      { issues: parsedBody.error.issues },
    )
  }
  let scheduleSpec: unknown
  try {
    scheduleSpec = JSON.parse(row.scheduleSpec)
  } catch {
    throw new ValidationError(
      'schedule-spec-invalid',
      `scheduled task '${row.id}' has invalid schedule-spec JSON`,
      { reason: 'invalid-json' },
    )
  }
  const parsedSpec = ScheduleSpecSchema.safeParse(scheduleSpec)
  if (!parsedSpec.success) {
    throw new ValidationError(
      'schedule-spec-invalid',
      `scheduled task '${row.id}' has an invalid schedule spec`,
      { issues: parsedSpec.error.issues },
    )
  }
  const body = parsedBody.data
  const spec = parsedSpec.data
  const bodyWithName = {
    ...(body as Record<string, unknown>),
    name: decorateTaskName((body as { name: string }).name, spec, now),
  }

  const owner = (await db.select().from(users).where(eq(users.id, row.ownerUserId)).limit(1))[0]
  if (!owner || owner.status !== 'active') {
    throw new ValidationError('owner-inactive', `owner '${row.ownerUserId}' is not an active user`)
  }
  const actor: Actor = buildActor({
    user: {
      id: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      role: owner.role,
      status: owner.status,
    },
    source: 'daemon',
  })
  // RFC-165 §9b: workflow rows keep the explicit fire-time gate; agent /
  // workgroup rows are fully re-validated inside their launch services
  // (ACL 404 / builtin 403 / readiness 422) — the dispatcher below.
  if (kind === 'workflow') {
    await assertWorkflowLaunchable(
      db,
      actor,
      (bodyWithName as unknown as { workflowId: string }).workflowId,
    )
  }

  const launch = buildLaunch(row.ownerUserId, row.id)
  const task = await launch(kind, bodyWithName, actor)
  return { taskId: task.id }
}

/**
 * Manual "run now" (RFC-159 T7): fire immediately via the SAME `fireSchedule` path
 * (owner actor + launchability re-check), but deliberately leave the schedule row's
 * automated-cadence state untouched — `next_run_at` / `last_*` / `consecutive_failures`
 * stay reserved for real scheduled fires, so a manual test-run never advances the clock
 * nor auto-disables the schedule. The launched task is stamped `scheduled_task_id`
 * (shows in run history); a `scheduled.fired` broadcast refreshes history for all
 * viewers. Throws (→ HTTP error) on any launch failure, exactly like `fireSchedule`.
 */
/**
 * RFC-165 (§9): one-shot boot healer — rewrite stored path-mode launch
 * payloads to their faithful `file://` form. Runs after migrations and BEFORE
 * the HTTP server starts serving (and before the scheduler ticker), so both
 * read paths and fires only ever see healed rows.
 *
 * Strategy (F19): `pathToFileURL(realpath(dir))` preserves the LOCAL repo
 * exactly (unpushed branches included — the cached mirror clones from the
 * path itself), unlike an origin-URL rewrite which drops anything unpushed.
 *   * dir exists and is a git repo → rewrite `{repoPath, baseBranch}` →
 *     `{repoUrl: file://…, ref: baseBranch}` (top level and each repos[] row);
 *     drop `fetchBeforeLaunch` (false/absent only). Git-ness is probed via
 *     `git rev-parse --git-dir` (a bare repo / worktree subdir has no `.git`
 *     child yet was perfectly launchable in path mode).
 *   * `fetchBeforeLaunch: true`     → DISABLE + lastError
 *     'rfc165-fetch-semantic-review' — the old semantics ("refresh the local
 *     repo's origin/* before launch") have no file:// equivalent; the user
 *     must confirm a URL choice and re-save. Never silently converted.
 *   * `baseBranch` naming a REMOTE-TRACKING ref (`origin/x`, `refs/remotes/…`)
 *     → DISABLE + lastError 'rfc165-remote-tracking-ref'. In the file clone
 *     that string resolves against the CLONE's own origin (= the source's
 *     local branches), not the source's refs/remotes/* — silently launching
 *     a different commit is exactly what F19 forbids.
 *   * dir missing / not a git repo → DISABLE + lastError
 *     'rfc165-local-path-retired'.
 * Idempotent: healed payloads carry no `repoPath`; already-disabled rfc165-*
 * rows are skipped.
 */
export async function healScheduledLaunchPayloads(
  db: DbClient,
): Promise<{ scanned: number; converted: number; disabled: number }> {
  const rows = await db.select().from(scheduledTasks)
  let converted = 0
  let disabled = 0
  const now = Date.now()

  const disable = async (row: Row, error: string): Promise<void> => {
    await db
      .update(scheduledTasks)
      .set({ enabled: false, nextRunAt: null, lastError: error, updatedAt: now })
      .where(eq(scheduledTasks.id, row.id))
    disabled += 1
  }
  // Resolve a legacy path to the CLONABLE git root (P2 review fixes ×2):
  //   * a `.git`-child check missed bare repos / worktree subdirs → probe with
  //     git itself;
  //   * a subdir inside a worktree passes `rev-parse` but `git clone
  //     file:///repo/subdir` fails (not a repo root) → canonicalize to
  //     `--show-toplevel`, falling back to the absolute git dir for bare
  //     repos (which have no worktree).
  // Returns null when the path isn't inside any git repo.
  const resolveGitRoot = async (p: string): Promise<string | null> => {
    if (!existsSync(p)) return null
    try {
      const top = await runGit(p, ['rev-parse', '--show-toplevel'])
      if (top.exitCode === 0 && top.stdout.trim() !== '') return top.stdout.trim()
      const bare = await runGit(p, ['rev-parse', '--is-bare-repository'])
      if (bare.exitCode === 0 && bare.stdout.trim() === 'true') {
        const gd = await runGit(p, ['rev-parse', '--absolute-git-dir'])
        if (gd.exitCode === 0 && gd.stdout.trim() !== '') return gd.stdout.trim()
      }
      return null
    } catch {
      return null
    }
  }
  const toFileUrl = (p: string): string => pathToFileURL(realpathSync(p)).href
  // A remote-tracking ref cannot be carried into the file clone faithfully —
  // the clone's `origin/x` points at the SOURCE's local x, not the source's
  // own refs/remotes/origin/x (P1 review fix: disable instead of drifting).
  // Spelling alone is NOT enough (P2 review fix): a real local branch or tag
  // literally named `origin/topic` is legitimate — verify against the source
  // repo and only treat the ref as remote-tracking when no local ref claims
  // that exact name.
  const isRemoteTrackingRef = async (root: string, ref: string): Promise<boolean> => {
    const spelledRemote =
      ref.startsWith('origin/') || ref.startsWith('refs/remotes/') || ref.startsWith('remotes/')
    if (!spelledRemote) return false
    try {
      const local = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])
      if (local.exitCode === 0) return false
      const tag = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${ref}`])
      if (tag.exitCode === 0) return false
    } catch {
      /* fall through to remote-tracking */
    }
    return true
  }

  for (const row of rows) {
    if (!row.enabled && (row.lastError ?? '').startsWith('rfc165-')) continue
    let payload: unknown
    try {
      payload = JSON.parse(row.launchPayload)
    } catch {
      continue // corrupt JSON → tolerant read surfaces it; not a path-heal target
    }
    if (typeof payload !== 'object' || payload === null) continue
    if (rejectRetiredStartTaskKeys(payload) === null) continue // already v2-clean
    const body = payload as Record<string, unknown>

    if (body['fetchBeforeLaunch'] === true) {
      await disable(
        row,
        'rfc165-fetch-semantic-review: fetchBeforeLaunch has no file:// equivalent — pick a repo source and re-save',
      )
      continue
    }

    // Pair each legacy path with the baseBranch that would ride into `ref`,
    // so both the root canonicalization and the remote-tracking check run
    // against the RIGHT source repo.
    const pairs: Array<{ path: string; ref: string | undefined }> = []
    if (typeof body['repoPath'] === 'string') {
      pairs.push({
        path: body['repoPath'] as string,
        ref: typeof body['baseBranch'] === 'string' ? (body['baseBranch'] as string) : undefined,
      })
    }
    const repos = Array.isArray(body['repos'])
      ? (body['repos'] as Array<Record<string, unknown>>)
      : []
    for (const r of repos) {
      if (r !== null && typeof r === 'object' && typeof r['repoPath'] === 'string') {
        pairs.push({
          path: r['repoPath'] as string,
          ref: typeof r['baseBranch'] === 'string' ? (r['baseBranch'] as string) : undefined,
        })
      }
    }
    if (pairs.length === 0) {
      // Retired keys present but no path value (e.g. stray baseBranch) — just
      // strip them so the payload becomes v2-clean.
      delete body['baseBranch']
      delete body['fetchBeforeLaunch']
      await db
        .update(scheduledTasks)
        .set({ launchPayload: JSON.stringify(body), updatedAt: now })
        .where(eq(scheduledTasks.id, row.id))
      converted += 1
      continue
    }
    const rootByPath = new Map<string, string>()
    let missing: string | undefined
    for (const { path } of pairs) {
      const root = await resolveGitRoot(path)
      if (root === null) {
        missing = path
        break
      }
      rootByPath.set(path, root)
    }
    if (missing !== undefined) {
      await disable(row, `rfc165-local-path-retired: ${missing}`)
      continue
    }
    let remoteRef: string | undefined
    for (const { path, ref } of pairs) {
      if (ref !== undefined && (await isRemoteTrackingRef(rootByPath.get(path)!, ref))) {
        remoteRef = ref
        break
      }
    }
    if (remoteRef !== undefined) {
      await disable(
        row,
        `rfc165-remote-tracking-ref: baseBranch '${remoteRef}' names a remote-tracking ref — pick a concrete branch/URL and re-save`,
      )
      continue
    }

    if (typeof body['repoPath'] === 'string') {
      body['repoUrl'] = toFileUrl(rootByPath.get(body['repoPath'] as string)!)
      if (typeof body['baseBranch'] === 'string') body['ref'] = body['baseBranch']
      delete body['repoPath']
      delete body['baseBranch']
    }
    for (const r of repos) {
      if (r === null || typeof r !== 'object') continue
      if (typeof r['repoPath'] === 'string') {
        r['repoUrl'] = toFileUrl(rootByPath.get(r['repoPath'] as string)!)
        if (typeof r['baseBranch'] === 'string') r['ref'] = r['baseBranch']
        delete r['repoPath']
        delete r['baseBranch']
      }
    }
    delete body['fetchBeforeLaunch']

    await db
      .update(scheduledTasks)
      .set({ launchPayload: JSON.stringify(body), updatedAt: now })
      .where(eq(scheduledTasks.id, row.id))
    converted += 1
  }
  return { scanned: rows.length, converted, disabled }
}

export async function runScheduleNow(
  db: DbClient,
  id: string,
  buildLaunch: BuildScheduleLaunch,
): Promise<{ taskId: string }> {
  const row = await getScheduledTaskRow(db, id)
  if (row === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  const result = await fireSchedule(db, row, buildLaunch, Date.now())
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.fired',
    id: row.id,
    ownerUserId: row.ownerUserId,
  })
  return result
}
