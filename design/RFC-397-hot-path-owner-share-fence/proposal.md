# RFC-397 热路径写入改用共享 owner 围栏：事件追加不再推进 owner revision

- **状态**：Draft（2026-10-30 落档，待设计门与用户批准）
- **来由**：v0.19.3 候选 `b430c7754` 的主 CI（run 41052627131，后端 ubuntu 分片 33/36，job 124052183671）红在
  `scheduler-boundary-fanout-concurrency.test.ts` 的 PostgreSQL 用例「B: RFC-130 — writer shards each run in their OWN iso
  worktree…」。用户 2026-10-30 决定：先走 RFC 根治，再发 v0.19.3。
- **涉及**：RFC-359（双引擎事务与 owner 围栏统一）、RFC-370（托管执行与执行权）、RFC-395（数据库目标 schema）。本 RFC 只改
  `task-execution` 运行态 ownership 的围栏原语与它在热路径上的选用，不改所有权协议本身。

## 1. 背景

### 1.1 现象

PostgreSQL 上，一个扇出里的三个写分片并行运行时，第三个分片在准备隔离工作区时失败（`fanout shard iso setup failed`，
`Failed query: update "agent_workflow"."task_execution_owners" set "revision" = … + 1 …`），按「join 后全败」语义整个任务
`failed`。约 150 次主 CI 里这是第一次出现；同一份后端代码在此前三次 CI 中这条都通过。

本机用一次性 PostgreSQL 17 容器复现（8 路并行、每路 8 次只跑这一条用例）：

| 条件                                          | 失败 | 其中与 CI 同签名 | 服务端记录的错误                                                              |
| --------------------------------------------- | ---- | ---------------- | ----------------------------------------------------------------------------- |
| 现状                                          | 4/64 | 2                | 2316 次 `40001 could not serialize access due to concurrent update`，0 次死锁 |
| 仅把串行化重试上限临时改为 30（实验，未提交） | 0/64 | 0                | —                                                                             |

### 1.2 根因

1. owner 围栏（`assertTaskOwnerTx`，`modules/task-execution/infrastructure/ownedTaskExecution.ts`）是 owner 行上的条件
   UPDATE：命中当前 claimed owner 才放行，并把 `revision` 加 1。
2. 产品里最热的写路径——运行时事件追加 `appendEvents`（`nodeExecutionPersistence.ts`，agent 每吐一批输出就写一次）——每次都走
   这道围栏，于是同一任务的 owner 行在 agent 运行期间被持续更新。
3. 同一任务上另有一批写入跑在 SERIALIZABLE 事务里，并以同一道围栏开场：effect 的准备与结算
   （`taskExecutionEffectPersistence.ts`）、运行时会话租约（`runtimeSessionLeaseOperations.ts`）等。PostgreSQL 的
   SERIALIZABLE 在快照之后遇到被别人更新并提交的行，一律报 40001；owner 行正被事件追加高频更新，这些事务就几乎必然冲突。
4. 冲突靠 `retryPostgresqlSerialization` 吸收：最多 10 次、满抖动退避上限 16ms（RFC-349 钉住累计最坏 < 200ms，以守住证据
   套件单请求 1000ms 的门槛）。兄弟分片持续输出时，某一笔连败 10 次，错误原样抛出，分片失败。

SQLite 不受影响：`BEGIN IMMEDIATE` 全库独占，写入本来就串行。问题自 RFC-395 epoch 2 / RFC-370 v3 起存在于 PostgreSQL，
v0.19.2 不含这些代码。

### 1.3 为什么不是调大重试

调大重试上限只是把「连败 N 次」的概率压低，热点仍在：事件追加越密，SERIALIZABLE 写入越难拿到窗口；而且会抬高 RFC-349
为证据门槛钉住的退避上界。热点来自围栏的形状，不来自重试预算。

## 2. 目标

1. 事件追加这类**不改变所有权**、只需「确认 owner 仍有效」的高频写入，改用**共享围栏**：校验与今天相同的 owner 条件，持有
   owner 行的共享锁直到提交，**不推进 `revision`**。
2. 所有权语义不变：
   - 过期 token（owner、世代、epoch 或状态不符）的写入照旧被拒，错误码不变；
   - 接管、续约、释放、关停等改 owner 行的写手，照旧等待正在进行中的围栏写入提交后才能落下，之后旧 token 的写入被拒。
3. PostgreSQL 上，同一任务的 SERIALIZABLE 围栏写入不再因事件追加而得到 40001；扇出写分片在并发输出下不再因
   重试耗尽而失败。
4. SQLite 与 PostgreSQL 用同一套业务算法（RFC-294 G7）：共享围栏在 SQLite 上是同一条件的读校验（事务本已独占），在
   PostgreSQL 上是 `SELECT … FOR SHARE`。

## 3. 非目标

- 不改 owner 行的列、`revision` 的含义与所有现有 CAS（续约 / 接管 / 释放 / 关停 / 子任务生命周期 / effect 静默）。
- 不改任何事务的隔离级别；SERIALIZABLE 写入之间（effect、会话租约、所有权变更彼此）的冲突仍由现有重试吸收。
- 不改 `retryPostgresqlSerialization` 的预算与退避（RFC-349 的证据门槛不动）。
- 不处理本次压测中另见的两种低频失败（见 design §6），它们另行归因。

## 4. 用户可见变化

- PostgreSQL 部署（含 CrewStation 托管）：并行节点 / 扇出写分片在 agent 持续输出时，不再偶发以 `iso-setup-failed`、会话租约
  或 effect 记录写入失败而让任务失败。
- SQLite 单机部署：行为不变。
- 无 API、配置或数据迁移变化。

## 5. 验收标准

1. 共享围栏对过期 token 的拒绝与现有围栏逐项一致（owner、世代、epoch、状态四种不符），两种 provider 都有用例。
2. 共享围栏不推进 `revision`；改所有权的围栏照旧推进。
3. PostgreSQL：接管（改 owner 行）在共享围栏写入进行中时等待其提交，提交后旧 token 的下一次追加被拒；有确定性用例。
4. PostgreSQL：SERIALIZABLE 事务建快照后，同一任务的事件追加提交，再执行 owner 围栏——现状得到 40001，改后成功；有确定性
   回归用例，且把追加改回推进式围栏时该用例失败。
5. 本机 8×8 并行压测扇出写分片用例：0 次失败，服务端不再出现由事件追加引起的 40001（对比 §1.1 基线，数字写进 design）。
6. 钉住「每次写入都推进 revision」的既有用例按新语义逐条改写并说明理由；主 CI 全绿。
