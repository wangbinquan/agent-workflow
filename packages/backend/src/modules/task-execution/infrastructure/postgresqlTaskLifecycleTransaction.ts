// RFC-359 —— PostgreSQL 专属的任务聚合写事务。
//
// RFC-359 AC-1（命名债收尾 §5hj）：中立的那两样（`withSerializableTaskExecution` /
// `TaskExecutionTransaction`）已拆到同目录的 `taskLifecycleTransaction.ts`。
// 留在这里的是**真的只服务 PostgreSQL** 的那一个：聚合根 `for update` 行锁。
// 本文件因此继续、也应当继续挂 `postgresql` 前缀。
//
// plan §5hn 的裁决仍然有效：`withPostgresqlTaskAggregateTransaction` 生产调用方已归零，
// **不删**——两个测试文件仍用它锁方言行为，且它的函数体就是这条技术的锁定参照。

import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'

import type { TaskExecutionTransaction } from './taskLifecycleTransaction'

/**
 * RFC-349 —— 单聚合的「读—改—写」事务：不走 SERIALIZABLE，改为在聚合根（task 行）上
 * 取排他行锁。
 *
 * 为什么换：SERIALIZABLE 对「先按 task_id 读一遍、再 delete 同一批、再 insert 回去」这种
 * 形状会大量误判。predicate lock 的粒度是**索引页**而不是行，于是两个改**不同任务**的事务
 * 只要 btree 页相邻就互判读写依赖。2026-09-03 对着真 PostgreSQL 的合成实验（10 万行、
 * 32 并发、逐项排除）：
 *
 *   基线（SERIALIZABLE）                       冲突率 22.9%
 *   去掉 generation fence 那次读                    23.1%   ← 不是 fence
 *   读改成整主键精确命中                            22.7%   ← 不是读的形状
 *   删掉 user 索引 / 每个任务换不同 user      22.5% / 22.7%  ← 不是热点用户
 *   去掉 insert（只 delete）                         0%     ← 冲突来自 delete+insert 这一对
 *   **READ COMMITTED + 聚合根 FOR UPDATE**           0.0%
 *
 * 而重试预算填不平这件事：取证门同时要求 `httpErrors === 0` 与单请求 < 1000ms，加重试只会
 * 把尾延迟推高（托管 2 核上已经量到 `API max 1066.8ms`）。
 *
 * 为什么安全：这条路径的不变量本来就是**每任务**的——它读的 `tasks.owner_user_id` 与
 * `task_collaborators` 都属于同一个任务，锁住任务行就把同一任务的并发写手串起来了，
 * 而不同任务之间本来就没有需要串行化的不变量。**只有满足这个条件的路径才可以用它**：
 * 事务读写的行全部属于同一个聚合根，且判据不依赖聚合之外的快照。跨聚合的不变量
 * （跨表计数、全局唯一性）仍然必须留在 `withSerializableTaskExecution` 上。
 *
 * 任务行不存在时不取锁：调用方自己的 NotFound 判据仍然成立（没有行就没有要保护的聚合）。
 */
export async function withPostgresqlTaskAggregateTransaction<T>(
  db: PostgresqlDatabaseClient,
  taskId: string,
  body: (tx: TaskExecutionTransaction) => Promise<T>,
): Promise<T> {
  return await databaseSessionFor(db).transaction(async (tx) => {
    // RFC-359 W11：行锁的渲染权归能力矩阵——PG 渲染 `select 1 … for update`，SQLite 是
    // no-op（`BEGIN IMMEDIATE` 已全库独占）。此前这里裸写 `for update`，于是同一个聚合根锁
    // 在仓里有两份渲染，改矩阵不会红这里；顺带它也让这个 opener 在 SQLite 上直接语法错误。
    await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)
    return await body(tx)
  })
}
