// 任务可见性 / 归属范围谓词的**兼容出口**。
//
// RFC-357 之前这里是判据本身；现在判据的唯一实现在
// `taskListPage/authorization.ts`（provider 中立、按闭合的 viewer 投影而不是整个
// Actor 取值），这里只剩四个保持稳定的导出名，供尚未切换的 legacy 调用点使用
// （`services/taskAuthorization.ts` 转出给 `services/task.ts` 与工作组房间）。
//
// 为什么不是复制一份：这一页此前在两个 provider 上就是两份实现，漂出了三处用户可见的
// 缺陷（facets 数在 view 之后、origin 按 scheduled_task_id 猜、层级写死）。在同一个模块
// 里再留一份「长得一样的」授权谓词，是同一个错误的更小号版本。

import type { SQL, SQLWrapper } from 'drizzle-orm'
import { and, inArray } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import { tasks } from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'
import {
  defaultTaskListRowRef,
  taskListOwnershipScopeCondition,
  taskListViewerOf,
  taskListVisibilityCondition,
  type TaskListOwnershipScope,
  type TaskListRowRef,
} from './taskListPage/authorization'
import type { TaskListPageDb } from './taskListPage/db'

/** SQLite-only predicate compatibility while callers move to closed ports. */
export interface LegacySqliteTaskAuthorizationRef extends TaskListRowRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
}

export type LegacyTaskOwnershipScope = TaskListOwnershipScope

export function legacySqliteTaskAuthorizationCondition(
  db: TaskListPageDb,
  ref: LegacySqliteTaskAuthorizationRef,
  actor: Actor,
): SQL<unknown> {
  return taskListVisibilityCondition(db, ref, taskListViewerOf(actor))
}

export function legacySqliteTaskOwnershipScopeCondition(
  db: TaskListPageDb,
  ref: LegacySqliteTaskAuthorizationRef,
  actorUserId: string,
  scope: LegacyTaskOwnershipScope,
): SQL<unknown> {
  return taskListOwnershipScopeCondition(db, ref, actorUserId, scope)
}

export function legacySqliteDefaultTaskAuthorizationRef(): LegacySqliteTaskAuthorizationRef {
  return defaultTaskListRowRef()
}

export async function legacySqliteVisibleTaskIdsOf(
  db: TaskListPageDb,
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
              legacySqliteTaskAuthorizationCondition(
                db,
                legacySqliteDefaultTaskAuthorizationRef(),
                actor,
              ),
            ),
      ),
  )
  return new Set(rows.map((row) => row.id))
}
