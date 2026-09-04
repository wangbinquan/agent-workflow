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

import { taskCollaborators, tasks } from '@/db/schema'
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
  return { id: tasks.id, ownerUserId: tasks.ownerUserId }
}

function collaboratorTaskIds(db: TaskListPageDb, userId: string) {
  return db
    .select({ id: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, userId))
}

/** 「这一行对该请求者可见吗」。全可见权限直接放行。 */
export function taskListVisibilityCondition(
  db: TaskListPageDb,
  ref: TaskListRowRef,
  viewer: TaskListViewer,
): SQL<unknown> {
  if (viewer.canReadAllTasks) return sql`1 = 1`
  return or(
    eq(ref.ownerUserId, viewer.userId),
    inArray(ref.id, collaboratorTaskIds(db, viewer.userId)),
  )!
}

/** 用户显式选择的归属范围（全部 / 我的 / 共享给我的），与可见性正交。 */
export function taskListOwnershipScopeCondition(
  db: TaskListPageDb,
  ref: TaskListRowRef,
  actorUserId: string,
  scope: TaskListOwnershipScope,
): SQL<unknown> {
  if (scope === 'all') return sql`1 = 1`
  const collaborator = inArray(ref.id, collaboratorTaskIds(db, actorUserId))
  if (scope === 'shared') {
    return and(collaborator, or(isNull(ref.ownerUserId), ne(ref.ownerUserId, actorUserId)))!
  }
  return or(eq(ref.ownerUserId, actorUserId), collaborator)!
}
