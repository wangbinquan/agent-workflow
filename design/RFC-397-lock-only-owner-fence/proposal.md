# RFC-397 数据写围栏只加锁：owner 行只在所有权变更与任务状态迁移时改写

- **状态**：Draft（2026-10-30 落档；设计门第 1 轮 FAIL 后按用户决定扩大范围重写，待第 2 轮设计门与用户批准）
- **来由**：v0.19.3 候选 `b430c7754` 的主 CI（run 41052627131，后端 ubuntu 分片 33/36，job 124052183671）红在
  `scheduler-boundary-fanout-concurrency.test.ts` 的 PostgreSQL 用例「B: RFC-130 — writer shards each run in their OWN iso
  worktree…」。用户 2026-10-30 决定先走 RFC 根治再发 v0.19.3，并在第 1 轮设计门后选定本 RFC 的范围（§6）。
- **修订**：RFC-328 §8.1「线性化 SQL」与 `revision` 的定义（「每次 fence/heartbeat/state mutation 单调推进」，
  `design/RFC-328-durable-task-execution-ownership-fence/design.md:339, 588-604`）中关于**普通数据写入**的部分。

## 1. 背景

### 1.1 现象

PostgreSQL 上，一个扇出里的三个写分片并行运行，第三个分片准备隔离工作区时失败（`fanout shard iso setup failed`，
`Failed query: update "agent_workflow"."task_execution_owners" set "revision" = … + 1 …`），按「join 后全败」语义整个任务
`failed`。约 150 次主 CI 里这是第一次出现；同一份后端代码在此前三次 CI 中这条都通过。机制在 v0.19.2 已经存在
（owner 条件 UPDATE、数据写入经它围栏、SERIALIZABLE 的 effect 事务以它开场，都在 `643d64db6` 中），这一次是首次观察到失败。

### 1.2 根因（本机实测）

一次性 PostgreSQL 17 容器，8 路并行、每路只跑这一条用例：

1. **失败率**：4/64 次失败（其中 2 次与 CI 同签名），服务端记录 2316 次
   `40001 could not serialize access due to concurrent update`，0 次死锁。
2. **谁在改写 owner 行**（语句日志按事务分组，32 次运行）：每一次普通数据写入都以 owner 行上的条件 UPDATE 开场，把 `revision`
   加 1、改写 `updated_at`。按事务所写的表归类：

   | 事务类别                                                       | 改写 owner 行次数 |
   | -------------------------------------------------------------- | ----------------- |
   | node run 铸造与生命周期（`node_runs`、配置、输入、选择、序号） | 765               |
   | effect 准备 / 结算（SERIALIZABLE）                             | 697               |
   | node run 运行态（merge 状态、仓库 checkpoint）                 | 391               |
   | node run 产出                                                  | 158               |
   | 任务级（任务状态与提交事件）                                   | 96                |
   | 运行时事件追加                                                 | 95                |

3. **谁失败**：全部 1118 次 40001 都落在 SERIALIZABLE 事务的第一条语句——owner 围栏。PostgreSQL 的 SERIALIZABLE 在快照之后
   遇到被别人**改写**并提交的行，一律报 40001；owner 行被同一任务的每一笔数据写入改写，SERIALIZABLE 写入（effect、会话
   租约、进程登记）就不断冲突，10 次重试（`retryPostgresqlSerialization`，退避 ≤16ms）被耗尽后错误原样抛出。

SQLite 不受影响：`BEGIN IMMEDIATE` 全库独占，写入本来就串行。

### 1.3 为什么改围栏而不是调重试

- 把重试上限临时改为 30：0/64（实验，未提交）。但热点仍在，只是更难连败；并会突破 RFC-349 为证据门槛钉住的退避上界。
- 把通用数据写围栏临时改为只加锁（`SELECT … FOR UPDATE` 校验同一条件，不改写 owner 行）：**0/64，0 次 40001**；owner 行
  上的 UPDATE 由 32 次运行约 3400 次（含失败重试）降为 64 次运行共 64 次（实验，未提交）。
- 代码里给出的围栏理由本来就是行锁：「行锁已把同一任务的写手串起来」（`ownedTaskExecution.ts:5-6`）。只加锁保留这把排他
  锁，去掉的只是行版本改写。

## 2. 目标

1. 普通数据写入（经 `assertTaskOwnerTx` / `fenceTaskWrite` 的全部写手，含 SERIALIZABLE 的 effect、会话租约、进程登记）的
   owner 围栏改为**只加锁**：校验与今天相同的条件，取得 owner 行排他锁直到提交，不改写该行（`revision`、`updated_at` 都不动）。
2. owner 行只由**所有权变更**（claim、心跳、撤权、取消撤权、标记需恢复、关停标记、释放、恢复后释放、outcome-unknown 释放）
   与**任务状态迁移**（`withOwnedTaskWrite`）改写，这些路径不变。
3. 互斥不变：同一任务的数据写入仍在 owner 行上串行；改写 owner 行的路径仍等在途数据写入提交；owner 元组、epoch 或有效状态
   变更之后，旧 token 的写入照旧以 `task-execution-stale-owner` 被拒。
4. PostgreSQL 上，同一任务的 SERIALIZABLE 写入不再因普通数据写入得到 40001；扇出写分片不再因此失败。
5. SQLite 与 PostgreSQL 同一算法（RFC-294 G7）：只加锁在 SQLite 上退化为同一条件的读校验（事务本已独占）。

## 3. 非目标

- 不改所有权变更与任务状态迁移的写法，不改 owner 表结构，不改任何事务的隔离级别。
- 不改 `retryPostgresqlSerialization` 的预算与退避（RFC-349 证据门槛不动）。
- 不处理调研中另见的问题（design §7）。

## 4. 行为变化

- **PostgreSQL 部署（含 CrewStation 托管）**：并行节点 / 扇出写分片不再偶发以 `iso-setup-failed`、effect 或会话租约写入失败
  让任务失败。
- **`revision` 的含义**：从「每次围栏写入都推进」变为「只在所有权变更与任务状态迁移时推进」；`updated_at` 同步。两种 provider 都
  如此。API、shared schema、前端都不暴露这两列。
- **依赖 revision 的 CAS**：停止证明、`releaseAfterStop`、outcome-unknown 释放、精确撤权、取消撤权、标记需恢复、关停标记等带
  预期 revision 的比较，不再因仍持有所有权的 owner 自己的数据写入而失配；仍因所有权变更与任务状态迁移而失配（design §3）。
- 无 API、配置或数据迁移变化。

## 5. 验收标准

1. 只加锁的围栏对四种过期 token（owner、世代、epoch、状态不符）的拒绝与现有一致，两种 provider。
2. 普通数据写入之后 `revision` 与 `updated_at` 不变；所有权变更与任务状态迁移之后照旧推进。
3. PostgreSQL：真实写手的事务在途时（经外层事务帧挂住），撤权 / 心跳等改写 owner 行的操作等待其提交；撤权之后旧 token 的下一次
   写入被拒。
4. PostgreSQL：SERIALIZABLE 事务**不经重试包装**取快照，同任务的普通数据写入在另一连接提交，再在该事务里执行 owner 围栏——
   **首次尝试**即成功。变异检查：围栏换回改写式，该用例以 40001 失败。
5. 停止证明（两种 provider）：证明形成后同任务的数据写入提交，静默结算与释放照常成功；证明形成后发生心跳或任务状态迁移，旧证明
   照旧失效。
6. 本机 8×8 并行压测扇出写分片用例：0 次失败、0 次 40001（对比 §1.2 基线）。
7. 钉住「每次围栏都推进 revision」的既有用例、SQL 形状断言、变异夹具与源码账本按新语义逐条更新并说明；主 CI 全绿。

## 6. 已作出的取舍

1. **范围**（用户 2026-10-30 在第 1 轮设计门后选定）：所有数据写围栏只加锁，而不是只改两处事件追加（数据表明追加只占改写次数的
   约 3%，修不好这次失败），也不是进程内按任务串行。
2. **锁模式**：`FOR UPDATE`（排他），与今天的互斥完全一致；不用 `FOR SHARE`，避免共享锁的升级死锁形态与 MultiXact。
3. **任务状态迁移保留改写**：`withOwnedTaskWrite` 依赖 revision 前进构造 `OwnedTaskTx`，且频率低（每次运行约 3 次），不在本 RFC
   内改动。
