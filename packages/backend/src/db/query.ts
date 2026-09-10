// Platform persistence query vocabulary used by transitional bounded-context
// application code. Keeping the ORM constructors behind this platform edge
// avoids coupling application modules to the transport package while RFC-294
// W2 moves the remaining row projections into infrastructure adapters.
export { and, desc, eq, inArray, ne } from 'drizzle-orm'

import { and, eq, inArray, or, type Placeholder, type SQL, type SQLWrapper } from 'drizzle-orm'
import { chunkedAll } from '@/util/sqlChunk'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { taskCollaborators, tasks } from './schema'
import type * as schema from './schema'

/**
 * RFC-357 —— 两个 provider 客户端的公共基类型。
 *
 * `DbClient`（bun:sqlite，同步）与 `PostgresqlDatabaseClient`（remote，异步，实际上是
 * drizzle 的 sqlite-proxy）都可赋值给它，于是同一段 query builder / `db.all(sql)` 在
 * `await` 之后两边行为一致。先例见 RFC-350 的 `taskIdleTimeoutPersistence.ts`。
 *
 * 放在这条平台词汇线上而不是某个模块里：它是**持久化的词汇**，不是谁的领域概念；
 * 定义在模块内会让每个跨模块使用者都记一条「legacy 指向模块内部」的越界边。
 */
export type ProviderNeutralDatabase = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>

export type ProviderNeutralDatabaseForMode<TMode extends 'sync' | 'async'> = BaseSQLiteDatabase<
  TMode,
  unknown,
  typeof schema
>

// ---------------------------------------------------------------------------
// 任务可见性判据（RFC-359 AC-11）
// ---------------------------------------------------------------------------
//
// 它按本文件头注的同一条理由放在这里：操作的 `tasks` / `task_collaborators` 是 schema 的
// **共享表**，消费方（评审徽标等）本来就在 join `tasks`——这是**持久化词汇**，不是谁的
// 领域概念；定义在模块内会让每个跨模块使用者记一条越界边。
//
// 曾试过导出在 `modules/task-execution/public/queries.ts` 上，被 RFC-294 N1b 的
// 「公共面不透明类型」判据拒了，而且**拒得对**：drizzle 的 `SQL` 是库内部类型，写进
// bounded context 的公共合同等于让消费方隔着合同耦合到 drizzle 的类型面。
//
// **为什么需要片段形态**：`taskAuthorization.visibleIds` 的姿势是「先把 taskId 列表捞出来、
// 再问一次可见性」——那是一次往返。SQLite 上是进程内调用（~0μs），PostgreSQL 上是一次真实
// RTT。徽标类轻端点的 P95 差值几乎全部来自往返次数（实测 `reviews/pending-count`
// SQLite 1.80ms / PG 7.33ms，差值 ≈ 3 × RTT 且不随行数放大）。拿到片段的调用方可以把它
// AND 进自己那一条语句，把那次往返省掉。`visibleIds` 也调这一个函数，两条路不可能漂。

/**
 * 读侧句柄：只需要 `select`——库、事务、以及只暴露读面的窄类型都能传进来
 * （判据只读，不关心事务边界）。
 */
export type TaskVisibilityReader = Pick<ProviderNeutralDatabase, 'select'>

/**
 * 请求者的闭合投影。判据只认这两件事，不认整个 `Actor`。
 *
 * `userId` 允许是 `Placeholder`：`taskOverviewQuery` 把这条判据编进**预编译模板**
 * （每次调用只换绑定值，不重新编译 SQL）。不放宽这一处，那边就只能自己再抄一份判据——
 * 而它正是首页计数的口径，抄一份就等于给「概览和列表对不上」留了一条无人看守的路。
 */
export interface TaskVisibilitySubject {
  readonly userId: string | Placeholder
  readonly canReadAllTasks: boolean
}

/**
 * `Actor` → 判据认识的闭合投影。**结构化取值**，不 import identity-access 的 `Actor`：
 * 这条平台词汇线不该知道谁是「演员」，只需要「哪个用户」「能不能看全部」。
 */
export function taskVisibilitySubjectOf(actor: {
  readonly user: { readonly id: string }
  readonly permissions: ReadonlySet<string>
}): TaskVisibilitySubject {
  return { userId: actor.user.id, canReadAllTasks: actor.permissions.has('tasks:read:all') }
}

/**
 * 判据作用的那一行。缺省是 `tasks` 本身；列表页的联表查询要对**别名列**求值，
 * 所以留成参数（RFC-357 `taskListPage/authorization.ts` 就是这个用法）。
 */
export interface TaskVisibilityRowRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
}

export function defaultTaskVisibilityRowRef(): TaskVisibilityRowRef {
  return { id: tasks.id, ownerUserId: tasks.ownerUserId }
}

/** 「我参与的任务 id」子查询。判据与它的分块版本共用同一份，两条路不可能漂。 */
export function taskCollaboratorTaskIds(db: TaskVisibilityReader, userId: string | Placeholder) {
  return db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, userId))
}

/**
 * 给「已经 join 了 `tasks`」的查询用的可见性条件：owner 是本人，或本人在
 * `task_collaborators` 里。`canReadAllTasks` 为真时返回 `undefined`（无需收窄），
 * 可以直接交给 `and(...)`。
 *
 * **仓里唯一的一份**。此前这条 `or(owner = me, id IN (我参与的))` 在六处逐字重复：
 * 本文件、`taskListPage/authorization.ts`、`collaborationTaskAccess.ts`、
 * `reviewTaskAccess.ts`、`taskOverviewQuery.ts`、`postgresqlTaskRouteOperations.ts`。
 * 它是**授权判据**——任何一处漂了，用户要么看见不该看见的任务，要么丢掉本该看见的，
 * 而六处里有一处还是 provider 专属的（那正是本 RFC 要消灭的形状）。
 */
export function taskVisibilityCondition(
  db: TaskVisibilityReader,
  subject: TaskVisibilitySubject,
  ref: TaskVisibilityRowRef = defaultTaskVisibilityRowRef(),
): SQL | undefined {
  if (subject.canReadAllTasks) return undefined
  return or(
    eq(ref.ownerUserId, subject.userId),
    inArray(ref.id, taskCollaboratorTaskIds(db, subject.userId)),
  )
}

/**
 * 「这些 taskId 里，哪些**存在且**对该请求者可见」。
 *
 * 存在性过滤是语义的一部分：不存在的 id 不会出现在结果里，`tasks:read:all` 也一样
 * （`rfc311-badge-counts` 的 `visibleTaskIdsOf drops unknown ids for every actor` 钉着这条）。
 *
 * **仓里唯一的一份**。此前四处各写一遍同一个「按 500 分块 + 逐块查存在性与可见性」的循环，
 * 其中 `collaborationTaskAccess.ts` 与 `reviewTaskAccess.ts` 的两份**逐字相同**、还各自把
 * 分块大小硬写成字面量 500（`util/sqlChunk.ts` 的 `SQL_IN_CHUNK` 就是这个数，它存在的理由
 * 正是「别把某个具体数字写进判据」）。
 */
export async function visibleTaskIdsFor(
  db: TaskVisibilityReader,
  subject: TaskVisibilitySubject,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (taskIds.length === 0) return new Set()
  const visibility = taskVisibilityCondition(db, subject)
  const rows = await chunkedAll([...new Set(taskIds)], (chunk) =>
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        visibility === undefined
          ? inArray(tasks.id, chunk)
          : and(inArray(tasks.id, chunk), visibility),
      ),
  )
  return new Set(rows.map((row) => row.id))
}
