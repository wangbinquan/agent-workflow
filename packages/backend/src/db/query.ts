// Platform persistence query vocabulary used by transitional bounded-context
// application code. Keeping the ORM constructors behind this platform edge
// avoids coupling application modules to the transport package while RFC-294
// W2 moves the remaining row projections into infrastructure adapters.
export { and, desc, eq, inArray, ne } from 'drizzle-orm'

import { eq, inArray, or, type SQL } from 'drizzle-orm'
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

export interface TaskVisibilitySubject {
  readonly userId: string
  readonly canReadAllTasks: boolean
}

/**
 * 给「已经 join 了 `tasks`」的查询用的可见性条件：owner 是本人，或本人在
 * `task_collaborators` 里。`canReadAllTasks` 为真时返回 `undefined`（无需收窄），
 * 可以直接交给 `and(...)`。
 */
export function taskVisibilityCondition(
  db: TaskVisibilityReader,
  subject: TaskVisibilitySubject,
): SQL | undefined {
  if (subject.canReadAllTasks) return undefined
  const collaboratorIds = db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, subject.userId))
  return or(eq(tasks.ownerUserId, subject.userId), inArray(tasks.id, collaboratorIds))
}
