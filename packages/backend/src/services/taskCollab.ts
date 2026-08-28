// RFC-036 — task collaboration service. RFC-099 (D6/D10/D13) removed the
// dormant node-level assignment helpers (node_assignments never had UI and
// is dropped by migration 0046) and added member management: task membership
// (owner + collaborators) is now the single answer-rights boundary for
// reviews and clarifications, and task users hold the same operational
// rights as the owner (cancel / retry / resume) — only member management,
// owner transfer and task deletion stay with the owner or explicit permission holders.

import type {
  AssignableTaskMemberRole,
  TaskActorRole,
  TaskMembers,
  UserPublic,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { tasks } from '@/db/schema'
import { taskCollaborators, tasks as tasksTable, users } from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import { hasResourceAclBypass, resolveTaskRole } from '@/services/resourceAcl'
import { ForbiddenError, ValidationError } from '@/util/errors'
import { triggerRevalidationAndWait } from '@/ws/revalidationHook'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'

/** Row-shape that visibility checks accept. The full `tasks` row is supersets of this. */
export type TaskRowForVisibility = Pick<typeof tasks.$inferSelect, 'id' | 'ownerUserId'>

/**
 * Pure read: is the actor allowed to see this task?
 * - actors with `tasks:read:all` see everything;
 * - owner sees their own;
 * - any collaborator role sees the task;
 * - daemon-token actor (__system__) sees everything via `tasks:read:all`.
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

/**
 * RFC-248 H9（实现门 P1）—— 用 `sourceTaskId` 重放前，先确认调用方**看得见**那个
 * 任务。
 *
 * `sourceTaskId` 完全由调用方控制。不设这道门的话，一个「能启动某工作流、但看
 * 不见任务 X」的用户可以传 X 的 id，让服务端读出 X 冻结的 `task_repos` 并按它
 * 物化——泄漏的是私有 / 已撤权任务的仓库构成（哪几个仓、什么 ref、什么布局），
 * 而且泄漏形式还是「任务成功启动」，完全不像一次越权。
 *
 * 与任务读取共用 `canViewTask`，且**不可见与不存在同形**（都 404），不让调用方
 * 靠错误码区分「有这个任务但你没权限」与「没有这个任务」。
 */
export async function assertCanReplaySourceTask(
  db: DbClient,
  actor: Actor,
  sourceTaskId: string,
): Promise<void> {
  const rows = await db
    .select({ id: tasksTable.id, ownerUserId: tasksTable.ownerUserId })
    .from(tasksTable)
    .where(eq(tasksTable.id, sourceTaskId))
    .limit(1)
  const row = rows[0]
  if (row === undefined || !(await canViewTask(db, actor, row))) {
    throw new NotFoundError('task-not-found', `task ${sourceTaskId} not found`)
  }
}

/**
 * Any membership row at all — including RFC-324's `observer`. This is the
 * VISIBILITY predicate: an observer was added precisely so they could watch.
 */
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

/**
 * RFC-324 —— 行动权成员：owner 或 collaborator，**不含 observer**。
 *
 * 这是「回答评审 / 反问」与「cancel / resume / diagnose」共用的判据。与
 * `hasMembership` 分开命名，是因为 RFC-324 之前它们是同一个问题，而现在把它们
 * 混起来正好会让观察者拿回他被明确排除的那些操作。
 */
export async function hasActingMembership(
  db: DbClient,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
  return rows.some((r) => r.role === 'owner' || r.role === 'collaborator')
}

/**
 * RFC-326 — synchronous twin of `hasActingMembership` for callers inside a
 * `dbTxSync` (the review decision re-verifies the actor's membership at its
 * commit point, linearised with `updateTaskMembers` by the shared task lock).
 */
export function hasActingMembershipTx(tx: DbTxSync, taskId: string, userId: string): boolean {
  const rows = tx
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
    .all()
  return rows.some((r) => r.role === 'owner' || r.role === 'collaborator')
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
 * over global permissions (D17): owner → 'owner', collaborator → 'user',
 * non-member privileged actor → a legacy audit label, anyone else → ForbiddenError.
 */
export async function requireTaskMember(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
): Promise<TaskActorRole> {
  // RFC-324 —— observer 看得见任务，但不是回答权主体，所以这里问的是行动权成员。
  const member = await hasActingMembership(db, task.id, actor.user.id)
  const role = resolveTaskRole(actor, task.ownerUserId ?? null, member)
  if (role !== null) return role
  throw new ForbiddenError(
    'not-task-member',
    'only task members or an actor with the required global task authority can do this',
  )
}

/**
 * RFC-324 —— 操作面的门：cancel / resume / diagnose / retry / repair /
 * change-narrative 生成。
 *
 * 与 `requireTaskMember`（回答权）判据相同、命名不同：两者在产品上是两件事
 * （「能不能替这个任务做决定」与「能不能推动这个任务」），今天恰好同档，
 * 分开命名让将来任一侧单独演进时不必先把调用点摘开。
 */
export async function requireTaskOperator(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
): Promise<void> {
  const member = await hasActingMembership(db, task.id, actor.user.id)
  if (resolveTaskRole(actor, task.ownerUserId ?? null, member) !== null) return
  throw new ForbiddenError(
    'task-observer-read-only',
    'you are an observer on this task; cancelling, resuming and retrying are reserved for its members',
  )
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
  // RFC-324 —— 面板列出两档成员；owner 行由 ownerUserId 表达，不进列表。
  const memberRows = collabRows.filter((r) => r.role === 'collaborator' || r.role === 'observer')
  const collaboratorIds = memberRows.map((r) => r.userId)
  const wanted = [...new Set([...(task.ownerUserId ? [task.ownerUserId] : []), ...collaboratorIds])]
  const userRows =
    wanted.length === 0 ? [] : await db.select().from(users).where(inArray(users.id, wanted))
  const byId = new Map(userRows.map((u) => [u.id, u]))
  const ownerRow =
    task.ownerUserId != null && task.ownerUserId !== SYSTEM_USER_ID
      ? (byId.get(task.ownerUserId) ?? null)
      : null
  const members = memberRows
    .map((r) => ({ user: byId.get(r.userId), role: r.role }))
    .filter(
      (m): m is { user: UserRow; role: 'collaborator' | 'observer' } =>
        m.user !== undefined && m.role !== 'owner',
    )
    .map((m) => ({ user: toUserPublic(m.user), role: m.role }))
  const isOwner = task.ownerUserId != null && task.ownerUserId === actor.user.id
  const canManage = hasResourceAclBypass(actor) || isOwner
  // RFC-324 —— 面板据此禁用 cancel / resume / 回答控件，而不是让点击撞上 403。
  const canOperate =
    canManage || memberRows.some((r) => r.role === 'collaborator' && r.userId === actor.user.id)
  return {
    taskId: task.id,
    ownerUserId: task.ownerUserId ?? null,
    owner: ownerRow ? toUserPublic(ownerRow) : null,
    members,
    canManage,
    canOperate,
  }
}

/**
 * PUT members — task owner or `resource-acl:bypass`. `members` is full-replace of
 * the non-owner member set, each entry carrying its RFC-324 grade. On owner
 * transfer the previous human owner is kept as a COLLABORATOR so they don't lose
 * their own task's controls (mirror of the resource-ACL rule, which keeps the
 * previous owner as a grantee).
 */
/**
 * RFC-330 —— 任务与数字员工案例共用的成员替换规则（纯函数）：
 *   - `members` 给了就全量替换，没给就沿用现状；同一用户出现两次取**最后**一条
 *     （与旧 `new Set(userIds)` 的去重一致；PK 含 role，写两档会出现两行）；
 *   - owner 转移时，前任（非 null、非系统、未另列）自动降为 collaborator，
 *     不让人丢掉自己任务的控制权（镜像资源 ACL 保留前任 grant 的规则）；
 *   - owner 永远不是成员行。
 */
export function planMembersReplacement(input: {
  readonly prevOwner: string | null
  readonly requestedOwner: string | undefined
  readonly requestedMembers:
    | ReadonlyArray<{ readonly userId: string; readonly role: AssignableTaskMemberRole }>
    | undefined
  readonly currentMembers: ReadonlyArray<{
    readonly userId: string
    readonly role: AssignableTaskMemberRole
  }>
}): { nextOwner: string | null; nextMembers: Map<string, AssignableTaskMemberRole> } {
  const nextOwner = input.requestedOwner !== undefined ? input.requestedOwner : input.prevOwner
  const nextMembers = new Map<string, AssignableTaskMemberRole>(
    (input.requestedMembers ?? input.currentMembers).map((m) => [m.userId, m.role] as const),
  )
  if (
    nextOwner !== input.prevOwner &&
    input.prevOwner !== null &&
    input.prevOwner !== SYSTEM_USER_ID &&
    !nextMembers.has(input.prevOwner)
  ) {
    nextMembers.set(input.prevOwner, 'collaborator')
  }
  if (nextOwner !== null) nextMembers.delete(nextOwner)
  return { nextOwner, nextMembers }
}

/** RFC-330 —— 引用的用户必须 active 且非系统用户（422 `members-user-invalid`）；任务 / 案例共用。 */
export async function assertMembersUsersActive(
  db: DbClient,
  body: {
    readonly ownerUserId?: string
    readonly members?: ReadonlyArray<{ readonly userId: string }>
  },
): Promise<void> {
  const referenced = new Set<string>((body.members ?? []).map((m) => m.userId))
  if (body.ownerUserId !== undefined) referenced.add(body.ownerUserId)
  if (referenced.size === 0) return
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

/** RFC-326 — what the locked section hands to the post-commit section. */
interface MembersCommit {
  prevOwner: string | null
  nextOwner: string | null
  beforeCollaborators: (typeof taskCollaborators.$inferSelect)[]
  nextMembers: Map<string, AssignableTaskMemberRole>
}

export async function updateTaskMembers(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
  body: {
    ownerUserId?: string
    members?: Array<{ userId: string; role: AssignableTaskMemberRole }>
  },
): Promise<TaskMembers> {
  // RFC-326 P13 — membership changes and review writes share the task's FIFO
  // lock (`reviewMutationCoordinator`). Inside the lock the task row is re-read:
  // the row the route loaded may be stale by the time this request reaches the
  // front of the queue (owner transferred, member removed), and the authorization
  // + prevOwner below must come from the fresh row, not the queued snapshot.
  // The WS revalidation wait and the broadcast stay OUTSIDE the lock — they can
  // take arbitrarily long and must not stall reviews / cancels on the same task.
  const commit = await withTaskReviewMutationLock(task.id, async () => {
    const fresh = (
      await db
        .select({ id: tasksTable.id, ownerUserId: tasksTable.ownerUserId })
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1)
    )[0]
    if (fresh === undefined)
      throw new NotFoundError('task-not-found', `task '${task.id}' not found`)
    const committed = await updateTaskMembersLocked(db, actor, fresh, body)
    // The response is the state THIS commit produced, read while the lock still
    // excludes the next writer — composing it after the (lock-free) revalidation
    // wait from a fresh member query would pair this commit's owner with rows a
    // later commit wrote (RFC-326 impl-gate P2).
    const members = await getTaskMembers(db, actor, {
      id: task.id,
      ownerUserId: committed.nextOwner,
    })
    return { ...committed, members }
  })
  const { prevOwner, nextOwner, beforeCollaborators, nextMembers } = commit

  // RFC-212 — AFTER the transaction commits: a member just lost access, so any
  // WS they have open on this task must be re-checked. Triggering inside/before
  // the tx would let the rescan read the pre-change membership and never close.
  await triggerRevalidationAndWait(db, 'task-members-changed')

  const visibleUserIds = new Set<string>()
  if (prevOwner !== null) visibleUserIds.add(prevOwner)
  if (nextOwner !== null) visibleUserIds.add(nextOwner)
  for (const row of beforeCollaborators) visibleUserIds.add(row.userId)
  for (const userId of nextMembers.keys()) visibleUserIds.add(userId)
  tasksListBroadcaster.broadcast(
    TASKS_LIST_CHANNEL,
    { type: 'task.members.changed', taskId: task.id },
    { kind: 'task.members-changed-audience', taskId: task.id, visibleUserIds },
  )

  return commit.members
}

async function updateTaskMembersLocked(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
  body: {
    ownerUserId?: string
    members?: Array<{ userId: string; role: AssignableTaskMemberRole }>
  },
): Promise<MembersCommit> {
  const canManage =
    hasResourceAclBypass(actor) || (task.ownerUserId != null && task.ownerUserId === actor.user.id)
  if (!canManage) {
    throw new ForbiddenError(
      'forbidden',
      'only the task owner or an actor with resource-acl:bypass can manage members',
    )
  }

  await assertMembersUsersActive(db, body)

  const prevOwner = task.ownerUserId ?? null
  let nextOwner: string | null = prevOwner
  let beforeCollaborators: (typeof taskCollaborators.$inferSelect)[] = []
  let nextMembers = new Map<string, AssignableTaskMemberRole>()

  const now = Date.now()
  dbTxSync(db, (tx) => {
    // Freeze the pre-change audience in the same transaction as the full
    // replacement. The post-commit WS frame can then authorize both sides of
    // the transition without racing a membership read.
    beforeCollaborators = tx
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, task.id))
      .all()
    const plan = planMembersReplacement({
      prevOwner,
      requestedOwner: body.ownerUserId,
      requestedMembers: body.members,
      currentMembers: beforeCollaborators
        .filter((r) => r.role === 'collaborator' || r.role === 'observer')
        .map((r) => ({ userId: r.userId, role: r.role as AssignableTaskMemberRole })),
    })
    nextOwner = plan.nextOwner
    nextMembers = plan.nextMembers

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
    for (const [userId, role] of nextMembers) {
      values.push({
        taskId: task.id,
        userId,
        role,
        addedBy: actor.user.id,
        addedAt: now,
      })
    }
    if (values.length > 0) {
      tx.insert(taskCollaborators).values(values).run()
    }
  })

  return { prevOwner, nextOwner, beforeCollaborators, nextMembers }
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
