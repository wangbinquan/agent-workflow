# RFC-397 以 owner 围栏开场的 SERIALIZABLE 数据写入降为 READ COMMITTED

- **状态**：Done（2026-10-31，随 v0.19.3 发布）：实现 `ee10efc6a`；发布提交 `d7b5d9da6` 主 CI 62/62（run 41157876045）；集中验证与 Codex 实现门见 design §4。v1（两处事件追加改共享锁）与 v2（数据写围栏只加锁）分别在第 1、2 轮设计门 FAIL，
  处置见 design §7；v3 按用户 2026-10-30 的选择重写，经第 3–5 轮设计门后获用户批准。
- **来由**：v0.19.3 候选 `b430c7754` 的主 CI（run 41052627131，后端 ubuntu 分片 33/36，job 124052183671）红在
  `scheduler-boundary-fanout-concurrency.test.ts` 的 PostgreSQL 用例「B: RFC-130 — writer shards each run in their OWN iso
  worktree…」。用户决定先按本 RFC 根治再发 v0.19.3。
- **不修订**：RFC-328 的 owner 围栏与 `revision` 语义（每次围栏写入照旧推进）。

## 1. 背景

### 1.1 现象

PostgreSQL 上，一个扇出里的三个写分片并行运行，第三个分片准备隔离工作区时失败（`fanout shard iso setup failed`，
`Failed query: update "agent_workflow"."task_execution_owners" set "revision" = … + 1 …`），按「join 后全败」语义整个任务
`failed`。约 150 次主 CI 里第一次出现；机制自 v0.19.2 即存在（`643d64db6`），这一次是首次观察到。

### 1.2 根因（本机实测）

一次性 PostgreSQL 17 容器，8 路并行、每路只跑这一条用例：

1. **失败率**：4/64 次失败（2 次与 CI 同签名），服务端 2316 次 `40001 could not serialize access due to concurrent update`，0 次死锁。
2. **谁在改写 owner 行**（语句日志按事务分组，32 次运行）：每一笔普通数据写入都以 owner 行条件 UPDATE 开场（RFC-328 的围栏）。
   node run 铸造与生命周期 765、effect 697、node run 运行态 391、产出 158、任务级 96、事件追加 95。
3. **谁失败**：1118 次 40001 全部落在 SERIALIZABLE 事务的第一条语句——owner 围栏。这些事务（effect 准备 / 结算 / 进程登记、
   运行时会话租约、托管进程登记）在快照之后遇到同任务其它写手改写并提交的 owner 行，PostgreSQL 一律报 40001；10 次重试
   （`retryPostgresqlSerialization`，退避 ≤16ms）被耗尽后原样抛出。READ COMMITTED 的写手遇到同样的情形只会等锁，提交后按最新
   版本重判条件，不报错。

SQLite 不受影响：`BEGIN IMMEDIATE` 全库独占。

### 1.3 为什么是「降隔离」而不是改围栏或调重试

- **调重试**（上限临时改为 30，实验未提交）：0/64，但热点仍在，并突破 RFC-349 为证据门槛钉住的退避上界。
- **围栏只加锁**（v2，原型 0/64、0 次 40001）：独立探针证实它让 SERIALIZABLE 事务在等到锁之后仍用等锁前的旧快照——同键插入得到
  `23505`（不重放），已结束的运行仍读作 `running` 并提交。旧围栏恰恰靠 40001 强制这些事务重放到新数据，去掉它就引入正确性缺陷。
- **降隔离**：这批事务改为 READ COMMITTED，owner 围栏仍是第一条写（行排他锁），之后每条语句都读到最新提交；同任务写手在 owner
  行上串行，等锁不再报错；死锁与残余冲突由整笔重放吸收。代码对单任务写入本来就是这个默认（`ownedTaskExecution.ts:36-44`、
  RFC-359 design.md:507-511、RFC-395 plan.md:870）——这批事务留在 SERIALIZABLE 只是「合一时沿用两侧最强档」
  （`taskExecutionEffectPersistence.ts:40-41`），没有点名任何不变量。

## 2. 目标

1. 以 owner 围栏开场的 SERIALIZABLE **数据写入**改为 READ COMMITTED + 整笔重放（`withTaskExecutionAggregateWrite`）：
   - 运行时会话租约 7 个事务（`runtimeSessionLeaseOperations.ts`）；
   - effect 准备、结算一族（四个入口）、进程登记（`taskExecutionEffectPersistence.ts`）；
   - 托管进程登记（`crewstation/processEffectProjection.ts`）；
   - effect 静默结算的四个入口（`effectQuiescence.ts`，今天是不重试的 READ COMMITTED）：因新增 family 锁可能成为死锁牺牲方，
     一并换原语并补任务根锁。
2. 每个事务的「先读后写」不变量都由 owner 行锁、任务根锁、行锁或唯一约束保护（design §3 逐项）；唯一的跨任务共享数据
   （父子任务共用 lineage 下的 effect family：effect 唯一槽、watermark、重放决定）由新增的 **family advisory 锁**串行，
   effect 静默收尾（`effectQuiescence.ts`，本已 READ COMMITTED）同样取这把锁。
3. 会话租约补四处加固（谓词收紧、锁下重读、精确删除计数、提前返回改用围栏后读），冲突错误只把租约主键冲突映射为
   `owner-conflict`。
4. PostgreSQL 上，扇出写分片与并行节点不再因同任务的数据写入耗尽 40001 重试而失败；也不出现旧快照判定。
5. SQLite 的事务模式与单写者边界不变；租约加固与错误映射收窄在两种 provider 上同样生效。

## 3. 非目标

- 不改 owner 围栏、`revision` 语义与任何所有权变更事务（claim、心跳、撤权、取消撤权、源终止、释放等仍为现状，会话外的 40001
  仍由现有重试吸收）。
- 不改 `retryPostgresqlSerialization` 的预算与退避（RFC-349 证据门槛不动）。
- 不处理调研中另见的问题（design §8）。

## 4. 行为变化

- **PostgreSQL 部署（含 CrewStation 托管）**：并行节点 / 扇出写分片不再偶发以 `iso-setup-failed`、effect 或会话租约写入失败
  让任务失败。
- **错误映射**：会话租约只把租约主键冲突报为 `runtime-session-conflict / owner-conflict`；父子任务争同一 effect family 时，
  败方得到与今天相同的类型化冲突（由 family 锁保证读到胜方结果），不再可能是裸 `23505`。
- **SQLite 单机**：事务模式不变；租约加固与错误映射收窄同样适用。
- **错误详情**：租约适配器的非主键约束错误不再被改写为 `owner-conflict`，原错误会进入运行结果与持久化的错误信息；上层的失败分类
  与恢复路径不变。
- 无 API、配置或数据迁移变化。

## 5. 验收标准

1. 转换后的事务在 PostgreSQL 上以 READ COMMITTED 运行（SQL 形状断言），SQLite 仍为 `BEGIN IMMEDIATE`。
2. **原故障的确定性回归**（barrier 协议：竞争写手持锁 → 确认被测事务的 owner 围栏处于锁等待 → 竞争写手提交；派发时记录含失败
   语句）：被测事务完成，只发出一次 `BEGIN` 与一次 owner 围栏、无失败语句；变异检查——换回 SERIALIZABLE，记录可见首次围栏以 40001
   失败及第二次 `BEGIN`，断言失败。静默收尾四入口单独验证其加锁读取契约、取锁顺序与 40P01 整笔重放。
3. 第 2 轮设计门的两个交错：`patch` 先建运行态行 → `claimNew` 走更新分支成功；运行结束状态先提交 → `preclaimResume` 得到
   `run-not-claimable`。
4. 父子任务争同一 effect family（准备 / 结算 / 静默收尾四入口两两并发，含跨 family 共用 fence 键、多 family 反序、
   `retry-authorized` 分支）：败方得到类型化冲突或在胜方之后正确推进，watermark 单调，无裸 `23505`、无挂起；静默收尾入口被选为
   死锁牺牲方时整笔重放成功，失败尝试不留下部分结算。
5. 会话租约加固各有「去掉即失败」的交错负对照；真正的租约主键冲突仍为 `owner-conflict`，其它约束错误保留原错误；托管登记的
   attempt CAS 命中 0 行时整笔回滚。
6. 本机 8×8 并行压测扇出写分片用例：0 次失败；服务端 40001 计数记入 design §4。
7. 钉住隔离级别、SQL 形状或「仍为 SERIALIZABLE」注释的既有用例、源码锁与账本按新语义逐条更新并说明；主 CI 全绿。

## 6. 已作出的取舍

1. **方向**（用户 2026-10-30 在第 2 轮设计门后选定）：降隔离，保留 RFC-328 语义；而不是围栏只加锁（有旧快照缺陷）或进程内按任务
   串行。
2. **发版顺序**（用户 2026-10-30）：本 RFC 完成、主 CI 全绿后再发 v0.19.3。
3. **family 锁而不是映射 23505**：映射只能把错误改名，锁让败方读到胜方结果、走今天的类型化分支，且一并覆盖结算与静默收尾的
   watermark 竞争。
