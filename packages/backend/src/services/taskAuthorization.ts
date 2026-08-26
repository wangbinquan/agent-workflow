import type { SQL, SQLWrapper } from 'drizzle-orm'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { taskCollaborators, tasks } from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'

/**
 * Minimal column contract used by task-list queries. Accepting SQLWrapper keeps
 * the predicate reusable for both Drizzle tables and fixed, trusted CTE aliases.
 */
export interface TaskAuthorizationRef {
  id: SQLWrapper
  ownerUserId: SQLWrapper
}

export type TaskOwnershipScope = 'all' | 'mine' | 'shared'

export function taskAuthorizationCondition(
  db: DbClient,
  ref: TaskAuthorizationRef,
  actor: Actor,
): SQL<unknown> {
  if (actor.permissions.has('tasks:read:all')) return sql`1 = 1`

  const collaborator = inArray(
    ref.id,
    db
      .select({ id: taskCollaborators.taskId })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, actor.user.id)),
  )
  return or(eq(ref.ownerUserId, actor.user.id), collaborator)!
}

export function taskOwnershipScopeCondition(
  db: DbClient,
  ref: TaskAuthorizationRef,
  actorUserId: string,
  scope: TaskOwnershipScope,
): SQL<unknown> {
  if (scope === 'all') return sql`1 = 1`

  const collaborator = inArray(
    ref.id,
    db
      .select({ id: taskCollaborators.taskId })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, actorUserId)),
  )
  if (scope === 'shared') {
    // `owner_user_id IS NULL`（系统发起 / 存量行）对 `<>` 不为真：只写 ne() 会把「我是
    // collaborator 的无主任务」从「与我共享」漏掉，而它明明在「我的任务」里（RFC-330 缺口 2）。
    return and(collaborator, or(isNull(ref.ownerUserId), ne(ref.ownerUserId, actorUserId)))!
  }
  return or(eq(ref.ownerUserId, actorUserId), collaborator)!
}

export function defaultTaskAuthorizationRef(): TaskAuthorizationRef {
  return { id: tasks.id, ownerUserId: tasks.ownerUserId }
}

/**
 * RFC-311 — batch twin of `canViewTask` for list/badge surfaces: one indexed
 * query per id chunk instead of one collaborator lookup per task (the shell
 * inbox badges ran that N+1 every 15s per open tab). Semantics are identical:
 * `canViewTask` = tasks:read:all ∨ owner=me ∨ collaborator (its SYSTEM branch
 * is a subset of owner=me), which is exactly `taskAuthorizationCondition`.
 * Ids with no task row are absent from the result, matching the callers'
 * existing "look up rows first, then filter" behavior — **including the
 * tasks:read:all branch**: it used to short-circuit by echoing the input ids
 * back, which made an admin's result include ids that do not exist while a
 * restricted actor's did not (实现门 P2-6:两个分支语义不同,而文档描述的是其中
 * 一个;当前调用方都先取行再过滤所以没发散,下一个调用方就会拿到 admin/非 admin
 * 计数不一致)。The admin branch now runs the same existence filter, minus the
 * authorization predicate.
 */
export async function visibleTaskIdsOf(
  db: DbClient,
  actor: Actor,
  taskIds: readonly string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const readsAll = actor.permissions.has('tasks:read:all')
  const rows = await chunkedAll(taskIds, (chunk) =>
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        readsAll
          ? inArray(tasks.id, chunk)
          : and(
              inArray(tasks.id, chunk),
              taskAuthorizationCondition(db, defaultTaskAuthorizationRef(), actor),
            ),
      ),
  )
  return new Set(rows.map((row) => row.id))
}
