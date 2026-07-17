// Workgroup service — CRUD on workgroups + workgroup_members (RFC-164 PR-1).
//
// Mirrors services/mcp.ts shape: DB is source of truth, the two tables are
// materialised into one Workgroup DTO (members eager-loaded, roster order =
// sortOrder then displayName), name unique constraint enforced both by the
// column index and by an explicit pre-insert lookup for a friendly
// ConflictError.
//
// Member semantics (design §1.2):
//   - full-replace on update: member rows are regenerated (ids are NOT
//     stable across saves). Launched tasks are unaffected — launch snapshots
//     the whole config onto the task (PR-3), so resource-level ids are only
//     meaningful until the next save.
//   - leader is referenced by displayName in Create/Update bodies and
//     resolved to the freshly-inserted member id here (schema-level shape
//     validation — lw requires an agent-member leader — already ran in zod).
//   - agent member names are soft references (dangling tolerated until
//     launch, matching workflow agentName behavior); human userIds must
//     resolve to real active users at save time (users are stable, and a
//     dangling human member has no launch-time validator to catch it).
//
// Reference-usability (RFC-099 D15) is the ROUTE's job via
// assertNewRefsUsable — this service only owns existence/shape.

import type {
  CreateWorkgroup,
  UpdateWorkgroup,
  Workgroup,
  WorkgroupMember,
  WorkgroupMode,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { discloseScheduleRefs } from './resourceAcl'
import type { Actor } from '@/auth/actor'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { scheduledTasks, users, workgroupMembers, workgroups } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect

export async function listWorkgroups(db: DbClient): Promise<Workgroup[]> {
  const rows = await db.select().from(workgroups)
  if (rows.length === 0) return []
  const memberRows = await db
    .select()
    .from(workgroupMembers)
    .where(
      inArray(
        workgroupMembers.workgroupId,
        rows.map((r) => r.id),
      ),
    )
  const byGroup = new Map<string, MemberRow[]>()
  for (const m of memberRows) {
    const list = byGroup.get(m.workgroupId)
    if (list === undefined) byGroup.set(m.workgroupId, [m])
    else list.push(m)
  }
  return rows.map((r) => rowToWorkgroup(r, byGroup.get(r.id) ?? []))
}

export async function getWorkgroup(db: DbClient, name: string): Promise<Workgroup | null> {
  const rows = await db.select().from(workgroups).where(eq(workgroups.name, name)).limit(1)
  const row = rows[0]
  if (row === undefined) return null
  const memberRows = await db
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, row.id))
  return rowToWorkgroup(row, memberRows)
}

/**
 * RFC-177: fetch a workgroup by its stable id (ULID). Powers the by-id subject
 * resolver (`GET /api/workgroups/by-id/:id`) so a task's frozen `workgroupId`
 * link survives a rename of the group. Same shape as `getWorkgroup`.
 */
export async function getWorkgroupById(db: DbClient, id: string): Promise<Workgroup | null> {
  const rows = await db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
  const row = rows[0]
  if (row === undefined) return null
  const memberRows = await db
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, row.id))
  return rowToWorkgroup(row, memberRows)
}

export async function createWorkgroup(
  db: DbClient,
  input: CreateWorkgroup,
  aclOpts?: { ownerUserId?: string },
): Promise<Workgroup> {
  if ((await getWorkgroup(db, input.name)) !== null) {
    throw new ConflictError('workgroup-name-in-use', `workgroup '${input.name}' already exists`)
  }
  await assertHumanMembersActive(db, input.members)

  const groupId = ulid()
  const now = Date.now()
  const memberValues = buildMemberValues(groupId, input.members, now)
  const leaderMemberId = resolveLeaderMemberId(input, memberValues)

  dbTxSync(db, (tx) => {
    tx.insert(workgroups)
      .values({
        id: groupId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        mode: input.mode,
        leaderMemberId,
        shareOutputs: input.switches.shareOutputs,
        directMessages: input.switches.directMessages,
        blackboard: input.switches.blackboard,
        maxRounds: input.maxRounds,
        completionGate: input.completionGate,
        // RFC-181 D: new groups default to autonomous (don't-interrupt-me) —
        // create-scoped only; update below preserves the stored value instead.
        autonomous: input.autonomous ?? true,
        // RFC-185 D4: fan-out is opt-in — default OFF so the original fixed
        // one-entity-per-agent mode is never changed implicitly.
        fanOut: input.fanOut ?? false,
        // RFC-099: creator becomes owner; new resources default to 'public' (D18).
        ownerUserId: aclOpts?.ownerUserId ?? null,
        visibility: 'public',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const m of memberValues) {
      tx.insert(workgroupMembers).values(m).run()
    }
  })

  const created = await getWorkgroup(db, input.name)
  if (created === null) throw new Error('workgroup disappeared right after insert')
  return created
}

export async function updateWorkgroup(
  db: DbClient,
  name: string,
  input: UpdateWorkgroup,
): Promise<Workgroup> {
  const existingRows = await db.select().from(workgroups).where(eq(workgroups.name, name)).limit(1)
  const existing = existingRows[0]
  if (existing === undefined) {
    throw new NotFoundError('workgroup-not-found', `workgroup '${name}' not found`)
  }
  await assertHumanMembersActive(db, input.members)

  const now = Date.now()
  const memberValues = buildMemberValues(existing.id, input.members, now)
  const leaderMemberId = resolveLeaderMemberId(input, memberValues)

  // Full-replace members + config in one transaction (design §1.2: member ids
  // regenerate; launched tasks read their own config snapshot).
  dbTxSync(db, (tx) => {
    tx.update(workgroups)
      .set({
        description: input.description,
        instructions: input.instructions,
        mode: input.mode,
        leaderMemberId,
        shareOutputs: input.switches.shareOutputs,
        directMessages: input.switches.directMessages,
        blackboard: input.switches.blackboard,
        maxRounds: input.maxRounds,
        completionGate: input.completionGate,
        // RFC-181 D (design-gate P1): a PUT that omits `autonomous` must NOT
        // silently flip the stored value in either direction — the field is
        // shared between Create/Update schemas, so the create default must not
        // leak into full-replace updates. Omitted ⇒ keep the existing row.
        autonomous: input.autonomous ?? existing.autonomous,
        // RFC-185 D4: same omitted-⇒-preserve contract as autonomous above.
        fanOut: input.fanOut ?? existing.fanOut,
        updatedAt: now,
      })
      .where(eq(workgroups.id, existing.id))
      .run()
    tx.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, existing.id)).run()
    for (const m of memberValues) {
      tx.insert(workgroupMembers).values(m).run()
    }
  })

  const updated = await getWorkgroup(db, name)
  if (updated === null) throw new Error('workgroup disappeared after update')
  return updated
}

/**
 * RFC-165 §9b（实现门 P1 修复）：workgroup 定时任务把目标冻结为可变的 NAME
 * （tasks 走 id + 快照，定时行不是）。rename/delete 遇引用行 → 409，防
 * 「先静默失败、名字复用后打错组」。
 */
async function scheduledRowsReferencingWorkgroup(
  db: DbClient,
  name: string,
): Promise<Array<{ id: string; name: string; ownerUserId: string }>> {
  const rows = await db
    .select({
      id: scheduledTasks.id,
      name: scheduledTasks.name,
      launchKind: scheduledTasks.launchKind,
      launchPayload: scheduledTasks.launchPayload,
      ownerUserId: scheduledTasks.ownerUserId,
    })
    .from(scheduledTasks)
  const out: Array<{ id: string; name: string; ownerUserId: string }> = []
  for (const row of rows) {
    if (row.launchKind !== 'workgroup') continue
    try {
      const p = JSON.parse(row.launchPayload) as { workgroupName?: unknown }
      if (p.workgroupName === name)
        out.push({ id: row.id, name: row.name, ownerUserId: row.ownerUserId })
    } catch {
      /* degraded rows are repaired/deleted via their own flow */
    }
  }
  return out
}

export async function deleteWorkgroup(db: DbClient, name: string, actor: Actor): Promise<void> {
  const existing = await getWorkgroup(db, name)
  if (existing === null) {
    throw new NotFoundError('workgroup-not-found', `workgroup '${name}' not found`)
  }
  // No task-side guard: tasks link by id + own a config snapshot, so
  // historical/running tasks keep functioning after the resource is deleted
  // (same durable-soft-link philosophy as tasks.scheduled_task_id).
  // Scheduled rows are the exception — they reference the mutable NAME.
  const schedRefs = await scheduledRowsReferencingWorkgroup(db, name)
  if (schedRefs.length > 0) {
    // RFC-203 T6: principal-aware disclosure (deleteWorkflow precedent) —
    // schedules are member-private, so names show only for the actor's own
    // schedules (or tasks:read:all admins); the rest is a count.
    throw new ConflictError(
      'workgroup-scheduled-referenced',
      `workgroup '${name}' is the target of ${schedRefs.length} scheduled task(s); delete or repoint them first`,
      discloseScheduleRefs(actor, schedRefs),
    )
  }
  await db.delete(workgroups).where(eq(workgroups.name, name))
}

/**
 * Rename a group and/or edit its description atomically (2026-07-13, 用户拍板
 * 「后端原子端点」). Both are the group's metadata fields, edited together in
 * the detail-page rename dialog:
 *   - `newName === oldName` ⇒ description-only edit: the name-collision and
 *     scheduled-reference guards DON'T apply (nothing about the name changes),
 *     so a description edit is never blocked by a scheduled task.
 *   - `description === undefined` ⇒ pure rename: the stored description is left
 *     untouched (the config PUT no longer carries it).
 * A no-op (name unchanged AND description unchanged/omitted) returns early.
 */
export async function renameWorkgroup(
  db: DbClient,
  oldName: string,
  newName: string,
  actor: Actor,
  description?: string,
): Promise<Workgroup> {
  const existing = await getWorkgroup(db, oldName)
  if (existing === null) {
    throw new NotFoundError('workgroup-not-found', `workgroup '${oldName}' not found`)
  }
  const nameChanged = newName !== oldName
  const descChanged = description !== undefined && description !== existing.description
  if (!nameChanged && !descChanged) return existing
  if (nameChanged) {
    if ((await getWorkgroup(db, newName)) !== null) {
      throw new ConflictError(
        'workgroup-name-in-use',
        `workgroup '${newName}' already exists; pick a different name`,
      )
    }
    // Tasks link by id; scheduled rows reference the mutable NAME (RFC-165 §9b)
    // — refuse the rename while any point at this group. (A description-only
    // edit keeps the name, so this guard is skipped for it.)
    const schedRefs = await scheduledRowsReferencingWorkgroup(db, oldName)
    if (schedRefs.length > 0) {
      throw new ConflictError(
        'workgroup-scheduled-referenced',
        `workgroup '${oldName}' is the target of ${schedRefs.length} scheduled task(s); repoint them before renaming`,
        discloseScheduleRefs(actor, schedRefs),
      )
    }
  }
  await db
    .update(workgroups)
    .set({
      ...(nameChanged ? { name: newName } : {}),
      ...(descChanged ? { description } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(workgroups.name, oldName))
  const renamed = await getWorkgroup(db, nameChanged ? newName : oldName)
  if (renamed === null) throw new Error('workgroup disappeared after rename')
  return renamed
}

/** New agent names referenced by `next` that `prev` didn't reference (D15 input). */
export function diffNewAgentMemberNames(
  prev: Pick<Workgroup, 'members'> | null,
  next: { members: ReadonlyArray<{ memberType: string; agentName?: string | undefined }> },
): string[] {
  const prevNames = new Set(
    (prev?.members ?? [])
      .filter((m) => m.memberType === 'agent' && m.agentName !== null)
      .map((m) => m.agentName as string),
  )
  const out = new Set<string>()
  for (const m of next.members) {
    if (m.memberType !== 'agent') continue
    if (m.agentName === undefined || m.agentName.length === 0) continue
    if (!prevNames.has(m.agentName)) out.add(m.agentName)
  }
  return [...out]
}

// --- internals ---

type MemberInput = CreateWorkgroup['members'][number]

function buildMemberValues(
  groupId: string,
  members: readonly MemberInput[],
  now: number,
): Array<typeof workgroupMembers.$inferInsert> {
  return members.map((m, i) => ({
    id: ulid(),
    workgroupId: groupId,
    memberType: m.memberType,
    agentName: m.memberType === 'agent' ? (m.agentName ?? null) : null,
    userId: m.memberType === 'human' ? (m.userId ?? null) : null,
    displayName: m.displayName,
    roleDesc: m.roleDesc,
    sortOrder: i,
    createdAt: now,
  }))
}

function resolveLeaderMemberId(
  input: { mode: WorkgroupMode; leaderDisplayName?: string | undefined },
  memberValues: ReadonlyArray<typeof workgroupMembers.$inferInsert>,
): string | null {
  // Only leader_worker has a leader; free_collab AND dynamic_workflow return null.
  if (input.mode !== 'leader_worker') return null
  // 决策 #21 quick create: a leaderless leader_worker group is SAVE-valid;
  // launch enforces readiness via workgroupLaunchReadiness.
  if (input.leaderDisplayName === undefined) return null
  // Zod superRefine already guaranteed agent-member when provided; re-check
  // defensively for service-layer callers that bypass the route schema.
  const leader = memberValues.find((m) => m.displayName === input.leaderDisplayName)
  if (leader === undefined || leader.memberType !== 'agent') {
    throw new ValidationError(
      'workgroup-leader-invalid',
      'leaderDisplayName must match an agent member',
    )
  }
  return leader.id
}

async function assertHumanMembersActive(
  db: DbClient,
  members: readonly MemberInput[],
): Promise<void> {
  const ids = [
    ...new Set(
      members
        .filter((m) => m.memberType === 'human' && m.userId !== undefined)
        .map((m) => m.userId as string),
    ),
  ]
  if (ids.length === 0) return
  const rows = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(and(inArray(users.id, ids)))
  const active = new Set(rows.filter((r) => r.status === 'active').map((r) => r.id))
  const bad = ids.filter((id) => !active.has(id))
  if (bad.length > 0) {
    throw new ValidationError('workgroup-member-user-invalid', 'human member user(s) not active', {
      userIds: bad,
    })
  }
}

function rowToWorkgroup(row: WorkgroupRow, memberRows: MemberRow[]): Workgroup {
  const members: WorkgroupMember[] = memberRows
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName))
    .map((m) => ({
      id: m.id,
      memberType: m.memberType,
      agentName: m.agentName,
      userId: m.userId,
      displayName: m.displayName,
      roleDesc: m.roleDesc,
      sortOrder: m.sortOrder,
    }))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    mode: row.mode,
    leaderMemberId: row.leaderMemberId,
    switches: {
      shareOutputs: row.shareOutputs,
      directMessages: row.directMessages,
      blackboard: row.blackboard,
    },
    maxRounds: row.maxRounds,
    completionGate: row.completionGate,
    autonomous: row.autonomous,
    fanOut: row.fanOut,
    members,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
