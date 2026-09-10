// 任务可见性判据的 **SQL 片段**形态——共享持久化词汇，不是跨上下文合同。
//
// 为什么放在 `db/` 而不是 task-execution 的 public 面
// -------------------------------------------------
// 最初把它导出在 `modules/task-execution/public/queries.ts` 上，被 RFC-294 N1b 的
// 「公共面不透明类型」判据拒了，而且**拒得对**：drizzle 的 `SQL` 是库内部类型，把它写进
// bounded context 的公共合同，等于让消费方隔着合同耦合到 drizzle 的类型面上；RFC-294 要求
// 公共合同是 exact 的。
//
// 而这个片段本身操作的 `tasks` / `task_collaborators` 都是 `db/schema.ts` 的**共享表**，
// 消费方（评审徽标等）本来就在 join `tasks`。所以它属于**和 schema 同一层的共享查询词汇**，
// 与「谁拥有可见性规则」是两件事：规则的**唯一定义**仍在这里，
// `modules/task-execution/infrastructure/taskAuthorization.ts` 的 `visibleIds` 也调它，
// 两条路由同一份代码派生，不可能漂。
//
// 为什么需要片段形态（RFC-359 AC-11）
// ---------------------------------
// `visibleIds` 的调用姿势是「先把 taskId 列表捞出来，再问一次可见性」——那是一次往返。
// 在 SQLite 上是进程内调用（~0μs），在 PostgreSQL 上是一次真实 RTT。徽标类轻端点的
// P95 差值几乎全部来自往返次数（实测 `reviews/pending-count` SQLite 1.80ms / PG 7.33ms，
// 差值 ≈ 3 × RTT 且不随行数放大）。拿到片段的调用方可以把它 AND 进自己那一条语句，
// 把那次往返省掉。
import { eq, inArray, or, type SQL } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks } from '@/db/schema'

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
