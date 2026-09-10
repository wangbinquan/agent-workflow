// RFC-357 —— 列表页的可见性与 scope 谓词，provider 中立。
//
// 平移自 `infrastructure/legacySqliteTaskAuthorization.ts` 的同名判据，**逐字不变**，
// 只把参数类型从 `DbClient` 放宽到两个 provider 的公共基类型（`TaskListPageDb`）——
// 子查询由 drizzle query builder 构造，两侧渲染出的 SQL 相同。
//
// `shared` 那一支的写法值得留一句：判据是「我是协作者，且我不是属主」，而
// `ne(ownerUserId, me)` 在 `owner_user_id IS NULL` 时是 NULL 而不是真（SQL 三值逻辑），
// 所以必须并上 `isNull(...)` 才能把「无主但我是协作者」的行收进来。PostgreSQL 侧
// `/api/tasks` 用的 `visibilityCondition` 写的是等价的 `IS DISTINCT FROM`。三态
// （owner=我 / owner=别人 / owner IS NULL）由 `rfc357-task-list-authorization` 钉住。

import { and, eq, inArray, isNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import {
  defaultTaskVisibilityRowRef,
  taskCollaboratorTaskIds,
  taskVisibilityCondition,
} from '@/db/query'
import type { TaskListPageDb } from './db'

/** 谓词作用的那一行：可以是 `tasks` 本身，也可以是查询里的别名列。 */
export interface TaskListRowRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
}

export type TaskListOwnershipScope = 'all' | 'mine' | 'shared'

/** 请求者的闭合投影——判据只认这两件事，不认整个 Actor。
 *  刻意不叫 `subject`：shared 的 `TaskListSubject` 是**筛选项**（agent / workflow /
 *  workgroup），同名会在解析函数里正面撞车。 */
export interface TaskListViewer {
  readonly userId: string
  readonly canReadAllTasks: boolean
}

/** Actor → 判据认识的闭合投影。列表页不把整个 Actor 交给 SQL 构造。 */
export function taskListViewerOf(actor: {
  readonly user: { readonly id: string }
  readonly permissions: ReadonlySet<string>
}): TaskListViewer {
  return { userId: actor.user.id, canReadAllTasks: actor.permissions.has('tasks:read:all') }
}

export function defaultTaskListRowRef(): TaskListRowRef {
  return defaultTaskVisibilityRowRef()
}

/**
 * 「这一行对该请求者可见吗」。全可见权限直接放行。
 *
 * RFC-359 W57：判据本身来自 `db/query.ts` 的**唯一一份**（此前这里是仓里六处逐字重复之一）。
 * 这一层只做两件本页特有的事：把「无需收窄」的 `undefined` 渲染成 `1 = 1`（本页的调用方要的是
 * 恒真条件，不是可选值），以及保留本模块的 `ref` / `viewer` 命名。
 */
export function taskListVisibilityCondition(
  db: TaskListPageDb,
  ref: TaskListRowRef,
  viewer: TaskListViewer,
): SQL<unknown> {
  return taskVisibilityCondition(db, viewer, ref) ?? sql`1 = 1`
}

/** 用户显式选择的归属范围（全部 / 我的 / 共享给我的），与可见性正交。 */
export function taskListOwnershipScopeCondition(
  db: TaskListPageDb,
  ref: TaskListRowRef,
  actorUserId: string,
  scope: TaskListOwnershipScope,
): SQL<unknown> {
  if (scope === 'all') return sql`1 = 1`
  // 协作者子查询取共享的那一份（与可见性判据同源，两条路不可能漂）。
  const collaborator = inArray(ref.id, taskCollaboratorTaskIds(db, actorUserId))
  if (scope === 'shared') {
    return and(collaborator, or(isNull(ref.ownerUserId), ne(ref.ownerUserId, actorUserId)))!
  }
  // `mine` 与可见性判据**今天恰好等价**，但它们是两个概念（一个是「我要看哪一档」，
  // 一个是「我能不能看」）。刻意不合并：可见性哪天扩了（例如加上工作组成员），
  // `mine` 不应该跟着扩。
  return or(eq(ref.ownerUserId, actorUserId), collaborator)!
}
