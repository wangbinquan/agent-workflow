// RFC-159 — scheduled-task CRUD + fire logic.
//
// Persistence is provider-owned; JSON columns are marshaled at this application
// boundary and re-validated with Zod on read. The launch gate
// (assertWorkflowLaunchable) runs at CREATE/UPDATE time AND again at fire time —
// access can be revoked in between (design.md §3/§5, R2-b/R3-1).
import type {
  CreateScheduledTask,
  ResourceAccess,
  ResourceGrantLevel,
  ScheduleAcl,
  UserPublic,
  ScheduledTask,
  ScheduledTaskListItem,
  ScheduleSpec,
  UpdateScheduleAclBody,
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
  type TriggerDependencySource,
  wallClockAt,
  redactGitUrl,
} from '@agent-workflow/shared'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ulid } from 'ulid'

import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DelegatedRequestAuthorityFactory } from '@/modules/identity-access/public/participants'
import { canEditAccess, canGovernAccess } from '@/services/resourceAcl'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { runGit } from '@/util/git'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  DigitalEmployeeTriggerSnapshot,
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
  TaskExecutionWorkflowSnapshot,
} from '@/modules/resource-catalog/public/types'
import type {
  IntegrationTriggerResourceQueries,
  ScheduledTaskCreateRecord,
  ScheduledTaskMutablePatch,
  ScheduledTaskPersistencePort,
  ScheduledTaskRecord,
} from '@/modules/integration/application/ports/scheduledTaskPersistence'

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
  resources: Readonly<{
    readonly authority: ResourceRequestContext
    readonly actor: Actor
    readonly resources: TaskExecutionResourceBinding
  }>,
) => Promise<{ id: string }>
export type BuildScheduleLaunch = (ownerUserId: string, scheduledTaskId: string) => ScheduleLaunch
export type ScheduleAuthorityInvocation =
  | { readonly kind: 'automatic'; readonly occurrenceAt: number }
  | { readonly kind: 'manual' }
export type ScheduleAuthorityRuntime = Readonly<{
  delegatedRequests: DelegatedRequestAuthorityFactory
  integrationTriggerResources: IntegrationTriggerResourceBinding
  taskExecutionResources: TaskExecutionResourceBinding
}>

export type IntegrationTriggerResourceBinding = IntegrationTriggerResourceQueries

/** Exact opaque handle and the current actor projection admitted with it. */
export interface IntegrationTriggerResourceAuthority {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
  readonly resources: IntegrationTriggerResourceBinding
  readonly taskExecutionResources: TaskExecutionResourceBinding
}

export interface IntegrationTriggerValidationRuntime {
  assertWorkflowLaunchable(workflow: TaskExecutionWorkflowSnapshot): Promise<void>
  assertAgentIntegrity(agentIds: readonly string[]): Promise<void>
}

export interface ScheduledTaskOperations {
  readonly persistence: ScheduledTaskPersistencePort
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: () => Promise<void> | void
}

export type Row = ScheduledTaskRecord
type LaunchableWorkflow = TaskExecutionWorkflowSnapshot

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

/**
 * RFC-204 — mask a credentialed `repoUrl` anywhere inside a stored launch body
 * before it leaves the daemon. Shallow by design: `repoUrl` only ever appears at
 * the top level or inside `repos[]`.
 */
function redactPayloadCredentials(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  const clone = { ...(payload as Record<string, unknown>) }
  if (typeof clone['repoUrl'] === 'string') {
    clone['repoUrl'] = redactGitUrl(clone['repoUrl'])
  }
  const repos = clone['repos']
  if (Array.isArray(repos)) {
    clone['repos'] = repos.map((r) =>
      r !== null &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>)['repoUrl'] === 'string'
        ? {
            ...(r as Record<string, unknown>),
            repoUrl: redactGitUrl((r as Record<string, unknown>)['repoUrl'] as string),
          }
        : r,
    )
  }
  return clone
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
    // RFC-204: a schedule stores the whole launch body, so a credentialed
    // repoUrl used to be handed straight back out by this mapper (and into
    // every backup). The sealing gate rewrites stored payloads to reference the
    // mirror by `cachedRepoId`; this is the read-side backstop for rows it
    // could not convert (no matching cache row) and for anything written before
    // the gate ran. Redaction only — the value stays launchable via the id.
    launchPayload: redactPayloadCredentials(payload.value),
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

export async function listScheduledTasks(
  operations: ScheduledTaskOperations,
): Promise<ScheduledTask[]> {
  const rows = await operations.persistence.list()
  return rows.map(rowToScheduledTask)
}

/**
 * RFC-324 —— 定时任务的访问级别。
 *
 * 沿用资源侧的四值梯子，但**没有 visibility 分支**：定时任务没有「全员可见」这一
 * 档，未被授权者与不存在同形。`tasks:read:all` 留在最后，等价于 RFC-324 之前的
 * 全局只读，不因新增授权面而收缩。
 *
 * 判据是纯函数（grant 由调用方取），列表面因此可以一次预取、逐行判定。
 */
export function resolveScheduleAccess(
  actor: Actor,
  row: Pick<ScheduledTask, 'ownerUserId'>,
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  if (actor.permissions.has('resource-acl:bypass')) return 'own'
  if (row.ownerUserId === actor.user.id) return 'own'
  if (row.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) return 'own'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return actor.permissions.has('tasks:read:all') ? 'read' : 'none'
}

/** Async form: resolves this actor's grant on one schedule, then the ladder. */
export async function resolveScheduleAccessFor(
  operations: ScheduledTaskOperations,
  actor: Actor,
  row: Pick<ScheduledTask, 'id' | 'ownerUserId'>,
): Promise<ResourceAccess> {
  if (actor.permissions.has('resource-acl:bypass') || row.ownerUserId === actor.user.id) {
    return resolveScheduleAccess(actor, row, null)
  }
  const grant = await operations.persistence.loadGrantLevel(row.id, actor.user.id)
  return resolveScheduleAccess(actor, row, grant)
}

/**
 * Read visibility. Single source shared by the list/detail routes and
 * /api/overview counting (RFC-190) — scheduled tasks stay member-private, NOT
 * the RFC-099 resource ACL, but RFC-324 lets their owner grant them out.
 */
export function canViewScheduledTask(
  actor: Actor,
  row: ScheduledTask,
  grant: ResourceGrantLevel | null = null,
): boolean {
  return resolveScheduleAccess(actor, row, grant) !== 'none'
}

/** RFC-232 — HTTP list rows after canonical mapping and visibility filtering. */
export async function listScheduledTaskItems(
  operations: ScheduledTaskOperations,
  actor: Actor,
): Promise<ScheduledTaskListItem[]> {
  // RFC-324 —— 一次取回本人在定时任务上的授权集合，逐行判定不再各查一次。
  const granted = actor.permissions.has('resource-acl:bypass')
    ? new Set<string>()
    : await operations.persistence.listGrantedResourceIds(actor.user.id)
  const visible = (await listScheduledTasks(operations)).filter((row) =>
    canViewScheduledTask(actor, row, granted.has(row.id) ? 'read' : null),
  )
  const owners = await operations.persistence.loadOwnerIdentities(
    visible.map((row) => row.ownerUserId),
  )
  return visible.map((row) => ({
    ...row,
    owner: owners.get(row.ownerUserId) ?? null,
  }))
}

export async function getScheduledTask(
  operations: ScheduledTaskOperations,
  id: string,
): Promise<ScheduledTask | null> {
  const row = await operations.persistence.get(id)
  return row === null ? null : rowToScheduledTask(row)
}

/** Raw DB row (unparsed JSON columns) — `fireSchedule` / run-now need it. */
export async function getScheduledTaskRow(
  operations: ScheduledTaskOperations,
  id: string,
): Promise<Row | null> {
  return await operations.persistence.get(id)
}

export async function loadIntegrationTriggerResourceSnapshot(
  resourceAuthority: IntegrationTriggerResourceAuthority,
  request: IntegrationTriggerResourceRequest,
): Promise<FrozenIntegrationTriggerResourceSnapshot> {
  const snapshots = await resourceAuthority.resources.loadAuthorized(resourceAuthority, [request])
  const snapshot = snapshots[0]
  if (snapshot === undefined) throw new Error('integration-trigger-snapshot-missing')
  return snapshot
}

function assertDigitalEmployeeIntake(
  employee: DigitalEmployeeTriggerSnapshot,
  body: Record<string, unknown>,
): void {
  const intakeKind = body['intakeKind'] ?? body['kind']
  const target = body['target']
  if (
    (intakeKind !== 'body' && intakeKind !== 'external-id') ||
    target === null ||
    typeof target !== 'object' ||
    Array.isArray(target)
  ) {
    throw new ValidationError('webhook-trigger-invalid', 'invalid digital employee intake')
  }
  if (!employee.intake.acceptedKinds.includes(intakeKind)) {
    throw new ValidationError(
      'employee-intake-kind-incompatible',
      `digital employee does not accept ${intakeKind} intake`,
    )
  }
  const values = target as Record<string, unknown>
  const allowed = new Set(employee.intake.targetFields.map((field) => field.fieldRef))
  const unknown = Object.keys(values).filter((key) => !allowed.has(key))
  const missing = employee.intake.targetFields
    .filter((field) => {
      const value = values[field.fieldRef]
      return field.required && (typeof value !== 'string' || value.trim() === '')
    })
    .map((field) => field.fieldRef)
  if (unknown.length > 0 || missing.length > 0) {
    throw new ValidationError(
      'employee-intake-target-incompatible',
      'digital employee target mapping does not satisfy its intake contract',
      { unknown, missing },
    )
  }
}

export async function assertIntegrationTriggerSnapshotUsable(
  operations: ScheduledTaskOperations,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  snapshot: FrozenIntegrationTriggerResourceSnapshot,
  body: Record<string, unknown>,
  triggerSource: TriggerDependencySource = { kind: 'none' },
): Promise<void> {
  if (snapshot.kind === 'scheduled-workflow' || snapshot.kind === 'webhook-workflow') {
    const target = snapshot.workflow
    // Preserve the RFC-159 schedule-specific incompatibility as the first
    // visible error after the participant's ACL/builtin gates.
    assertNoRequiredUploadInput(target)
    const closureJson = await resourceAuthority.taskExecutionResources.freezeCallClosure(
      Object.freeze({
        authority: resourceAuthority.authority,
        actor: resourceAuthority.actor,
      }),
      { id: target.id, definition: target.definition },
    )
    assertTriggerPreflight({ root: target.definition, closureJson, source: triggerSource })
    await operations.validation.assertWorkflowLaunchable(target)
    assertWorkflowLaunchInputs(
      target.definition.inputs,
      (body['inputs'] as Record<string, string> | undefined) ?? {},
    )
    return
  }
  if (snapshot.kind === 'scheduled-agent') {
    await operations.validation.assertAgentIntegrity([snapshot.agent.id])
    body['agentName'] = snapshot.agent.name
    const { validateAgentLaunchShape } = await import('@/services/agentLaunch')
    validateAgentLaunchShape(
      snapshot.agent.inputs,
      body as { description?: string; inputs?: Record<string, string> },
      { multipart: false },
    )
    return
  }
  if (snapshot.kind === 'scheduled-workgroup') {
    const memberAgentIds = snapshot.workgroup.members.flatMap((member) =>
      member.memberType === 'agent' &&
      typeof member.agentId === 'string' &&
      member.agentId.length > 0
        ? [member.agentId]
        : [],
    )
    await operations.validation.assertAgentIntegrity(memberAgentIds)
    body['workgroupName'] = snapshot.workgroup.name
    return
  }
  assertDigitalEmployeeIntake(snapshot.employee, body)
}

function scheduledResourceRequest(
  kind: ScheduledLaunchKind,
  body: Record<string, unknown>,
  source: 'schedule' | 'webhook',
): IntegrationTriggerResourceRequest {
  if (kind === 'workflow') {
    return source === 'schedule'
      ? { kind: 'scheduled-workflow', workflowId: body['workflowId'] as string }
      : { kind: 'webhook-workflow', workflowId: body['workflowId'] as string }
  }
  if (kind === 'agent') return { kind: 'scheduled-agent', agentId: body['agentId'] as string }
  return { kind: 'scheduled-workgroup', workgroupId: body['workgroupId'] as string }
}

/**
 * Current-owner launch validation over one Resource Catalog snapshot. Webhook
 * agent/workgroup launches deliberately reuse the scheduled variants; workflow
 * keeps a distinct request kind for exact consumer accounting.
 */
export async function assertScheduledTargetUsable(
  operations: ScheduledTaskOperations,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  kind: ScheduledLaunchKind,
  body: Record<string, unknown>,
  _defaultRuntime?: string | null,
  triggerSource: TriggerDependencySource = { kind: 'none' },
  source: 'schedule' | 'webhook' = 'schedule',
): Promise<void> {
  const snapshot = await loadIntegrationTriggerResourceSnapshot(
    resourceAuthority,
    scheduledResourceRequest(kind, body, source),
  )
  await assertIntegrationTriggerSnapshotUsable(
    operations,
    resourceAuthority,
    snapshot,
    body,
    triggerSource,
  )
}

export async function createScheduledTask(
  operations: ScheduledTaskOperations,
  input: CreateScheduledTask,
  opts: {
    actor: Actor
    resourceAuthority: IntegrationTriggerResourceAuthority
    beforeWriteTx?: () => Promise<void>
    defaultRuntime?: string | null
  },
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
    operations,
    opts.resourceAuthority,
    kind,
    body as unknown as Record<string, unknown>,
    opts.defaultRuntime,
  )
  const spec = ScheduleSpecSchema.parse(input.scheduleSpec)
  const now = Date.now()
  const id = ulid()
  await opts.beforeWriteTx?.()
  const request = scheduledResourceRequest(
    kind,
    body as unknown as Record<string, unknown>,
    'schedule',
  )
  const record: ScheduledTaskCreateRecord = {
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
  }
  const createdRow = await operations.persistence.createAtomically({
    record,
    authority: opts.resourceAuthority,
    request,
    finish(target) {
      const finalBody = { ...(body as unknown as Record<string, unknown>) }
      if (target.kind === 'scheduled-agent') finalBody['agentName'] = target.agent.name
      if (target.kind === 'scheduled-workgroup') {
        finalBody['workgroupName'] = target.workgroup.name
      }
      return { ...record, launchPayload: JSON.stringify(finalBody) }
    },
  })
  const created = rowToScheduledTask(createdRow)
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.created',
    id: created.id,
    ownerUserId: created.ownerUserId,
  })
  return created
}

export async function updateScheduledTask(
  operations: ScheduledTaskOperations,
  id: string,
  patch: UpdateScheduledTask,
  opts: {
    actor: Actor
    resourceAuthority: IntegrationTriggerResourceAuthority
    beforeWriteTx?: () => Promise<void>
    defaultRuntime?: string | null
  },
): Promise<ScheduledTask> {
  const existing = await getScheduledTask(operations, id)
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
  if (armsLaunchAgainst(existing.enabled) && !opts.actor.permissions.has('tasks:execute')) {
    throw new ForbiddenError('forbidden', 'missing permission: tasks:launch', {
      requiredPermission: 'tasks:execute',
    })
  }

  // R3-1: re-gate whenever the RESULT is enabled (spec-only / re-enable / payload
  // change). Skip when the result is disabled so a user can still stop/clean up a
  // schedule whose target vanished — EXCEPT when the payload itself is being
  // replaced (RFC-218 impl-gate P2-5): new payload content must validate
  // regardless of enabled state, or a disabled edit can persist a shape that
  // deterministically fails every future fire and "save" still reports success.
  if ((enabled || patch.launchPayload !== undefined) && patchedPayload !== null) {
    await assertScheduledTargetUsable(
      operations,
      opts.resourceAuthority,
      existing.launchKind,
      patchedPayload as unknown as Record<string, unknown>,
      opts.defaultRuntime,
    )
  }

  await opts.beforeWriteTx?.()
  const now = Date.now()
  // 实现门 P1 修复（arming TOCTOU）：权限判定若基于 stale 的 existing.enabled，
  // 与写入之间的窗口里另一请求可以先把行 enable——窄 PAT 的 spec-only 更新就
  // 顺着旧快照绕过了 tasks:launch。判定 + 组 set + 写入收进 provider transaction：对
  // FRESH 行重算 arming，越权即回滚整个更新。
  const updatedRow = await operations.persistence.updateAtomically({
    id,
    authority: opts.resourceAuthority,
    decide(fresh) {
      if (armsLaunchAgainst(fresh.enabled) && !opts.actor.permissions.has('tasks:execute')) {
        throw new ForbiddenError('forbidden', 'missing permission: tasks:launch', {
          requiredPermission: 'tasks:execute',
        })
      }
      const resultEnabled = patch.enabled !== undefined ? patch.enabled : fresh.enabled
      const finalKind = ScheduledLaunchKindSchema.safeParse(fresh.launchKind ?? 'workflow')
      if (!finalKind.success) {
        throw new ValidationError(
          'scheduled-task-invalid',
          `scheduled task '${id}' has an invalid launchKind`,
        )
      }
      if (patch.launchKind !== undefined && patch.launchKind !== finalKind.data) {
        throw new ValidationError(
          'scheduled-kind-immutable',
          `launchKind is immutable (existing '${finalKind.data}'); delete and recreate to change the subject`,
        )
      }
      let finalPayload: typeof patchedPayload = null
      if (patch.launchPayload !== undefined) {
        finalPayload = patchedPayload
      } else {
        let raw: unknown
        try {
          raw = JSON.parse(fresh.launchPayload)
        } catch {
          raw = null
        }
        const parsedFreshPayload = scheduledPayloadSchemaFor(finalKind.data).safeParse(raw)
        if (parsedFreshPayload.success) finalPayload = parsedFreshPayload.data
      }
      if ((resultEnabled || patch.launchPayload !== undefined) && finalPayload === null) {
        throw new ValidationError(
          'scheduled-task-needs-repair',
          `scheduled task '${id}' has an unreadable launchPayload — supply a full launchPayload to repair it`,
        )
      }
      const request =
        resultEnabled || patch.launchPayload !== undefined
          ? scheduledResourceRequest(
              finalKind.data,
              finalPayload as Record<string, unknown>,
              'schedule',
            )
          : null
      return {
        request,
        finish(target) {
          const set: ScheduledTaskMutablePatch = { updatedAt: now }
          if (patch.name !== undefined) set.name = patch.name
          if (patch.launchPayload !== undefined && finalPayload !== null) {
            const persistedPayload = { ...(finalPayload as Record<string, unknown>) }
            if (target?.kind === 'scheduled-agent') {
              persistedPayload['agentName'] = target.agent.name
            }
            if (target?.kind === 'scheduled-workgroup') {
              persistedPayload['workgroupName'] = target.workgroup.name
            }
            set.launchPayload = JSON.stringify(persistedPayload)
            // A successful full repair also clears the RFC-165 migration breadcrumb.
            if (existing.launchPayload === null || existing.migrationNeeded) set.lastError = null
          }
          if (patch.scheduleSpec !== undefined && patchedSpec !== null) {
            set.scheduleSpec = JSON.stringify(patchedSpec)
          }
          if (patch.enabled !== undefined) set.enabled = resultEnabled
          if (!resultEnabled) {
            set.nextRunAt = null
          } else if (patch.scheduleSpec !== undefined || (resultEnabled && !fresh.enabled)) {
            set.nextRunAt = computeNextRunAt(patchedSpec as ScheduleSpec, now, now)
            set.consecutiveFailures = 0
          }
          return set
        },
      }
    },
  })
  const updated = rowToScheduledTask(updatedRow)
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.updated',
    id: updated.id,
    ownerUserId: updated.ownerUserId,
  })
  return updated
}

/**
 * RFC-324 §7 —— 定时任务的授权面读取。
 *
 * 与 13 类 ACL 资源的 `getResourceAcl` 同形，少一个 visibility（定时任务没有
 * public 这一档），并且**不支持转移 owner**：fire 以 owner 身份执行，换 owner 等于
 * 换执行身份，那是另一件事，本 RFC 不开这个口子。
 */
export async function getScheduleAcl(
  operations: ScheduledTaskOperations,
  actor: Actor,
  row: ScheduledTask,
): Promise<ScheduleAcl> {
  const snapshot = await operations.persistence.loadAcl(row.id)
  if (snapshot === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${row.id}' not found`)
  }
  const grantRows = snapshot.grants
  const byId = new Map(snapshot.users.map((user) => [user.id, user] as const))
  const grants = grantRows
    .map((g) => ({ user: byId.get(g.userId), level: g.level }))
    .filter((g): g is { user: UserPublic; level: ResourceGrantLevel } => g.user !== undefined)
  const selfGrant = grantRows.find((g) => g.userId === actor.user.id)?.level ?? null
  const access = resolveScheduleAccess(actor, row, selfGrant)
  return {
    resourceType: 'scheduled_task',
    resourceId: row.id,
    ownerUserId: row.ownerUserId,
    owner: row.ownerUserId === SYSTEM_USER_ID ? null : (byId.get(row.ownerUserId) ?? null),
    grants,
    canManage: canGovernAccess(access),
    canEdit: canEditAccess(access),
    aclRevision: snapshot.aclRevision,
  }
}

/**
 * RFC-324 §7 —— 授权面写入：owner / `resource-acl:bypass`，`aclRevision` CAS。
 *
 * CAS、被授权用户存活检查与全量替换在同一个写事务里，与 `updateResourceAcl`
 * 同款：分开做会留下「先判后写」的缝，一个暂停在编辑态的面板足以把已撤销的授权
 * 写回去。
 */
export async function updateScheduleAcl(
  operations: ScheduledTaskOperations,
  actor: Actor,
  row: ScheduledTask,
  body: UpdateScheduleAclBody,
): Promise<ScheduleAcl> {
  const access = await resolveScheduleAccessFor(operations, actor, row)
  if (!canGovernAccess(access)) {
    throw new ForbiddenError(
      'resource-govern-owner-only',
      'granting a scheduled task is reserved for its owner',
    )
  }
  const now = Date.now()
  await operations.persistence.replaceAclAtomically({
    resourceId: row.id,
    expectedResourceId: body.expectedResourceId,
    expectedAclRevision: body.expectedAclRevision,
    actorUserId: actor.user.id,
    bypassOwner: actor.permissions.has('resource-acl:bypass'),
    grants: body.grants,
    systemUserId: SYSTEM_USER_ID,
    updatedAt: now,
  })

  await operations.resourceAclChanged()
  const fresh = await getScheduledTask(operations, row.id)
  if (fresh === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${row.id}' not found`)
  }
  return getScheduleAcl(operations, actor, fresh)
}

export async function deleteScheduledTask(
  operations: ScheduledTaskOperations,
  id: string,
): Promise<void> {
  const existingRow = await operations.persistence.delete(id)
  const existing = existingRow === null ? null : rowToScheduledTask(existingRow)
  if (existing === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
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
  operations: ScheduledTaskOperations,
  row: Row,
  buildLaunch: BuildScheduleLaunch,
  now: number,
  identityAccess: ScheduleAuthorityRuntime,
  invocation: ScheduleAuthorityInvocation,
  defaultRuntime?: string | null,
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

  const delegated = await identityAccess.delegatedRequests.forSchedule({
    ownerUserId: row.ownerUserId,
    scheduleId: row.id,
    invocation,
  })
  if (delegated === null) {
    throw new ValidationError('owner-inactive', `owner '${row.ownerUserId}' is not an active user`)
  }
  const actor: Actor = delegated.actor
  const resourceAuthority = Object.freeze({
    authority: delegated.authority,
    actor,
    resources: identityAccess.integrationTriggerResources,
    taskExecutionResources: identityAccess.taskExecutionResources,
  })
  // RFC-224: save-time acceptance is not a launch capability. Re-evaluate the
  // canonical target and its effective runtime on every fire, using the daemon
  // default that is current for this tick/run-now request. The launch services
  // retain their own final gates, but this shared preflight also protects
  // injected ScheduleLaunch implementations and rejects before any launch
  // side effect.
  await assertScheduledTargetUsable(
    operations,
    resourceAuthority,
    kind,
    bodyWithName,
    defaultRuntime,
  )

  const launch = buildLaunch(row.ownerUserId, row.id)
  const task = await launch(
    kind,
    bodyWithName,
    actor,
    Object.freeze({
      authority: delegated.authority,
      actor,
      resources: identityAccess.taskExecutionResources,
    }),
  )
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
  operations: ScheduledTaskOperations,
): Promise<{ scanned: number; converted: number; disabled: number }> {
  const rows = await operations.persistence.list()
  let converted = 0
  let disabled = 0
  const now = Date.now()

  const disable = async (row: Row, error: string): Promise<void> => {
    await operations.persistence.updateHealedPayload({
      id: row.id,
      disableError: error,
      updatedAt: now,
    })
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

    // RFC-320: unlike path-mode payloads, a stored client-owned Git identity
    // needs no semantic conversion. Drop it; the schedule owner is resolved at
    // each actual fire. This also makes rows injected after the SQL migration
    // self-heal instead of being misclassified as path migrations.
    const hadClientGitIdentity = 'gitUserName' in body || 'gitUserEmail' in body
    delete body['gitUserName']
    delete body['gitUserEmail']
    if (hadClientGitIdentity && rejectRetiredStartTaskKeys(body) === null) {
      await operations.persistence.updateHealedPayload({
        id: row.id,
        launchPayload: JSON.stringify(body),
        updatedAt: now,
      })
      converted += 1
      continue
    }

    if (body['fetchBeforeLaunch'] === true) {
      await disable(
        row,
        'rfc165-fetch-semantic-review: fetchBeforeLaunch has no file:// equivalent — pick a repo source and re-save',
      )
      continue
    }

    // RFC-248: `repos[]` 退役后，存量的**多仓** payload 到这里是无法自愈的——
    // 框架没法替用户凭空造一个仓库组（挂载布局、ref、只读是人的设计意图，不是
    // 能从两个 URL 推出来的东西）。
    //
    // 不处理的后果不是「保持现状」，而是一条**反复失败的启用中计划**：`repos`
    // 现在会让 `rejectRetiredStartTaskKeys` 返回非 null，于是每轮扫描都把它当
    // 「待转换」捡起来、删掉几个别的键、写回、计一次 converted，而 `repos` 还
    // 在——下一轮再来一遍，永远清不干净；与此同时计划照旧到点触发、每次 422。
    // 这正是设计第 10 行要防的烂账，只是从存量 payload 这一侧进来的。
    //
    // 单条 `repos` 是可以自愈的（它语义上就是单仓），下面统一在末尾摊平；
    // 两条及以上只能停发并说清怎么改。
    {
      const rawRepos = body['repos']
      if (Array.isArray(rawRepos) && rawRepos.length > 1) {
        await disable(
          row,
          `rfc248-multi-repo-retired: inline repos[] is retired (${rawRepos.length} entries); ` +
            'create a repo group and re-save this schedule with repoGroupId',
        )
        continue
      }
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
      // RFC-248: 到这里 `repos` 至多一条（多条已在上面停发）。把它摊平成顶层
      // 单仓字段再删除——**必须删**，留着它 payload 永远不是 v2-clean，扫描会
      // 每轮把这行捡起来重写一次，计划则一直启用着反复 422。
      flattenSingleRepo(body)
      await operations.persistence.updateHealedPayload({
        id: row.id,
        launchPayload: JSON.stringify(body),
        updatedAt: now,
      })
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
    // 路径已在上面的循环里healed成 URL，这里把这唯一一条摊平进顶层并删除
    // `repos`，payload 才真正 v2-clean。
    flattenSingleRepo(body)

    await operations.persistence.updateHealedPayload({
      id: row.id,
      launchPayload: JSON.stringify(body),
      updatedAt: now,
    })
    converted += 1
  }
  return { scanned: rows.length, converted, disabled }
}

/**
 * RFC-248: 把**至多一条**的存量 `repos[]` 摊平成顶层单仓字段，并删掉 `repos` 键。
 *
 * 单条 `repos` 语义上就是单仓（RFC-066 时代 length-1 走的正是单仓码路径，
 * 字节级等价），所以摊平是无损的。两条及以上的调用方在上面已经停发。
 *
 * 顶层字段**已存在时不覆盖**——那种 payload 本来就自相矛盾（schema 的
 * 单仓 ⊕ 组互斥会拒），保留顶层、丢掉数组是更可预期的一侧。
 */
function flattenSingleRepo(body: Record<string, unknown>): void {
  const raw = body['repos']
  if (!Array.isArray(raw)) return
  const only = raw.length === 1 ? (raw[0] as Record<string, unknown> | null) : null
  if (only !== null && typeof only === 'object') {
    for (const k of ['repoUrl', 'cachedRepoId', 'ref'] as const) {
      if (body[k] === undefined && typeof only[k] === 'string') body[k] = only[k]
    }
  }
  delete body['repos']
}

export async function runScheduleNow(
  operations: ScheduledTaskOperations,
  id: string,
  buildLaunch: BuildScheduleLaunch,
  identityAccess: ScheduleAuthorityRuntime,
  defaultRuntime?: string | null,
): Promise<{ taskId: string }> {
  const row = await getScheduledTaskRow(operations, id)
  if (row === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  const result = await fireSchedule(
    operations,
    row,
    buildLaunch,
    Date.now(),
    identityAccess,
    { kind: 'manual' },
    defaultRuntime,
  )
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.fired',
    id: row.id,
    ownerUserId: row.ownerUserId,
  })
  return result
}

// RFC-284 T9（§2.2）——引用扫描的实现在叶子模块（避免与 workflow.ts 成环）；
// 本文件保留 design 命名的导出面。
export { scheduledRowsReferencing } from './scheduledTaskRefs'
