// RFC-036 — task collaboration service. RFC-099 (D6/D10/D13) removed the
// dormant node-level assignment helpers (node_assignments never had UI and
// is dropped by migration 0046) and added member management: task membership
// (owner + collaborators) is now the single answer-rights boundary for
// reviews and clarifications, and task users hold the same operational
// rights as the owner (cancel / retry / resume) — only member management,
// owner transfer and task deletion stay owner/admin.

import type { TaskActorRole, TaskMembers, UserPublic } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type { tasks } from '@/db/schema'
import { taskCollaborators, tasks as tasksTable, users } from '@/db/schema'
import { isAdminActor, resolveTaskRole } from '@/services/resourceAcl'
import { ForbiddenError, ValidationError } from '@/util/errors'
import { triggerRevalidation } from '@/ws/revalidationHook'

/** Row-shape that visibility checks accept. The full `tasks` row is supersets of this. */
export type TaskRowForVisibility = Pick<typeof tasks.$inferSelect, 'id' | 'ownerUserId'>

/**
 * Pure read: is the actor allowed to see this task?
 * - admins (tasks:read:all) see everything;
 * - owner sees their own;
 * - any collaborator role sees the task;
 * - daemon-token actor (__system__) sees everything via tasks:read:all.
 */
export async function canViewTask(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
): Promise<boolean> {
  if (actor.permissions.has('tasks:read:all')) return true
  if (task.ownerUserId && task.ownerUserId === actor.user.id) return true
  if (task.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) return true
  return hasMembership(db, task.id, actor.user.id)
}

export async function hasMembership(
  db: DbClient,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
    .limit(1)
  return rows.length > 0
}

export async function listCollaborators(
  db: DbClient,
  taskId: string,
): Promise<(typeof taskCollaborators.$inferSelect)[]> {
  return db.select().from(taskCollaborators).where(eq(taskCollaborators.taskId, taskId))
}

/**
 * RFC-099 (D5/D7) — the answer-rights gate for reviews and clarifications,
 * returning the role snapshot to record on the action. Member identity wins
 * over the global admin role (D17): owner → 'owner', collaborator → 'user',
 * non-member admin → 'admin', anyone else → ForbiddenError.
 */
export async function requireTaskMember(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
): Promise<TaskActorRole> {
  const member = await hasMembership(db, task.id, actor.user.id)
  const role = resolveTaskRole(actor, task.ownerUserId ?? null, member)
  if (role !== null) return role
  throw new ForbiddenError('not-task-member', 'only task members or an admin can do this')
}

// ---------------------------------------------------------------------------
// RFC-099 (D10) — task member management (GET/PUT /api/tasks/:id/members)
// ---------------------------------------------------------------------------

type UserRow = typeof users.$inferSelect

function toUserPublic(row: UserRow): UserPublic {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  }
}

export async function getTaskMembers(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
): Promise<TaskMembers> {
  const collabRows = await listCollaborators(db, task.id)
  const collaboratorIds = collabRows.filter((r) => r.role === 'collaborator').map((r) => r.userId)
  const wanted = [...new Set([...(task.ownerUserId ? [task.ownerUserId] : []), ...collaboratorIds])]
  const userRows =
    wanted.length === 0 ? [] : await db.select().from(users).where(inArray(users.id, wanted))
  const byId = new Map(userRows.map((u) => [u.id, u]))
  const ownerRow =
    task.ownerUserId != null && task.ownerUserId !== SYSTEM_USER_ID
      ? (byId.get(task.ownerUserId) ?? null)
      : null
  const memberUsers = collaboratorIds
    .map((id) => byId.get(id))
    .filter((u): u is UserRow => u !== undefined)
    .map(toUserPublic)
  const canManage =
    isAdminActor(actor) || (task.ownerUserId != null && task.ownerUserId === actor.user.id)
  return {
    taskId: task.id,
    ownerUserId: task.ownerUserId ?? null,
    owner: ownerRow ? toUserPublic(ownerRow) : null,
    users: memberUsers,
    canManage,
  }
}

/**
 * PUT members — owner/admin only. `userIds` is full-replace of the
 * collaborator set. On owner transfer the previous human owner is kept as a
 * collaborator so they don't lose sight of their own task (mirror of the
 * resource-ACL rule).
 */
export async function updateTaskMembers(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
  body: { ownerUserId?: string; userIds?: string[] },
): Promise<TaskMembers> {
  const canManage =
    isAdminActor(actor) || (task.ownerUserId != null && task.ownerUserId === actor.user.id)
  if (!canManage) {
    throw new ForbiddenError('forbidden', 'only the task owner or an admin can manage members')
  }

  const referenced = new Set<string>(body.userIds ?? [])
  if (body.ownerUserId !== undefined) referenced.add(body.ownerUserId)
  if (referenced.size > 0) {
    const rows = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(inArray(users.id, [...referenced]))
    const active = new Set(rows.filter((r) => r.status === 'active').map((r) => r.id))
    const bad = [...referenced].filter((id) => id === SYSTEM_USER_ID || !active.has(id))
    if (bad.length > 0) {
      throw new ValidationError('members-user-invalid', 'referenced user(s) not active', {
        userIds: bad,
      })
    }
  }

  const prevOwner = task.ownerUserId ?? null
  const nextOwner = body.ownerUserId !== undefined ? body.ownerUserId : prevOwner

  let nextUserIds: string[]
  if (body.userIds !== undefined) {
    nextUserIds = [...new Set(body.userIds)]
  } else {
    const current = await listCollaborators(db, task.id)
    nextUserIds = current.filter((r) => r.role === 'collaborator').map((r) => r.userId)
  }
  if (
    nextOwner !== prevOwner &&
    prevOwner !== null &&
    prevOwner !== SYSTEM_USER_ID &&
    !nextUserIds.includes(prevOwner)
  ) {
    nextUserIds.push(prevOwner)
  }
  nextUserIds = nextUserIds.filter((id) => id !== nextOwner)

  const now = Date.now()
  dbTxSync(db, (tx) => {
    if (nextOwner !== prevOwner) {
      tx.update(tasksTable).set({ ownerUserId: nextOwner }).where(eq(tasksTable.id, task.id)).run()
    }
    tx.delete(taskCollaborators).where(eq(taskCollaborators.taskId, task.id)).run()
    const values: (typeof taskCollaborators.$inferInsert)[] = []
    if (nextOwner !== null) {
      values.push({
        taskId: task.id,
        userId: nextOwner,
        role: 'owner',
        addedBy: actor.user.id,
        addedAt: now,
      })
    }
    for (const userId of nextUserIds) {
      values.push({
        taskId: task.id,
        userId,
        role: 'collaborator',
        addedBy: actor.user.id,
        addedAt: now,
      })
    }
    if (values.length > 0) {
      tx.insert(taskCollaborators).values(values).run()
    }
  })

  // RFC-212 — AFTER the transaction commits: a member just lost access, so any
  // WS they have open on this task must be re-checked. Triggering inside/before
  // the tx would let the rescan read the pre-change membership and never close.
  triggerRevalidation(db, 'task-members-changed')

  return getTaskMembers(db, actor, { id: task.id, ownerUserId: nextOwner })
}

/**
 * RFC-165 (F17): pure row builder behind `recordLaunchContext` — validates
 * every referenced user against the provided user rows (active only) and
 * returns the deduped owner + collaborator rows. Extracted so the launch
 * transaction (dbTxSync, synchronous surface) can run the SAME logic inline
 * without this module's async db reads.
 */
export function buildLaunchCollabRows(
  args: {
    taskId: string
    ownerUserId: string
    collaboratorUserIds: ReadonlyArray<string>
    now: number
  },
  userRows: ReadonlyArray<{ id: string; status: string }>,
): (typeof taskCollaborators.$inferInsert)[] {
  // 1. Validate every referenced user is active.
  const referenced = new Set<string>()
  referenced.add(args.ownerUserId)
  for (const u of args.collaboratorUserIds) referenced.add(u)
  const active = new Set(userRows.filter((r) => r.status === 'active').map((r) => r.id))
  for (const id of referenced) {
    if (!active.has(id)) {
      throw new ValidationError('invalid-collaborator', `referenced user '${id}' is not active`)
    }
  }

  // 2. Owner row + collaborator rows, deduped by the composite PK.
  const collabValues: (typeof taskCollaborators.$inferInsert)[] = []
  collabValues.push({
    taskId: args.taskId,
    userId: args.ownerUserId,
    role: 'owner',
    addedBy: args.ownerUserId,
    addedAt: args.now,
  })
  for (const u of args.collaboratorUserIds) {
    if (u === args.ownerUserId) continue
    collabValues.push({
      taskId: args.taskId,
      userId: u,
      role: 'collaborator',
      addedBy: args.ownerUserId,
      addedAt: args.now,
    })
  }
  const seenPK = new Set<string>()
  return collabValues.filter((v) => {
    const key = `${v.taskId}::${v.userId}::${v.role}`
    if (seenPK.has(key)) return false
    seenPK.add(key)
    return true
  })
}

/**
 * Persist a task's launch-time owner + collaborators. Caller has already
 * inserted the `tasks` row (so taskCollaborators FKs resolve) — this just
 * writes the supporting rows. (RFC-099 removed the assignments leg.)
 */
export async function recordLaunchContext(
  db: DbClient,
  args: {
    taskId: string
    ownerUserId: string
    collaboratorUserIds: ReadonlyArray<string>
    now: number
  },
): Promise<void> {
  const rows = await db.select().from(users)
  const insertCollab = buildLaunchCollabRows(args, rows)
  if (insertCollab.length > 0) {
    await db.insert(taskCollaborators).values(insertCollab)
  }
}
