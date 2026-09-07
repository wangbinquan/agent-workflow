// RFC-349 — PostgreSQL task lifecycle primitives used only by named
// task-execution atoms. They are named after the provider because their
// *judgement* is PostgreSQL-shaped (SERIALIZABLE budgets, aggregate-root row
// locks); the transaction boundary and the lock rendering are both neutral.
//
// RFC-359 W5-T18：这几个开事务的地方原本直接调驱动的 `db.transaction(`，是账本里的裸事务。
// 它们现在一律走 `databaseSessionFor(db)` 的中立会话。两件事因此变了，都是修复：
//   · **可重入**——裸的 PG `db.transaction(` 会在**另一条连接**上另开一笔并独立提交，外层
//     回滚带不走它（本波实撞：外层回滚后 SQLite 侧 0 行、PG 侧 1 行）。中立会话按客户端认
//     AsyncLocalStorage 帧，嵌套时复用外层事务句柄，于是内层的写随外层一起回滚。
//   · **失败回滚**——体内抛错整笔回滚的语义由原语统一保证，两个引擎相同。
// 隔离级别与行锁的判断没有变：serializable 走的正是本文件当年那段
// 「SET TRANSACTION ISOLATION LEVEL SERIALIZABLE + 40001/40P01 退避重试」——
// `platform/persistence/databaseTransaction.ts` 的 `serializable` 显式记着它以本文件为蓝本。

import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'

// RFC-359 W7：这个别名以前借道 `platform/events/committed/postgresqlPersistence.ts`——那个文件
// 是已提交事件出站存储的 PG 适配器，与本别名毫无关系，只是当年顺手把 PG 客户端的事务句柄类型
// 定义在了那里。出站存储合一后该文件整个删除。
//
// RFC-359 W5-T18：它不再从 PG 客户端的 `transaction` 签名里挖，而**就是**中立事务句柄
// `DatabaseTransaction`——事务由中立会话开出，交给 body 的本来就是那一个。别名留着是因为
// 这几个 atom 的调用点还叫这个名字；语义上它已经没有 provider 私有面了。
export type PostgresqlTaskExecutionTransaction = DatabaseTransaction

export async function withPostgresqlSerializableTaskExecution<T>(
  db: PostgresqlDatabaseClient,
  body: (tx: PostgresqlTaskExecutionTransaction) => Promise<T>,
): Promise<T> {
  return await databaseSessionFor(db).serializable(body)
}

// RFC-359 W11 退役：`withPostgresqlNodeRunAggregateTransaction` 与
// `lockPostgresqlNodeRunAggregateRoot` 已删除。它们是 RFC-349 给 node run 写事务开的那一对
// （非 SERIALIZABLE 的事务边界 + `node_runs` 行的聚合根锁）；**W4-B1 把两份 provider 投影合成
// `nodeExecutionPersistence.ts` 一份**之后，那条路走的是 `withTaskExecutionWrite` + 能力矩阵的
// `lockAggregateRoot`，这两个导出从此**零生产调用方**——`packages/backend/src` 下一处 import
// 都没有，唯一的引用来自两份测试。删除而不是「改调 capabilities」：改调只会凭空给一段死代码
// 续命（同一个错误 RFC-359 W10 在 `runPostgresqlResourceCatalogTransaction` 上刚犯过一次，
// 见 W5-T20 账本里那段更正）。
//
// 「为什么当年要有它」这段实测数据没有丢：`withTaskExecutionWrite` 那一侧与
// `tests/rfc349-task-aggregate-transaction.test.ts` 的第二个 describe 头注释各留一份
// （小表上 SERIALIZABLE 的 predicate lock 落到索引**页**：8 并发满速冲突率 81.2%、逃逸 234；
// 换成聚合根行锁后 0% / 0 / 904 ops/s）。判「零生产消费者」时**要把测试排除在消费者之外**。

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
 * （跨表计数、全局唯一性）仍然必须留在 `withPostgresqlSerializableTaskExecution` 上。
 *
 * 任务行不存在时不取锁：调用方自己的 NotFound 判据仍然成立（没有行就没有要保护的聚合）。
 */
export async function withPostgresqlTaskAggregateTransaction<T>(
  db: PostgresqlDatabaseClient,
  taskId: string,
  body: (tx: PostgresqlTaskExecutionTransaction) => Promise<T>,
): Promise<T> {
  return await databaseSessionFor(db).transaction(async (tx) => {
    // RFC-359 W11：行锁的渲染权归能力矩阵——PG 渲染 `select 1 … for update`，SQLite 是
    // no-op（`BEGIN IMMEDIATE` 已全库独占）。此前这里裸写 `for update`，于是同一个聚合根锁
    // 在仓里有两份渲染，改矩阵不会红这里；顺带它也让这个 opener 在 SQLite 上直接语法错误。
    await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)
    return await body(tx)
  })
}
