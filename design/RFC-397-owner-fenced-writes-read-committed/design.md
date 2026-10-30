# RFC-397 设计：以 owner 围栏开场的 SERIALIZABLE 数据写入降为 READ COMMITTED

`file:line` 以 `e9021ee29` 为准，路径相对 `packages/backend/src/`（另注明者除外）。缩写：`OTE` = `modules/task-execution/infrastructure/ownedTaskExecution.ts`，
`TEP` = `…/taskExecutionEffectPersistence.ts`，`LEASE` = `…/runtimeSessionLeaseOperations.ts`，`NRW` = `…/nodeRunWriteProtocol.ts`，
`EQ` = `…/effectQuiescence.ts`，`PEP` = `…/crewstation/processEffectProjection.ts`，`SCH` = `…/persistence/schema.ts`。

## 1. 现状

### 1.1 事务原语

| 原语                                                                                                                                  | PostgreSQL     | SQLite            | 重放                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------- | ---------------------------------- |
| `withTaskExecutionWrite`（OTE:29-34）                                                                                                 | READ COMMITTED | `BEGIN IMMEDIATE` | 无                                 |
| `withTaskExecutionAggregateWrite` = `retryingWriteTransaction`（OTE:45-50，`platform/persistence/retryingWriteTransaction.ts:12-26`） | READ COMMITTED | `BEGIN IMMEDIATE` | 40001 / 40P01 整笔重放，只在最外层 |
| `withTaskExecutionSerializable`（OTE:59-64）                                                                                          | SERIALIZABLE   | `BEGIN IMMEDIATE` | 40001 / 40P01 整笔重放，只在最外层 |

嵌套调用复用外层事务帧、不升级隔离、不在内层重放（`platform/persistence/databaseTransaction.ts:260-297`）。本 RFC 涉及的入口
在生产代码里都不在外层帧中被调用（调研逐一核对了调用方：都包着 git / 文件 / 进程 / 网络等外部 I/O）。

### 1.2 本 RFC 涉及的事务

| 事务                                                                                                                | 位置                                   | 每次运行的频率        |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------- |
| 租约 `claimNew` / `preclaimResume` / `confirmResume` / `rotate` / `markResetPending` / `discard` / `release`        | LEASE:70, 128, 192, 218, 346, 386, 420 | 每个运行时会话数次    |
| effect `prepareAndAcquire`                                                                                          | TEP:338-613                            | 每个外部 effect 一次  |
| effect 结算 `settleTx` 及入口 `settle` / `settleGateRollback` / `settleCodeHostNode` / `settleWorkspacePreparation` | TEP:615-823, 825, 850, 879, 888        | 每个外部 effect 一次  |
| effect `recordProcessSpawn`                                                                                         | TEP:894-981                            | 每个进程一次          |
| 托管 `recordSpawnReceipt`                                                                                           | PEP:40-83                              | 每个托管进程一次      |
| effect 静默结算四个入口（今天是不重试的 READ COMMITTED，因新增 family 锁一并换原语）                                | EQ:528-537, 720-736, 755-777, 881-916  | 每次运行时停止 / 恢复 |

除最后一行外，它们都以 owner 条件 UPDATE 围栏开场（OTE:67-96；租约经 LEASE:45-48 的 `fence()` = `fenceTaskWrite` + 任务根锁），
跑在 SERIALIZABLE。同任务的其它写手（铸造、状态迁移、运行态、产出、事件追加）都改写 owner 行，于是这些事务在快照之后遇到被改写的
owner 行就得到 40001（proposal §1.2）。最后一行 EQ 的四个入口不同：今天是不重试的 READ COMMITTED，以 `lockAndAssertOwnerTx`
（EQ:174-206：owner 行 `FOR UPDATE` 后读取并要求 revision 与证明一致）开场，不改写 owner 行；纳入本 RFC 只因为新增的 family 锁。

### 1.3 v2 被否决的原因（实测）

独立探针（PostgreSQL 17，不经仓库代码；SERIALIZABLE 先取快照，READ COMMITTED 写手随后提交）：

| 场景                                  | 写手改写 owner 行（现状） | 写手只对 owner 行加锁（v2） |
| ------------------------------------- | ------------------------- | --------------------------- |
| 同键插入（写手已插入并提交）          | 40001，重放后走更新分支   | **23505**，不重放           |
| 过围栏后读运行状态（写手已改为 done） | 40001，重放后读到 done    | **读到 running 并提交**     |

## 2. 设计总则

1. 上表事务改用 `withTaskExecutionAggregateWrite`：owner 围栏仍是第一条写，READ COMMITTED 下它等在途写手提交后按最新版本重判条件，
   之后整个事务持有 owner 行排他锁，并紧接着取任务根锁；其后每条语句读到的都是最新提交的数据。事务所依赖的本任务事实由谁保护，
   逐项见 §3（不是笼统的「所有写手都先过 owner」）：
   - 有执行上下文的数据写手：owner 围栏（同一行排他）。
   - 无上下文 / 控制面写手（如人工门决定 `taskDecisionParticipant.ts:212`、无主写入）：它们取任务根，转换后的事务也在 owner 之后
     立即取任务根，二者在根上互斥。
   - 重放决定行的其它写手（继续执行的准入绑定 `taskContinuationAdmission.ts:298`、intent 终结的释放
     `taskExecutionIntentTerminalSequence.ts:64, 81`，后者经 `taskExecutionIntentTerminalPersistence.ts:15` 以 SERIALIZABLE 运行、
     不取 owner / 根）：都是对决定行 `record_revision` / 状态的单行 CAS，与本 RFC 的消费 CAS 一样原子，败方得到今天的类型化错误；
     决定行的**插入**只发生在 EQ，归 family 锁（§3.2）。
   - 托管启动恢复（`crewstation/bootRecovery.ts:61-127`）：在 HTTP 与任何自动续跑之前运行（`bootstrap/daemonApplication.ts:730-732`），
     并先过托管执行权围栏，与运行期写手不并发。
2. 跨任务的读后写不受 owner 行保护，逐项落到唯一约束或新增的 family advisory 锁（§3.2）。
3. 体内只有数据库操作，整笔可重放：`ulid()` 在重放时重新生成；回调外取得的时间（`prepareAndAcquire`、`recordProcessSpawn` 的 `now`，
   TEP:341、897）与调用方传入的时间在重放时不变；回调内的默认时间（`settleTx` 的 `input.now ?? Date.now()`，TEP:626；租约 `fence()`
   调用处的 `Date.now()`，如 LEASE:209）在重放时重新取得，只影响时间戳。
4. 所有权变更不变，按实际事务边界：claim（`taskOwnershipPersistence.ts:288`）、停止后释放（`:506`）、恢复后释放（`:555`）、取消撤权
   （`childTaskLifecycleParticipant.ts:769`）、源终止（`sourceTerminationTarget.ts:170`）是 SERIALIZABLE 事务，40001 由现有重试吸收；
   精确撤权与旧 daemon 撤权（`taskOwnershipPersistence.ts:449-465`）、标记需恢复（`:472-492`）、心跳（`:414-447`）是无事务包装的单语句
   CAS / UPDATE。它们都以 owner 行 CAS 为准、低频。
5. 嵌套：原语在已有事务帧里复用外层、不降隔离、不重放（`retryingWriteTransaction.ts:17`）。本 RFC 的入口在生产代码中都不在外层
   帧里调用；「首次尝试完成」只对顶层调用成立，不推广到任意嵌套调用。

## 3. 逐事务分析

### 3.1 运行时会话租约（LEASE）

共同事实：

- `fence()`（LEASE:45-48）= `fenceTaskWrite`（有环境上下文时改写 owner 行，无上下文时只读校验）+ 任务根 `FOR UPDATE`。
- 租约行以 `(protocol, session_id)` 为主键（SCH:2778），是唯一可能与别的任务共享的行；其余读写都在本任务内。
- 会话写入协议 `compareAndWriteRunSessionInTx`（NRW:340-386）先 `lockRun`（`node_runs … FOR UPDATE`，NRW:74）再读写
  `node_run_runtime_states`；该表的全部生产写手（NRW:201-206、305-335、372、376）都先 `lockRun`。

| 事务                                   | 读后写不变量                                         | READ COMMITTED 下的保护                                             | 本 RFC 的改动                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `claimNew`（LEASE:70-126）             | 一个会话一份租约；运行为 running、无会话             | 租约主键（23505 → `owner-conflict`）；运行条件在 `lockRun` 之后重读 | 仅换原语                                                                                                                             |
| `preclaimResume`（LEASE:128-190）      | 租约空闲且属本任务本节点；运行为 running、无会话     | 围栏 + 根锁之后的读即最新；租约 UPDATE 是单行 CAS                   | UPDATE 谓词加 `task_id`、`node_id`、`reset_pending = false`：根锁已排除本任务内的替换窗口，这是让最终写入自带归属条件的额外 CAS 约束 |
| `confirmResume`（LEASE:192-216）       | 租约仍由该 token 持有                                | 运行侧由 `lockRun` 保护                                             | 围栏 + 根锁之后按 token 重读租约（`FOR UPDATE`），不在则 `lease-mismatch`                                                            |
| `rotate`（LEASE:218-344）              | 旧租约处于 reset-pending 且由 token 持有；新会话无主 | 新会话由主键保护；运行与历史重标由根锁保护                          | 删除旧租约改为 `DELETE … RETURNING`，谓词加 `reset_pending = true AND leased_at IS NOT NULL`，要求恰好 1 行                          |
| `markResetPending`（LEASE:346-384）    | 租约由 token 持有且未 reset                          | 单行 CAS（计数已检查）                                              | 提前返回（LEASE:367）改用围栏之后的读                                                                                                |
| `discard` / `release`（LEASE:386-453） | 按 token 删除 / 释放                                 | 单行 CAS（计数已检查）                                              | 仅换原语                                                                                                                             |

错误映射：`constraintViolation`（LEASE:36-42）今天把任何表的 23505（以及 PostgreSQL 报文里带表名的 FK / CHECK 违例）都映射为
`owner-conflict`。改为只匹配租约主键约束 `runtime_session_leases_pkey`（PostgreSQL 按约束名，与生成 schema 一致：
`platform/persistence/schema/postgresqlPlan.ts:214`；SQLite 按报文中的表与列），其余约束错误原样抛出。适配器之上的分类不变：
运行器对 `claimNew` / `rotate` 的失败仍按原生会话协议失败处理并走既有的 reset / `runtime-session-identity-invalid` 路径
（`application/taskAgentRun.ts:1228-1270, 1618`），恢复入口仍广泛记为 `runtime-session-conflict`（`:674`）；变化在于错误详情会进入
运行结果与持久化的错误信息。两种 provider 共用这份实现，所以映射收窄与四处加固对 SQLite 同样生效。

第 2 轮设计门的两个交错：

- `patch` 建运行态行 vs `claimNew`：两者都先过 owner 围栏、任务根、`lockRun`，READ COMMITTED 下后到者看到已建的行，走更新分支，
  不再撞主键。
- 运行结束状态 vs `preclaimResume`：状态迁移先过 owner 与根（`nodeRunLifecyclePersistence.ts:38-48`），READ COMMITTED 下
  `preclaimResume` 在围栏之后的读看到 done，返回 `run-not-claimable`；若 `preclaimResume` 先提交，运行随后结束时由运行器的释放 /
  修复路径收回租约（与今天相同）。

### 3.2 effect 账本（TEP、EQ）

跨任务共享的数据：子任务继承父任务的 execution lineage（`modules/task-execution/domain/taskCreation.ts:77-78`），重新铸造的运行沿用
continuation slot（`application/buildNodeRunMintRecord.ts:20-28`），因此父子 / 前后两代子任务可能落在同一 `(lineage, family)`：

- effect 全局唯一槽 `(lineage, family, generation)`（SCH:507-511）；
- watermark：每个 family 一行，单调推进，`record_revision` CAS（SCH:733-743；写入在 TEP:754-820 与 EQ:277-353）；
- 重放决定行（SCH:744-754；写入在 EQ:640-680，被 TEP:442-516 读取与消费）；
- fence 键（`workspace:…`、`code-host:…`）以 `fence_key WHERE released_at IS NULL` 唯一（SCH:395-398），冲突已映射为
  `task-execution-resource-conflict`（TEP:576-585）并由等待循环重试。

RFC-328 design.md:394 写明「live-effect unique 与 watermark revision CAS 共同保证旧 child 与新 child 不能并发创建或在 hard delete 后
复用同 generation」——今天这一保证在 PostgreSQL 上还依赖 SERIALIZABLE 的重放把败方带到胜方之后。

**family advisory 锁**：键为 `task-execution-effect-family:${lineage}:${family}`，经能力矩阵 `engineOf(tx).advisoryLock(tx, key)`
（`platform/persistence/capabilities.ts:146, 360, 477-489`；PostgreSQL `pg_advisory_xact_lock`，SQLite no-op）取得，事务结束释放。

| 事务                               | 取锁位置                                                                                                                                             | 理由                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `prepareAndAcquire`（TEP:338-613） | owner 围栏与任务根之后（TEP:346 之后），读 effect / watermark / 决定之前                                                                             | 败方等胜方提交后读到胜方的 effect 或 watermark，走今天的类型化分支（`task-continuation-conflict` / `-stale`），不再撞唯一槽 |
| `settleTx`（TEP:615-823）          | 读到 attempt 与 effect 并校验归属之后（约 TEP:645），**任何 fence 释放（TEP:685、733）之前**                                                         | watermark 的插入与 CAS 不再与他任务 / 静默收尾竞争；fence 释放前取锁避免与持锁插入 fence 的 `prepareAndAcquire` 形成环      |
| EQ 的四个结算入口（见下）          | owner 校验与任务根之后；收集本事务全部待结算 attempt 的完整 family 键，去重并按完整键排序后一次取齐，**任何 attempt / effect 修改与 fence 释放之前** | 同上；多 family 按排序取，避免两两成环                                                                                      |

**EQ 的四个入口**今天都用不重试的 `databaseSessionFor(db).transaction`，且 `lockAndAssertOwnerTx`（EQ:174-206）只锁 owner 行：
`resolveQuiescedManagedProcesses`（EQ:528-537）、`closeOutcomeUnknownAndRelease`（EQ:720-736）、`closeRecoveredOutcomeUnknownAndRelease`
（EQ:755-777）、`resolveQuiescedCodeHostMutations`（EQ:881-916）。加入 family 锁后它们可能成为死锁牺牲方，所以一并改为
`withTaskExecutionAggregateWrite`，并在 `lockAndAssertOwnerTx` 之后、读取运行事实（EQ:417、835 一带）之前取任务根锁。四个事务体
只有数据库操作（无进程 / 网络 / 文件调用），时间由调用方传入或在回调外取得，可整笔重放；失败的尝试整笔回滚，不留下部分结算、
产出或 owner 变更。调用方 `transferOwnerRow`（`taskDriverRelease.ts:80-150`）在 EQ 成功后才释放 owner，不变。

锁序：owner 行 → 任务根 → family 锁（排序）→ effect / attempt / fence / watermark / 决定行 → node run → 下级行，与
`TASK_AGGREGATE_LOCK_ORDER`（`application/ports/taskAggregateWrite.ts:9-15`）一致。跨任务的等待只发生在 family 锁、fence 键与
租约主键上，之后不会再取别的任务的 owner 或根。fence 键可以跨 family 共享，保留现有的资源键排序（`domain/executionEffect.ts:83-90`）
与唯一冲突处理（TEP:576-585）。advisory 锁是重量级锁，残余的环会被 PostgreSQL 检测为 40P01，所有参与方都是可整笔重放的顶层事务；
重试仍有上限，不承诺任意竞争下必然成功。

其余：

- `recordProcessSpawn`（TEP:894-981）：读写全在本任务内（attempt CAS、node run 与下级行），换原语即可。
- `prepareAndAcquire` 的「generation 恰为下一代」读在两条语句（TEP:411、422）里；family 锁让它们在同一临界区内，消除了第 1 份调研指出
  的两次快照之间的窗口。
- 结算一族里 `settleCodeHostNode`、`settleWorkspacePreparation` 按投影输入锁根（TEP:98、123），实现时补「投影任务 = token 任务」
  的校验，避免越序锁到别的根。

### 3.3 托管 `recordSpawnReceipt`（PEP:40-83）

读写都在本任务内，换原语即可。同时把 attempt UPDATE（PEP:68-74，今天只按 id 且不检查结果）补成按 `state = 'acting' AND epoch`
的 CAS 并检查行数，与 TEP:945-979 一致。

### 3.4 不变的部分

- owner 围栏、`revision` 与 `updated_at` 的推进、所有权变更事务、心跳。
- `withTaskExecutionSerializable` 原语保留（所有权变更与跨任务路径仍用；`packages/backend/tests/rfc359-w4-d24-adapters.test.ts:183-185` 钉住）。
- SQLite：三种原语都是 `BEGIN IMMEDIATE`，事务模式与单写者边界不变；共享实现里的租约加固与错误映射收窄同样适用（§3.1）。
- 托管 `recordSpawnReceipt` 的 attempt CAS 命中 0 行时整笔回滚（§3.3）。

## 4. 测试策略

新增 `packages/backend/tests/rfc397-owner-fenced-writes-read-committed.test.ts`，文件头写明来由（CI run 41052627131、proposal §1.2 的归因、
§1.3 的探针）。功能用例两种 provider 都跑（`describeEachProvider`），并发用例只在 PostgreSQL 上跑：

并发用例的公共做法：竞争方在外层事务帧里执行真实写手（`databaseSessionFor(db).transaction` 复用外层帧，锁持有到外层提交）后挂起；
被测事务启动；轮询 `pg_stat_activity` / `pg_locks` 确认被测事务停在**该用例指定的阻塞点**上，然后才让竞争方提交。被测事务经一个只供它
使用的数据库客户端运行。测试辅助 `tests/helpers/eachProvider.ts` 的 SQL 记录器今天只记成功返回的语句（其 PostgreSQL 实现 :854-867），
本 RFC 为它增加**派发时记录**：每条语句在发出时登记，失败的语句连同 SQLSTATE 一并记下，`BEGIN` 也计入；既有的成功语句视图保持原义。

1. **原故障的确定性回归**（PostgreSQL；只用于以 OTE 条件 UPDATE 围栏开场的数据写入：`claimNew`、`prepareAndAcquire`、`settle`、
   `recordProcessSpawn`）。竞争方 = 同任务的 node run `patch`；阻塞点 = 被测的 owner 围栏 UPDATE（`wait_event_type = 'Lock'`）。断言
   被测完成，被测客户端只发出一次 `BEGIN` 与一次 owner 围栏 UPDATE，且无失败语句。变异检查：被测换回
   `withTaskExecutionSerializable`——快照早于竞争方提交，首次 owner 围栏 UPDATE 以 40001 失败（派发记录可见其 SQLSTATE），随后第二次
   `BEGIN`，断言失败。
   1a. **EQ 四个入口**（PostgreSQL；保留其加锁读取 + 精确 revision 契约，不套用 1 的判据——竞争方的任何围栏写入都会推进 revision，EQ 按
   契约就应报 `task-execution-stale-owner`）：
   - SQL 顺序：owner 行 `FOR UPDATE` → 任务根 `FOR UPDATE` → 排序后的 family advisory 锁 → 首次 attempt / effect UPDATE；
     `resolveQuiescedCodeHostMutations` 先读取并校验全部 resolution 的 attempt / effect、收齐键再取锁，不边遍历边取；
   - 用测试专用触发器注入一次 `40P01`，两个注入点：首个 attempt UPDATE（验证入口接上整笔重放，派发记录可见两次 `BEGIN`）；以及
     一次结算两个 effect 时的**第二个** attempt UPDATE——此时第一个 effect 的 attempt、fence 释放、watermark 与（code-host 入口的）
     产出投影已经写下，断言失败尝试的这些写入全部撤销、成功重放只推进一次业务 revision。「只注入一次」由触发器读取一个在被测事务外
     建好的测试 sequence 实现（`nextval` 不随回滚复原；普通表里的标记会随回滚复原，导致每次重放都再报错）；
   - 用一个持有同一 family 锁的事务阻塞 EQ（阻塞点 = advisory 锁等待），释放后 EQ 完成且只开一次事务。
2. **交错 i**：竞争方 = `patch` 建运行态行；被测 = `claimNew`。断言成功且运行态行的会话被更新，无 `owner-conflict`。
3. **交错 ii**：竞争方 = 运行结束状态迁移；被测 = `preclaimResume`。断言 `run-not-claimable`。
4. **family 竞争**（PostgreSQL，两个任务共享 lineage 与 family；阻塞点 = family advisory 锁或 fence 键的等待，不是 owner 行）：
   - 两个 `prepareAndAcquire`：一方成功，另一方得到今天的类型化冲突，无 `23505`；
   - `settle` 与 EQ 各入口对同一 family：watermark 单调、`record_revision` 连续，无裸错误；
   - 不同 family 共用同一 fence 键（一方持锁插入、另一方释放）：不挂起；
   - EQ 一次结算多个 family、两侧输入顺序相反：不挂起；
   - `settle` 的 `retry-authorized` 提前释放分支（TEP:683-687）同样先取 family 锁；
   - 注入 40P01（让 EQ 入口成为死锁牺牲方）：整笔重放成功，失败尝试不留下部分结算、产出或 owner 变更。
5. **租约加固**：每项都是「去掉该加固就失败」的交错（初读在围栏之前、竞争方在等待期间改变租约）——
   - `confirmResume`：被测初读到有效 token 后等围栏；竞争方 `release` 该租约并提交；被测必须 `lease-mismatch`，且运行未接上会话；
   - `rotate`：被测初读合法且 reset-pending 后等围栏；竞争方 `discard` 旧租约并提交；被测 `DELETE … RETURNING` 得 0 行而失败，不插入新租约；
   - `markResetPending`：被测初读 `resetPending = true` 后等围栏；竞争方使租约消失并提交；被测不得返回旧的 `true`；
   - `preclaimResume`：SQL 捕获断言最终 UPDATE 的谓词含 `task_id`、`node_id`、`reset_pending = false`（根锁已排除对应窗口，这里验证
     的是写入契约）。
   - 托管 `recordSpawnReceipt`：保留「attempt 初始即非 `acting` 被前置读取拒绝」的用例；另加「前置读取通过、UPDATE 命中 0 行」——用
     测试专用触发器让该 attempt 的 UPDATE 不生效、不报数据库错误而只影响 0 行——PostgreSQL 用针对该 attempt 的
     `BEFORE UPDATE FOR EACH ROW … RETURN NULL`，SQLite 用 `BEFORE UPDATE … WHEN … BEGIN SELECT RAISE(IGNORE); END`；由应用层的
     行数检查抛错，断言整笔回滚（owner revision、receipt、node run 投影都不变）；UPDATE 的 `state` / `epoch` 谓词另作 SQL 契约断言。
6. **错误映射**：真正的租约主键冲突仍为 `owner-conflict`；其它约束错误保留原错误（两种 provider）。
7. **隔离级别**：SQL 捕获断言转换后的事务不发出 `set transaction isolation level serializable`；SQLite 仍为 `BEGIN IMMEDIATE`。

既有用例与账本（按新语义逐条更新，改动处注明 RFC-397）：

- 钉住租约为 SERIALIZABLE：`rfc349-runtime-session-lease-provider.test.ts:75-77, 84-85`；`rfc359-w4-d24-adapters.test.ts:167-169`
  （源码锁，`:183-185` 关于原语存在的部分保留）。
- 钉 SQL 形状：`rfc395-run-write-atomicity.test.ts:566-660, 704-737` 中与租约相关的断言按新形状更新；该文件刻意建立的外层
  SERIALIZABLE 覆盖（`:83`、`:482-506`）保留，用来继续证明嵌套时不降隔离、不重放。
- 原语契约保留不改：`rfc395-task-aggregate-write.test.ts:21-28, 40, 55-70`（PostgreSQL READ COMMITTED、SQLite `BEGIN IMMEDIATE`、
  40001 / 40P01 重放、嵌套不重放）。
- `NRW:340-341` 的注释「callers retain SERIALIZABLE」改为 READ COMMITTED + 根锁 + `lockRun` 的事实。
- effect 一致性：`rfc359-w8-effect-persistence-conformance.test.ts`（revision +1 等断言不变，确认仍绿）。
- 架构守卫：`architecture/rfc359-w8-t29-unnormalized-unique-insert.test.ts`（其 :567-570 以「TEP 在 SERIALIZABLE」解释安全、:482-484
  的 EQ 说明已过时）按新事实更新；`architecture/rfc359-w6-t28-read-modify-write.test.ts:159-169`、
  `architecture/rfc359-converged-twins.test.ts:226-235`、`architecture/rfc328TaskExecutionLedger.ts:234-244, 603-614`、
  `rfc359-t7b-driver-release-settles-effects.test.ts:552-553`、`rfc349-task-aggregate-transaction.test.ts:153-161` 逐个核对。
- 变异夹具 `fixtures/rfc359-p0-mutations.ts`：P0-2 锚点（TEP 中 `await assertTaskOwnerTx(tx, input.token, now)` 的出现次数）随改动核对。
- 源码账本 `fixtures/rfc395-serialized-insert-source-locks.json`：若改动 `nodeRunWriteProtocol.ts`（注释），重新审阅后更新其 sha256。
- 未列出的受影响用例在集中验证时逐个归因后处理。

压测证据（本机一次性 PostgreSQL 容器，8 路 × 8 次只跑用例 B）：基线 4/64、2316 次 40001；实现后重测，数字写回本节。

## 5. 与 RFC-294 目标架构的对齐

- **落位**：`task-execution` 限界上下文 infrastructure 层（租约、effect、托管投影的持久化适配器）；复用 `platform/persistence` 已有的
  `retryingWriteTransaction` 与能力矩阵 `advisoryLock`，platform 不新增 API、不依赖模块。
- **演进**：把单任务写入统一到 RFC-359 / RFC-395 已定的默认（READ COMMITTED + 聚合根锁 + 重放），跨任务部分用显式锁表达，而不是
  依赖隔离级别的副作用。
- **G7**：两种 provider 同一算法。**偏离项**：无。

## 6. 风险

1. **跨任务锁**：family 锁是新的跨任务锁；按 §3.2 的位置与排序取得，残余环由 40P01 重放兜底。用例 §4.4 覆盖。
2. **effect 账本的正确性**：恰好一次语义依赖 CAS、唯一槽与 watermark；本 RFC 不改这些判据，只改它们在并发下的保护方式；一致性用例全量
   回归。
3. **错误码变化**：租约的非主键约束错误不再被吞成 `owner-conflict`，可能在日志里出现此前被掩盖的错误；这是暴露而非新增。
4. **所有权变更事务仍会遇到 40001**：低频，现有重试吸收；压测数字验证。

## 7. 设计门处置

- 第 1 轮（v1：两处事件追加改共享锁）FAIL：归因未证实——语句日志证明事件追加只占约 3%（proposal §1.2）。
- 第 2 轮（v2：数据写围栏只加锁）FAIL：SERIALIZABLE 写手在锁后仍用旧快照，探针证实（§1.3）；另指出的 RFC-349 SQL 断言与响应夹具、
  双 provider 的 SQL 形状差异、回滚探针、工作组主持账本归类、锁模式表述等，随方向改变不再适用或已在 §4 清单中处理（工作组主持账本
  实为 `retryingWriteTransaction`，`modules/resource-catalog/infrastructure/workgroupTurnsOperations.ts:549`，已不在本 RFC 范围）。

- 第 3 轮（v3）FAIL，方向确认可行：EQ 四个入口改为整笔重放并补任务根锁、family 锁按完整键排序且在首次修改前取得（§3.2）；确定性回归改为 barrier 协议与「围栏只发一次」判据（§4.1）；租约负对照改为去掉加固即失败的交错，family 用例补全分支（§4.4–§4.5）；同任务写手的保护按不变量列出例外、重放时间戳与心跳的描述更正（§2）；SQLite 与错误映射的表述收窄（§3.1、§3.4）；保留原语契约与外层 SERIALIZABLE 覆盖用例（§4）。

- 第 4 轮（v3.1）FAIL，生产设计各项确认已解决；剩余为验收设计：SQL 记录器漏计失败语句——改为派发时记录（含 SQLSTATE 与 `BEGIN`）并以「一次 `BEGIN`、一次围栏、无失败」为判据（§4 开头、§4.1）；EQ 不套用围栏 UPDATE 判据，单列加锁读取契约、触发器注入 40P01 与 advisory 阻塞点（§4.1a）；family 用例改在 advisory / fence 阻塞点设 barrier（§4.4）；托管零行 CAS 改用触发器制造「前置读取通过、UPDATE 命中 0 行」（§4.5）；§1.2、§2.3、§2.4 的事实按实际事务边界更正。

- 第 5 轮（v3.2）PASS WITH CHANGES：上一轮四项均已解决；两处 minor 已并入——EQ 的 40P01 增加「第一个 effect 已写下后在第二个
  attempt UPDATE 注入」以证明写后回滚，一次性注入用事务外 sequence（§4.1a）；托管零行 CAS 给出 SQLite 的 `RAISE(IGNORE)` 写法（§4.5）。

## 8. 调研中另见、不在本 RFC 内

- 本机压测另见两种低频失败：一次任务 `failed` 而无 WARN；一次任务 `done` 后在 EQ:298 抛 `recovered generation regressed below
retained watermark`。需另行归因。
- 关停标记不检查 UPDATE 结果（`taskExecutionShutdownOperations.ts:89-121`）；源终止先锁任务根再撤 owner，与规定锁序相反
  （`taskDefinitionWriteParticipant.ts:166`、`sourceTerminationTarget.ts:154`）。
- `repairAfterOrphanReap`（LEASE:455-496）在事务外读后决定释放还是丢弃。
- 失败日志只含 Drizzle 的「Failed query」、不含 SQLSTATE（`describeEffectError` 只取最外层 message），改法另议。
