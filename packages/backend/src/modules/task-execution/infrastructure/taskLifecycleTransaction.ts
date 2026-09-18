// RFC-359 AC-1（命名债收尾 §5hj）—— 任务执行写事务的**中立**原语。
//
// 它从 `postgresqlTaskLifecycleTransaction.ts` 拆出来：那个文件里两样东西的归属不同，
// 而一个文件只能有一个名字。
//   · 这里的 `withSerializableTaskExecution` / `TaskExecutionTransaction` —— **中立**，
//     两个引擎的写路径（含共用的取消 / 启动 / 修复实现）都在跑它；
//   · 留在原文件的 `withPostgresqlTaskAggregateTransaction` —— **真的只服务 PostgreSQL**
//     （聚合根 `for update` 行锁，SQLite 在 `BEGIN IMMEDIATE` 下无此概念）。
// 拆开之后两个文件的名字都说真话：中立的不再挂 `postgresql` 前缀，PG 专属的继续挂着。
//
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

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'

// RFC-359 W7：这个别名以前借道 `platform/events/committed/postgresqlPersistence.ts`——那个文件
// 是已提交事件出站存储的 PG 适配器，与本别名毫无关系，只是当年顺手把 PG 客户端的事务句柄类型
// 定义在了那里。出站存储合一后该文件整个删除。
//
// RFC-359 W5-T18：它不再从 PG 客户端的 `transaction` 签名里挖，而**就是**中立事务句柄
// `DatabaseTransaction`——事务由中立会话开出，交给 body 的本来就是那一个。别名留着是因为
// 这几个 atom 的调用点还叫这个名字；语义上它已经没有 provider 私有面了。
export type TaskExecutionTransaction = DatabaseTransaction

/**
 * RFC-359 AC-1（plan §5gw）：名字去掉 `Postgresql` 前缀——**它没有孪生，前缀纯属历史**。
 *
 * 它**从来就只是一层转交**——函数体就是 `databaseSessionFor(db).serializable(body)`，
 * 而 `databaseSessionFor` 本身按引擎派发：PostgreSQL 侧渲染
 * `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` 并在序列化失败时重放整笔；
 * SQLite 侧是 `serializable: transaction`（`BEGIN IMMEDIATE` 下整库独占，已是最强隔离）。
 * 也就是说**两个引擎早就都实现了它**，只有这个名字和形参还钉在 PostgreSQL 上。
 *
 * 保留这层薄包装而不是把 18 个调用点改成 `databaseSessionFor(x).serializable(…)`：
 * 名字本身在表达「任务执行写事务用可串行化语义」这条意图，摊平会把意图摊没。
 *
 * **形参已放宽到中立句柄**（RFC-359 plan §5gz）。§5gw 当时刻意没放，理由是「现在没有调用方需要」；
 * 启动面合一开工后**有了**——SQLite 侧要把自己的库传进同一台启动内核，这条
 * `@/db/query` 的跨 context import 于是是被需求逼出来的，不再是预支。
 */
export async function withSerializableTaskExecution<T>(
  db: ProviderNeutralDatabase,
  body: (tx: TaskExecutionTransaction) => Promise<T>,
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
