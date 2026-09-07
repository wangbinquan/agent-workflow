# RFC-359：任务分解

## 0. 波次总览

**原则（D2/D3，修订）**：每一波自身可发布。实际顺序按硬依赖：**W2（原语+矩阵）→ W1 实现类条目 →
W1 接线类条目 → W3 → W4 → W5 → W6**。原稿「W1 优先」的理由对接线类条目成立，对实现类条目不成立
（它们在 PG 侧根本没有实现，在 W2 之前修只能抄第二份——正是本 RFC 要消灭的东西）。

| 波 | 内容 | 为什么是这个顺序 |
| --- | --- | --- |
| **W1** | 修 12 条 P0，让 PG 真的能跑任务 | 不修的话后面每一波都在一个跑不起来的 provider 上验证 |
| **W2** | 统一事务原语 ✅ + 能力矩阵 `EngineCapabilities` | 它是「一份实现」的唯一技术前提；矩阵是「PG 最高性能」的唯一表达处 |
| **W3** | 统一启动序列（消灭 `cli/start.ts` 的 provider 分支） | 结构性缺陷的正身；W1 修的多数缺口在这里被永久关闭 |
| **W4** | 逐 context 合一适配器（153 对 → 0） | 体量最大，但 W2 之后是机械工作 |
| **W5** | 防复辟：七条结构性守卫 + harness 按 provider 参数化 + **全量套件在真 PG 上进 push CI** | 守卫的棘轮值要等 W4 收敛完才能钉死；覆盖率对等棘轮可提前到 W1 后立即上 |
| **W6** | PostgreSQL 性能：JSONB + GIN 投影、`EXPLAIN (ANALYZE)` 热查询审计、双引擎性能基线 | 放 W4 之后——合一前给 PG 调优就是在给一份即将删除的实现调优 |
| **W7** | W4 的收尾：把 W5 守卫点出来的**剩余成对适配器**逐对合一 | 见 §5c——W4 当时没有「还剩哪些对、每对验没验过」的清单，是 W5 的成对账本把它变成了可排期的有限集 |

## 0b. 验收记分板（as of `fa92150c7`，2026-09-07）

「完整落地」= proposal §7 的 12 条 AC 全部达成。逐条实测状态如下——**数字都是跑出来的，不是估的**；
本波仍有多刀在跑，未达成项的数字会继续动。

| AC | 判据 | 实测 | 状态 |
|---|---|---|---|
| AC-1 | 成对文件数 → 0（**已按实测修订**，见 proposal §7 的修订段） | 153 → **11**；其中机制分叉以对拍替代合一 **7 对**，仍缺对拍见证 **5 对** | 进行中 |
| AC-2 | `cli/start.ts` 无 `provider === 'sqlite'` 分支；`servePostgresqlDaemon` 删除 | 分支 **0**；该函数已删，仅注释里留历史引用 | ✅ |
| AC-3 | 统一事务原语的双引擎原子性对拍；裸 `db.transaction(` 收敛 | 裸事务账本 17 → **5** | 进行中 |
| AC-4 | 方言表 exact 清单，每条两个 provider 各真实执行一次 | `RAW_DIALECT_DEBT` 在册；`UNSHIMMED_FUNCTION_DEBT` **0** | 进行中 |
| AC-5 | 防复辟守卫锁死新增 | W5 一整套守卫已落（T17/T18/T19/T19b–g/T20） | ✅ |
| AC-6 | **全量** backend 行为套件在**真 PostgreSQL** 上进 push CI | ubuntu 4 分片跑 `bun test --isolate --shard=N/4`，`AW_TEST_POSTGRESQL_URL` 指向真 postgres:17 服务；macOS 是唯一显式 `AW_TEST_PROVIDERS=sqlite` 的 lane（Actions 在 macOS 上起不了服务容器） | ✅ |
| AC-7 | 前置对账 12 条 P0 全消失，各带先红后绿 + 变异实证 | W1 已收 | ✅ |
| AC-8 | 用户可见行为逐字不变 | 各波对拍持续验证中 | 进行中 |
| AC-9 | exact-SHA CI 全绿（含真 PG 全量），取证 sha + run id 写回 | **未取证** | 待办 |
| AC-10 | 业务代码里 `provider === '<literal>'` 为零 | **0** | ✅ |
| AC-11 | 两引擎各取 P95 基线，PG 不劣于 SQLite | 5 个性能守卫全 `describeEachProvider`；`rfc311-perf-guards` 有跨引擎 P95 对比 + 塌方探测断言 | ✅ |
| AC-12 | 组合根全量，`*-not-bound` 为零 | 组合根 70 → **20** | 进行中 |

**已知仍在路上的**：W6 的 T23（JSONB + GIN）/ T24（`->>`·`@>`）/ T25（批量写）——T23 要改
`db/schema.ts`，会开一个全仓 PG 迁移漂移窗口（所有 PG 泳道同时假红），必须在**没有其他刀在跑**
的安静工作树上做；T25 的热路径落在并发最密的 `task-execution/infrastructure`。三件一并压到本波排空后。

**AC-9 的取证纪律**：取证 sha 必须是**含全部 RFC-359 改动的那一笔**，且要看**含该 commit 的
superseding run** 的绿（共享 main 上并发 push 会取消你的 run），并按失败测试的 owning commit 归属。
被 supersede 取消的 run **不是绿**。详见 `docs/dev-gotchas.md` 对应两条。

## 1. W1 —— 修 P0（让 PostgreSQL 可用）

| 任务 | 内容 | 证据 |
| --- | --- | --- |
| T1 ✅ | **P0-7** 延迟提问自动派发：PG 无实现。**已按做法①落地（2026-09-05）**：派发管线 `legacySqliteTaskQuestionDispatch.ts` 改跑 `DatabaseSession`（事务体开头 `lockAggregateRoot(tasks)`），事务体里的六类参与者各合成一份中立实现（committed-event append / node_runs 铸造 / human-gate 跃迁 / continuation 准入 / 决定接受 / gate 操作日志），`createTaskDagCollaborationOperations` 两 provider 共用，PG daemon 的 `DeferredTaskQuestionDispatcherBinding` 删除。`rfc359-t1-deferred-question-dispatch.test.ts` + 三个原子测试在两个引擎上各绿 | 真机实证，`node_runs` 0 行 → 两引擎各铸出 cross-clarify-answer rerun |
| T2 | **F-H2-1** 评审决定 / 反问下发 / 快速澄清三条命令端口：PG 无实现，路由必 500。**T2a ✅（2026-09-05）反问下发**：`questionDispatchCommand.ts` 一份实现（派发管线已跑在 DatabaseSession 上），PG daemon 注入 `questionDispatches`，`rfc359-t2-question-dispatch-command.test.ts` 两引擎各绿。**T2b ✅（2026-09-05）快速澄清**：`legacySqliteClarify/seal.ts` 的事务体迁到 DatabaseSession（开头 `lockAggregateRoot(tasks)`；`reconcileRoundEntriesTx` / `setNodeClarifyDirectiveTx` 随之中立），`legacySqliteClarifyDecision.ts` 参与者改用 journal / `acceptHumanGateDecisionTx` / 中立事件 append，`clarifyDecisionCommand.ts` 一份实现替代 `legacySqliteClarifyDecisionComposition.ts`，PG daemon 注入 `clarifyDecisions`；自澄清回滚的 effect 观察者（`legacySqliteNodeRollback.ts`）按客户端品牌挑两份真实现之一（fenced-dispatch 入 rfc349 fork 账本，两份 effect persistence 的合一归 W4）。`rfc359-t2b-clarify-decision.test.ts` 五个场景两引擎各绿。**T2c ✅（2026-09-05）评审决定**：`legacySqliteReview.ts` 的决定 / 评论增改删 / 文档选择五个事务体迁到 DatabaseSession（决定事务开头 `lockAggregateRoot(tasks)`；批量评论去重、归档、outputs upsert、上游作废 + 重跑铸造、兄弟级联全在同一事务）；同批合成四份中立原子并退役 PG 副本——`nodeRunLifecycleTransition.ts`（`setNodeRunStatusTx` / `transitionNodeRunStatusTx`，PG participant 的 `set` 委托过去）、`taskAuthorization.ts`（替代 `postgresqlTaskAuthorization.ts`）、`committedReviewArtifactReader.ts`（替代两份 reader）、`reviewMutationScope.ts`（替代 `sqliteReviewMutationScope.ts`；SQLite 独有的同步 `findTaskIdSync` 入队捷径退役，「先发出者先入队」改由 coordinator 等待在途作用域解析来保证，两引擎同一规则，`rfc326-review-decision-transaction` / `review-cancel-concurrency` 的线性化锁仍绿）；`reviewDecisionCommand.ts` 一份实现替代 `legacySqliteReviewDecisionComposition.ts`，PG daemon 注入 `reviewDecisions`。`rfc359-t2c-review-decision.test.ts` 六个场景两引擎各绿。**F-H2-1 三条命令端口至此全部合一。** 留债：`dispatchReviewNodeUnlocked`（评审门开启，12 处同步站点）与 `listReviewSummaries` 等读面仍绑 DbClient，归 W4 collaboration 收口 | `commandContext.ts:161-186` |
| T3 ✅ | **F-H2-2** development mission 的 `agentLauncher` / `scriptLauncher` 未注入 + 终态观察者零调用。**已修（2026-09-05）**：agent / script 动作执行器合一为 `composition/actionExecutionRunners.ts`（工作区 / baseline / 挂载校验 → agent 或 exact 脚本引用校验 → 宿主快照合成 → `launchHostTask` → 终态观察 / `fetchOutcome` / `cancel`），provider 只在 `actionExecutionEnvironment.ts` 提供两件私有能力：SQLite = `startTask`（`preCreatedWorktree` borrowed）/ `cancelTask`，PG = 根启动内核（`internal.workspace = borrowedPostgresqlWorkspace`，该租约从数字员工执行搬来共用）/ 取消命令；`agentActionExecution.ts` / `scriptActionExecution.ts` 退成薄 composer（`compose*` / `composePostgresql*`），agent 查询由 bootstrap 注入（模块不再 import resource-catalog 内部）；PG daemon 接上两个 launcher 与 `createPostgresqlDevelopmentMissionExecutionTerminalObserver`（ref-box 形态与 `cli/start.ts` 同）。`rfc359-t3-action-execution-runners.test.ts`：执行器在两个引擎上各跑（四条配置失败 / 正向启动 + 终态观察 + fetchOutcome / 启动抛错 / cancel 三态；script 四条配置失败 / 正向）+ PG daemon 接线与薄壳源码锁；RFC-310 PR-4 真子进程用例照旧绿 | `agentActionOrchestrator.ts:274-279`（修前锚点） |
| T4 ✅ | **P0-3/P0-4** boot 恢复四步在 PG 不可达；`servePostgresqlDaemon` 永不返回。**已修（2026-09-05，四步部分）**：四步合一为 `composition/bootRecovery.ts`（`runTaskExecutionBootRecovery`：prepare 撤销旧 owner → `reapOrphanRuns` → `repairRuntimeSessionLeasesAfterOrphanReap` → finalize 清算并释放；锁证明由 `createDaemonLockProof` 铸造，RFC-328 允许表随之改锚），`cli/start.ts` 与 `postgresqlDaemonApplication.ts`（HTTP 前、delete 认领续做前）都调它；新增中立 `createRuntimeSessionLeaseOperations(db)`。**P0-4 根因**：PG `assertPostgresqlTaskOwnerlessTx` 把 `!== 'released'` 一律拒绝，`prepare` 撤销（`revoked`）之后的收割 / 周期修复全部 409——改为只拒活着的 `claimed`（`released` / `revoked` / `recovery-required` 都没有能再写库的 worker；SQLite 侧这几条路不读 owner 行）。`rfc359-w3-t4-boot-recovery.test.ts` 三个场景两引擎各绿 + 两入口顺序锁（rfc223-pr5 锁改锚）。**未完**：`servePostgresqlDaemon` 永不返回形态（T14）与其余 boot 步骤（T15）仍在 W3 | `cli/start.ts:1160-1162,1570,2007-2037`（修前锚点） |
| T5 ✅ | **P0-5** clarify 全量封存在 PG 上 409 并回滚整笔答案。**已随 T2b 合一（2026-09-05 确认）**：seal 是一份 `DatabaseSession` 实现，node_run 的 `awaiting_human → done` 是带 CAS 的条件 UPDATE（命中 0 行即安全 no-op），PG 不再经 `set({ allowedFrom })` 抛 409；`rfc359-t2b-clarify-decision.test.ts` 新增「澄清 node_run 已 failed 时整轮 seal 仍成功、答案落库、round 翻 answered」两引擎各绿 | `postgresqlNodeRunLifecyclePersistence.ts:154-160`（修前锚点） |
| T6 ✅ | **P0-6** 定义损坏的工作流在 PG 上永久删不掉、列表整体 422。**已修（2026-09-05，删除半边）**：PG 仓库 `delete` 不再解析 definition——只用原始行的 ACL 身份（`aclIdentity(row)`）与版本，版本冲突时 revision 算得出就带上、算不出只报 409（`staleRow`）；`assertDeleteInTransaction` 改收 `WorkflowAclIdentity`，并补齐 SQLite 一直有而 PG 从未有的两道删除守卫（非终态任务引用 → `workflow-in-use`、定时任务启动目标 → `workflow-scheduled-referenced`，错误码 / 详情同形）；SQLite `deleteWorkflow` 的 stale 分支同样改为坏定义只报 409。`rfc359-t6-corrupt-workflow-delete.test.ts` 四个场景两引擎各绿（夹具 `tests/helpers/workflowCatalog.ts` 按品牌装配目录）。**未动**：列表 / 详情对坏行 422 两侧一致，是否改成跳过坏行属产品行为变更，不在 parity 范围 | `postgresqlWorkflowRepository.ts:258`（修前锚点） |
| T7 ✅ | **P0-1/P0-2** 两道 owner 围栏：适配器不读环境上下文 / effect 账本私有 fence 加等值判定。**已修（2026-09-05）**：PG 八处围栏（`postgresqlNodeExecutionPersistence` / `postgresqlNodeRunLifecyclePersistence` / `postgresqlWrapperRunPersistence` / `postgresqlMergeStateLifecyclePersistence` / `postgresqlTaskEngineApplicationPersistence` / `postgresqlTaskRuntimeLifecyclePersistence` / `postgresqlCollaborationRuntimeMechanics` 两处）改为 `input.executionContext ?? currentTaskExecutionContext(taskId)`（与 `sqliteOwnedTaskMutation` / `taskLifecycle.ts` 同规则）；`postgresqlTaskExecutionEffectPersistence.assertOwner` 去掉 revision / leaseUntil 等值与租约过期判定，与公共 `assertPostgresqlTaskOwnerTx` / SQLite `withOwnedTaskTx` 同（身份 + epoch + claimed）。`rfc359-t7-owner-fences.test.ts`：环境上下文内不传 executionContext 的 transition / upsertOutputs / patch 放行、显式上下文优先、心跳后旧 token 开 effect 并结算——两引擎各绿 + 源码锁 | 真库复现 + `postgresqlTaskLifecycleTransaction.ts:153-157` 的反证注释 |
| T7b ✅ | **P0-10** 驱动释放不清算 effect ⇒ owner 永久卡 `claimed`、重启也救不回。**已修（2026-09-05）**：静默清算合一为 `infrastructure/effectQuiescence.ts`——managed-process 证据判定（spawn receipt ↔ node_run 的 pid / launchNonce / binary）、outcome-unknown 闭合（attempt / fence / watermark / replay-decision / 意图终结 / owner 释放）、exact-stop 与 successor-daemon 两种权威只差 `resolveQuiescenceAuthority` 一处判定；事务按 §5 READ COMMITTED + owner 行 `lockAggregateRoot`。释放序列合一为 `infrastructure/taskDriverRelease.ts`，`taskDriverLifecycle.ts` / `postgresqlTaskDriverLifecycle.ts` 只装配依赖（registry / persistence / 停心跳 / finalizeWorkspace）。中立端口 `TaskExecutionEffectPersistence` 补齐 `unresolvedEffectIds` / `unreapedProcessCode` / `resolveQuiescedManagedProcesses` / `closeOutcomeUnknownAndRelease`，两个适配器都只委托；PG successor 恢复（`postgresqlTaskExecutionRecovery.ts`）改调同一份，本地 `resolveManagedProcesses` / `closeOutcomeUnknown` 删除；新增按客户端品牌分派的 `createTaskExecutionPersistence(db)`（fenced dispatch，账本登记）。`rfc359-t7b-driver-release-settles-effects.test.ts` 七个场景（applied / 未激活 / 证据不足闭合 / child-unkillable / 过期 driver 不碰库 / successor 权威 / exact-stop 证明围栏）两引擎各绿 + 源码锁。**留债**：SQLite 同步 store（`sqliteTaskExecutionEffect.ts`）里的 `resolveQuiescedManagedProcesses` / `closeOutcomeUnknownAndRelease` / `closeRecoveredOutcomeUnknownAndRelease` 同步孪生仍被 `sqliteTaskExecutionRecovery.ts` 调用，W4 pair-deletion 时删；code-host 探针解析（`resolveCodeHostMutations` PG 私有 vs SQLite 同步版）尚未合一，同归 W4 | `postgresqlTaskDriverLifecycle.ts:106-157` vs `taskDriverLifecycle.ts:127-212`（修前锚点） |
| T7d ✅ | **P0-11** 技能启动屏障从不装配 ⇒ 崩溃后该技能永久保存不了 / 同名永远建不了；损坏快照照常注入任务。**已修（2026-09-05）**：PG daemon 在 `applyPendingRestore()` 之后装配 `composePostgresqlSkillCatalogBoot`——fail-closed `runIdentityMigrationBarrier()` → `activateAvailabilityGate()`，HTTP 前 `reconcileLiveFiles()`（best-effort），HTTP 后后台 `backfillLegacyVersions()` + `reverifySnapshots()`，与 `cli/start.ts` 同序；`rfc359-t7d-postgresql-skill-catalog-boot.test.ts` 给 PG daemon 与 rfc223-pr5 同款顺序锁，并在两引擎上各跑一遍屏障/闸/对齐/回填/reverify。两份 boot adapter（`sqlite/postgresqlSkillCatalogBoot.ts`，各 1.4k 行）的合一归 W4 | `composePostgresqlSkillCatalogBoot` 零调用方 |
| T7e ✅ | **P0-12** 工作组反问在 PG 上等于不存在（`protocolBlock` 是 stub，agent 永不发起反问）。**已修（2026-09-05）**：协议块渲染器 `renderWgProtocolBlock` / `wgHostRolePorts`（纯函数）从 legacy/context.ts 迁到 `application/workgroups/workgroupProtocol.ts`，两 provider 共用（legacy 再导出）；「能否反问」按 RFC-207 §3.7.2 只判一次——collaboration 的 `workgroupClarifyAskGate.ts`（预算 / 已问次数 / per-asker stop，公共 participant `createWorkgroupClarifyAskGate` / `countWorkgroupClarifyAsks`），legacy `resolveWgClarifyAllowed` / `countWgClarifyAsks` 只转发；中立驱动的 `WorkgroupTurnsPersistencePort` 新增 `clarifyAllowed`，PG 适配器接 collaboration 的 gate，`clarifyEnabled` 与协议块共用同一个答案；顺带修正驱动里 fc 指派回合的端口错配（stub 对 agent 说 `wg_task_results`，解析却要 `wg_result`；批任务回合现在按 `batchCount` 走 `wg_task_results`）。`rfc359-t7e-workgroup-clarify-ask-gate.test.ts` 两引擎各绿 | `workgroupTurnsDriver.ts:432-439,551-562` |
| T7c ✅ | **任务删除认领无恢复方**：`recoverInterruptedTaskDeletes` 形参是 `LegacySqliteTaskDatabase`，修好启动序列也接不上。**已修（2026-09-05）**：`infrastructure/taskDeleteRecovery.ts` 按 `ProviderNeutralDatabase` + `TerminalMaintenanceStore` 端口重写一份（级联树 parent_task_id BFS 取代 SQLite 递归 CTE；事务开头 `lockAggregateRoot(taskExecutionMaintenanceClaims)`），认领的事务内 `assertClaimTx` / `transitionTx` 合一为 `infrastructure/terminalMaintenanceClaim.ts`；清理计划解析 / 磁盘清理搬入同文件，`services/taskDelete.ts` 只再导出（`deleteTask` 本身仍是 SQLite legacy 路径）；PG daemon 在 `activateAvailabilityGate()` 之后、HTTP 之前调用。`rfc359-t7c-task-delete-recovery.test.ts` 六个场景（io-complete 续做整树 / claimed / recovery-required 行已删 / 计划损坏 / 树变化 ConflictError / 清理挂起）两引擎各绿 + PG daemon 顺序锁。**留债**：SQLite 同步 store 的 `assertClaimTx` / `transitionTx` 仍被 `deleteTask` / archive 路径调用，W4 pair-deletion 时删 | 正常并发的 `ConflictError` 分支即可达 |

**每条都要**：先写一条能稳定复现的红用例（PG 侧），再修，修完再跑一次原变异确认转红。

**W1 的实际形状比「接线」重**：T1（clarify 自动派发）、T2（三条决定命令）、T7b（effect 清算）、
T7c（删除恢复）四条**在 PG 侧根本没有实现**，或**中立端口本身没声明该能力**——不是「写好了没人调」，
是要连端口带实现一起补。规模评估须按这个口径重做，不能按 W3 的接线量类比。

**T7 的次序说明**：P0-1 当前被 P0-7 遮蔽（任务活不到 `runNode`）。T1 落地后 P0-1 是否立刻接棒
**必须实测确认**，不能假定。

## 2. W2 —— 统一事务原语

- **T8** `platform/persistence/transaction.ts`：`DatabaseSession.transaction()`，两个 provider 各一实现
  （design §3.2 / §3.3）。
- **T9** `platform/persistence/writerLease.ts`：SQLite 进程内单写者异步租约 + 重入检出
  （`AsyncLocalStorage`）。
- **T10 ✅** 原子性对拍用例：proposal §3 的三组实测固化，两个 provider 各跑一遍（**AC-3**）——`rfc359-database-transaction.test.ts`（SQLite 前提 + 原语）与 `rfc359-each-provider-harness.test.ts`（双引擎回滚 / 提交）。
- **T11（修订）** ~~`dbTxSync` 改为兼容层~~ **做不到**（同步返回 `T`，转调异步必改签名）。改为：
  逐 context 迁移调用点，与 W4 各批同批；`dbTxSync` 调用点归零时删除。过渡期共存危险形态已由
  `db/transactionScope.ts` 堵死（`88b9a5940`）。
- **T11b ✅** `platform/persistence/capabilities.ts`：`EngineCapabilities` 接口 + 两个 provider 实现
  （design §5）。把散落的既有资产收进来：`postgresqlNullOrdering.ts`、三条 parity 守卫的判据、
  `postgresqlSerializationRetry.ts` 的 `errno` 判据、RFC-357 的 `numeric*` 归一、标量函数 shim 清单。
  每项双引擎实测断言。
- **T11c ✅** PG 会话默认 READ COMMITTED，`serializable(…)` 作 opt-in；`lockAggregateRoot` / `claimRows` /
  `advisoryLock` 三个并发原语落地并双引擎实测。
- **T11d ✅（2026-09-05，CI 实撞 `6efee254f` 后补）** 旁观者隔离：SQLite 统一事务在新的事件循环任务里开始
  （`setImmediate`），过渡期的同步写者不再可能与事务体的微任务链交错；旁观者语句守卫从 `dbTxSync` 扩到全部语句
  （`guardForeignStatements`），事务体跨宏任务时记带调用栈的 error 日志（design §3.2）。同批：runtime registry
  改两阶段停机（`release` 记结果 / `settle` 才唤醒等待者，driver 释放序列在库里 owner 行转移后再 settle）。
- **T12** 事务体软超时 + 结构化诊断；lint 规则禁止事务体内 import 进程/网络/fs（design §3.4）。
- **T13** RFC-311 基准库上实测吞吐前后对比，结果写回 proposal §6 的 **C-2**。

## 3. W3 —— 统一启动序列

- **T14 ✅（2026-09-05）** 监听器与关机序列合一为 `serveDaemon`（`cli/start.ts`），PG 分支与 SQLite 主路径
  都调它；`servePostgresqlDaemon` 删除。SQLite 此前写在监听器 `shutdown()` 里的四步（蒸馏 worker 回收 /
  after-commit 泵注销 / webhook 终态控制停机 / 任务优雅关停）改为会话的关闭参与者，与 PG 同一组 id、同一顺序
  （PG 补 `memory-distill-recover-running`）。`rfc359-w3-t14-serve-daemon.test.ts` 锁：一个 `Bun.serve`、一个
  `serveDaemon`、监听器里不得出现 provider 专属收尾、两会话关闭参与者集合相等。PG 与 SQLite 汇入同一条 boot
  序列的另一半（provider 执行分支归零）是 T16。
- **T15** 逐条接上 PG 缺的 boot 步骤（补审已列全）：boot 恢复四步、skill catalog boot 五项、
  终态工作区回收策略注册、数字员工模板播种、demo 播种、融合三步、定时任务载荷治愈、
  终态维护恢复五项。**多数 PG 适配器已写好且已接进 persistence，只是没人调。**
  - **T15-A ✅（2026-09-05）**：boot 恢复四步（T4）、skill catalog boot 五项（T7d）、终态工作区回收策略注册（P1-12
    注册半边；`postgresqlSourceTerminationParticipant.ts` 手写 UPDATE 不查策略仍待修）、孤儿凭据租约清理、融合三步、
    定时载荷治愈、数字员工模板、demo 播种、webhook 投递恢复、终态维护恢复五项之 delete（T7c）已按 `cli/start.ts`
    同序接进 `postgresqlDaemonApplication.ts`；runtime 注册表 boot 在 PG 路径由 `composePostgresqlProviderSession`
    跑过一次、不重复。`rfc359-w3-t15-boot-step-parity.test.ts` 锁两入口同组标记、同相对顺序。
  - **T15-B ✅（2026-09-05）**：归档恢复上端口 `TaskArchiveMaintenanceCommand.recover(options)`——SQLite 适配器包既有
    `recoverInterruptedArchives`，PG 适配器 = `recoverCompletedIo`（补齐 io-complete 时 tmp 带 manifest 则提升为正式目录的
    同一规则）+ `.tmp-*` 收尾；`.tmp-*` 的提升 / 丢弃 / 放回规则合一为 `infrastructure/archiveTempDirectorySweep.ts`，
    两侧共用。工作区四步走既有中立 `WorkspaceMaintenanceCommand.recover`：新增 `webhookClaims: 'all'`（boot 持单实例锁
    接管全部 webhook-terminal 认领；ticker 仍只接管过期租约）与 `healed`（`listUnstampedTerminalWorkspaces` +
    `healMissingWorkspace` 回填 RFC-165 前被删目录的幽灵工作区）。两个入口同序调用（`archive.recover` /
    `…Maintenance.recover` 进顺序锁）；SQLite boot 的四个 legacy 调用退役（函数本体仍被终态效果 /
    rfc165 / rfc300 / rfc311 黄金锁引用，W4 再删）。中立工厂 `composeWorkspaceMaintenanceCommand(db)` /
    `createTaskArchiveMaintenanceCommand(db)`（落 providerRuntime.ts，避免经 services/taskArchive 成环）。
    `rfc359-w3-t15b-terminal-maintenance-recovery.test.ts` 五个场景两引擎各绿。
- **T16 ✅（2026-09-05）** `cli/start.ts` 的 SQLite 内联装配（1700 行）抽成 `composeSqliteProviderSession`，与
  `composePostgresqlProviderSession` 同一份输入 / 输出契约（`DaemonProviderSessionComposeInput` /
  `ComposedDaemonProviderSession`）；`startCommand` 不再有 provider 执行分支——会话装配经
  `composeDaemonProviderSession` 按 `DatabaseProvider` 查表（`satisfies Record<…>` 穷举），运行时收窄走
  `platform/persistence` 的 `requireDatabaseProviderRuntime`，热切换的会话工厂中立（目标 provider 由
  `databaseProviderTraits(...).migrationRole` 判，不写字面量）。`rfc359-w3-t14-serve-daemon.test.ts` 扩成 T16 守卫
  （唯一 serveDaemon 调用点、startCommand 无 provider 字面量、查表穷举）；RFC-349 fork 账本的 `cli/start.ts`
  条目退役。文件拆分（`cli/sqliteDaemonApplication.ts`）留作纯搬家，随 W4 一起做（30 个读 start.ts 的源码锁要同批改）。
- **T16b** schema 契约补**触发器**维度：今天投影只覆盖表/列/约束/索引，9 个 SQLite 触发器一个都没到 PG。
  首个实锤（2026-09-05，T2a 真库用例）：`rfc328_tasks_lineage_after_insert` / `rfc328_node_runs_lineage_after_insert` 在 SQLite 上回填
  `execution_lineage_id` / `lineage_slot_path_json` / `continuation_slot_key`，PG 上没有——靠它们的插入在 PG 上落成 NULL，
  continuation 准入直接判 `lineage changed`。生产启动路径显式写 `executionLineageId`（`postgresqlTaskRouteLaunchOperations.ts:820`）才没炸；
  任何不走启动路径的插入（测试夹具、修复脚本、node_runs 直插）都会踩到。
  逐条判定「投影成 PG 触发器」还是「上移为应用层判据」，`node_runs.lineage_slot_path_json` 是唯一
  当前没有应用层等价物的一条。
  **T2c 实证②（2026-09-05）**：`tasks.owner_user_id → users(id)` 的 FK 只存在于 SQLite 迁移 `0020_rfc036_task_collab.sql`（`schema.ts` 无 `references`，PG 投影无此约束；双引擎夹具因此要显式插 users 行）——迁移 SQL 与 drizzle schema 的差集也要进 T16b 的对账。

## 4. W4 —— 逐 context 合一适配器

按前置对账的缺陷密度排序，**每个 context 一个 PR**：

| 批 | context | 配对数 | 已知缺陷 |
| --- | --- | --- | --- |
| B1 | task-execution | 44 | 最多（P0 ×4 + P1 ×10+） |
| B2 | resource-catalog | 29 | P0 ×1 + P1 ×10 |
| B3 | collaboration | 19 | P0 ×2 + P1 ×2 |
| B4 | memory / identity-access / intent / integration / auth | 25 | P1 ×2 |
| B5 | digital-employee / development-automation / code-capability | 23 | P0 ×1 + P1 ×1 |
| B6 | platform / event-center / source-control / knowledge-evolution | 13 | **0**（本就同构，机械合一） |

每批的做法见 design §4。**B6 放最后**：它零缺陷，是最干净的收尾，也是给守卫钉棘轮的基线。

- **B1 进度（2026-09-05）**：42 对（对拍脚本按 provider 名归一后算相似度：3 对逐字相同、~10 对只差客户端类型 /
  少量方言、其余是「SQLite 薄壳套 legacy 同步实现 vs PG 整份实现」）。**批 1 ✅**：逐字相同的三对合一——
  `taskOverviewQuery.ts` / `branchTraceSnapshotReader.ts`（`DrizzleBranchTraceSnapshotReader`）/
  `taskRollbackQueries.ts`（`DrizzleTaskRollbackQueries`，SQLite 孪生此前无消费者），六个 provider 文件删除，
  `rfc359-w4-b1-identical-adapters.test.ts` 两引擎各跑 + 源码锁；RFC-349 cutover 账本对应边退役。
  **批 2a ✅**：只差客户端类型 / 同步异步形态的五对合一——`gateContinuationEffectPersistence.ts`（effect 持久化经端口注入，
  `settleGateRollback` 上 `TaskExecutionEffectPersistence` 端口）/ `nodeActivationSnapshotReader.ts` / `taskArtifactPathQueries.ts`
  / `dynamicWorkflowPersistence.ts`（两个 compose 具名工厂只做绑定）/ `frameBackfillStore.ts`（`applyRunFrames` 改走统一事务原语，
  此前 PG 用裸 `db.transaction`、SQLite 用 dbTxSync），十个 provider 文件删除；`rfc359-w4-b1-batch2a-adapters.test.ts` 两引擎各跑
  + 源码锁；RFC-349 fork 账本 `frameBackfill.ts` 条目退役。**批 2b ✅**：`taskExecutionReadModels.ts`（`createTaskExecutionReadModels`；composition 的
  `composeSqlite/PostgresqlTaskExecutionReadModels` 只是绑定别名）/ `taskLifecycleWsProjection.ts`（`createDatabaseTaskLifecycleWsProjection`
  / `Projector`，`committedEvents` 的 provider 具名导出为别名）/ `childTaskBudgetQueries.ts`（`DrizzleChildTaskBudgetQueries`），六个 provider
  文件删除；`services/execution/{childBudget,executionWatch,outcome,startupVerificationRead}` 改指中立实现，RFC-349 cutover 账本四条
  legacy → sqlite 边退役（基线 62 → 58）；`rfc359-w4-b1-batch2b-adapters.test.ts` 两引擎各跑 + 源码锁。**批 2c ✅**：先落中立的
  `infrastructure/ownedTaskExecution.ts`（`withTaskExecutionWrite` 统一写事务 + `assertTaskOwnerTx` owner CAS + `assertTaskOwnerlessTx`
  无主围栏 + `fenceTaskWrite` 「显式上下文 > 环境上下文 > 无主围栏」），再把 `wrapperRunPersistence.ts` / `nodeRunRuntimePersistence.ts`
  （freeze 两侧都过围栏，此前 PG 侧无围栏）/ `schedulerCompletionPersistence.ts` / `taskIdleTimeoutPersistence`（两个具名工厂退为别名）
  合到它上面，八个 provider 文件删除；rfc359-t7 源码锁与 rfc294Canonical worker-epoch 正则改指中立文件；
  `rfc359-w4-b1-batch2c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 26 对（按对拍脚本重数：批 2b 后是 30 对，非此前记的 31）。
  **批 2d ✅**：`runtimeSessionCapturePersistence.ts` / `gateContinuationPreDrivePersistence.ts` / `mergeStateLifecyclePersistence.ts`
  （读 + CAS 写同一事务）/ `taskEngineApplicationPersistence.ts` 四对合到 `ownedTaskExecution.ts` 上，八个 provider 文件删除；
  SQLite 统一事务补回 RFC-111 PR-D 的 `BEGIN IMMEDIATE` 写锁重试（复用 `retrySqliteWrite`，只包 BEGIN）——此前只有 SQLite 的
  会话捕获适配器单独包着，合一后不能丢；rfc144 merge_state 直写清单 5 → 4、rfc341 / rfc359-t7 源码锁与 rfc294Canonical 正则改指
  中立文件；`rfc359-w4-b1-batch2d-adapters.test.ts` 两引擎各跑 + 源码锁。剩 22 对（`TaskRecoveryOperations` 0.89 是下一个，
  其余多与 B2 / B3 的对（resource snapshots / human gate）或 lifecycle 对耦合）。
  **批 2e ✅**：`taskRecoveryOperations.ts`（两份约千行合成一份）——取 SQLite 的形状，四条状态迁移由 provider 装配面注入
  （PG 侧新增 `createPostgresqlRecoveryAdministration`，与 SQLite 侧同形），`recordAutoRecoveryAttempt` 取 PG 的
  事务形态，PG 内联的租约孤儿修复抽成 `repairRuntimeSessionLeaseAfterOrphanReapTx`；s14 / s15 / terminal-status /
  rfc294Canonical 改指中立文件；`rfc359-w4-b1-batch2e-adapters.test.ts` 两引擎各跑 + 源码锁。剩 21 对。
  **批 2f ✅**：`nodeExecutionPersistence.ts`（最热的写路径：统一写事务 + 围栏，PG 聚合根行锁改由能力矩阵
  `lockAggregateRoot` 表达）/ `taskListPage/database.ts` / `taskCatalogSources.ts`（两对薄壳），六个 provider 文件删除；
  `rfc359-w4-b1-batch2f-adapters.test.ts` 两引擎各跑 + 源码锁。剩 18 对（其中 human gate / resource snapshots 与 B2 / B3
  耦合；lifecycle 内核四对〔task runtime lifecycle / node run lifecycle / intent / intent terminal〕与 shutdown /
  auto-repair / archive / route / launch / child launch / runtime participants 十对是「SQLite 薄壳套 legacy 同步内核 vs PG
  整份实现」，下一步先合 lifecycle 内核）。
  **批 2g ✅**：lifecycle 内核四对合一——`taskRuntimeLifecyclePersistence.ts` / `nodeRunLifecyclePersistence.ts`（含事务内参与者
  `createNodeRunLifecycleParticipantInTx`）/ `taskExecutionIntentPersistence.ts` / `taskExecutionIntentTerminalPersistence.ts`（含
  `terminalizeTaskExecutionIntentsInTx`；intent 两条沿用 `serializable`），八个 provider 文件删除，SQLite 同步内核
  （`platform/persistence/sqlite/taskLifecycle.ts` 等）暂留给 legacy 直接调用方。**顺带修掉合一暴露的两条缝**（批 2f 推上 main 后
  CI 全红的根因）：①io-virtual 行「born done」但输出在下一笔事务才落——统一事务在新的事件循环任务里开始后，另一条调度扫描能在两笔
  之间看见没有输出的 done 行并派发下游（`scheduler.test.ts` 多边并入同一端口丢了第二个输入）；`NodeRunMintInput.outputs` 让行与初始
  输出同一事务落库。②SQLite 统一事务的写锁重试改为**整笔重跑**（沿用 `retrySqliteWrite` 判据），此前只包 BEGIN，`runner.test.ts`
  注入在 insert 上的 BUSY 不再被兜住。`rfc287-t13` 把「准备行在 startTask 返回时已存在」的同步假设改为轮询。剩 15 对。
  **批 2h ✅**：`taskExecutionShutdownOperations.ts`（停机幸存者处置：控制面 CAS **不过围栏**——幸存者的 owner 仍是 claimed，
  与下一次启动的孤儿收割同理；`markRecoveryRequired` 取 SQLite 的精确元组 + revision CAS）；rfc294Canonical 把 2g 的三个
  lifecycle / intent 中立文件从 worker-epoch 改回 control-revision 归类；`rfc359-w4-b1-batch2h-adapters.test.ts` 两引擎各跑 + 源码锁。
  剩 14 对：human gate（B3）/ resource snapshots（B2）/ runtime participants / source termination / effect persistence /
  runtime session leases / auto-repair / execution recovery / ownership / archive / route / route launch / child launch /
  terminal maintenance——后面这十几对都是「SQLite 薄壳套 legacy 同步内核 vs PG 整份实现」，随 dbTxSync 调用点归零一起合。
- **B2 进度（2026-09-05）**：29 对。**批 a ✅**：`infrastructure/resourceCatalogTransaction.ts`（目录写事务的统一原语：
  `DatabaseSession.serializable`，目录写入有跨行不变量，沿用 PG 的 SERIALIZABLE）+ 四对只差客户端类型 / 事务原语的合一——
  `demoResourceCatalogSeed.ts` / `mcpProbeStore.ts` / `pluginGenerationGc.ts` / `agentResourceInventory.ts`（库存读取的 db 绑定并进
  既有共享文件），八个 provider 文件删除；rfc345 / rfc349 / rfc199 的「两份真实适配器」源码锁改为「一份中立实现、不含 provider
  名」；`rfc359-w4-b2a-adapters.test.ts` 两引擎各跑 + 源码锁。剩 25 对（下一批：AclRegistry + ResourceGrantRepository 的可见性
  谓词合一，随之带 ResourceCatalogOverview / CatalogQuery——后者的 `instr(lower(…))` 在 PG 上有同名 shim，可直接一份）。
  **批 b ✅**：`infrastructure/resourceVisibility.ts`（ACL 表注册 `ACL_TABLES` + 可见性阶梯 `visibleRowsCondition` + grant 谓词 +
  Promise 形态的 `createResourceGrantReadPort`）一份；`sqliteAclRegistry` / `postgresqlAclRegistry` 的表注册退为别名，
  `sqliteResourceGrantRepository` 只留 legacy 同步 `*InTx` 读法并转发中立件，`postgresqlResourceGrantRepository` 删除；
  `resourceCatalogOverview.ts` / `catalogQuery.ts`（搜索谓词统一为 `instr(lower(…))`，PG 基线有同名 shim；SQLite 侧三个无消费者的
  全量翻页便捷函数删除）合一，四个 provider 文件删除；rfc349 ACL 边界 / rfc345 合同 / rfc305 / rfc349 PG adapters 源码锁改指中立文件；
  `rfc359-w4-b2b-adapters.test.ts` 两引擎各跑（可见性阶梯四态 / grant 三法 / 概览计数 / 搜索与 after 游标）。剩 21 对。
  **批 c ✅**：`mcpRuntimeTestPersistence.ts`（约两千行，对拍归一后 0 处语义差异）/ `mcpRuntimeTestLease.ts` 合一，四个 provider 文件
  删除；SQLite 侧五个独立导出的同步租约函数没有外部消费者（服务层早已只经 `McpRuntimeTestLeaseOperations` 端口）一并删除；
  rfc349 NULL 排序守卫的 NULL-free 证明条目随 PG 文件退役（守卫只扫 PG 执行面，中立文件的同一句 ORDER BY 由 DB CHECK 保证）；
  `rfc359-w4-b2c-adapters.test.ts` 两引擎各跑。剩 19 对。
- **B3 进度（2026-09-05）**：19 对。**批 a ✅**：六对只差客户端类型 / 事务原语的适配器合一——`taskFeedbackStore.ts`
  （`DrizzleTaskFeedbackStore`）/ `reviewNodeReviewerStore.ts`（替换指派走统一事务）/ `collaborationTaskAccess.ts` /
  `reviewTaskAccess.ts`（取 SQLite 的单查询成员判定）/ `humanGateContinuationRecovery.ts` / `humanGateTerminalSweep.ts`（统一事务 +
  同一笔里追加 node-statuses committed event），十二个 provider 文件删除，`composition.ts` 留 `createSqlite… / createPostgresql…`
  具名绑定给两个 bootstrap；PG daemon 装配任务可见性端口改经 collaboration composition，`cli/postgresqlDaemonApplication.ts ->
  collaboration/infrastructure/postgresqlCollaborationTaskAccess` 这条 R1 债随文件删除还清（commons-debt baseline 288→287）；
  rfc294Canonical terminal-maintenance 正则 / lifecycle-grep-guard 清单 / rfc202 源码锁改指中立文件；rfc202 T3 用例改为等清扫落定
  （终态清扫只剩一份异步实现，SQLite 侧不再在提交后钩子里同步完成）；`rfc359-w4-b3a-adapters.test.ts` 两引擎各跑 + 源码锁。
  剩 13 对（human gate open / review repair / clarify seal / collaboration runtime mechanics 等与 lifecycle 内核耦合的对，随
  dbTxSync 归零一起合）。
- **B4 进度（2026-09-05）**：25 对。**批 a ✅**：identity-access `ownerIdentityQueries.ts` / memory
  `memoryDistillReadStore.ts` + `memoryInjectionReadStore.ts` / integration `terminalWorkspaceAttribution.ts` +
  `webhookEndpointAdministration.ts` + `webhookTriggerAdministration.ts` + `webhookDispatchRuntime.ts`（执行器调用面，
  RFC-243 / RFC-257 / RFC-321 源码锁改指中立文件）七对合一，十四个 provider 文件删除；`composition/webhookDispatch.ts`
  留 `createSqlite… / createPostgresql…` 具名绑定给两个 bootstrap。双引擎用例在真 PG 上抓到一条老 PG 适配器就有的
  P1：`memoryInjectionReadStore` 用模块顶层常量捕获 `memories.*` 列，绕过 provider 投影代理，`createdAt / version /
  approvedAt` 以字符串回到注入逻辑——改为查询时取列（见 `docs/dev-gotchas.md`）。`rfc359-w4-b4a-adapters.test.ts`
  两引擎各跑 + 源码锁。剩 18 对（intent 的 SQL 程序执行器 / IntentPersistence 两对是「同步程序 + 同步授权会话 vs 异步」，
  随 dbTxSync 归零一起合；其余为 integration 的 delivery / dispatch / MR 终态控制 / 定时任务持久化等）。
  **同批修守卫盲区**：`tests/architecture/postgresqlSurface.ts` 的 PG 执行面判据只认 provider 名与 PG 客户端类型，
  RFC-359 的中立句柄不在其中——每合一一对，新的中立实现就整体掉出三条 RFC-349 陷阱守卫的视野（前三批后执行面
  204 → 191）。判据纳入 `ProviderNeutralDatabase` / `DatabaseTransaction` / `databaseSessionFor(`（执行面 265），
  当场抓到并处置 9 处可空列裸排序 + 1 处裸 like（`services/task.ts` / `legacySqliteReview.ts` 改走
  `engineOf(db).ascNullsFirst / descNullsLast`，`mcpRuntimeTestPersistence.ts` 的最早空闲截止补 `isNotNull`，
  四处 gate revision 读法与 `effectQuiescence` 的机器标记匹配登记为可证明 / 有意精确）。`rfc349-dual-provider-predicate-drift`
  的过期配对登记（B2 批 b 合掉的 `CatalogQuery::catalogWhere`）曾把 main 推红一轮（dd1879ecd 热修），配对数下限与
  执行面下限改按 W4 的收敛趋势设置（配对 > 0；执行面 ≥ 100，两份变一份后收敛到约 180）。
  **批 b ✅**：integration `codeHostEventResponseDirectory.ts` / `webhookDispatchPersistence.ts` / `webhookDeliveryQueries.ts`
  （仓库路径枚举保留 loose index scan 的递归 CTE，表与列改经 drizzle 引用渲染——PG 侧带 schema 前缀，裸表名在 PG 上根本
  跑不通；计数走 drizzle `count()`）/ `mrTerminalControlPersistence.ts`（统一事务；PG 侧「先按流序列化再看 open 状态」的事务级
  advisory lock 改由引擎能力矩阵 `advisoryLock` 表达，SQLite 单写者下 no-op）四对合一，八个 provider 文件删除；rfc261 /
  rfc349 PG adapters 的源码锁改指中立文件与能力矩阵；`rfc359-w4-b4b-adapters.test.ts` 两引擎各跑（含 MR 守卫状态机、按流认领
  与开机对账）+ 源码锁。剩 14 对：intent 两对与 `scheduledTaskPersistence` / `integrationTriggerResources`（同步授权会话）随
  dbTxSync 归零一起合；`webhookDeliveryPersistence` / `verifiedWebhookDelivery{Store,Persistence}` PG 侧多出 MR 守卫与
  notExists 逻辑，需要先对账再合；其余为 identity-access / memory 的大对。
  **批 c ✅**：identity-access `oidcProviderRepository.ts`（写路径走统一原语的 `serializable`——PG SERIALIZABLE + 重试、SQLite
  独占事务；slug 撞库经能力矩阵 `classifyError` 归类再核对约束名）/ memory `memoryDistillWorkStore.ts` 两对合一，四个 provider
  文件删除；`memoryDistillSessionCapture.ts` 的两个 sink / 两个工厂合成一份。identity-access 公共面只导出
  `DrizzleOidcProviderRepository`，rfc349 cutover 账本里 public → provider 适配器的两条债随之还清；
  `rfc359-w4-b4c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 12 对。
- **B6 进度（2026-09-05）**：7 对（event-center 3 / source-control 3 / knowledge-evolution 1；platform/persistence 的 provider
  命名文件按 W5-T17 允许留在原地，不计入）。**批 a ✅**：source-control `workspaceMaintenanceStore.ts` /
  `repositoryWorkspaceStore.ts` + event-center `eventResponseRuleStore.ts` / `customEventSourceStore.ts` 四对合一，八个 provider
  文件删除。仓库工作区存储把三处方言差异收进引擎能力矩阵：PG 的 `LOCK TABLE … SHARE ROW EXCLUSIVE`（仓库组图版本核对）改为
  事务级 `advisoryLock`；SQLite 聚合面板的 `INDEXED BY` 改为新增能力 `indexHint`（PG 空）；凭据擦除后的
  `secure_delete + checkpoint + VACUUM` 改为新增能力 `reclaimScrubbedStorage`（PG 交给 autovacuum）。自定义事件源发布保留
  PG 版事务末尾的 CAS。`composition/workspaceMaintenance.ts` 退成一条路径。`rfc359-w4-b6a-adapters.test.ts` 两引擎各跑 +
  源码锁。剩 3 对（`eventStore` 1377 行、`repositoryTransportCredentialRepository`、knowledge-evolution `fusionRepository`
  ——后者带跨 context 的同步事务参与者，随 dbTxSync 归零一起合）。**顺带观察到的对账缺口（未处置，记 P2）**：
  `repo_group_nodes` 上「group 挂载不得带 ref / subdir」的 CHECK 只在 SQLite 生效，PG 基线没有投影该约束（双引擎用例里
  同一条非法节点 SQLite 拒绝、PG 接受；批 c 又撞到第二处：`repository_transport_connections.endpoint_binding_digest`
  的「64 位十六进制」与 `token_hint` 定长 4 的 CHECK 同样只在 SQLite 生效）——PG schema 投影器对 SQLite CHECK 的覆盖面要单独盘一次，归 W5 守卫。
  **批 b ✅**：event-center `eventStore.ts`（1377 行的孪生对）合一，两个 provider 文件删除——以 PG 版为底（`count()`、
  `returning` 可见性判定、订阅 / 事件记录的 `onConflictDoNothing` 幂等插入两侧同形），四笔多语句写走统一事务原语，观察者到期
  扫描的 NULL 落位经能力矩阵 `ascNullsFirst` 表达；rfc349 null-ordering 与 event-delivery 用例改指中立文件。
  `rfc359-w4-b6b-adapters.test.ts` 两引擎各跑（登记 / 订阅幂等 / 观察判重 / 投递认领与结算围栏 / 观察者认领与 obsolete 结算）
  + 源码锁。剩 2 对。
  **批 c ✅**：source-control `repositoryTransportCredentialRepository.ts` 合一，两个 provider 文件删除（以 PG 版为底，四笔
  多语句写走统一事务原语，行数判定改用 `affectedRows`）；composition 留两个具名绑定；rfc349 promise-contract 源码锁改指中立
  文件。`rfc359-w4-b6c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 1 对（knowledge-evolution `fusionRepository`：带 memory /
  resource-catalog 的同步事务参与者，随 dbTxSync 归零一起合）。
- **B5 进度（2026-09-05）**：23 对。**批 a ✅**：code-capability 七对（`capabilityParamRead` / `capabilityTemplatePersistence` /
  `codeWorkspaceRead` / `demoSeedPersistence` / `repoEndpointRead` / `readinessFactsRead` / `roundAttemptsRead`）+
  development-automation 两对（`cutoverStore` / `employeeWorkspacePersistence`）机械合一，十八个 provider 文件删除。差异全部收进
  既有原语：模板名字撞库经 `classifyError` 归类；节点 run 列表「未启动排最前」经 `ascNullsFirst`；演示种子多语句写走统一事务
  原语；投影列在函数内取。六个 composition 两条 bootstrap 路径装同一份，`createSqlite/PostgresqlCapabilityTemplatePersistence`
  留作装配别名（server.ts / postgresqlDaemonApplication.ts 仍按旧名取，bootstrap 收敛时删）。rfc349 cutover 账本
  `legacyResourcePackageMutationDependencies → sqliteCapabilityTemplatePersistence` 那条债随之还清（55 → 54），rfc317 表归属账本
  的两个 provider 站点并成一个（19 → 17），commons-debt R1 的同一条边改指中立文件。`rfc359-w4-b5a-adapters.test.ts` 两引擎各跑；
  两个 provider 边界锁的家族表改为单文件。剩 14 对（`DeliveryChain` 21 hunk / `TemplateUpstreamPersistence` 18 /
  `WorkItemProjectionRead` 10 / `ReviewerResolutionRead` 7 / `ReactionRoundQueries` 13 / `IntegrationTriggerParticipant` 7 /
  `UploadPlanStore` 20 / `ReconcilerReaders` 24 / `AdmissionLookup` 33 / `PlaybookSagaStore` 37 / `RuntimeStore` 59 /
  `AuthoringStore` 75 / `ConfigResourceStore` 90 / `MissionStore` 145——按 hunk 数从小到大逐批合，先对账再合）。
  **批 b ✅**：code-capability `reviewerResolutionRead`（类 `DrizzleReviewerResolutionRead`）/ `workItemProjectionRead`（`count()`
  聚合、三组投影列改为函数内取）/ `deliveryChainRead`（SQLite 版三个裸函数并进端口工厂，保留其表设计注释）/
  `templateUpstreamPersistence`（PG 版的两次 `SELECT … FOR UPDATE` 锁定读改为能力矩阵 `lockAggregateRoot`，事务走统一原语；
  SQLite 的 dbTxSync 参与者退役）+ digital-employee `reactionRoundQueries`（`descNullsLast` 经能力矩阵表达）五对合一，十个 provider
  文件删除；drift 守卫里 `DeliveryChain.ts::toRow` 的豁免随孪生对消失一并删除。`rfc359-w4-b5b-adapters.test.ts` 两引擎各跑
  + 源码锁。剩 9 对（`IntegrationTriggerParticipant` 带 dbTxSync 同步参与者，随 dbTxSync 归零一起合；其余 8 对为
  `UploadPlanStore` 20 / `ReconcilerReaders` 24 / `AdmissionLookup` 33 / `PlaybookSagaStore` 37 / `RuntimeStore` 59 /
  `AuthoringStore` 75 / `ConfigResourceStore` 90 / `MissionStore` 145）。
  **批 c ✅**：development-automation `reconcilerReaders`（六个纯读查询保留 SQLite 侧的函数名、PG 侧的 async 形状）/
  `admissionLookup`（以 PG 版为底自带查询，不再借道 SQLite 的 assignment / employee store 同步助手）/ `uploadPlanStore`
  （读回带 disposition 投影；`insertUploadPlan` 改为在调用方事务句柄上异步落库——PG mission store 的内联落库改用它；
  SQLite mission store 的 launch 事务仍是 dbTxSync 同步形状，留一份文件私有的 `insertUploadPlanSync`，随 MissionStore
  合一一起删）三对合一，六个 provider 文件删除。`rfc359-w4-b5c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 6 对，全部是
  「SQLite 同步 store（dbTxSync）+ async 包装 vs PG 整份 async 实现」：`PlaybookSagaStore` / `RuntimeStore` / `AuthoringStore` /
  `ConfigResourceStore` / `MissionStore` / `IntegrationTriggerParticipant`——合一 = 该 context 的 dbTxSync 调用点归零，
  按 §W4 的「逐 context 迁移」推进，PG 版为底。
- **dbTxSync 归零路线（2026-09-05 起，W4-D 系列）**：剩下的 65 对几乎全是「SQLite 同步 store（dbTxSync）+ async 包装 vs PG
  整份 async 实现」，合一 = 该 context 的 dbTxSync 调用点归零，PG 版为底、经统一事务原语接进 SQLite 装配。同步事务参与者
  跨 context 传递（resource-catalog 的资源快照 / ACL 参与者被 integration / task-execution / intent / collaboration /
  memory / knowledge-evolution 的同步事务消费），所以按**依赖链从叶到根**推进：先把被消费的参与者换成中立的
  `DatabaseTransaction` 参与者（PG 版本就是），再把消费方 context 的事务改走 `databaseSessionFor(db).transaction`，
  最后 resource-catalog 自己的 68 处调用点收尾。每一步都是「一条链一批」，双引擎用例 + 源码锁 + 宽批次照旧。
  **D1 ✅（integration 触发器链）**：digital-employee `integrationTriggerParticipant.ts`（绑定统一事务句柄的 owner 参与者，
  同步参与者 `…ParticipantSync` 退役）/ resource-catalog `aggregateAdapters/integrationTriggerResourceSnapshots.ts`
  （以 PG 读取器为底：ACL 判定用 domain 的 `resolveAccessFrom` + grants 读，行映射用中立的 agent / workflow 映射器；
  workgroup 映射器仍在 PG 命名的仓库文件里，随 B2 合一挪名）+ `composition/integrationTrigger.ts` 单一工厂
  （`inTransaction(tx: DatabaseTransaction, pair, digitalEmployees)`；`application/participants/integrationTriggerResourceSnapshot.ts`
  的同步端口分派与 public 的 `IntegrationTriggerResourceSnapshotInTx` 类型一并退役）/ integration
  `scheduledTaskPersistence.ts`（四笔多语句写走统一事务原语，认领 CAS 用 returning 判定）+ `integrationTriggerResources.ts`
  + `composition/scheduledTasks.ts` 的 `composeScheduledTaskRuntimeFor` / `composeIntegrationTriggerResourceQueries`；
  server.ts / cli/start.ts 的 SQLite 装配改交快照工厂（不再传 `canViewResourceInTx` 同步 ACL 与同步数字员工参与者），
  九个文件删除，integration 的 dbTxSync 调用点 9 → 0（scheduledTask 相关）。`rfc359-w4-d1-adapters.test.ts` 两引擎各跑
  （写事务里加载已授权快照 / 私有资源对外人 404 / CAS 认领 / 记账与自动停用 / ACL 原子替换 / 数字员工快照与归档）+
  rfc345 / rfc349 锁改指中立文件。**下一条链**：integration 的 webhook 投递与验证（`webhookDeliveryPersistence` /
  `verifiedWebhookDelivery{Store,Persistence}`，PG 侧多出 MR 守卫与 notExists 逻辑，先对账）与 `developmentAdapterStore`。
  **D2 ✅（integration webhook 投递链）**：`webhookDeliveryPersistence.ts`（以 PG 版为底：同 uuid 重投的 attempt bump 改为
  `UPDATE … RETURNING` 一步原子；GC 两段各自「先选 id 再改 / 删」在统一事务原语里，SQLite 此前的 rowid 子查询方言退役；对账
  结论：PG 侧的 notExists 守卫（未成功的控制 effect / 活跃启动守卫）与 SQLite 的原生 SQL 语义相同）+
  `verifiedWebhookDeliveryPersistence.ts`（以 PG 版为底，MR 流序列化锁经能力矩阵 `advisoryLock` 表达，与启动预留共用
  `${endpointId}:${streamKey}` 键；SQLite 的同步 `SqliteVerifiedWebhookDeliveryStore` 与 application 的同步
  `createAcceptVerifiedWebhookDelivery` 一并退役）两对合一，四个 provider 文件删除；webhookIngress / webhookDelivery /
  webhookTerminalControl / webhookDispatch 四个 composition 两条路径装同一份。`rfc359-w4-d2-adapters.test.ts` 两引擎各跑
  + rfc303 用例改走异步端口 + rfc349 锁改指中立文件。integration 剩 `developmentAdapterStore`（SQLite 同步 store 被五个
  composition 与 application 命令同步消费；PG 侧只有只读修订面——「一好一坏」的存量，须把 application 命令改异步后合一）
  与 `scheduledTaskPersistence` 之外的对已清零。
  **D2 顺带抓到的 PG 功能缺口（已修）**：`webhook_deliveries` 的两条部分唯一索引（`idx_webhook_deliveries_dedupe` /
  `idx_webhook_deliveries_mr_fact`）此前只在 SQLite 迁移 0157 里存在、没进 drizzle 声明；PG 投影（`buildLogicalSchemaContract`
  只读 drizzle 声明）因此没有它们——同 uuid 重投与 MR 同事实重投在 PG 上不撞唯一键，去重分支永远走不到。本批把两条索引
  逐字进 `schema.ts`，PG 基线 / journal 用 `bun run db:rfc349-postgresql-schema` 重采（contract digest 变化，已部署的 PG
  目标须按 RFC-349 重做 cutover——与 RFC-354 PR-1 同规则；PG 侧尚无增量迁移，记 W5-T19h）。**这是一类系统性缺口**：凡是
  迁移 SQL 里手写而未进 drizzle 声明的索引 / CHECK / 触发器，PG 都没有（B6 记的 `repo_group_nodes` / 传输凭据 CHECK 是同一类）。
  W5-T19g 做一次「迁移后 sqlite_master vs 逻辑契约」的对账守卫，把所有此类差异要么补进声明、要么显式登记为 SQLite 专属。
  **D3 ✅（resource-catalog ACL 内核）**：目录自有 ACL 类型的读端口（`aclReadRepository.ts`：快照读在目录写事务原语里，
  owner / name 预检与七个异步读助手中立）、写端口（`resourceAclRepository.ts`：identity 行 CAS + grants 整体替换 +
  after-write 钩子同一事务，owner+name 撞库经能力矩阵 `classifyError` 归类再核约束名）与 `aclRegistry.ts`（唯一性类型集 /
  约束名一份，旧 PG 名留作别名）合一，PG 三个文件删除；`providerResourceCatalog.ts` 两条装配路径装同一份
  （`composeResourceCatalogFor`），`composition/resourceAcl.ts` 的默认路径（无 owner 侧 identity persistence、无同步
  after-write 钩子）改走中立端口，带同步参与者的调用（development_adapter / employee_* 的 identity persistence、mcp 装配的
  同步钩子）仍走 SQLite 同步路径，随各 owner 的 dbTxSync 归零一起退。`rfc359-w4-d3-adapters.test.ts` 两引擎各跑。
  剩余 SQLite 专属：`sqliteResourceAclRepository.ts`（identityPersistence 分支 + 同步 withMutation）、
  `sqliteAclReadRepository.ts`（`*InTx` 同步读，workgroup / legacy 快照消费；memory 用的同步快照读端口已随 D4 退役）、
  `sqliteResourceGrantRepository.ts`（`*InTx`）——它们是「同步参与者」的最后一层，随 D 系列逐链退役。
  **D4 ✅（memory 目录链）**：`memoryCatalogOperations.ts`（以 PG 版为底、逐命令按 SQLite 正典语义对账：晋升 / 编辑 / 迁移
  scope 的多语句写走统一事务原语并在事务提交后才发 WS；编辑与迁移经版本 CAS；迁移在授权判定后二次读行（带 `currentVersion`
  的 stale 详情）并刷新 actor 再判一次，`changedFields` 逐字段；scope 的资源访问由 resource-catalog 的中立 participant 在
  同一事务里回答，repo / repo_group 的存在性与管理权由 source-control 的中立读取器回答；搜索经能力矩阵
  `likeCaseInsensitive` + `likeEscape`。**一处有意偏离**：用户搜索词里的 `%` / `_` 此前在两个 provider 上都按 LIKE 通配符
  解释——「100%」会命中「100」开头的任何正文——现在按字面匹配，且不再有裸 LIKE 模式）+ `skillMemoryFusionParticipant.ts`
  （PG 融合 participant 转中立；`listFusedIntoSkill` 一份）+ `memoryDistillRuntimeResolver.ts`（一份类，旧类名留别名）+
  `composition.ts` 单一路径（`composeMemoryOperationsFor` / `composeMemoryCatalogOperations`，旧 provider 名保留为装配
  别名；测试用故障注入缝 `MemoryCatalogTestHooks` 只在装配时给）。resource-catalog：scope 访问 participant 的唯一 owner 工厂
  进 application（`createResourceScopeAccessParticipant(reads)`），中立读取器 `aggregateAdapters/resourceScopeAuthorization.ts`，
  装配 `composition/resourceScopeAuthorization.ts`；端口归 memory（`application/ports/resourceScopeAccess.ts`），resource-catalog
  的 public 面不引 Actor、不点名事务句柄；同步的 `ResourceScopeAuthorizationInTx`（public brand）/
  `composeResourceScopeAuthorizationBinding` / `createSqliteResourceCatalogAclSnapshotReadPort` / `ResourceCatalogAclSnapshotReadPort`
  退役。source-control：`repositoryScopeExistenceReads` 一份（SQLite 同步读取器退役，PG 名留别名）。platform 的 SQLite overview
  读模型改经 memory 目录合同取记忆计数。legacy facade `services/memory.ts` 与 SQLite 专属 `sqliteMemoryCatalog.ts`（1282 行的
  函数式面）退役，十四个测试文件改经 `MemoryCatalogOperations` 合同（`tests/helpers/memoryCatalog.ts`）。九个文件删除，memory
  的 dbTxSync 调用点只剩 `sqliteMemoryMembershipParticipant.ts`（knowledge-evolution 同步融合提交要的，随 KE 归零一起退）。
  `rfc359-w4-d4-adapters.test.ts` 两引擎各跑（目录 CRUD / 搜索大小写与字面通配 / 替代链 / 编辑 OCC / WS / 分页等价 /
  可见性与管理权矩阵 / scope 迁移含测试缝下的回滚 / 融合 participant / 仓库 scope 读取器）+ rfc345 / rfc347 / rfc305 / rfc349 /
  rfc353 锁改指中立文件，两个 fake-PG 单测（memory catalog / fusion）随之删除；rfc349 cutover 账本还清一条（54 → 53），
  rfc294 capability 兼容债还清三条（29 → 26）。**下一条链**：knowledge-evolution 融合提交（`markFusedSync` /
  `unfuseAboveVersionSync` 的同步消费方：KE 的 `sqliteFusionRepository` 与 resource-catalog legacy `skillVersion.ts`）与
  `developmentAdapterStore`。
  **D5 ✅（knowledge-evolution 融合链）**：`fusionRepository.ts`（以 PG 版为底：十处 dbTxSync 事务改走统一事务原语；
  技能操作锁撞库经能力矩阵 `classifyError` 归类成同一个 `skill-operation-busy`；跨聚合的两半——memory 的成员关系、
  resource-catalog 的版本提交——经 tx-bound participant 工厂注入，provenance 修复逐条各自开事务走同一个 participant）+
  resource-catalog `skillVersionCommitParticipant.ts`（版本提交写入面一份：复合前置条件重验 + `skills` 推进 + `skill_versions`
  落行，判据仍只在 `domain/skillVersionCommit`）+ KE `composition/fusion.ts` 单一路径（`composeFusionPersistenceFor` /
  `composeFusionOperationsFor`，旧 provider 名保留为装配别名）。memory 的 SQLite 同步融合写入面（`markFusedSync` /
  `reassignFusedSkillSync` / `composeSqliteFusionMemoryMembership`）与 resource-catalog 的 `sqliteSkillVersionCommitSync` /
  `composeSqliteFusionSkillVersionCommit` 退役；server.ts / cli/start.ts / system-operations 三处 SQLite 根改交中立工厂
  （与 PG daemon 同一份）。四个 provider 文件删除，knowledge-evolution 的 dbTxSync 调用点 10 → 0。留下的同步残余只有
  legacy 技能回滚那一条（memory `unfuseAboveVersionSync` + resource-catalog `sqliteSkillVersionCommitParticipant.ts` 的两个
  同步栅栏助手，都被 `legacy/skillVersion.ts` 的 dbTxSync 路径消费），随 resource-catalog 技能仓库对（B2 延后项）合一一起退。
  `rfc359-w4-d5-adapters.test.ts` 两引擎各跑（apply 的版本 / 成员关系 / 发布 / 操作账本序列与失败回收、操作锁撞库归类、
  CAS / 决策认领 / 取消认领的前置条件、provenance 修复与幂等、决策恢复三分支）；rfc353 / rfc199 / fusion-engine 锁改指
  中立文件，`rfc349-fusion-provider-persistence` fake-PG 单测随之删除。**下一条链**：`developmentAdapterStore`（integration；
  须先把 application 命令改异步）与 identity-access 的两对大 PG 底（`UserAccessRepository` / `OidcIdentityCrossContext`）。
  **D6a ✅（foreign-owner ACL 家族第一刀：development adapter 链）**：resource-catalog 的 ACL identity persistence 端口改成
  异步、绑定目录写事务句柄（`ResourceAclIdentityPersistence.loadForMutation(tx, id)` 交出 identity 行、撞名判定与带 aclRevision
  CAS 的写回；同步形态改名 `Sync*`，只剩 digital-employee 的 employee_* owner 在用，随 D6b/c 退）；中立的 ACL 读 / 写端口
  （D3）多一条 foreign-owner 分支，目录自有类型与 owner 交来的 identity 共用同一份决策与 grants 替换；
  `composeForeignResourceAclFor({db, identity})` 给两个 bootstrap 同一条 foreign ACL 路径（看不见即 not-found，提交后唤醒实时
  订阅）。integration：`developmentAdapterStore.ts` 一份（identity + immutable revisions，publish 走统一事务原语，撞名经能力矩阵
  归类；ACL identity 面即上面的端口）、`developmentAdapterCommands.ts` 改异步（owner 改名进 store，editor 改名栅栏在装配层）、
  `developmentAdapterConfigOperations.ts` 单一路径 `composeDevelopmentAdapterConfigOperationsFor({db, access, grants})`（PG 侧
  279 行的内联实现退役；显式授权事实经目录的 grant 读端口）、approvalGateway / pipelineEvidence / requirementSource 三处运行器
  装配各一份（旧 provider 名留别名）。PG daemon 的 development_adapter ACL 路由改走中立 foreign 路径，employee_* 仍走
  `postgresqlForeignResourceAcl.ts` 直到 D6b/c。三个 provider 文件删除，integration 的 dbTxSync 归零；D4 留的
  `postgresqlRepositoryScopeExistenceReads` 别名随本刀删除并销账。`rfc359-w4-d6a-adapters.test.ts` 两引擎各跑（store 的
  identity / revisions / 撞名 / purpose 不可变 / 归档门；配置装配的可见性、技术细节读面、editor 改名栅栏、publish / archive 各自
  的门；foreign ACL 的 CAS、grants 替换、换 owner 撞名与旧 owner 降为 read）；rfc310 的 adapter 用例与夹具改异步，rfc323 /
  rfc317 表归属锁改指中立文件。**下一刀 D6b / D6c**：development-automation `ConfigResourceStore`（employee_job_template）与
  digital-employee `AuthoringStore`（employee_definition / employee_tool）接同一个异步 identity 端口，之后删
  `postgresqlForeignResourceAcl.ts` 与 Sync* 形态。
  **D6b ✅（development-automation 配置族）**：`configResourceStore.ts` 一份（action template / verification profile 的
  identity + immutable revisions；撞 (owner, name) 经能力矩阵归类成 typed 409，publishRevision 走统一事务原语，archive 单语句
  returning 判 not-found；`list` 按 createdAt, id 定序），同步 `ConfigResourceStore` 端口形态随 bun-sqlite 专属实现一起退役、
  端口只剩异步 `ConfigResourcePersistence`；`developmentConfigPersistence.ts` 一份（digital employee / automation policy 的
  identity 与 revision：publish 先 `lockAggregateRoot` 再「draft 未变」CAS，PG 上即 FOR UPDATE、SQLite 独占事务下 no-op；
  错误码沿 SQLite 语义）；`assignmentStore.ts` 一份（引用存在性校验与 upsert 同一写事务，scope 谓词直接下推 `IS NULL` / `=`
  而不是全量拉回 JS 过滤，`now` 由调用方给）；员工 publish lookup 只剩异步形态、`publishLookup.ts` 删除；`migrationAssets.ts`
  一份（幂等键 (owner, name) 用同一条 SQL 谓词，employee / policy 落库改走 `DevelopmentConfigPersistence`）。生产里再无
  `sqliteDigitalEmployeeStore.ts` 消费者，它的函数面搬到 `tests/helpers/digitalEmployeeStore.ts`（底层走中立持久化，publish
  校验与生产同一套，`lookup` 参数可省）供 14 个 RFC-310 用例沿用。装配：`composeDevelopmentConfigOperationsFor({db, …})` 单一
  入口（位置参数形态与 PG 入口名留别名），`composition.ts` / `missionOperations.ts` 两个 bootstrap 同一份 persistence。六个
  provider 文件删除，development-automation 配置族 dbTxSync 归零。`rfc359-w4-d6b-adapters.test.ts` 两引擎各跑（配置资源的
  identity / revisions / 撞名 / archive；identity 持久化的 revise / publish CAS / archive 与 publish lookup 四类引用；assignment
  的 scope 校验、引用存在性、同 scope 覆盖、§3.8 解析与删除；legacy 迁移的读—析—落库与幂等），末尾源码锁保证该族不再出现
  provider 专属文件。**下一刀 D6c**：digital-employee `AuthoringStore`（employee_definition / employee_tool /
  employee_job_template）接同一个异步 identity 端口，之后删 `postgresqlForeignResourceAcl.ts` 与 `Sync*` 形态。
  **D6c ✅（digital-employee 作者面 + foreign-owner ACL 收尾）**：`authoringStore.ts` 一份（类型包 / 工具 / 岗位模版 /
  员工定义 / 全局执行策略五个聚合的 identity + immutable revision；撞唯一索引经能力矩阵归类成 typed 409，多表写走统一事务
  原语，缺席行按 returning 行数判 typed 404，publish / update 员工定义前先按同一谓词判 identity——revision 表带 FK，直接插会以
  驱动错误而不是 404 收场；`ensureExecutionPolicy` 先 `lockAggregateRoot` 锁单例行再读—改—写；列表在 JS 侧排序，不让 DB
  collation 决定顺序；ACL 列映射在函数内构造——模块级常量会把 SQLite 形态的列句柄冻结在 PG 路径上，aclRevision 以 int8 字符串
  回来、CAS 永远不等）。端口 `DigitalEmployeeAuthoringPersistence` 改成显式异步接口，同步 `DigitalEmployeeAuthoringStore` 与
  `asAsync*` 桥退役；employee_* 的 ACL identity 面改成与目录同形的异步端口（`loadForMutation(tx, id)` + aclRevision CAS），
  `DigitalEmployeeAuthoringAdapter` 把它连同持久化一起交出；Bun-dev 的类型包草稿覆盖改包异步持久化，且两个 bootstrap 同一语义
  （PG 装配也认 `typePackageDriftPolicy`）。装配：`composeDigitalEmployeeBootstrapReadsFor` / `createDigitalEmployeeAuthoringReads`
  各一份，`readPersistedDigitalEmployeeTypePackageDescriptorJsons` 改异步。两个 bootstrap 的 employee_* ACL 都改走
  `composeForeignResourceAclFor`（与 development_adapter 同一条路径），`platform/persistence/postgresqlForeignResourceAcl.ts`
  删除；resource-catalog 的 `SyncResourceAclIdentity*` 端口形态、SQLite ACL 仓库里的同步 identity 分支、`services/resourceAcl.ts`
  的同名再导出（连同其 R1 兼容边）一起退役，`updateResourceAcl` 的 `identityPersistence` 选项消失。三个 provider 文件删除，
  digital-employee 作者面 dbTxSync 归零。`rfc359-w4-d6c-adapters.test.ts` 两引擎各跑（类型包幂等 / drift / 定序；工具登记—
  校验回写—发布—退役；岗位模版撞名 / 404 / 发布；员工定义 create / update / 类型期望不符 404 / 撞名不留半个 revision；全局
  执行策略幂等递增；foreign ACL 的读面、grants 替换、CAS、换 owner 撞名、岗位模版按类型版本分区、工具不判撞名、private 对陌生人
  即 not-found），末尾源码锁保证该族不再有 provider 专属文件、目录不再有同步 identity 形态。rfc223 / rfc351 / drift 等用例改接
  异步持久化与中立 foreign 路径。**下一刀**：digital-employee runtime / input-upload / writer-cutover 三对与 identity-access 的两对
  大 PG 底。
  **D7a ✅（digital-employee 临时上传 + writer cutover）**：`inputUploadStore.ts` 一份（幂等键按 actor 分区命中即返回既有行；
  delete 单语句 returning 判本人 pending 行；sweepExpired 每片一个有界批次），同步 `EmployeeInputUploadStore` 形态退役；
  `writerCutoverPersistence.ts` 一份（activate / refresh 先 `lockAggregateRoot` 锁 'global' 单例行再数旧 Mission、翻 mode 写回；
  migrationSnapshot 改成逐语句快照读——旧 SQLite 实现刻意用 deferred 事务不抢 writer，PG 的 READ COMMITTED 事务对多条
  select 也不提供更强一致性，两边语义一致，S-10 的裸事务账本随之归零）。装配：`composeDigitalEmployeeMaintenanceCommands` /
  `composeDigitalEmployeeWriterCutoverFor` 各一份（PG 入口名留别名给 fake-PG 用例与 provider 边界锁），server / start / PG
  daemon 三处 bootstrap 同一入口。一个 provider 文件删除。`rfc359-w4-d7a-adapters.test.ts` 两引擎各跑（上传的幂等 / 解析校验
  / 删除 / 有界清扫；writer 的第 0 代升第 1 代、refresh、快照投影、重复 activate 幂等），末尾源码锁。**下一刀 D7b**：
  digital-employee `RuntimeStore` 对（1955 / 2003 行，15 处 dbTxSync）；之后 identity-access 的两对大 PG 底。
  **D7b ✅（digital-employee 运行时案件持久化）**：`runtimeStore.ts` 一份（以 PG 版为底：14 处 `db.transaction` 改走统一
  事务原语；计量与成员替换两处读—改—写先 `lockAggregateRoot` 锁案件行；受影响行数经 `affectedRows`；案件搜索的大小写不敏感与
  通配符转义走能力矩阵 `likeEscape` / `likeCaseInsensitive`（顺带修掉用户输入里 `%` / `_` 当通配符的旧行为）；nullable 列的
  ORDER BY 走能力矩阵 `ascNullsFirst`，SQLite 的 NULL 最小语义在 PG 显式 nulls first）；同步 `RuntimeCaseStorePort` 不再有
  实现、只作为异步合同的类型来源，`asAsyncRuntimeCasePersistence` 桥退役；两个 bootstrap 的装配同一份。两个 provider 文件
  （1955 + 2003 行）删除，digital-employee 的 dbTxSync 归零。`rfc359-w4-d7b-adapters.test.ts` 两引擎各跑（createCase 的一笔
  事务落案件 / 上下文 / 外部主体 / 生命周期 outbox 与上传认领冲突；计量 CAS 与成员替换；分页的 facets / 成员制 mine-shared /
  终态目录状态 / 大小写不敏感搜索与通配符字面匹配 / 游标；反应轮次的投递去重与合并、建轮次 CAS、跑、重试、结算、block /
  resume / upgradePolicy / terminate 级联与终态后投递直接 obsolete），末尾源码锁；rfc349 案件搜索 parity 锁改成「两个引擎都
  走能力矩阵」。**下一刀 D8**：identity-access 的两对大 PG 底（`UserAccessRepository` 554 / 760 行、`OidcIdentityCrossContext`
  318 / 781 行）。
  **D6c 补 ✅（启动期并发注册幂等，2026-09-05）**：作者面存储改成真异步后，同一拍构造的两份 `DigitalEmployeeAuthoringService`
  （路由层 + worker）并发注册同一类型包，读—插之间有让出点，第二个 insert 撞 `(type_id, revision)` 主键，daemon 在 8f89a3ee4 /
  d03fc3694 的 CI 上起不来（后端全部分片 + e2e 全红）。修法：`ensureTypePackage` 改「insert … ON CONFLICT DO NOTHING + 回读比
  digest」（两引擎同形，漂移仍报错）；`ensureExecutionPolicy` 先 `advisoryLock` 再锁单例行（PG 上首次创建也串行）；service 暴露
  `ready()`、后台初始化的拒绝标记为已接手；`composeDigitalEmployee` 收中立句柄、PG 入口成别名。
  `rfc359-w4-d6c-bootstrap-idempotency.test.ts` 两引擎各跑（改前 5/6 红），教训进 `docs/dev-gotchas.md`。
  **D8 ✅（identity-access 账户 / 授权持久化 + OIDC 身份关联）**：`userAccessPersistence.ts` 一份（以 PG 版的「读集 → 同步纯决策
  → 落库」为底：`BufferedUserAccessTransaction` 只认读集声明过的行、未声明读 fail closed，两个引擎都走 `session.serializable`；
  唯一冲突经能力矩阵新项 `uniqueViolationTarget` 映射回 `username-taken` / `profile-email-conflict` / `oidc-email-conflict`，两个
  引擎同一条正则）；出站授权围栏一份代码：先问能力矩阵新项 `readRowSync`（SQLite 驱动同步，跨进程写者立即可见），PG 退回本
  进程缓存（授权读预热、写提交后刷新）。`oidcIdentityCrossContext.ts` 一份（PG 的内存暂存 + 一笔 serializable 回放；RFC-220 S13 的
  选择器复核仍先于 profile 名字判定；用户名冲突不再漏成裸驱动错误）——OIDC 本就是 identity-access 的 infrastructure，直接用同一份
  写模型，RFC-349 期经 TransactionScope 认领桥绕回运行时公共面的 `initialUserAccess.forTransaction` / `syncOidcProfileInTransaction` /
  `mapOidcEmailConstraint` 与 `InitialUserAccessProvisioner` 参与者退役（src 里唯一的外部消费者是 auth 中只有测试在用的
  `completeBootstrapWithAdmin`，一并删除；bootstrap 首管理员只剩 `auth.completeBootstrap` 一条路——admin 没有默认附加授权，两个 auth
  persistence 直落用户 + 审计已是完整语义）。装配：`createIdentityAccessRuntime({db})` 收中立句柄、PG 入口成别名且不再要
  `crossContextTransactions`；`composeOidcIdentityOperations` / `composeOwnerIdentityQueries` 各一个中立入口，provider 名入口删除、
  消费者改名。五个 provider 文件（554 + 760 + 318 + 781 + 35 行）与两个假 PG 测试删除；schema 补上
  `user_identities_provider_subject_unique`（SQLite 迁移早有、PG 缺）并重采 PG 基线。`rfc359-w4-d8-adapters.test.ts` 两引擎各跑
  （目录搜索 / 查找顺序、围栏预热与旁路写者可见性、同步决策 + CAS、未声明读 fail closed、唯一冲突映射、选择器漂移回滚、建号一笔
  提交、绑定 / 解绑 / 用户不存在），能力矩阵两新项在 `rfc359-engine-capabilities` 两侧各有真实执行；rfc305 / rfc347 / rfc345 /
  rfc349 各锁与账本改指中立文件。**下一刀 D9**：auth 的 `sqliteAuthPersistence` / `postgresqlAuthPersistence` 对（含 legacy
  login policy / session / pat store）。
  **D9 ✅（auth 认证持久化 + PAT 调用审计）**：`auth/infrastructure/authPersistence.ts` 一份（登录策略 / bootstrap 首管理员 /
  会话 / PAT / 本地口令）——事务形态按统一原语与能力矩阵取最优而不是照搬 PG 版的「全 SERIALIZABLE」：读—改—写先
  `lockAggregateRoot` 锁策略单例行 / 用户行（RFC-221 的登录 / 策略线性化点在两边都成立），登录方法发现用只读
  `serializable` 快照，会话 / PAT 解析这条每请求热路径改成一条 join 读 + 一条带 `revoked_at is null` 谓词的单语句 touch
  （PG 上不再每请求一笔 SERIALIZABLE，SQLite 上不再抢 writer 租约做只读解析），bootstrap 的唯一冲突经能力矩阵
  `uniqueViolationTarget` 映射回 `username-taken` / `email-taken`。`tokenCallAudit.ts` 一份（有界清扫是「子查询取一批 id +
  DELETE … RETURNING」一条语句，两引擎同形）。装配：`createAuthRuntimeFor({db, onCredentialRevoked?, sourceWriteWindow?})`
  收中立句柄（`provider` 字段由会话引擎给出，`allowsLegacyDaemonTestAccess` 收任意客户端句柄），`createPostgresqlAuthRuntime`
  成别名，`createTokenCallAudit` / `legacyTokenCallAudit` 各一个中立入口；`createSqliteAuthRuntime` /
  `createSqliteTokenCallAudit` / `createPostgresqlTokenCallAudit` / `legacySqliteTokenCallAudit` 与应用层从未被消费的
  `AuthProvider` / `AuthPersistenceBinding` 删除，main.ts / server.ts / maintenanceWorker / services 消费者改名。四个 provider
  文件（495 + 574 + 79 + 96 行）与假 PG 测试删除；`rfc359-w4-d9-adapters.test.ts` 两引擎各跑（bootstrap 与策略门、唯一冲突映射、
  登录方法发现、口令登录 / 会话解析 / touch 节流 / 撤销 / 清扫、PAT 解析与本地口令写入、审计归属 / 脱敏 / 逆序 / 有界清扫）。
  legacy SQLite 夹具（`legacySqliteLoginPolicy` / `SessionStore` / `PatStore` / `AuthRuntime`）不是 provider 对，仍为测试夹具，
  另行退役。**下一刀 D10**：development-automation 剩余的 mission / playbook / upload store 对与 resource-catalog legacy 对。
  **D10 ✅（development-automation 的 Mission 持久化 + 读模型，附带列 facade 修根）**：
  `development-automation/infrastructure/missionStore.ts` 一份（`createMissionPersistence(db)`：launch 幂等与上传认领 / plan
  一笔事务、OCC / epoch、MR claim 唯一、wake hint 去重、deferred wake、decision digest 去重 + 快照原子落、writable action
  单活、attempt ordinal、effect 幂等与状态机、feedback 台账），`missionReadModels.ts` 改成中立异步（`listMissionSummariesPage`
  行值 keyset + `createMissionReadModelQueries(db)`：分页 / facets / counts / 详情 / MR 投影 / effect 台账 / 决策 trace /
  终态分组）；同步的 `MissionStore` 端口只保留为类型源，`createMissionCodeHostEventContinuation` /
  `createDevelopmentMissionExecutionTerminalObserver` 各剩一个中立入口，composition / start.ts / server.ts /
  postgresqlDaemonApplication 消费者改接。`sqliteMissionStore.ts`（886 行）/ `postgresqlMissionStore.ts` /
  `postgresqlMissionReadModels.ts` 与只跑 SQLite 的 `rfc310-pr2-mission-store` 删除；32 个 rfc310 / rfc311 测试文件按 codemod
  改成 await；boundary / null-ordering / predicate-drift（基线 8 → 7）/ t3 runners / pr7b 各锁改指中立文件。
  `rfc359-w4-d10-adapters.test.ts` 两引擎各跑全部存储不变量 + 读模型 + 源码锁。
  **修根**：D10 双引擎用例抓到 PG 上列表页游标 `createdAt` 回成字符串——表 facade 只在访问时解析到当前 provider，
  而模块加载期捕获进常量的列对象（`const COLUMNS = { createdAt: table.createdAt }`，全仓 12 处）那时还是 SQLite 列，
  在 PG 上解码就绕开了 pg 投影的 `bigint → number`。`db/providerSchema.ts` 把列也做成访问时解析的 facade（身份稳定、
  原型 / 映射 / 所属表随当前 provider），`rfc359-provider-schema-column-facade.test.ts` 故意在模块加载期捕获列，两引擎锁住
  解码 / 编码 / 行值比较 / 原型。**下一刀 D11**：development-automation 的 `PlaybookSagaStore` 对与 upload store，
  再到 resource-catalog legacy 对。
  **D11 ✅（development-automation 的 Playbook saga 持久化 + 上传会话 store）**：
  `infrastructure/playbookSagaStore.ts` 一份（`createPlaybookSagaPersistence(db)`：step run / mission link / approval saga
  的幂等认领全部落在唯一索引上——`insert … onConflictDoNothing().returning()` 两引擎同形；`updateStepRun` 读—判—写
  放在统一事务里、落库 `where state = from` 的 CAS；`sagaDigest` 三张表同一快照走 `serializable`）。
  `infrastructure/uploadSessionStore.ts` 一份（`createUploadSessionPersistence(db)`；**`claimUploadSessions(tx, …)` 是唯一的
  认领原语**：条件 UPDATE … RETURNING 的 CAS + 失败后读一行分类，launch 事务 `missionStore.commitMissionLaunch` 直接调用它，
  D10 里内联的那份认领循环删除；`deleteUpload` 是本人 + pending 围栏写进语句的单条 DELETE … RETURNING；`sweepExpired`
  是子查询取一批 id + DELETE … RETURNING 一条语句；`createUpload` 的幂等键查—插在一笔事务里，并发由 insert 冲突路径兜底，
  null actor 也按 `is null` 幂等——旧 SQLite 版 `actorUserId ?? ''` 永远匹配不到匿名行）。
  `missionInputUploadPersistence.ts` 只剩两份建在它上面的薄适配（`createMissionInputUploadPersistence` /
  `createUploadMaintenancePersistence`），`composition/missionInputUploads.ts` 一个 `composeMissionInputUploadOperations`，
  server.ts / postgresqlDaemonApplication 改接；`composePlaybookSaga` 一个别名。端口：`UploadSessionPersistence` 改成
  Promise 合同（同步 `UploadSessionStore` 删除），同步 `PlaybookSagaStore` 只保留为类型源。
  `sqlitePlaybookSagaStore.ts`（493 行）/ `postgresqlPlaybookSagaStore.ts`（411 行）/ `sqliteUploadSessionStore.ts`（144 行）与
  只跑 SQLite 的 `rfc310-pr3-upload-session` 删除；playbook-coordinator / pr2-admission / pr3-upload-security / pr3-journey /
  rfc338 五个测试按 codemod 改 await；boundary 锁改指中立文件，predicate-drift 的两条 `PlaybookSagaStore.ts::*` 豁免删除
  （基线 7 → 5）。`rfc359-w4-d11-adapters.test.ts` 两引擎各跑上传会话合同①–⑥（含 null actor 幂等、sweep limit）与 saga
  的认领幂等 / 状态机 CAS / link / approval / join / digest，附源码锁。**下一刀 D12**：development-automation 剩余
  provider 对（retentionSweeper / repositoryFactsCollector / uploadPublicationReceipt / uploadPlacementPersistence /
  requirementBundleRef / repositoryLocationRead / admissionLookup 装配对），再到 resource-catalog legacy 对。
  **D12 ✅（development-automation 剩余六个 infrastructure 对 + 三组装配对）**：`uploadPlacementPersistence.ts`
  （`createUploadPlacementPersistence`：record 的幂等落 `dev_upload_receipts_unique`，旧 SQLite 版「plan 下任何 receipt 都
  拦」的过宽判定退役）、`uploadPublicationReceipt.ts`（`recordUploadPublicationReceipt` / `hasUploadPublicationReceipt`
  中立异步，查—插一笔事务 + 冲突路径兜底）、`requirementBundleRefPersistence.ts`（`createRequirementBundleRefPersistence`，
  copyLatestRequirements 在统一事务里）、`gitBaselineReader.ts`（`createRepositoryLocationRead`；`resolveActionBaseline` /
  `createRepositoryBaselineResolver` 收中立句柄）、`repositoryFactsCollector.ts`（`createRepositoryFactsCollector` 一个）、
  `retentionSweeper.ts`（`sweepDevelopmentRetention` 一份：删已结算 attempt / 标 bundle 指针各是一条带子查询的语句 +
  RETURNING 计数——不再先取 id 列表再按 id 删，大 Mission 上 id 列表当绑定参数会撞上限；`count()` 走 drizzle 的
  Number 映射，numeric-projection 登记项随之删除）。装配层三组对收口：`composeDevelopmentAdmissionLookup` /
  `composeDevelopmentAutomationMaintenanceCommands` / `composeDevelopmentAutomation` / `composeDevelopmentMissionOperations`
  各一份（`db: ProviderNeutralDatabase`），`composeSqlite*` / `composePostgresql*` 五个孪生删除，start.ts / server.ts /
  postgresqlDaemonApplication / maintenanceWorker 改接；composition.ts 与 missionOperations.ts 不再 import 任一 provider
  客户端类型。pr5-seed-absorption / pr3-placement / rfc310Pr3Fixture / 两个假 PG 测试改接，boundary 锁改成「只有中立入口」。
  `rfc359-w4-d12-adapters.test.ts` 两引擎各跑 placement 读写幂等、publication receipt 首次 / 重放 / 换 baseline、bundle 指针
  latest / findManifest / 复制、仓库位置读取、保留期清扫（只删已结算、只标 active、无策略 / 未终态不动、limit）+ 源码锁。
  development-automation 的 infrastructure 里 provider 对至此清零；剩 `employeePlatformWorkItemPersistence` /
  `developmentDeliveryProvider` 两个在文件内分支的 sqlite / postgresql 工厂，以及 composition/ 下 digitalEmployeeWorkspace /
  digitalEmployeePlatformWorkItems / legacyMissionDrain 三组装配对——**下一刀 D13**。
  **D13 ✅（development-automation 最后三组 provider 对）**：`employeePlatformWorkItemPersistence.ts` 一份
  （`createEmployeePlatformWorkItemPersistence`：审批 saga 幂等准备 = onConflictDoNothing + 同事务回读，publish 两表更新在
  统一事务里）、`developmentDeliveryProvider.ts` 一份（`createDevelopmentDeliveryProvider`；无密钥嵌入的 volatile 仓库 URL
  按数据库句柄身份取——此前只有 SQLite 版接了这条回退，PG 上少一条能力）、`legacyMissionDrain.ts` 一份
  （`createLegacyMissionDrainPort`；注：生产装配没有消费方，只被 rfc317 跨界端口测试与表归属账本引用）。装配层
  `createDevelopmentEmployeeCaseWorkspaceDetailReader` / `composeDevelopmentEmployeeWorkspace` /
  `composeDevelopmentEmployeePlatformWorkItems` 各一份（`db: ProviderNeutralDatabase`），六个 `*Sqlite*` / `*Postgresql*` 孪生
  删除，start.ts / server.ts / postgresqlDaemonApplication / composition.ts 改接，七个测试改接，
  rfc349-development-integration-composition 的「PG 装配必须命名自己的适配器」清单去掉三个 development-automation 条目。
  `rfc359-w4-d13-adapters.test.ts` 两引擎各跑 workspace 读 / head 更新、审批 saga 幂等准备 / 提交 / 观测、candidate 幂等 /
  commit / publish 原子、轮次校验取最高 attempt、仓库解析（未缓存 / volatile / SecretBox 解封）与 MR 事实目标、排空视图
  计数与 truncated + 源码锁。**development-automation 至此没有任何 provider 命名的持久化或装配孪生。**
  **下一刀 D14**：resource-catalog legacy 对（16 对）。
  **D14 ✅（resource-catalog · Agent 聚合：一份实现，SQLite 装配切过去）**：resource-catalog 的两侧形态不对称——
  SQLite 侧是 `legacy/*` 同步服务外面的薄包装（`sqliteAgentRepository.ts` 50 行），PG 侧是完整的异步重写
  （`postgresqlAgentRepository.ts` 231 行 + `postgresqlAgentPersistenceSemantics.ts` 420 行）。合一的办法是让异步实现成为
  唯一实现：`infrastructure/agentRepository.ts`（`createAgentRepository`：写路径全在 `runResourceCatalogTransaction`
  的 serializable 事务里；owner + name 唯一冲突经能力矩阵 `uniqueViolationTarget` 映射回 `agent-name-in-use`——PG 给
  约束名 `agents_owner_name_unique`、SQLite 给列清单 `agents.owner_user_id, …`，一条正则两边都认）、
  `agentPersistenceSemantics.ts`（`createAgentPersistenceSemantics`：引用 / runtime / 依赖环 / 删除受引用校验）、
  `agentImportQueries.ts`（`createAgentImportReferenceReadPort` + `createImportReferenceReadPortInTransaction`，
  `ACL_TABLES` 只有一份）。装配层 `composeAgentCatalog` 一份（`db: ProviderNeutralDatabase` + persistence +
  resourceCatalog），`composeAgentImportQueries` / `composeDatabaseAgentResourceInventorySource` /
  `composeDatabaseAgentResourceIntegrity` / `composePortableImportReferences(InTransaction)` 各一份；server.ts 与 start.ts
  的 SQLite 装配改成与 PG daemon 同一套（persistence 语义层 + runtimeProfiles 走 runtimeRegistry）；
  `postgresqlClassicCatalogs.ts` 的 Agent 分支改接中立入口。SQLite 专属的同步 portable-import 终写围栏
  （`createPortableImportReferenceSyncFence` / `TransactionBoundImportReferenceSyncReadPort`，无生产消费方）删除。
  五个 provider 文件删除；rfc345（contracts / classic-facades / agent-import-queries）与 rfc349 classic adapters、rfc305
  跨界账本改指中立文件；七个测试与 legacy/workgroup/launch.ts 改接。`rfc359-w4-d14-adapters.test.ts` 两引擎各跑创建 /
  同 owner 同名冲突 / 引用与 runtime 校验 / fence 过期 / 改名冲突 / 删除受引用保护 / 引用标签 / import 快照 + 源码锁。
  **留下的债**：`legacy/agent.ts` 同步服务仍被 services/agent.ts 门面、task-execution、code-capability 等消费，它不是
  provider 对而是「只有 SQLite 能走」的旧路径，随各消费方切到 `AgentCatalogModule` 后再删。**下一刀 D15**：
  resource-catalog 的 Skill / Workflow 聚合按同一办法合一（PG 异步实现成为唯一实现）。
  **D15 ✅（resource-catalog · Workflow 聚合：一份实现，SQLite 装配切过去）**：`infrastructure/workflowRepository.ts`
  （`createWorkflowRepository`：创建 / 复制 / update 的 already-current 与 committed / 删除只用原始行的 ACL 身份与版本，全在
  统一 serializable 事务里）、`workflowPersistenceSemantics.ts`（`createWorkflowPersistenceSemantics`：定义引用可见性、
  复制命名、非终态任务 / 定时任务 / 被 call 的删除守卫，事件钩子）、`workflowValidation.ts`
  （`createWorkflowValidationPort` 装载两引擎同形的库存跑共享校验器；`createWorkflowReferenceAdmissionPort` 的 D15 准入）
  各一份。**managed skill 可用性判据只有一份**：`skillContentAvailability.ts`（reservation ready + 本次启动已复核 + 权威
  版本目录在盘上），SQLite bootstrap 与 PG 内容生命周期都用它。装配层 `composeWorkflowCatalog` 一份（PG 形状）+
  `composeDatabaseWorkflowCatalog({db, resourceCatalog, skillContent})`（语义层与 `/ws/workflows` 广播事件在这里接，
  两个 provider 同一份），server.ts / start.ts 切过去；`postgresqlClassicCatalogs.ts` 的 Workflow 分支改接。五个 provider
  文件删除；rfc345（contracts / classic-facades / neutralization）与 rfc349 两把 adapters 锁改指中立文件；
  `tests/helpers/workflowCatalog.ts` 不再按 provider 分叉。`rfc359-w4-d15-adapters.test.ts` 两引擎各跑创建 / 复制命名 /
  update 三态 / 删除受 call 引用保护 / 校验与准入 / skill 可用性 + 源码锁。
  **合一时补齐的两处 PG 缺口**（双引擎批次抓到）：①删除广播的受众——旧 SQLite 路径在删除事务里取出可见性 / owner /
  授权用户随帧旁路带给 WS 注册表，冷缓存的私有观众才能收到 delete 帧，PG 版此前漏了（rfc099-ws-acl-filter 红）；
  现在 `createWorkflowRepository` 在事务里取受众交给 `deleted` 钩子，`composeDatabaseWorkflowCatalog` 带着广播。
  ②RFC-264 改名门——只有改名才受统一命名规则约束、历史名字原样回存可保存，PG 版此前不校验改名（`_reserved` 也能存）；
  现在语义层一条门两引擎同用（workflows.test.ts 红）。
  **留下的债**：`composeSqliteDynamicWorkflowValidationContext`（task engine 的动态工作流校验上下文）仍走 legacy 装载器，
  PG daemon 从目录查询拼上下文——两边拼法不同，随「动态工作流校验上下文」单独一刀合一；`legacy/workflow.ts` 同步服务仍被
  services/workflow.ts 门面、task-execution 等消费。**下一刀 D16**：Mcp 聚合。

  **D16 ✅（resource-catalog · Mcp 聚合：一份实现，运行时测试生命周期进仓库事务）**：`infrastructure/mcpRepository.ts`
  （`createMcpRepository({db, lifecycle})`：创建 / update（OCC 按 configHash）/ 改名 / 删除只回 agent 引用，
  `mcp-name-in-use` 经能力矩阵的唯一冲突映射）、`mcpRuntimeTestTransitions.ts`（`transitionMcpRuntimeTests`：配置变更→
  空闲会话结束、忙碌会话阻塞到本回合后，停用 / 删除→立即结束；`transitionMcpAclRuntimeTests`：按账号权限 + 可见性快照判定，
  失去可见性→access-revoked、保留→阻塞；`deletePreparedMcpRuntimeTests`：未安全停止的会话让删除抛
  `mcp-test-cleanup-incomplete`）、`mcpTransactionLifecycle.ts`（把两条接进仓库事务）各一份——**ACL 变更转换此前只有
  SQLite 有**，PG 版 ACL 写入不动测试会话，合一时补齐。装配层 `composeMcpCatalog` 一份 + `mcpAclRuntimeTestLifecycle()`
  （资源目录 ACL 写入后的事务内钩子，两 provider 同一份）、`composeMcpProbeStore` / `composeMcpRuntimeTestPersistence` /
  `composeMcpRuntimeTestProvider` 各一份；server.ts / start.ts / postgresqlDaemonApplication.ts 同一套装配。三个 provider
  文件删除（`sqliteMcpRepository` / `postgresqlMcpRepository` / `postgresqlMcpTransactionLifecycle`），
  `services/mcpRuntimeTestTransitions.ts` 零生产消费门面退役；rfc345（contracts / acl-facade-retirement /
  mcp-plugin-neutral-facades）、rfc349（adapters / resource-package-bootstrap）、rfc231 写点清单、rfc294 canonical
  manifests 改指中立文件；`tests/helpers/mcpServiceBinding.ts` 不再按 provider 分叉。`rfc359-w4-d16-adapters.test.ts`
  两引擎各跑创建 / 同名冲突 / OCC / 改名撞名 / 引用保护删除 / 会话清理守卫 / 三类会话转换 + 源码锁。
  **留下的债**：`legacy/mcpRuntimeTestTransitions.ts` 同步版仍被 runtime-registry 写点与 `mcpPersistence.ts` 消费，随那些
  写点切异步后删。
  **D14 / D15 的 CI 回归（94ce5351b 红，随 D16 一并修）**：①Agent 语义层的引用缺失先走 RFC-228 结构化预检
  （`agent-resources-invalid` + issues）再走逐类围栏——合一时次序反了，`skill-not-found` 抢先（rfc223-pr1-impl-gate 红）；
  ②provider 路径的 ACL 写入提交后要唤醒实时订阅（`resource-acl-changed`）——旧 SQLite 组合在 afterCommit 里触发、
  provider 组合漏了，被升档的观众收不到刷新帧（e2e rfc324-graded-grants 红）；③RFC-310 架构清单里的
  `postgresqlAgentPersistenceSemantics` 路径改指中立文件。前两条 `rfc359-w4-d14-d15-regressions.test.ts` 两引擎各锁一遍。
  教训进 `docs/dev-gotchas.md`：provider 形状成为唯一实现时，SQLite 侧的 HTTP / e2e 锁会**第一次**照到它，每刀的本地批次
  要把该聚合的 HTTP 层与 ACL / WS 用例（rfc223 / rfc228 / rfc324 / rfc099 / rfc212 家族）一并带上。
  **下一刀 D17**：Plugin 聚合。

  **D17 ✅（resource-catalog · Plugin 聚合：一份仓库、一份目录装配、一份代际清扫装配）**：`infrastructure/pluginRepository.ts`
  （`createPluginRepository({db})`：创建 / publish（按 configHash OCC，整行 WHERE + RETURNING 判定）/ 改名 / 删除只回 agent
  引用；`plugin-name-in-use` 经能力矩阵的唯一冲突映射）一份；`composition/pluginOperations.ts` 只剩 `composePluginCatalog`
  （PG 形状：访问判定与 ACL 操作都经资源目录的 provider 中立应用）+ `composePluginCatalogFromAdapters`；
  `composition/pluginGenerationGc.ts` 只剩 `composePluginGenerationGcCommand`。server.ts / start.ts /
  postgresqlDaemonApplication.ts / maintenanceWorker.ts 同一套装配，legacy `workflow.validator.ts` 的插件库存改读中立仓库。
  两个 provider 文件删除；rfc345 contracts、rfc349（adapters / contributions / search-case-parity）、rfc284 dedup、rfc231
  写点清单改指中立文件；`tests/helpers/pluginServiceBinding.ts` / `intentResourceCatalogBinding.ts` 不再按 provider 分叉。
  `rfc359-w4-d17-adapters.test.ts` 两引擎各跑创建 / owner 级同名冲突 / assertNameAvailable / publish OCC / 改名撞名 /
  引用保护删除 + 源码锁。**下一刀 D18**：Workgroup 聚合。

  **D18 ✅（resource-catalog · Workgroup 聚合：一份仓库、一份引用可用性判定、一份目录装配）**：
  `infrastructure/workgroupRepository.ts`（`createWorkgroupRepository(db, deps)`：创建 / 复制（版本 + 快照哈希 OCC）/
  save 三态 / 删除（定时任务与非终态任务引用守卫、受众随回执）全在统一 serializable 事务里；`workgroup-name-in-use` /
  `workgroup-copy-name-conflict` 经能力矩阵的唯一冲突映射；两份 provider 文件此前逐字同形，PG 版直接成为唯一实现）、
  `infrastructure/referenceUsability.ts`（`resolveAgentIdsUsable` 预检 / `assertAgentIdsUsableInTransaction` 同事务终检 /
  `resolveAccessInTransaction` / `listGrantedUserIdsInTransaction`，缺失与不可见一律 `acl-missing-refs`）各一份；
  `composition/workgroupOperations.ts` 只剩 `composeWorkgroupCatalog` + `composeWorkgroupCatalogFromAdapters`，仓库依赖
  由 `workgroupRepositoryDependencies({db})` 一处装配（测试也从这里拿）。server.ts / start.ts / postgresqlDaemonApplication.ts
  同一套装配；四个 PG-only 聚合适配器改读中立的 `workgroupFromRows`。四个 provider 文件删除；rfc225 写点清单、rfc231、
  rfc345（contracts / classic-facade-neutralization）、rfc349 adapters 改指中立文件。`rfc359-w4-d18-adapters.test.ts`
  两引擎各跑创建 / 同名冲突 / 不可见与不存在成员 / 复制 OCC / save 三态 / 删除 OCC 与受众 + 源码锁。
  **留下的债**：Workgroup 的任务房与回合（`sqliteWorkgroupTaskRoom.ts` 71 行薄驱动 vs PG 的
  `postgresqlWorkgroupTaskRoom*` 1457 行、`sqliteWorkgroupTurnsOperations.ts` 34 行 vs `postgresqlWorkgroupTurnsOperations.ts`
  567 行）是「SQLite 走 legacy engine、PG 全量实现」的不对称对，随 legacy workgroup engine 退役单独一刀（D19）。
  **下一刀 D19**：Workgroup 任务房 / 回合合一。这一刀体量最大且行为风险最高，拆三步走：

  **勘察结论（决定拆法）**：任务房与回合是 W4 里最后、也是最不对称的一对——SQLite 侧是 legacy workgroup engine
  上的薄驱动（`sqliteWorkgroupTaskRoom.ts` 71 行 + `sqliteWorkgroupTurnsOperations.ts` 34 行），PG 侧是原生实现
  （任务房 `postgresqlWorkgroupTaskRoom*.ts` 1457 行；回合 `postgresqlWorkgroupTurnsOperations.ts` 567 行，
  决策逻辑在 provider 中立的 `application/workgroups/workgroupTurnsDriver.ts` 2819 行里）。**测试覆盖也不对称**：
  SQLite / legacy 路径有 13 个行为套件（rfc164 引擎 / rfc185 领队扇出 / rfc189 回合 / rfc215 批次 / rfc329 待办 /
  rfc311 徽标 ACL / rfc108 自动恢复…），PG 走的中立驱动只有 3 个、且多是源码形状锁——**PostgreSQL 跑的是一条
  几乎没有行为覆盖的路径**，正是本 RFC 要根除的形态。故按风险分三刀：D19a 结构（参与者对 + 围栏去重，零行为变更）、
  D19b 任务房本体（SQLite 装配切到中立实现）、D19c 回合引擎（legacy engine 的回合面退役）。

  **D19a ✅（任务房事务内参与者合一 + 无主围栏去重：零行为变更）**：
  `collaboration/infrastructure/workgroupTaskRoomClarifyParticipant.ts`（反问投影 / 关闭未决自问）与
  `task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts`（继续 / 失败任务）各一份中立实现，装配层
  `composeWorkgroupTaskRoomClarifyParticipantFactory` / `composeWorkgroupTaskRoomTaskParticipantFactory` 各一份
  （事务类型三处都收敛到 `DatabaseTransaction`）。同批发现 `assertPostgresqlTaskOwnerlessTx` 与中立的
  `assertTaskOwnerlessTx` 是**逐字重复**，删掉 PG 那份、六个消费方改指中立模块。三个 provider 文件删除；
  rfc294 preflight 的能力债清单四条并成两条、rfc349 协作运行时锁改指中立工厂。
  `rfc359-w4-d19a-adapters.test.ts` 两引擎各跑反问投影（按 asker 聚合 + 非空 shardKey 的 stop 指令）、
  未决自问的 CAS 关闭与重放幂等、无主围栏的四种 owner 状态 + 源码锁。
  **D19b ✅（任务房本体合一：一份房间给两个引擎，「恢复执行」按部署形态注入 —— 采纳方案 2）**：
  三份中立房间文件（`workgroupTaskRoom{,Commands,Queries}.ts`）+ 一份装配 `composeWorkgroupTaskRoom`，
  两个 bootstrap 装同一份；`composeWorkgroupTaskRoomActiveUsers` / `composeWorkgroupTaskRoomDynamicWorkflow`
  把此前只在 PG daemon 里内联的两段判据（在岗用户过滤、动态工作流三层复核 + 另存为）提成共用装配。
  四个 provider 文件删除。**PostgreSQL 房间路径由此第一次拿到行为覆盖。**

  **合一时抓到、并按「合一前 SQLite 行为为准」修掉的差异**（这正是本 RFC 要根除的形态——两份实现各自演进）：
  1. 「恢复执行」的两件事按**部署形态**（不是按数据库）注入 `WorkgroupTaskRoomContinuationDriver`：
     `assertResumable`（单进程查工作树 → 工作树被 GC 回收就 410，闸门 / holder / 消息随事务整体回滚、
     决策保持可重试；多进程空操作）与 `driveAfterCommit`（单进程就地认领已准入的意图并驱动，
     即 `wakeHumanGateContinuation`；多进程交给 daemon 的 `human-gate-continuation` worker）。
     两处调用次序照抄合一前：预检排在合法性复核**之后**（提案不再通过当前池校验仍是 409，工作树没了才 410）、
     写入之前；驱动排在提交与广播之后。rfc164 的 410 与 rfc167 的原子换挡 / 相位复位因此全部照旧。
  2. `continueTask` 的意图类别改回 `gate-continuation`、载荷收回 `{v,event}` 两键。这一类里还住着 RFC-333
     人工门的富载荷，驱动链会 `decodeHumanGateContinuationPayload` 解它，多一个键就当场
     `invalid-human-gate-continuation-payload`；两键形态才被 `isLegacyTaskGateContinuationPayload` 识别成
     「由准入方自己驱动」而跳过那几步。合一前的 PG 房间写的是 `kind:'resume'`——**没有任何人认领它**。
  3. 加成员时解析不到的 agent 引用错误码回归 `acl-missing-refs`（合一版一度是 `workgroup-config-agent-missing`）。
  4. 遣散最后一个人类成员后的补跑（`continueIfStillParked`：立刻一次 + 2.5s 后一次）。引擎可能带着遣散前的
     快照慢一拍才把任务提交成 `awaiting_human`，那一拍落在配置更新事务之后，任务会永远停在等一个不存在的人。

  **收尾（同批）**：legacy 那四个动作文件（`taskActions` / `dwActions` / `room` / `configActions`，1749 行）
  生产零消费者，删除；6 个测试消费者改接中立房间（三个纯派生函数的改从 `application/workgroups/workgroupRoomProjection.ts`
  导入；徽章两套走新的 `tests/helpers/workgroupTaskRoom.ts` 装配；rfc223 引用围栏的 `beforeWriteTransaction`
  接缝随「事务外预检 + 事务内复核」一起退役，留下同一条用户可见行为的断言）。
  九把按文件名点名的清单锁改指中立实现，rfc217 G5 的模式分支棘轮把中立房间纳入扫描面。
  `rfc359-w4-d19b-adapters.test.ts` 两引擎各跑房间聚合读 / 可见性 404 / 发言写入 + 广播 / 终态拒绝 + 源码锁。

  **两处守卫脆弱点同批修掉**：路由错误码守卫的语料用 `trackedFiles`，新测试在 `git add` 之前不在语料里
  ——本地绿、提交之后才红（288a8f888 把 main 推红即此）；rfc345 的 schema 导入扫描在三份源码**拼接**后
  贪婪匹配，正文里出现「tasks」这个词（哪怕只是注释）就被误判成导入了 tasks 表，改为逐文件取块。

  **D19c ✅（回合引擎合一：SQLite 切到中立驱动，并补回它缺的整套提示词）**：
  持久化适配器中立化（`workgroupTurnsOperations.ts`；`GREATEST` 收进能力矩阵新增的 `greatest`，两方言各取
  `GREATEST` / `max`）、宿主账本参与者中立化（`workgroupHostLedgerParticipant.ts`）、装配收成一份
  `composeWorkgroupTurnsOperations`，三个 bootstrap 装同一条；SQLite 的 34 行 legacy 薄壳与
  `services/workgroup/engine.ts` 门面删除，回合操作改由 bootstrap 注入。

  **关键发现**：13 个「SQLite 行为套件」全都直接调 `runWorkgroupEngine`，**一条都没经过中立驱动**——
  PostgreSQL 跑的那条路几乎没有行为覆盖。把其中 5 个套件（约 88 条断言）改接
  `tests/helpers/workgroupTurns.ts` 的 shim 后，一次照出中立驱动与正典之间 8 处差异，逐条按
  「合一前 SQLite 为准」修回（每一条都是 PG 上一直存在的用户可见退化）：

  1. **整套提示词是降级版**——没有 charter 围栏 / goal 块 / 能力卡名册 / 领队账本 / peer results ·
     mentions · 黑板三段切片 / 闸门打回反馈块。legacy 的 `prompts.ts` + `context.ts` 搬进 application 层
     （`workgroupTurnPrompts.ts` / `workgroupTurnContext.ts`，输入换成 `WorkgroupTurnsSnapshot`）。
  2. **协议重提示块**写成了另一套更短的 `## Protocol correction`（G6 单一定义点随之搬进中立驱动）。
  3. **失败重试判据**：中立驱动对任何失败都重试并贴原始 errorMessage；正典走 FOLLOWUP_POLICY 表，
     只有协议失误才重试，且给按原因裁剪的可操作指引。
  4. **瞬时运行时故障**没有单独预算（正典：换新进程整轮重跑、不吃协议预算、不贴提示）。
  5. **反问被硬压制**（RFC-181 C）没有专门分支（正典：按角色贴 `Ask-back is OFF` 重试，耗尽后领队推游标
     丢弃继续、成员卡片浮 failed，绝不 park）。
  6. **17 处系统消息**各手写正文、逐条与模板渲染器不同 → 一律改由 `buildSystemMessage` 渲染。
  7. **标题去重丢弃**没有系统告警；去重只可能在提交时定论（并发成员回合共享快照），所以提交回执带上
     被跳过的操作键，驱动据此补消息。
  8. **free_collab 机械收敛**的闸门说明恒为空（它没有领队回合能推 idle → declared）。

  另加一条：`node.status{pending}` 广播在中立驱动里变成宿主的可选能力，测试 shim 按生产形态接上。
  十把点名清单锁改指中立实现；`rfc359-w4-d19c-adapters.test.ts` 两引擎各跑「领队派单 → 成员交付 →
  领队收敛」与「协议出错重提示一次后收敛」+ 源码锁。

  **D19c-tail（待办，独立一刀）**：legacy engine 那一片（`engine` / `turnExecution` / `memberTurns` /
  `rounds` / `wake` / `prompts` / `hooks` / `messages` / `lifecycle` / `strategies/*`，约 4500 行）现在
  **生产零消费者**，只剩测试还在引。删它不是机械 sweep：8 个模块共 25 个符号被测试直接消费
  （`decideAssignmentReconcile` / `deriveWakeSet` / `deriveLeaderClarifyPark` / `resolveWgClarifyAllowed` /
  `executeTurn` / `casAssignmentStatus`…），要逐个判定「中立驱动里的对应判据是哪一个、要不要导出、
  断言怎么改写」。`state` / `launch` / `constants` / `askerKey` 四个文件仍有真实生产消费者，不在退役范围内。

  **D22 ✅（数字员工岗位模版目录合一）**：此前 SQLite 是套在 legacy Agent 写面（`legacy/agent.ts`）上的
  59 行薄壳、PostgreSQL 是 390 行原生实现。正典取 PG 那份——它本来就是**按 builtin 模版语义**写的
  （系统 owner + builtin 双条件定位、`visibility:'public'` + `builtin:true` 落库、改名与更新过
  updatedAt + aclRevision 双 OCC），而 SQLite 那条借道普通 Agent 写面、带着一整套面向用户输入的
  ACL / 闭包校验——模版定义是代码自有、由 daemon 铸造的，那套校验既不适用也拦不住什么。合一顺带把
  `legacy/agent.ts` 从这条链上摘掉。provider 差异只剩驱动错误的形状，经能力矩阵 `uniqueViolationTarget`
  映射回闭合错误合同。两个 provider 文件删除；rfc345 边界锁与 rfc347 委派臂账本改指中立实现。
  `rfc359-w4-d22-adapters.test.ts` 两引擎各跑建 builtin 的三列落值 / 重复 id 与同名冲突 / 双 OCC 围栏 /
  非系统 builtin 的行按 id 被占用拒绝。

  **D24 ✅（运行时会话租约合一：一份实现，且不改隔离级别）**：这是「乙类」里取证已完成的那一对
  （502 / 504 行，归一化相似度 0.65）。差别只有三处，逐条收掉：①事务原语——**合一没有改隔离级别**，
  中立会话本来就有 `serializable`（PG 抬到 SERIALIZABLE 并按 40001 重放，SQLite 的 `BEGIN IMMEDIATE`
  本来就是全库独占），新增的 `withTaskExecutionSerializable` 两边各取所需，于是「PG 能不能降到
  READ COMMITTED」这个待裁决问题**不必回答**；②owner 围栏——PG 的本地 `fence()` 与中立
  `fenceTaskWrite` 逐字同义，改为委派，环境上下文至此只在 `ownedTaskExecution.ts` 读一次；
  ③驱动错误形状——改走能力矩阵 `classifyError`（`claimNew` 防重复认领靠的本来就是主键
  `(protocol, session_id)` + 这条映射，不是隔离级别）。
  `sqliteRuntimeSessionLeaseOperations.ts` 删除，按品牌分派的装配收成一行转出口；三个 bootstrap 改从
  装配层取（直连 infrastructure 会新增 R1 inbound 越界边）。四把清单锁改指中立实现，其中三条是**销账**
  （fork 计数 2→1、provider 专属依赖 50→49、能力兼容债 22→21、`taskExecutionPersistence` 的分派 4→2）。
  `rfc359-w4-d24-adapters.test.ts` 两引擎各跑，含 plan 点名的那条：**并发 `claimNew` 恰好一个成功、
  另一个 owner-conflict**，且落库行与胜出者一致、败者的 run 不带 session。

  ### 剩余 task-execution 对的相似度普查（2026-09-06，按可合难度排序）

  归一化（去注释、抹掉 provider 词）之后逐对量的相似度，越高越接近「同一份逻辑的两种写法」：

  | 相似度 | 对 | SQLite / PG 规模（字符） |
  | --- | --- | --- |
      | 0.31 | TaskExecutionRuntimeParticipants | 5215 / 6082 |
  | 0.26 | TaskExecutionEffectPersistence | 9821 / 28952 |
  | 0.22 | TaskLifecycleAutoRepairCommand | 2176 / 5988 |
  | 0.13 | TaskExecutionRecovery | 10139 / 19951 |
  | 0.09 | TaskOwnershipPersistence | 1541 / 12763 |
  | 0.08 | TaskArchiveMaintenanceCommand | 2133 / 21589 |
  | ≤0.04 | TaskRouteOperations / SourceTerminationParticipant / TerminalMaintenancePersistence / TaskRouteLaunchOperations / ChildExecutionLaunchOperations | 见普查 |

  **D25 ✅（human-gate 停靠原子合一，2026-09-06）**：上一轮把 `HumanGateTaskLifecyclePersistence`
  动了一次又还原，卡点是它内部 new 了 `PostgresqlHumanGateOpenParticipantInTx`——collaboration 侧
  的另一对（695 / 820 行）。这一刀按记录的顺序从 collaboration 起手，一次收掉**三对 + 一条 legacy 路**：

  - **`humanGateOpenParticipant.ts`（新，中立）** 替代 `sqlite|postgresqlHumanGateOpenParticipant.ts`。
    正典取 SQLite 那份的语义：逐点的陈旧原因文案、提交 / 完成的**幂等重放**、以及「提交要求工件全
    `staged`、完成要求工件全 `finalized`」两条判据。关键发现是**这些语义早就有中立副本**——
    `humanGateOperationJournal.ts`（`DatabaseHumanGateOperationJournal`）是 `SqliteHumanGateOperationStore`
    的逐行异步移植，PG 那份参与者却自己内联了一套**更弱**的 commit / complete（不认幂等重放、
    不校工件状态、只从 `prepared` 起跳）。合一直接用 journal，于是 PG 侧顺带补齐了这三条。
    node run 的停靠改走 collaboration 自己声明的窄能力 `HumanGateNodeRunLifecycleParticipantInTx`
    （由 task-execution 供给），不再 import 对方 infrastructure。
  - **`humanGateTaskLifecyclePersistence.ts`（新，中立）** 替代两份 provider 实现。三处差异各取中立
    原语：`withTaskExecutionSerializable`（不改任一引擎的隔离级别）、`assertTaskOwnerTx` /
    `assertTaskOwnerlessTx`（围栏从**库外预读**挪进同一笔事务，两个引擎都不再有「读完到写之间被人
    认领」的窗口）、`transitionHumanGateTask`（蓝本就是 SQLite 跑最久的那份）。
  - **`clarifyQuestionSnapshotReader.ts`（新，中立）** 替代 `sqlite|postgresqlClarifyQuestionSnapshotReader.ts`
    ——两份逐字同一条查询，只差取行姿势。
  - **legacy 同步停靠路整条退役**：`sqliteTaskParkTransaction.ts` / `sqliteManualQuestionParkTransaction.ts` /
    `composition/taskExecutionHumanGateAdapter.ts` / task-execution 侧的同步 `HumanGateOpenParticipant`
    端口全删。`composition/humanGate.ts` 的 `parkPreparedHumanGate` /
    `settleManualQuestionParkObligations`（legacy review / clarify 服务的入口）直接落到中立原子——
    对账下来它与 `TaskParkTransaction` **逐条同判据**（同一个 owner 围栏、同一条 `transitionHumanGateTask`、
    同样提交后发事件），本来就是同一份逻辑的第二次抄写。

  又是「按端口数覆盖、不是按实现数」那条：RFC-333 的停靠套件（`rfc333-task-participants.test.ts`，
  15 个 test）**全部直接 new SQLite 那几个类**，PG 侧只有装配被引用过。这批已改接中立端口后一次全绿，
  说明两侧行为本来就该一致；新增 `rfc359-w4-d25-adapters.test.ts` 给**两个引擎**补齐停靠的核心判据
  （门消费 + 任务跃迁 + 两族事件同笔落定 / 陈旧 taskRevision 整笔回滚 / 无义务时结算是 no-op /
  带守卫的 CAS 正常落定），9 条两引擎各绿。

  留债当场清掉了 —— 见下面的 D26。

  **D26 ✅（手工提问写面合一 + 同步 gate 操作 store 退役，2026-09-06）**：
  `sqlite|postgresqlManualQuestionOpenWriter.ts`（165 / 269 行）并成一份中立实现。又是同一形态：
  PG 那份把 journal 的 `beginTx` / `markPreparedTx` **内联重写**成裸 INSERT + UPDATE，少了三条
  ——不查幂等键回放、`claimEpoch` 恒写 1、不比 `requestHash`。合一改用中立 journal 后一并补齐。

  写面是 `SqliteHumanGateOperationStore` 的最后一个消费者，于是那 825 行**整份删除**；
  `humanGateOperationTransactionStore.ts` 只留共享形状（租约常量 / 工件声明与快照 / begin 的回答），
  同步接口与 `services/humanGateComposition` 的 `createHumanGateOperationStore` 桥（零消费者）
  一起退役，rfc349 provider 具名依赖账本销一条。

  测试的处置同样按「覆盖跟着端口走」：`rfc333-human-gate-operation-store.test.ts` 锁的五条 store
  判据，其实早已被**双引擎**的 `rfc359-t1-human-gate-journal.test.ts` 逐条接管（同名五条 + 恢复
  认领排序一条），所以该文件只留与引擎无关的规范化请求断言；`rfc333-human-gate-artifact-recovery.test.ts`
  的夹具改用中立 journal。新增 `rfc359-w4-d26-adapters.test.ts` 九条两引擎各绿。

  **D27 ✅（任务执行资源快照合一 + 中立只读快照事务，2026-09-06）**：相似度表里最高的那一对
  （0.59）。resource-catalog 侧两份读面（legacy 494 行 / PG 529 行）本来就**逐行同一套逻辑**，
  差别只有三处，逐条对账后取中立形态：

  - **事务**：`DatabaseSession` 新增 `snapshotRead`。这是本刀唯一的新能力，加它是因为两个引擎
    在这条读路径上**本来就各有边界**且都不能丢：SQLite 走 `dbTxSync`（BEGIN IMMEDIATE），PG 走
    `REPEATABLE READ READ ONLY`。中立 `transaction()` 在 PG 上是 READ COMMITTED，会让闭包递归
    取数失去一致视图；所以按能力矩阵的路子补一条只读快照，两边各取原样，**边界一格未改**。
  - **可见性**：新增 `infrastructure/resourceAclTransaction.ts` 的 `canViewResourceForTx`。
    与 legacy `canViewResourceInTx` 同一条判据（audience → 私有才查授权 → `resolveAccessFrom`
    → `canViewAccess`）；PG 此前在读面里内联了逐字等价的一份。
  - **行映射**：改用同 context 内的 `*Persistence` 中立映射器。这是本刀风险最高的一处，逐个对账过
    ——`rowToAgent` vs `agentFromPersistenceRow`（sidecar 提升规则、runtime 列规则逐条相同）、
    `rowToWorkflowDetail` vs `workflowDetailOf∘workflowFromPersistenceRow`（两侧的
    `normalizeWorkflowSnapshot` / `workflowDraftSnapshotOf` 是同一个 `WorkflowDraftSnapshotSchema.parse`，
    所以 `snapshotHash` 逐字节相同）、`rowToWorkgroup` vs `workgroupFromRows`（函数体逐行相同）、
    mcp / plugin 两个本来就是同一个函数的别名。

  闭包冻结只保留异步一份：`freezeTaskExecutionCallClosureAsync` 与同步版**逐语句同构**（同一个
  builder、同一顺序、同一序列化），只在 loader 上多一个 await——所以「异步版能不能覆盖同步版」
  这个挂了很久的待裁决问题，答案是可以，且不必做行为取舍。参与者合同随之改成 Promise 面，
  `loadAuthorized` 顺序求值（闭包依赖「上一条结果决定下一条」，并发化会改变错误先后）。

  策略束里只留 legacy 行为神谕（`legacyTaskExecutionInjectionResolver`，生产零消费）还要的三个
  行映射器：它在 task-execution 里，直接 import 对方 infrastructure 会新增跨 context 内部边
  （实撞一次，R1 守卫当场报红），所以照旧经 services 装配边注入，随该文件退役一并删。

  `rfc359-w4-d27-adapters.test.ts` 九条两引擎各绿；`rfc349-task-execution-provider-adapters` 的
  闭包一致性断言从「两份实现冻出同一结果」改成「同一份实现在两个引擎上冻出同一结果」，并继续锁
  PG 那笔仍是只读可重复读快照。

  **D23a ✅（技能目录的双引擎取证基线，2026-09-06）**：合一动手前先按 D19b/D19c 的方法论取证
  ——**按端口数覆盖、不是按实现数**。新增 `tests/helpers/skillCatalog.ts`（两侧装配成同一个
  `SkillCatalogModule`；装配形状本身就是分叉的一部分，所以按能力矩阵的 `isolation` 分派，
  `describeEachProvider` 有意不把 provider 名交给 body）与
  `rfc359-w4-d23a-skill-conformance.test.ts`（八个场景 × 两引擎 = 16 条）。

  **结论：端口面已经一致**——建 / 读 / 列、内容与文件树、重名拒绝、保存推进版本、陈旧 token 拒绝、
  文件写入与读回、受保护主文件不许删、删除后再读为 null，八条在两个引擎上逐条同形同码。
  这是 D23b/c 的判据基线：合一之后每一条都必须继续成立。

  **风险因此收窄**：剩下的分叉不在端口面，而在**崩溃安全机器**本身（boot 验证、操作恢复、
  身份迁移、版本发布的 staging/swap 阶梯）——那些要的是进程级 / 崩溃矩阵测试，不是端口级场景。
  D23b（把 legacy 机器迁到 `DatabaseSession`）的验收面应当照着那一层去补，而不是再堆端口场景。

  **同批照出一条与 RFC-359 无关的存量问题**：把全部 skill 套件放进同一个 bun 进程跑，
  `skill-versioning` 的 v1/v2 与 RFC-170 的 rollforward 会红成 `skill-not-found`；去掉本次新增的
  文件照红。是跨文件的进程级状态串味（嫌疑：`skillBootVerify` 的模块级集合、
  `providerSchema` 的全局 provider 选择），CI 靠分片才没暴露。已记进 `docs/audit-backlog.md`。

  **D19c-tail 进行中（2026-09-06 落了四刀）**：legacy workgroup engine 那一片生产零消费者，
  但它的行为套件还锁着**已经没人跑**的那份实现。逐组重指到中立驱动，收干净才能删岛。

  - **第一刀（唤醒集）**：`deriveWakeSet` / `decideWorkgroupOutcome` / `WakeSet` / `WakeItem` /
    `WorkgroupOutcome` / `InflightTurns` 在中立驱动里本来就有、只是模块私有，按需导出；
    「只读成员」判据在中立侧住在 `workgroupTurnsOperations.readonlyPermission`，一并导出。
    新增 `tests/helpers/workgroupWake.ts` 把旧的 `WakeInput` 字面量翻成 `(snapshot, inflight)`
    ——其中 `budgetUsed` 在中立侧是**从 hostRuns 推**的，适配器按模式合成恰好产出该预算的 host run。
    八个套件 159 条全绿。只调了两处**命名差**（连字符拼写、`leader-nudge` 不再带 `nudgeCount`），
    判据一条没动。
  - **第二刀（领队反问停靠）**：`leaderClarifyParkedOf` 从宿主账本参与者里抽成具名导出，
    RFC-187 F3 的五条改指它。生产行为一格未变——这一格 symbol-owner 增长是「把既有规则命名」的代价。
  - **第三刀（派单卡转移表）**：两张表**逐字相同**，rfc164 全表遍历与 rfc181 的 A2 三条边直接改指
    `WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS`。
  - **第四刀（房间消息 / 回合账本）——照出一处真缺口**：RFC-274 要求系统署名的房间消息要么带
    模板 key、要么显式声明 `localization: 'original'`；合一时中立驱动把**分类字段连同判据一起丢了**，
    于是两个 provider 都少了这道关，平台手写的英文兜底文案可以直接落进房间且无从本地化。已补回
    （目标种子那条正文是用户原文，显式标 original；其余 15 处本来就带模板 key），并由 rfc274 锁住三态。

  - **第五刀（派单卡 CAS / 成员游标）**：写面判据改锁中立账本操作。
  - **第六刀（反问许可）**：断言直接问 gate，legacy 的转发层不再被锁。
  - **第七刀（消息回合边界）**：`messageTurnBoundary` 抽名；「失败即关闭」那条改锁它的结构前提。
  - **第八刀（收尾轮）——第二处真缺口**：收尾轮丢掉的派单在房间里没有任何说明（模板
    `roundCapDispatchIgnored` 早就有，合一后没有调用方）。补回，并把零增量 / 收尾判据抽名改锁生产。
  - **第九刀（崩溃后派单对账）**：`decideAssignmentReconcile` 抽名改锁生产。
  - **第十刀（澄清续跑复活）——第三处真缺口**：RFC-187 T13 的恢复有两半，合一只带来一半。
    唤醒还在（`autoResumeInterruptedTasks`），**按原样澄清血缘重铸续跑**丢了：中立驱动的采纳只取
    pending，而 `interrupted` 是终态，于是只会另铸一条普通 `wg-leader-round`。而人回答过的 Q&A 是
    **靠 rerun cause 的血缘**注回提示词的（`buildClarifyQueueContext` 只在 clarify-answer /
    cross-clarify-questioner-rerun 上返回 Q&A），少了这半，任务虽被唤醒、领队却再看不到答案。已补回。
  - **第十一刀（传输重试进账本）——第四处真缺口**：中立驱动带来了「换进程重跑不吃协议预算」，
    却没带来**重跑自己进账本**那半：`retryIndex: retryBase + attempt` / `cause: attempt === 0 ? 主 cause`
    在流中断重跑（不推进 attempt）时会**撞同一个 retryIndex**、还挂主 cause。前者破坏 node_run 的
    身份（血缘 / 采纳会挑错行），后者让它**进轮次记账**——free_collab 的 `roundBudget` 逐条数成员 run、
    只跳过 `wg-protocol-retry`，一次流中断就白吃掉一整轮。补回 `freshMintOffset` +
    `transientRetryPending` 两个语义，先红后绿，双引擎锁。
  - **第十二刀（删岛）**：最后四处引用改指生产后，`engine` / `turnExecution` / `memberTurns` /
    `messages` / `prompts` / `rounds` / `lifecycle` / `wake` / `hooks` / `strategies/*` 共 **4112 行**
    整片删除（`askerKey` / `constants` / `launch` / `state` 是被全仓复用的共享件，留下）。RFC-181 的
    两条澄清判据改指 `CollaborationRuntimeMechanics` 的 SQLite 实现（collaboration 早有自己的一份，
    legacy 那份是重复件）；RFC-185 的两条传输重试断言改走中立驱动的真消息回合；RFC-182 的 pending 帧
    唯一广播点、重试预算单源锁、RFC-200 的 nonce 线程锁全部改锚中立驱动。
    `rfc294-review-off-dag-offered-edges` 的那条 RC→COL 边按它自己写明的销账条件退账（43 → 42）；
    rfc217 G5 的模式分支棘轮把中立驱动与提示词组装**纳入扫描面**（此前它们不在账内，等于 20 处分支
    从棘轮视野里消失了），rfc328 的写点允许表删掉 `rounds.ts#stampWgRound`。

    删之前还要把八个「按路径段拼」的源码锁逐条重指（`scripts/tests-referencing.sh` 只找 import，
    找不到这种形态），其中一条照出**第五处**缺口：房间消息 id 在中立驱动里退回了普通 `ulid()`。
    房间切片与成员游标都按 `message.id > cursor` 的**字典序**判「我没看过的」，同毫秒两条消息之间
    没有稳定序，游标若先落在字典序较大的那条上，另一条对该成员**永远不再出现**——正是 RFC-186 §3-4
    引入 `monotonicFactory()` 要消除的窗口。已补回，并加了「同毫秒连发 64 条严格递增」的行为判据。

  **D19c-tail ✅ 完工**：legacy workgroup 引擎岛已删除，两个 provider 只剩一条回合实现。
  过程中照出并修好**五处**合一遗漏的真缺口（系统消息分类、收尾轮房间说明、澄清续跑复活、
  传输重试记账、房间消息单调 id），全部带判据。

  ### 生命周期修复这一对的勘察结论（2026-09-06，**订正**）

  第一眼看上去是「一好一坏」：`TaskLifecycleAutoRepairCommand` 的 SQLite 侧是 65 行薄适配器，
  套在 `platform/persistence/sqlite/taskLifecycleRepair.ts`（513 行）+ `taskLifecycleRepair/options-*.ts`
  （14 个规则族、2613 行）这套成熟机器上；PG 侧只有 198 行，且**只实现 `S4.kick-task`**，
  别的选项一律抛 `postgresql-auto-repair-option-not-supported`。

  **对账之后不成立**：v1 里 `autoApplyEligible: true` 的选项**只有 S4.kick-task 一个**
  （`options-S4.ts:30` 是全仓唯一一处），而 `runAutoRepairOnce` 只在「恰好一个 autoApplyEligible
  且 available」时才自动施用。也就是说两边的**自动**修复能力**等价**，PG 不是缺能力，是把这唯一一条
  重写了一遍。人工修复面（诊断页那条路）两边也都是全的：PG 有自己的
  `postgresqlTaskRouteRepairOperations.ts`（1448 行），R1 / R2 / C1 / T1–T3 / U1 / S1–S6 全覆盖。

  **所以这里的问题是重复实现，不是能力缺口**——排期上没有「PG 用户此刻用不了」的紧迫性，价值在于
  「以后新增一个 autoApplyEligible 的选项不用写两遍、也不会只有一边生效」。真正的大头是那 1448 行
  PG 路由修复与共享目录的重复（形态同 D23：一侧薄适配 + 成熟机器，另一侧原生重写）。
  好消息是共享那套**天然中立**：`taskLifecycleRepair.ts` 与全部 options 模块里 `dbTxSync` /
  `.all()` / `.get()` / `.run()` 各 0 处，用的全是 drizzle 异步面，只是被类型钉成 `DbClient`、
  住在 `platform/persistence/sqlite/` 路径下。合一形状因此是把它整体提为中立（换类型 + 挪目录，
  事务点走 `databaseSessionFor`），PG 那两份退役。

  ### D23b ✅ 落地（2026-09-06/07）：先拆墙，再迁机器

  D23b 一度判定阻塞——技能的两个提交面被 **bundle apply 的同步大事务**调用（`dbTxSync`），
  body 里 await 不了，而 op 原语中立化后必须 await。**解法是先拆那堵墙**：

  1. **拆墙**：`legacyResourcePackageBundleApply.ts:390` 的大事务换成
     `databaseSessionFor(db).transaction(...)`，边界一格未变（journal 的 prepared→applying CAS、
     全部资源提交、journal committed 仍是同一笔），`.run()` 后读 `.changes` 换成中立的 `affectedRows()`。
     链上其余**同步** `*InTx` 成员（agent / mcp / workflow / workgroup / template）暂时保留，
     由 `bindApplyTx` 内一个具名的 `syncTx` 把中立句柄重新窄化给它们。
     **这不是强转谎话**：SQLite 会话交出的事务句柄**就是 `DbClient` 本身**
     （`createSqliteDatabaseSession`：`const tx = db as unknown as DatabaseTransaction`），
     适配器只是把平台层**已经依赖的那条身份**在类型上说一遍，并带退役条件——两套 apply 引擎
     合一时随文件一起消失，新增同步成员会被 `rfc359-sync-transaction-highwater` 账本挡下。
  2. **迁机器**：`skillOperations` / `skillReserveOp` / `skillDeleteOp` / `skillMigrateOp` /
     `skillVersionOp` / `skillOpRecoveryDriver` / `skillVersion` / `skill` / `skillIdentityMigration` /
     `skillBootVerify` 全部改吃中立事务。两阶段提交的阶段边界、锁的生命周期、崩溃恢复方向判据、
     隔离与 quarantine、发布阶梯的 swap/backup 顺序**逐条不变**；唯一冲突判别从写死的 SQLite
     错误串换成引擎能力面（`engineOf(tx).classifyError`）。
  3. **清重复件**：三处「只为同步路径存在」的副本按它们自己写明的退役条件删除——
     `sqliteSkillVersionCommitParticipant.ts`、`sqliteMemoryMembershipParticipant.ts`、
     `createSyncSkillRestoreMembership` / `SyncMemoryMembershipUnfuse`。

  **判据面**：技能与捆绑应用两侧 **322 条**用例全绿（崩溃恢复矩阵、身份迁移屏障、发布 staging 阶梯、
  boot 重验、包应用重放都在内）。同步事务面账本 41 → 33 个文件、124 → 85 个调用点。

  **三次撞上「漏 await 静默通过类型检查」**（`docs/dev-gotchas.md` 刚记下的那条），无一例外表现为
  「写好像没生效」而不是编译错：`deleteSkill` 漏 await ⇒ 删除没删掉；捆绑应用的**幂等尾**漏 await
  ⇒ 发布完没 mark boot-verified；测试侧多处漏 await ⇒ 断言拿到 Promise。按 gotchas 记的办法
  （按改成异步的导出名逐个 grep 调用点）全部找出。**D23c**（SQLite 装配切到这套机器、PG 那 3342 行
  原生实现退役）是下一刀。

  ### D23c ✅ 落地（2026-09-07）：技能目录合一，PostgreSQL 原生实现整体退役

  **动手前先做了一次决定性实验**：把双引擎一致性夹具的 PG 分支直接指向（D23b 已中立化的）legacy
  机器，跑 D23a 的 8 个场景。第一轮 8 条全红——`loadSkillRow` 在 create 之后读不到刚写的行。
  排下来是**我自己**在上一轮把 `tx.insert(skills).values({...}).run()` 的 `.run()` 摘掉时漏了
  `await`（同一个坑第四次）：SQLite 单连接下这条也一样不执行，只是那轮没跑测试没暴露；PG 上
  立刻现形。补上 `await` 后**两个引擎各 8/8 全绿**——合一可行由实测而非纸面对账确认。

  **合一的四刀**：

  1. **技能身份迁移屏障中立化**（`legacy/skillIdentityMigration.ts`，942 行）。这是最后一块
     SQLite-only 的技能机器：19 处同步读写 + 一条 `PRAGMA foreign_key_check('skill_versions')`。
     文件系统布局两个引擎共用（`~/.agent-workflow/skills/`），所以 SQLite→PG 迁过来的部署**照样
     可能**带着旧的 name-目录布局，屏障两边都真的需要，不能按「PG 没有历史包袱」糊弄过去。
     期间又逮到 **3 处漏 await 静默通过类型检查**：两处是 `boolean && versionPathsCanonical(...)`
     ——`false | Promise<boolean>` 是合法类型，而 Promise 恒真，判据直接失效；一处是两条 authority
     断言被整个丢掉。全部由「按改成异步的导出名逐个 grep」找出，`docs/dev-gotchas.md` 那条办法再次奏效。
  2. **合一时按「好的那份」抬齐**：PG 原生屏障**整条略过**了引用完整性复核（SQLite 侧有
     `PRAGMA foreign_key_check`）。合一没有取交集，而是把判据改写成两个引擎都能跑的孤儿行查询
     （`skill_versions LEFT JOIN skills WHERE skills.id IS NULL`），语义与 PRAGMA 对该表的检查一致
     ——**PG 侧因此补齐了此前缺失的这道屏障**。这正是「不允许一个好一个不好」的处理方式。
  3. **顺手退掉挡路的 ACL 分叉**：`updateResourceAcl` 的 SQLite 专属同步 after-write 分支
     （连同 `sqliteResourceAclRepository.ts` 334 行、`transitionMcpAclRuntimeTestsInTx`）**没有任何
     生产调用方**——最后一个在 W4-D16 就改走中立 `ResourceAclMutationLifecycle` 了，只剩一个测试
     自己手接旧钩子、证明一处没人用的接线。测试改指生产装配后整条退役，ACL 读面随之全面中立化
     （`createSqliteResourceGrantReadPort` 这个别名一直只是中立实现的旧名字）。
  4. **装配收口**：`sqliteSkillRepository/ZipImport/CatalogBoot` 更名为中立的
     `skillRepository/skillZipImportAdapter/skillCatalogBootAdapter`；`composePostgresqlSkillCatalog`
     与 `composePostgresqlSkillCatalogBoot` 删除，两个 daemon 走同一个 `composeSkillCatalog` /
     `composeSkillCatalogBoot`；PG bundle 的技能格换成中立目录 + 共用的 `createSkillContentAvailability`。

  **退役的四个文件（3342 行）**：`postgresqlSkillRepository.ts`(505) /
  `postgresqlSkillContentLifecycle.ts`(873) / `postgresqlSkillZipImport.ts`(546) /
  `postgresqlSkillCatalogBoot.ts`(1418)，加上 `sqliteResourceAclRepository.ts`(334)。

  **补上的验收缺口（这一刀最重要的一步）**：合一前，那套崩溃安全机器的 14 个套件（boot 验证 /
  操作恢复 / 身份迁移 / 发布 staging 阶梯 / 版本…共 4140 行）**全是单引擎**的。合一之后它们描述的
  就是 PostgreSQL 的行为，却一次都没在 PG 上跑过——只把实现并成一份、验收面仍只覆盖一个引擎，
  等于把「一个测到、一个没测到」换个位置放。新增 `rfc359-w4-d23c-skill-machinery-conformance.test.ts`
  补上那一层，挑**引擎语义真的可能分叉**的路径两个引擎各跑一遍（8 场景 × 2 = 16 条全绿）：
  ① 两阶段 op 的锁互斥；② 重名冲突的唯一冲突分类必须判 409 而非 500（SQLite 看 errno、PG 看
  SQLSTATE，最容易只在一侧成立）；③ 崩在 create 途中的 `reserving` 行 + 锁被恢复驱动清干净
  ——**正是 P0-11 说的那个「PG 上永远没人清、同名永远建不了」的形态**，现在两个引擎都实测清得掉；
  ④ 身份迁移屏障的引用完整性复核两个引擎都真的执行（外键在两侧都挡得住孤儿行，制造不出来，
  所以另加一条源码锁：判据必须是可移植的孤儿行查询、不得退回 PRAGMA）；⑤ 版本提交 / 回滚同形；
  ⑥ 孤儿锁 GC 不误伤活着的 op；⑦ phase 阶梯走完锁真的释放。纯文件系统的部分与引擎无关，
  留给既有单引擎套件，不重复。

  **判据面**：技能 / 包 / RFC-345 / RFC-359 相关 **156 个测试文件**在两个引擎上全绿
  （SQLite 1143 条、开 PG 后 1423 条）；D23a 的 8 场景 × 2 引擎现在跑的是**同一份实现**。
  9 条源码锁按新形状改写（不是放宽：`rfc345-classic-facade-provider-neutralization` /
  `rfc345-skill-zip-provider-neutral` / `rfc345-skill-catalog-boot-participant` /
  `rfc349-resource-catalog-classic-postgresql-adapters` 都从「PG 那份保持原生」改成
  **锁「只剩一份、四个原生文件必须保持不存在」**）。同步事务面账本 32 → **30 个文件、83 → 81 个调用点**；
  RFC-294 的 off-DAG offered 边少一条（`postgresqlSkillRepository → memory` 随文件退役，早于其 W4-E3 计划波次）。

  ### D28a ✅ 落地（2026-09-07）：任务归属端口的双引擎取证基线

  下一对（`TaskOwnershipPersistence`）与合一前的技能目录**同形**：SQLite 是 43 行薄适配器套
  563 行成熟同步实现，PostgreSQL 是 444 行原生重写；覆盖同样倒挂——
  `rfc328-durable-ownership.test.ts` 有 1495 行正确性矩阵，**全部只跑 SQLite**，PG 那 444 行的
  owner CAS / 租约 / 撤销 / 恢复逻辑**没有任何活着的行为覆盖**（现有引用全是源码文本锁）。

  按 D23a 的方法论先取证：新增 `rfc359-w4-d28a-task-ownership-conformance.test.ts`，
  九个场景通过同一个端口在两个引擎上各跑一遍（**18 条全绿**）：认领 / 重复认领冲突 /
  不存在的 intent / 心跳续租（revision 与租约都要推进）/ 撤销要对上 revision /
  撤销后心跳被围栏挡住 / 标记需要恢复 / 旧世代 daemon 被持锁者撤销 / 无 owner read 回 null。
  **结论：这一对的端口面本来就一致**（不像技能那次一跑就照出 PG 缺一道屏障），
  所以 D28b 的合一风险主要在事务原语本身，不在行为分叉。

  ### D28b 的真实形状（2026-09-07 实做到一半后回退，未提交；这是本轮最有价值的勘察结论）

  **它不是「再合一对」，而是把剩下的整条同步事务面一次性拔掉**——因为那 30 个文件是**一个连通分量**，
  由五个共享的同步 helper 绑在一起，动其中任何一个都会连锁拉动其余：

  | 同步 helper | 调用点 | 中立孪生 |
  | --- | --- | --- |
  | `setNodeRunStatusTx` | 8 | ✅ `nodeRunLifecycleTransition.ts`（异步、中立） |
  | `terminalizeTaskExecutionIntentsTx` | 8 | ✅ `effectQuiescence.ts`（异步、中立，且**更强**） |
  | `withOwnedTaskTx` | 10 | ❌（但它本身就是中立 `assertTaskOwnerTx` 逐字重复的一份） |
  | `withTaskExecutionMutation` | 4 | ❌ |
  | `withTaskExecutionTransaction` | 3 | ❌ |

  实测：把 owner 围栏一改，类型错一口气从 0 涨到 140+，跨
  `sqliteTaskExecutionEffect.ts`(1756 行 / 66 处同步调用)、`sqliteTaskExecutionEffectPersistence.ts`、
  `services/task.ts`、`platform/persistence/sqlite/taskLifecycle.ts`、
  `collaboration/legacySqliteReview.ts`、`sqliteCollaborationWorkgroupClarify.ts` 等十余个文件。
  **本轮把已改的部分整体回退**（工作树留干净），理由是：在一次会话里把这么大的异步化连同
  「漏 await 静默通过类型检查」的风险一起推上共享 main，不划算——这一刀值得单独一个 PR 专门做。

  **已勘明的三条，下一刀可以直接用**：

  1. **`withOwnedTaskTx` 是 `assertTaskOwnerTx` 的逐字重复**（`ownedTaskExecution.ts`），
     只是外面裹了 `dbTxSync`——D21 的 owner CAS 去重没走完最后一步。中立那份唯一缺的是
     「把 bump 后的 revision 交出来」，加上即可，不必新写。
  2. **两个现成的合一红利，且中立那份都更强**：
     `terminalizeTaskExecutionIntentsTx` 的中立版校验 terminalize 行数与预期相等、不等就抛
     `task-continuation-stale`，同步那份直接放过；`setNodeRunStatusTx` 同样有中立异步孪生。
     合一时按「好的那份」抬齐（与 D23c 处理引用完整性复核同一原则）。
  3. **顺序**：先给 `assertTaskOwnerTx` 加返回值并让 `withOwnedTaskTx` 委托过去 → 再退
     `terminalizeTaskExecutionIntentsTx` / `setNodeRunStatusTx` 的同步孪生 → 再 effect store →
     最后调用方。每一步跑一次 `bunx tsc` 与 D28a 套件；**每把一个函数从同步改成异步，都要按
     `docs/dev-gotchas.md` 那条「按导出名 grep 调用点」扫一遍**——这一轮在技能那边就是靠它
     逮到 3 处漏 await 静默通过类型检查（两处是 `boolean && Promise` 恒真、判据直接失效）。

  ### D28b 第二次尝试与它换来的门（2026-09-07，实测后再次回退）

  按上面的顺序真的做了一遍：30 个文件机械迁完、`bunx tsc` **全绿**。然后把类型感知的
  `@typescript-eslint/no-floating-promises` 第一次指向那批文件——**当场 62 处被丢掉的 Promise**。
  也就是说这条路上「类型检查过了」根本不构成证据：漏掉的 await 只表现为「写好像没生效」，
  而且集中在崩溃 / 并发才走到的分支上，正是任务执行内核最不能出错的地方。**据此再次整体回退**
  （工作树干净、main 全绿），但这一次带回了让它安全的东西：

  **① 这道门已经常设**（`bun run lint:promises` → 独立的 `eslint.promises.config.js`，只针对
  `packages/backend/src/**/*.ts`，只开 `no-floating-promises` + `no-misused-promises`，约 30s，
  已挂进 `bun run lint`）。独立成一份配置是必要的：主配置带上 `project` 会让 RFC-282 那种
  `eslint.lintText` 合成路径解析失败、连带吞掉该文件其它规则的报告。
  下一次做这刀**先开门再动手**，让它全程亮着——事后补是补不干净的。

  **② 开门当天照出并修掉 15 处存量真丢弃**（与本次迁移无关、早已在 main 上）：
  - `effect?.succeed()/fail()`（`nodeRollback` / `nodeIsolation` 共 6 处）——effect 台账的结算
    记录不等落库就返回；
  - fan-out 的 `recordConsumed`——端口写成 `void`、实现是异步写 `node_execution`，
    这次写被合法丢掉（契约已收窄成 `Promise<void>`）；
  - **资源包 apply 在写入落库之前就铸回执**——`commitCapability` 同步调用异步的 `applyPrepared`，
    「已应用」的回执可能先于写入返回。**这一处是 W4-D23b（本轮 `2de427ad8`）自己引入的**，
    由这道门当场抓出；契约（7 个 `*PackageMutationParticipantInTx.commit`）已改成 Promise 形。
  - 另有 4 处确属刻意的 fire-and-forget，改成显式 `void` 并写明理由。

  **③ 契约不要写 `void | Promise<void>`**：联合里混进 `void` 之后，丢 Promise 是合法写法，
  连 `no-floating-promises` 都不报。本轮把 `commitSkillReadyInTx` / `compensateManagedSkillStage`
  等 3 处收窄成 `Promise<void>`（实现本来就是异步、消费者本来就 await）。

  **结论**：D28b 依然是「把剩下整条同步事务面一次性拔掉」，形状与顺序同上一节；
  改变的是**它现在有了机械化的验收面**。没有这道门之前不该再尝试第三次。

  ### D28b 第三次尝试：真实规模比账本大一倍以上（2026-09-07，仍回退）

  这次带着已经开好的门重做了一遍，并且找到了前两次没找到的那一层：**账本里那 30 个文件不是全部**。
  账本清点的是「调用 `dbTxSync` / `withOwnedTaskTx` 的文件」，而另有 **37 个文件只是 `DbTxSync`
  类型的消费者**（aggregateAdapters 的两个参与者、`existingTransactionScope`、ACL 读仓 /
  grant 仓、committed-event 参与者、mcp / plugin persistence …）——它们不调用同步原语，
  所以从不进账本，但同步面一动它们全部要跟着动。**实际改动面 72 个文件、约 3700 行**，
  是账本数字的一倍以上。

  三次尝试的类型错都停在同一种地方，且**越做越大**：104 → 235 → 268。自动化（终结符改写、
  编译器驱动的 asyncify、按声明 / 按位置补 await、箭头回调 asyncify）每次都能砍掉八成，
  剩下的两成是**必须逐处读代码判断 await 落在哪里**的，机械 pass 到这里会开始互相打架
  （最后一轮 262 → 268 就是两个 pass 互相撤销对方）。

  **结论（第三次，判据比前两次硬）**：这一刀不能靠脚本收尾，也不该在一次会话里推上共享 main。
  它需要的是：**先把账本改成按 `DbTxSync` 类型消费者清点**（现在的口径少算一半以上），
  然后按文件逐个人工过，全程开着 `bun run lint:promises`（这道门已常设，见上一节）。
  在此之前不要再尝试第四次机械转换——三次都停在同一堵墙上，堵的位置也一次比一次靠后。

  ### D28b 第四次：换一种切法，第一刀落地（2026-09-07，已提交 c074e806d）

  前三次都把 D28b 当成「一次性拔掉整条同步事务面」，于是每次撞在同一堵墙上。这次换了切法，
  第一刀当天绿着上了主干。**变的不是工具，是找缝的判据**：

  - 前三次按**文件**切（账本 30 个 / 实际 61 个引用 `DbTxSync` 的文件）。一个文件里但凡有一处
    同步调用点，整份都要转 async，async 于是从那里向所有调用方扩散——级联面就是那约 3700 行。
  - 这次按**「外层函数是不是已经 async」**切。同步网关 `sqliteOwnedTaskMutation` 的四个导出
    只有 5 处调用点，而这 5 处的外层函数（`setTaskStatus` / `transitionMergeState` /
    `dispatchReviewNodeUnlocked`）**本来就是 async**——改完补个 `await` 就完了，**零级联**。

  照这个判据重看剩下的面，它就不再是「一件事」，而是一串**互不牵连的小刀**：一处同步调用点，
  只要外层函数已经 async、且体内用到的内层 helper 已有中立 async 版本，它就能单独迁、单独测、
  单独提交。本刀用到的三个内层 helper（`transitionNodeRunStatusTx` /
  `createNodeRunMintParticipantInTx` / `transitionHumanGateTask`）**全部早已存在**——W1/W4 前几波
  已经把中立侧建好了，剩下的只是把调用点接过去。这也解释了前三次为什么越做越大：机械 pass 不区分
  「已经 async 的外层」和「要连带转 async 的外层」，把两类混在一起做，后者的级联淹掉了前者的收益。

  **落地结果**（c074e806d）：`sqliteOwnedTaskMutation.ts` 整份退役；同步事务面账本 30 → 29 个文件
  （调用点 81 → 77）；rfc349 provider 具名依赖 46 → 44；`public/` 少两条点名 provider 的债。
  行为上补了一处分叉：旧同步网关在「无执行上下文」分支里既不开事务也不设围栏、直接裸写，新路径
  按统一规则走无主围栏——PG 侧一直是有围栏的那侧，合一以它为准（`rfc359-w4-d28b-owned-mutation-gateway.test.ts`
  双引擎各 2 条锁住，变异验证：摘掉 `fenceTaskWrite` 后正是围栏那 2 条红）。

  **下一刀怎么选**（同一判据，逐处筛）：

  1. `grep` 出还在用 `dbTxSync` / `withOwnedTaskTx` 的调用点；
  2. 每一处先看**外层函数是不是已经 async**——是就进候选；不是就跳过，它属于要连带转 async 的那
     一类，留到最后统一处理；
  3. 再看体内的内层 helper——判据要写严一点：**不是「有没有中立 async 版本」，而是「这个 helper
     的类型面还被别人钉在 `DbTxSync` 上没有」**。两者不等价，`legacy/agent.ts` 就是反例：它 5 个
     调用点的外层函数全是 `async`（第 2 步全过），体内却只调一句
     `commitAgentCreateInTx(tx, prepared)`，而这个 helper 的签名是 `(tx: DbTxSync, …) => void`，
     并且**被生产的意图应用链共用**（`aggregateAdapters/legacyIntentApplyResourceParticipants.ts`
     的端口逐字段声明成 `(tx: DbTxSync, prepared: unknown) => void`）。把它改成中立的，意图应用
     那条链要跟着改——级联从这里开始。所以 `legacy/agent.ts` **不是**一刀，它属于「意图应用参与者
     链」那一批，要连着做。
  4. 两条都满足就是一刀：改完跑 `bun run lint:promises` + 双引擎跑一遍 + 把账本改小，单独提交。

  **第二刀（同日，`0560998df`）验证了这套筛法可复用**：runtime 注册表那一对（247 行 SQLite /
  336 行 PG，十二个方法同名同序）五处同步调用点的外层函数**全部已经是 async**，一筛就中，改完
  同样零级联。这一刀比第一刀更进一步——不只是退掉同步网关，而是**把两份 provider 实现整体合成
  一份**，PG 那 336 行连同它内联重写的会话失效逻辑一起退役。两条经验记下来：

  - **隔离级别要逐方法抄 PG 那份**，别一刀切成 `.transaction`。PG 侧对「先查后写」的跨行判据
    （默认 runtime 不许停用 / 最后一个不许删 / 种子只种一次）用的是 SERIALIZABLE + 40001 重放，
    合一后对应 `databaseSessionFor(db).serializable`；其余两处才是普通写事务。
  - **合一会顺带照出「PG 自己抄了一份」**：`transitionRuntimeTests` 在 PG 文件里被内联重写，与
    `legacy/mcpRuntimeTestTransitions.ts` 的同步版并存。这类重复只有在合一时才会被逼着逐字段对
    账——本次对完确认语义相同，合并即可；D23c / D25 / D26 那几次对完是 PG 更弱，要按强的那侧抬齐。

  ### 账本里有一批「测试专用」的同步面：先分类，再决定要不要迁（2026-09-07 清点）

  按上面的筛法逐处看 resource-catalog legacy 那 11 个调用点时发现：**其中 10 个所在的函数在
  生产代码里一个静态调用方都没有**，只被测试大量使用。逐个清点（`grep` 静态调用点，
  排除定义文件本身）：

  | 函数 | 生产调用方 | 测试用点 |
  | --- | --- | --- |
  | `legacy/agent.ts` `createAgent` | 0 | 250 |
  | `legacy/agent.ts` `updateAgent` | 0 | 36 |
  | `legacy/agent.ts` `deleteAgent` | 0 | 23 |
  | `legacy/agent.ts` `renameAgent`（2 处调用点） | 0 | 14 |
  | `legacy/workflow.ts` `copyWorkflow` | 0 | 9 |
  | `legacy/workgroups.ts` `createWorkgroup` | 0 | 53 |
  | `legacy/workgroup/state.ts` `casGateStatus` | 0 | 14 |
  | `legacy/workflow.ts` `createWorkflow` | 1（`legacy/workflow.yaml.ts`） | 110 |
  | `legacy/importRefs.ts` `resolveImportRefs` | 1（同上） | 11 |

  而那唯一的上游 `importWorkflowYaml` 自己也是**生产零调用方 / 16 处测试用点**——整条
  YAML 导入链在生产里没有入口（生产只消费同文件里的纯函数 `stringifyWorkflowYaml`）。
  资源写面的生产路径早已走中立的 `agentRepository.ts` / `agentPersistence.ts` 那一套。

  **这件事改变优先级**：这 8 个调用点**不是**「PostgreSQL 上跑不了某个功能」，而是**测试夹具
  把一批已死的生产代码吊着**。它们在账本里和真正的单引擎路径混在一起，会让「还剩多少」显得比
  实际的用户可见风险更严重。

  **另记一笔工具上的坑**：用「往上找最近的函数声明」这种正则启发式判断「外层是不是 async」会
  **漏判**——`renameAgent` 明明是 `export async function`，却因为它体内先出现了别的匹配行而被归进
  「外层非 async」那一堆。也就是说零级联候选比第一次扫出来的 23 处**更多**，下一轮筛选建议直接用
  TypeScript AST 取 enclosing function，别用正则。

  **处置建议（按性价比排序，都不必一次做完）**：

  1. **先确认「零调用方」**——上面只查了静态调用点，还要排除经 operation descriptor /
     `services/*` re-export 的动态到达。确认后按仓规「删除优于 deprecate」整体删除，测试改接
     中立仓（`agentRepository` / `workflowPersistence` 一类），账本一次掉 10 个点——
     `legacy/agent.ts` 那 5 个调用点**整份**都在这一类里（create / update / delete / rename×2）。
  2. **若暂不删**：把它们的内部改成中立事务原语即可，**签名一格不动**（它们本来就是 `async`），
     250 处测试调用完全无感——这仍然是零级联的一刀，只是收益是「账本数字」而非「用户可见能力」。
  3. **别再把它们和真单引擎路径混在一张表里**：下次更新账本正文时给这类加个标记，让读账本的人
     一眼看出哪些是「功能只有一个引擎能用」，哪些只是「测试夹具吊着的死代码」。

  **仍然成立**：不要再做第四次全量机械转换。账本口径确实少算一半以上（30 个调用者 vs 61 个
  `DbTxSync` 引用者），但**按这种切法它不再是拦路石**——每一刀只动自己那几处；口径问题留到最后
  那批「外层函数还不是 async」的文件时一并处理。

  ### 剩余工作的真实形状：一件事，不是 N 件（2026-09-06 量化）

  上面两条勘察（D23b 卡在 bundle apply 的同步大事务、剩余 task-execution 对卡在 `withOwnedTaskTx`）
  指向同一个根：**bun:sqlite 独有的同步事务面**。已按调用点清点并上了高水位账本
  （`tests/architecture/rfc359-sync-transaction-highwater.test.ts`，注册进 `ledger-baselines.json`
  与 `guard-manifest.json`）：

  | 上下文 | 调用点 |
  | --- | --- |
  | modules/resource-catalog | 52 |
  | modules/task-execution | 20 |
  | platform | 18 |
  | modules/intent | 13 |
  | modules/collaboration | 8 |
  | services | 4 |
  | auth | 4 |
  | **合计** | **129（43 个文件）** |

  中立原语**早就有**（`databaseSessionFor` / `withTaskExecutionWrite` / `withTaskExecutionSerializable`），
  所以剩下的不是设计问题而是迁移量。账本让这件事从此可计数、可防守：新增一个同步调用点就红，
  收敛了也要改账本——每一次减少都留下一次有署名的记录。

  ### Skill 聚合的勘察结论（W4-D23，尚未动手；这是剩余最大的一块）

  形态与任务房 / 回合完全同类，但深一个量级：**SQLite 侧是一层薄适配器，套在成熟的崩溃安全机器上**
  （`sqliteSkillRepository.ts` 129 行 → `legacy/skill.ts` + `legacy/skillVersion.ts`；
  `sqliteSkillCatalogBoot.ts` 22 行 → `legacy/skillBootVerify` + `skillIdentityMigration` +
  `skillVersion`；`sqliteSkillZipImport.ts` 23 行 → `legacy/skill-zip`），**PostgreSQL 侧是 3342 行原生
  重写**（`postgresqlSkillCatalogBoot.ts` 1418 / `postgresqlSkillContentLifecycle.ts` 873 /
  `postgresqlSkillRepository.ts` 505 / `postgresqlSkillZipImport.ts` 546）。两侧归一化后的**相似度只有
  7%**——不是同一份逻辑的两种写法，是两套机器。测试覆盖同样倒挂：SQLite / legacy 侧 52 个套件，PG 侧 6 个。

  **为什么不能照 D19c 的做法直接合**：D19c 能把 PG 那份提为中立基线，是因为它的决策逻辑本来就在
  provider 中立的 driver 里、PG 那份只是持久化适配器。Skill 不是——SQLite 那套机器同时耦合
  **文件系统**（`skillFsPublish` 的暂存目录 / 原子换入、`skillHash` 的树哈希、`skillIdentityPaths`）
  与 **`dbTxSync`**（28 处），崩溃安全协议就建立在「同步事务 + 目录换入」的次序上。把它中立化＝把
  这套恢复协议整体迁到 `DatabaseSession`，那正是账本里一直挂着的 **W9-E** 波次。

  **建议拆法（每一刀都要能独立跑绿）**：
  1. **D23a 勘察对账（零生产改动）**：把两侧的行为逐条列成对照表——版本快照 / 内容围栏 / 目录换入 /
     启动重验 / 身份迁移屏障 / zip 导入的解析与提交，各自的失败模式与恢复点。产出是「哪一份是正典」的
     逐条裁决，呈用户确认。参照 D19c 的教训：**先对着端口数覆盖**（`SkillRepository` /
     `SkillCatalogBootAdapter` / `SkillZipImportPort`），52 个套件里有多少是直连 legacy 实现的。
  2. **D23b 把 legacy skill 机器迁到 `DatabaseSession`**（W9-E 的实质）：28 处 `dbTxSync` 换成统一事务
     原语，恢复协议的次序不变。这一刀不碰 provider 分叉，只把 SQLite 那套变成两个引擎都能跑的。
  3. **D23c 合一**：SQLite 装配切到那套（已中立的）机器，PG 的 3342 行原生实现退役；差异按 D19c 的三条
     处置（正典恒取合一前 SQLite / 部署形态差异抽端口 / 合完立刻跑「谁引用了这些路径」的全部测试）。

  **剩余 provider 对的形态普查（决定后续排序）**：把 resource-catalog 里剩下的成对文件按
  「SQLite 是不是 legacy 薄壳」分两类——
  - **对称对（机械可合，无行为风险）**：`PackageResourceRows`（230 / 220 行，无 legacy import）、
    `IntentContextResourceAuthorization`（63 / 52 行，无 legacy import）→ 已由 **D20** 合掉。
  - **薄壳对（SQLite 是 legacy 上的壳，PG 是原生实现，且测试覆盖倒挂）**：任务房（71 / 1457）、
    回合（34 / 567）、Skill 三对（22–129 / 505–1418，52 个套件盯 SQLite 侧、PG 侧只有 6 个）、
    `ResourcePackageMaintenance`（293 / 379，5 处 legacy import）、
    `DigitalEmployeeAgentTemplateCatalog`（59 / 390）。这一类**都不是机械合一**：合的时候要先裁
    「哪一份实现是正典」，且大概率会像 D19b 一样撞出用户可见的行为差异。建议逐个先做「形态勘察 +
    覆盖对比」再动手，不要按文件数排优先级。

  **D20 ✅（两对对称适配器合一）**：`infrastructure/intentContextResourceAuthorization.ts`
  （Intent 上下文的资源身份 / 授权等级读取；异步端口一份，SQLite 的同步变体保留——Intent 宿主在
  SQLite 上仍跑在 `dbTxSync` 回调里，随宿主切统一事务原语后退役）与
  `infrastructure/packageResourceRows.ts`（资源包的 owner+name 查找 + 预览 / 导出读模型）各一份。
  同批清掉两处死代码：SQLite 的 Intent **异步**工厂零生产消费（两个 SQLite bootstrap 用的都是同步版）、
  `listSqlitePackageResourceRowsByIds/ByNames` 零消费；`sqlitePackageResourceRows.ts` 缩到只剩
  legacy 提交路径用的四个同步助手。三个 provider 文件删除；rfc345 三把锁与 rfc349 adapters 锁改指中立实现。
  `rfc359-w4-d20-adapters.test.ts` 两引擎各跑身份读取 / 授权三元组精确命中 / owner-name 查找 /
  读模型按 id 与 name 取快照 / 只回活跃用户 + 源码锁。

  ---

  ## W4 机械阶段收尾：剩余 provider 对的全仓普查（2026-09-06）

  D14–D20 之后，**能靠「PG 异步实现改名成中立实现 + SQLite 装配切过去」机械合掉的对已经清空**。
  全仓仍有 176 个 provider 命名的文件、约 39 对，逐对量过之后它们全部落进下面两类，**每一类都需要
  先做一个决定，不能再当重构顺手推**：

  ### 甲类：薄壳对——SQLite 是 legacy 上的壳，PG 是原生实现，且**测试覆盖倒挂**

  | 对 | SQLite / PG 行数 | SQLite 侧行为套件 | PG 侧 |
  | --- | --- | --- | --- |
  | 工作组任务房 | 71 / 1457 | 13（含 rfc164 / rfc167 / rfc311 / rfc329） | 3（多为源码形状锁） |
  | 工作组回合引擎 | 34 / 567（+ 中立驱动 2819） | 同上 | 同上 |
  | Skill 三对 | 22–129 / 505–1418 | 52 个文件 | 6 |
  | ResourcePackageMaintenance | 293 / 379（5 处 legacy import） | — | — |
  | DigitalEmployeeAgentTemplateCatalog | 59 / 390 | — | — |
  | task-execution 十对（TaskRouteOperations 292 / 2048、TaskRouteLaunchOperations 92 / 1362、TerminalMaintenancePersistence 33 / 543、TaskOwnershipPersistence 43 / 444、TaskArchiveMaintenanceCommand 66 / 746、ChildExecutionLaunchOperations 87 / 770、TaskExecutionEffectPersistence 369 / 1007、TaskExecutionRecovery 393 / 674、TaskLifecycleAutoRepairCommand 65 / 198、TaskExecutionResourceSnapshots 40 / 69） | — | — |

  **这一类的共同问题**：两侧不是同一份逻辑的两种写法，而是**两套实现**；哪一份是正典要先裁。

  **D19b 给出了这一类的做法模板（已实证）**：照 PG 形状合完、双引擎测试全绿，仍撞出 4 条用户可见的
  行为差异（confirm 恢复失败从 410 变 200、继续意图类别写成没人认领的 `resume`、加成员的错误码变了、
  遣散人类成员后的补跑丢了）。处置不是回退，而是：
  1. **正典恒取合一前 SQLite 的行为**（它有 13 个套件盯着，PG 侧那条路几乎无覆盖）；
  2. 差异若源自**部署形态**（daemon 是否与 API 同进程）而非数据库，就抽成一个注入端口，两个 bootstrap
     各注入自己的实现——不要在实现里按 provider 分叉；
  3. 合完立刻跑「引用了这些路径的全部测试」（`scripts/tests-referencing.sh`），逐条把红归因成
     「锁的是文件名」还是「锁的是行为」；后者一律按 ①修回去。

  **做法建议**：逐对先出「形态勘察 + 覆盖对比 + 行为差异清单」，按上面三条处置；不要按文件数排优先级。

  ### 乙类：同一判据的两种写法——端口已是异步，卡在**逐对的语义判断**上

  （初稿把这一类记成「同步宿主对」，逐对量过之后更正：`RuntimeSessionLeaseOperations`（9 个方法全
  `Promise`）、`HumanGateTaskLifecyclePersistence`（3 个全 `Promise`）等的**端口契约本来就是全异步**，
  SQLite 只是内部用 `dbTxSync` 实现——调用方能 await，所以它们和 D14–D18 一样**没有宿主阻塞**。）

  真正卡住的是**逐对的语义判断**，各不相同，必须一对一看清再动：

  - **事务隔离级别**：PG 侧的 `withPostgresqlSerializableTaskExecution`（SERIALIZABLE + 40001 重试）
    与中立的 `withTaskExecutionWrite`（`databaseSessionFor(db).transaction`，PG 上是 READ COMMITTED）
    不是同一条路。中立模块的注释论证过「owner 围栏本身是 owner 行上的条件 UPDATE，行锁已把同一任务的
    写手串起来」，但**每一对都要单独确认它没有跨行不变量**才能降级。

    **`RuntimeSessionLeaseOperations` 的答案已经取证（结论：可以降级）**：
    - 七个操作只碰 `runtime_session_leases` 与 `node_runs` 两张表；
    - 每一处写入要么是主键作用域的 insert，要么带身份 + 状态谓词的 CAS
      （`protocol` / `sessionId` / `leaseNodeRunId` / `leaseNonceDigest` / `resetPending` / `status`）；
    - 唯一的「先查后写」竞态在 `claimNew`：租约表主键是 `(protocol, sessionId)`，而代码里**本来就有**
      `if (constraintViolation(error)) fail('owner-conflict')` —— 也就是说它防重复认领靠的是主键 +
      显式冲突映射，**不是靠 SERIALIZABLE**。
    - 因此这一对可以按 D14–D18 同法合并（PG 异步实现改名成中立实现、SQLite 装配切过去），
      **唯一要补的验收**：两引擎各跑一条并发 `claimNew`，断言恰好一个成功、另一个是 `owner-conflict`。
  - **同步 / 异步的闭包冻结**：`TaskExecutionResourceSnapshots` 的 SQLite 侧走
    `freezeTaskExecutionCallClosureSync`、PG 侧走 `...Async`，application 层同时留着两份冻结器；
    合一要先确认异步那份能覆盖同步那份的所有调用点。
  - **真同步宿主**：只有 Intent 上下文授权那半是货真价实的——Intent 宿主在 SQLite 上确实跑在
    `dbTxSync` 回调里（D20 已把异步半合掉、同步半按债保留）。

  **共同的机会（已清 ✅ D21）**：`assertPostgresqlTaskOwnerTx` 与中立的 `assertTaskOwnerTx` 又是一对
  **逐字重复**（归一化后逐字相等，与 D19a 去重掉的 `assertPostgresqlTaskOwnerlessTx` 同形）。
  已删掉 PG 那份定义，三个生产消费方（协作运行时机制 / 运行时会话租约 / 人类闸门）与一个测试改指中立模块；
  owner CAS 围栏至此只有 `ownedTaskExecution.ts` 一处定义。这一条不需要任何语义判断。

## 5. W5 —— 防复辟

- **T19g（D2 新增）** 「迁移后 `sqlite_master` vs 逻辑契约」对账守卫：把 SQLite 迁移跑完后的索引（含部分索引谓词）/ CHECK /
  触发器与 `buildLogicalSchemaContract()` 逐项对拍，差异要么补进 drizzle 声明（PG 随之投影），要么显式登记为 SQLite 专属并写明理由。
  已知差异：`repo_group_nodes` group 挂载 CHECK、`repository_transport_connections` 摘要 / token_hint CHECK（B6 记）。
- **T19h（D2 新增）** PG 目标的增量迁移：目前 `migratePostgresqlSchema` 只认 empty / ready，plan 变了已部署目标只能重做 cutover。
  设计 PG 侧的 journal 追加与按语句补齐，让 schema 演进对两个引擎同一套流程。

- **T17** provider 命名文件只允许在 `platform/persistence/`（棘轮到 0）。
- **T18** 裸 `db.transaction(` 只允许在事务原语文件。
- **T19** `provider === ` 只允许在 `platform/persistence/`，其余全仓 exact 账本为空。
- **T19b** 组合根全量：`cli/` 与 `*/composition*` 下禁 `*-not-bound` 与晚绑定 holder。
- **T19c** 启动序列恰有一个调用方，`cli/start.ts` 无 provider 执行分支。
- **T19d** 覆盖率对等棘轮（过渡期，可在 W1 后立即上）：同一 port 两侧行覆盖率差超阈值即红。
- **T19f** PG 执行面上禁止模块顶层捕获 `@/db/schema` 的表列（`const X = { …: 表.列 }` / 顶层 `select({...})`
  投影常量）：表是按 provider 投影的 Proxy 门面，顶层捕获会钉死在加载时的 provider 上，PG 侧 bigint mapper 丢失、
  数值列以字符串返回（B4a 实撞，`memoryInjectionReadStore` 老 PG 适配器同病）。守卫扫 `postgresqlExecutionSurface`
  语料，存量逐条改为函数内取列后钉 0。
- **T19e ✅（首版）** `tests/helpers/eachProvider.ts`：`describeEachProvider` harness（design §11.1）——双引擎是
  **缺省**，PG 侧无 URL 即 **fail** 而非 skip（`AW_TEST_PROVIDERS=sqlite` 仅本地显式降级）；
  per-file schema 隔离；body 拿不到 provider 名。存量 816 文件 / 1,882 处 `createInMemoryDb(` 逐 context 迁入。
- **T19f** 守卫「测试不得写死引擎」：harness 之外的 `createInMemoryDb(` 棘轮 1,882 → 0；测试内
  按 provider 分叉须经 `capabilities` 且计数入账。
- **T21b** 执行链取证进 push CI：两个引擎上各起一个任务跑到 done（RFC-349 验收漏掉的那一环）；
  `postgresql-evidence.yml` 的 `prepareSoakDataset` 不再把在飞任务归一成 done。
- **T20** 方言表完备性守卫（语料按类型可达派生，沿用 `tests/architecture/postgresqlSurface.ts`）。
- **T21 ✅（首版，`test-backend-postgresql` 窄 lane 暂留）** **四个 backend 分片各自带 `services: postgres:17`**，PG 半边在每个分片里跑（design §11.2）；
  `test-backend-postgresql` 窄 lane 退役。时长由 per-file schema 并行 + W4 后测试数减半对冲，
  实测写回 proposal §6。按 D5 不打折。
- **T22** 退役 `rfc349-dual-provider-predicate-drift`（对象已消失），退役 `dbTxSync`（**C-1**）。

### W5 落地记录（2026-09-07，`e0be514a3` + `604b0a184`）

16 条守卫一次上线，全部只降不升棘轮 + 变异验证，`tests/architecture/` 571 pass / 0 fail。
账本值全部用 census 的 `ledgerEntryCount` / `corpusFloor` 实算。

| 守卫 | 账本 | 值 |
| --- | --- | --- |
| T17 provider 命名文件位置 | `PROVIDER_NAMED_FILE_DEBT` / `..._DIRECTORY_DEBT` | 136 / 2 |
| T18 裸 `db.transaction(` | `BARE_TRANSACTION_DEBT` | 17 |
| T19 provider 条件分叉 | `PROVIDER_BRANCH_DEBT` / `..._RELOCATION_DEBT` | 16 / 1 |
| T19b 组合根占位 | `COMPOSITION_ROOT_PLACEHOLDER_DEBT` | 13 |
| T19c 启动序列 | `PROVIDER_EXECUTION_BRANCH_DEBT` | 1 |
| T19d 覆盖对等 | `COVERAGE_PARITY_LEDGER` / `INVERTED_PAIRS` | 26 / 6 |
| T19f 测试写死引擎 | `TEST_ENGINE_HARDCODING_DEBT` | 821 |
| T19f 顶层捕获表列 | `TOPLEVEL_COLUMN_CAPTURE_DEBT` | 8 文件 / 83 处 |
| T19g schema 契约对账 | `SQLITE_ONLY_PROTECTIONS` 等三份 | 149 / 7 / 4 |
| T20 方言完备性 | `RAW_DIALECT_DEBT` / `UNSHIMMED_FUNCTION_DEBT` | 12 / 0 |
| W6-T28 读—改—写不加锁 | `READ_MODIFY_WRITE_DEBT` | 9 文件 / 20 处 |
| 判据缺口账本（新） | `DUAL_ENGINE_PREDICATE_GAPS` | 17 |
| 成对适配器对拍（新） | `PROVIDER_PAIR_CONFORMANCE_LEDGER` | 26 对 / 25 未验证 |
| 组合根被测试构造（新） | `PROVIDER_RUNTIME_UNEXERCISED` | 70 / 102 |
| 死适配器（新） | `DEAD_PROVIDER_ADAPTER_DEBT` | 18 |
| 工件格式可移植性（新） | `ARTIFACT_FORMAT_PORTABILITY` | 12 格真值表 |

**已知缺口**：RFC-317 的中央高水位网按符号名只认 `*_DEBT`，所以 `SQLITE_ONLY_PROTECTIONS`(149)、
`PROVIDER_RUNTIME_UNEXERCISED`(70)、`DUAL_ENGINE_PREDICATE_GAPS`(17)、`COVERAGE_PARITY_LEDGER`(26)
**不在中央网里**——各自文件内有逐字相等断言、并非无人看守，但少了跨守卫统一视图。统一改名进网是独立一刀。

### 计划勘误（本轮实测推翻，动手前先读这一节）

**① T21b 的 `prepareSoakDataset` 断言：字面属实，危害不成立，不要改。**
计划写「它把在飞任务归一成 done」。那两条 UPDATE 确实存在（`tests/helpers/rfc349PostgresqlHostedEvidence.ts:1143-1172`），
但改的是 `scripts/perf-seed.ts` 秒级前刚播的**合成 fixture 行**——唯一调用点紧跟 `daemon.stop()` 之后，
库里没有任何进程跑过的行，那条 lane 也从不起任务，报告里没有一条判据依赖任务状态。
**而且删掉它换不来「在飞状态」**：daemon 一启动，boot recovery 就把同一批行逐行 reap 成 `interrupted`
（weekly 档约 6 万 runs、full 档约 60 万），可能顶穿 300s/600s 的 ready 超时——姊妹脚本
`scripts/rfc338-maintenance-soak.ts:246-251` 已经写过这个理由。

**② T22 前半「`rfc349-dual-provider-predicate-drift` 对象已消失」：不成立，现在不可执行。**
26 对适配器仍在盘上，该守卫今天跑绿（在扫，不是空转），且它自己写着退役条件——「W5-T17 棘轮到 0 时
随之退役」，而 T17 今天是 136 行。**它要等 W4 收敛完才能退役**，不是现在。

**③ T19f「存量逐条改为函数内取列后钉 0」把 0 当成了起点。** 实测上线当天存量就是 83 处 / 8 文件
（RFC-311 列表页投影常量那一轮留下的）。「钉 0」是终点。

### T21b 的正确落点（调研结论，未实施）

push CI 的四个 ubuntu 分片**早就带真 PostgreSQL**（W5-T21 已落），所以这条守卫**一行 YAML 都不用改**——
缺的是一个 `describeEachProvider` 后端集成测试。真正的代价在测试本身：唯一的驱动 harness
`tests/helpers/taskExecutionTestTopology.ts` 整个是 SQLite 硬编码，PG 侧要另攒一份端口束（约 150–250 行）。
而且**全仓今天没有任何测试真的在 PostgreSQL 上跑过执行链**，这条守卫大概率会当场挖出真缺陷——
它是一个 RFC 子任务的体量，不是 CI 接线。

## 5b. W6 —— PostgreSQL 最高性能（design §10）

- **T23** DDL 投影：JSON 列在 PG 上渲染为 JSONB；热查询列建 GIN（D6，存量 PG 部署一次迁移）。
- **T24** 矩阵的 `jsonExtract` / `jsonContains` 渲染成 `->>` / `@>`；替换 `json_extract` shim 的热路径调用。
- **T25** 批量写：矩阵给出 `batchInsertMax`，逐行 INSERT 的热路径改按批。
- **T26 ✅ 已完成**（W8）。三条计划缺口全部销账，`PLAN_GAPS` 现为空。实测：任务目录
  `facet_attention` loops 10000 → 1、84.053ms（含 JIT 32.419ms）/ 107,042 buf → 22.006ms / 2,098 buf；
  `/api/cached-repos` facets loops 10000×3 → 1、122.262ms（含 JIT 63.606ms）/ 200,820 buf →
  35.214ms / 5,191 buf。整条路径墙钟（50k 语料）：任务目录 99.8 → 27.8ms、仓库页 149.9 → 27.7ms，
  **两条路径的 JIT 编译都消失**（估算代价掉到 `jit_above_cost` 以下，未动任何 JIT 参数）。
  **过程中推翻了本账本自己写的「正解」**：原方案「两个 EXISTS 改成预聚合 UNION + LEFT JOIN」在 PG 上确实快，
  但它把代价从 O(仓库数) 换成 O(任务数)，而生产里任务表大几个数量级——实测 SQLite 侧 **退化 80×**
  （0.2ms → 16.3ms），并当场把 `rfc311-perf-guards` [sqlite] 打红（`SCAN tasks` 裸扫无界表）。
  最终形状是把 `exists` 送回 **WHERE 子句**（两个 planner 都会上提成 semi/anti join）+ 三格互斥标量子查询，
  **让每个引擎各自选计划**：PG 选 hash semi join、SQLite 选索引探，两种表比例下都不退化。
  教训：「PG 上更快」不等于「该这么写」——本 RFC 的判据是**两个引擎都不退化**。
- **T27 ✅ 已完成**。5 个性能守卫（`rfc311-perf-guards` / `rfc311-perf-foundation` /
  `rfc244-task-operations-benchmark` / `rfc311-task-page-fastpath` / `rfc311-task-page-filtered-fastpath`）
  全部走 `describeEachProvider`；`rfc311-perf-guards` 里有真正的**跨引擎对比**——两个引擎各取 P95、
  打印比值作诊断，并带一条 AC-11「塌方探测」断言。注意判据本身已按 RFC-244 的教训从**墙钟**
  换成**取回行数**（墙钟测不出真回归、机器一忙又假红），墙钟仅作诊断基线保留。
- **T28** 写法纪律审计：全仓「读—改—写中间不锁」的形状清单（`READ_MODIFY_WRITE_DEBT`，8 文件 / 19 处）。
  **用户 2026-09-07 裁决：「功能问题就做」。** 判据因此**不是「有没有加锁」，而是「并发能不能
  产出用户可见的错结果」**——丢一次计数、少一行、状态被覆盖，这些是功能缺陷，做；判不可达的
  （调用方本就在同一把写锁内串行 / 单一写者 / 该路径即将退役）写清理由留在账本里，不改。
  实施纪律：**先写双引擎并发用例把错的结果演出来（红），再加 `lockAggregateRoot`（绿）**；
  演不出错结果 ⇒ 该处不可达，回去重判。用能力矩阵的 `lockAggregateRoot`，不得裸写
  `SELECT … FOR UPDATE`（会掉进 T20 的裸方言账本）。
  **勘误（2026-09-07 实测推翻）**：本条原写「19 处里 17 处两个引擎都有 ⇒ 不是 provider 分叉」。
  **那是错的。** 代码形状确实两侧都有，但**缺陷只在 PostgreSQL 上成立**——W8 的变异验证
  6/6 全是「PG 红、SQLite 绿」。原因是 `createSqliteDatabaseSession` 是**进程内单写者租约 +
  `BEGIN IMMEDIATE`**，两笔写事务之间没有任何交错窗口；SQLite 上连**表达**这类时序都不行
  （旁观者语句会被 `CrossContextTransactionError` 当场拦下，用例因此要按 capabilities 分叉）。
  所以 T28 **正中本 RFC 的靶心**：同一份实现搬到另一个引擎才暴雷。
  推论：这类用例的 SQLite 那一遍**不是冗余**——它钉住的正是「换个引擎才炸」这件事本身。
  变异验证时若**只在 PostgreSQL 上红**（SQLite 的 `BEGIN IMMEDIATE` + 写者租约本就全序列化），
  那是结论不是缺陷，要如实记录。
  这类代码在 SQLite 上碰巧正确、在 PG 上是竞态——合一时必须改形状，不能原样搬。

## 5c. W7 —— 成对适配器收尾（并发波次）

**为什么排在 W5/W6 之后**：W4 定的目标是「153 对 → 0」，但当时没有「还剩哪些对、每对验没验过」
的清单，只能凭印象挑。W5 的 `rfc359-w5-provider-pair-conformance` 账本把它变成了**有限、可排期、
带 verified/unverified 状态**的集合——W7 就是照着那张表逐对收。测试文件统一叫 `rfc359-w7-*`。

**做法上的一个前提**：此前合一验证只能串行，因为 PG harness 按文件 `drop schema … cascade`，
两批双引擎测试并行会互相清库（见 `docs/dev-gotchas.md` 那一条）。本波先在同一个容器里开了
8 个隔离库（`awpar1`…`awpar8`），每个作业独占一个，**并行验证才成立**；git index 与
`architecture/*.json` 重采仍然只能串行。

### 已合 11 对（各带 `describeEachProvider` 对拍）

`RealtimeStore` · `ResourceLimitPersistence` · `ClarifyDirectiveStore` · `ReviewRepairParticipant` ·
`ClarifyRepairParticipant` · `TerminalMaintenancePersistence` · `IntentSqlProgramRunner` ·
`IntentPersistence` · `platform/events/committed/Persistence` · `CollaborationRouteOperations` ·
`CollaborationRuntimeMechanics`。

**净退役 4960 行**（删 6902 / 新建 1942），同时新增 **20 个双引擎对拍文件 / 10281 行**。
最能说明形态的一组：`collaborationRouteOperations.ts` 用 **149 行**替代了 2269+116 行，
`collaborationRuntimeMechanics.ts` 用 **99 行**替代 1746+81 行——因为 PG 那两份「原生重写」重写的，
正是 SQLite 薄壳早已转发过去的同一台机器。

**「先补对拍、再合一」这条又一次被证明是对的**（D23c/D25/D26 之后第四次）——纸面判成
「零分叉」的对，一跑对拍就照出真差异：

- **`ClarifyDirectiveStore`：PG 侧的裸 `db.transaction` 不可重入。** 外层显式事务里调 `store.set`，
  外层回滚后 SQLite 侧 0 行（写被一起回滚）、**PG 侧 1 行**（另开连接独立提交，外层带不走）；
  外层事务还开着时独立连接就已经能看到那笔写。合一后两侧都可重入，这条已锁进对拍。
- **`TerminalMaintenancePersistence`：PG 侧有两处更强，按强侧抬齐。**
  ① 并发 claim 的错误分类（PG 捕 `23505` → `task-terminal-maintenance-conflict`，SQLite 侧让裸
  `SQLITE_CONSTRAINT_UNIQUE` 冒泡）——中立实现改走能力矩阵的 `classifyError`；
  ② `snapshotTree` 的原子性（PG 把递归枚举 + 快照放同一笔 SERIALIZABLE，SQLite 分两笔 ⇒ 枚举与
  快照不原子）——中立实现只保留单事务形态，子树枚举用迭代 BFS 替掉两方言不通用的 `WITH RECURSIVE`。
  两条都做了变异验证。
- **两个 repair participant 的事务包裹没有语义依据**：`unapprove` 在 SQLite 侧包、PG 侧不包，
  `reopen` 反过来。合一按**语句形态**裁定（读改写序列包、单条 CAS UPDATE 不包），
  理由写进头注释——而不是「保留原样」。
- **`IntentSqlProgramRunner` 的 `get` 陷阱**：详见 `docs/dev-gotchas.md` 新增的那一条。
  纸面上「以 PG 为正典」会让 SQLite 上每个具名字段静默变 `undefined`。

### 判定为**不该合**的对：从 3 对增到 7 对

成对账本上「同名两份实现」并不等于「重复实现」。逐方法核对后判定**不合**的，本波又加两对——
合一会把一侧的缺口伪装成完成：

| 对 | 为什么不合 |
| --- | --- |
| `LogicalSource` / `LogicalTarget` | 漂移检测与目标端口物理绑定引擎 |
| `TaskLifecycleAutoRepairCommand` | PG 侧只实现了 14 个规则族中的 1 个 |
| `IntentApplyArtifactLifecycle` | **两套不同的恢复设计**：SQLite 重放 `skill_operations` 账，PG 从 `skills`/`skill_versions` 行 + 目录哈希重新推导。两侧写路径只产出各自那一套事实，换一侧跑就无据可依。日志工件词汇也不互通（同一列 `intent_apply_journal.prepared_artifacts_json`：`opId`/`skillDir` vs `operationId`/`stagingDirectory`，信封一个带 `{version,artifacts}` 一个是裸数组），而解码器是 `.strict()`。 |
| `IntentApplyOperations` | 骨架同构，但挂的是**两套资源会话协议**（提交期句柄、提交后前滚、资源侧中止的形状都不同），合它等于先合 resource-catalog 的两套 apply 栈。 |
| `TaskRouteOperations` | **两台执行引擎**（见下「挑对的先验」）：SQLite 侧带模块级可变全局 + 2 处 `dbTxSync` + 自驱进程内 scheduler，PG 侧一律委托端口 + serializable 事务 + 已提交事件出站。合一的前置是 `services/task.ts` 的调度耦合与同步事务面——正是本节记的结构性阻塞。 |
| `TaskRouteLaunchOperations` | 1362 行里只有 47 行与那 92 行壳对位，其余是别的端口借住同一文件；真正要合的是它背后的启动机器。 |

**「不合」不等于「不管」**：这两对各配了一份双引擎对拍（共 1182 行），A 段锁两侧真正同义的
共同子集、B 段锁实测分叉，并做了变异验证——其中一次专门变异「照 PG 那侧合一」，确认对拍会拦住。
成对账本上它们从 `unverified` 翻成 `verified by`，但 `PROVIDER_PAIR_COUNT` **不减**：
仍是两份实现，只是从此有守卫看着。

### 「不能合」与「一侧更弱」是两件事，要分开处置

同一轮对拍在这两对上还照出三条**与合不合无关**的「一个好一个不好」，已单独立刀抬齐：
① 提交后前滚未完成时 SQLite 丢掉 `rollForward` 的返回值（那一行看上去干净，要等 boot/hourly
才发现）；② `intent-left-retryable` 诊断词汇只有 SQLite 记，运维在 PG 部署上 grep 不到同一类失败；
③ `plugin-install` 前滚的插件存在性判定只有 PG 做，SQLite 上「插件其实没装成」永远发现不了。

### 挑对的先验：**薄壳只说明「真实现在别处」，不说明「PG 抄了它」**

成对适配器里 SQLite 侧常常只有几十行。本波量了所有对的 `postgresql/sqlite` 行数比，
高比值确实高度对应「PG 把 SQLite 早已转发过去的那台机器又抄了一遍」——合掉后中立实现极短：

| 比值 | sqlite → postgresql | 合一后 |
| --- | --- | --- |
| 7.0 | 292 → 2048（`CollaborationRouteOperations` 是同形态） | **149 行**替代 2385 |
| — | 81 → 1746（`CollaborationRuntimeMechanics`） | **99 行**替代 1827 |
| — | 41 → 363（已提交事件出站存储） | 净退役 390 行 |

**但这条先验必须修正一次，否则会误判**：`TaskLifecycleAutoRepairCommand` 比值 3.0（65 → 198）
同样是薄壳，却是判定**不该合**的那一对——SQLite 的真能力在 `taskLifecycleRepair/options-*.ts`
（14 个规则族），PG 那 198 行只实现了 **1 个**。照「薄壳 = 抄写」硬合，会把 13 个规则族的缺口
伪装成完工。

**正确用法**：薄壳 ⇒ 先找到它转发去的那台机器，拿**机器**去比 PG 那份，然后才分得清
「PG 抄了同一台机器」（纯重复，合）还是「PG 另建了一个部分替代品」（能力缺口，不合）。

**再修正一次（task-route 两对实测）：薄壳可能转发到「好几个横向层」，不是一台机器。**
`sqliteTaskRouteOperations.ts` 292 行看着比值 7.0，但它转发到**四处**——`services/task.ts`
（读面 ~1220 + 命令面 ~2030）、`services/taskDelete.ts`(399)、
`legacySqliteTaskCollab.ts`(516)、`taskLifecycleRepair.ts`(513)，**合计约 4700 行**，
对面是 `postgresqlTaskRouteOperations.ts`(2048) + `postgresqlTaskRouteRepairOperations.ts`(1448)
约 3500 行。**不是「壳 + 机器被抄」，是两台执行引擎**：SQLite 侧带模块级可变全局、2 处
`dbTxSync`、并自己驱动进程内 scheduler；PG 侧一律委托三个端口 + `withPostgresqlSerializableTaskExecution`
+ 已提交事件出站。

**另一个陷阱：对面那个大文件里可能大部分不属于这个端口。** `postgresqlTaskRouteLaunchOperations.ts`
1362 行里**只有 47 行**站在 92 行壳对面，其余是别的端口借住在同一文件
（`createRootLaunch` 287 / `createPostgresqlTaskLaunchArms` 236 / 启动参与者 110 / 接口与快照构造 ~640）。

**所以量比值只能用来排优先级，不能用来下判定。** 判定必须做两件事：
① 把薄壳的**全部**转发目标找齐并求和；② 把对面文件按端口**分区段**，只比属于该端口的那部分。
本波已合的对里，`platform/events/committed/` 就是靠②才发现「802 行里只有一半服务这个端口」。

另一端也有信号：**比值接近 1 的对（两侧各自长出同样体量的代码）与「已判定不合」高度重合**
——`LogicalSource` 1.1、`SourceTerminationParticipant` 1.0、`TaskExecutionRuntimeParticipants` 1.2、
`ResourcePackageMaintenance` 1.3。同等体量通常意味着它们真的在做不同的事。

### 本波暴露的两个结构性阻塞

1. **`sqliteTerminalMaintenance.ts`（519 行 / 5 处 `dbTxSync`）删不掉**——`services/taskArchive.ts`
   `services/taskDelete.ts` `platform/persistence/sqlite/systemWorkspaceGc.ts` 三处要的是**同步端口
   独有**的 `assertClaimTx` / `transitionTx`，中立参与者是 async、进不了 `dbTxSync`。
   **同步事务面是死代码清理的前置**，不只是「以后再说的债」。
   三处的级联深度都很浅（两处外层已 async、一处只差一级），按 §「D28b 的可做判据」是最易的一类。
2. **`clarify_rounds` 的 `kind` / `status` CHECK 在 PG 上不存在**（实测：同一行 SQLite 拒、PG 收）。
   这与 W5-T19g 的 `SQLITE_ONLY_PROTECTIONS` 账本是同一件事的两次独立发现，
   佐证那 149 条不是纸面差异。

## 5d. W8 —— 一条必须挂在所有 `pre_snapshot` 类判据上的折扣（2026-09-07 实测）

W8 有三条分叉判据建立在**节点重试时按 `pre_snapshot` 回滚工作树**这条路径上
（retry 的快照丢失升级、syncWorkflow 的 canceled 档回滚、canceled wrapper 的原地复活）。
它们的代码路径是活的、判据也是对的，但**"用户可见"要打一个折扣，必须写明**：

**`pre_snapshot` / `pre_snapshot_repos_json` 今天没有任何写入方。** RFC-130 删掉了写入——
`modules/task-execution/composition/nodeMechanics.ts:4106-4111` 明写「the RFC-092/098
pre-snapshot … is GONE … columns + rollbackNodeRunWorktrees stay in the schema as
defense-in-depth but are no longer written here」。全 `src` 扫过一遍，其余 `preSnapshot:`
站点全是**继承传递**（`row.preSnapshot` / `latest.preSnapshot`），没有一处算出新 sha 写进去。

因此这三条的「同一操作两个引擎在磁盘上留下不同内容」**只对 pre-RFC-130 的存量行成立**
（或手工种的行）。抬齐仍然要做——路径是活的，哪天恢复写入就会立刻生效，而且判据本身正确；
但**不要把它们当成"当前生产里正在发生的用户可见故障"**去汇报。

**一般规律**：本 RFC 反复用「用户看到什么」作为判据，这很对；但「用户看到什么」的前提是
**这条路径当前真的会被走到**。判定一处分叉的用户可见后果时，要顺带确认它依赖的字段 / 状态
**今天还有没有生产写入方**——否则会把「存量数据上的差异」讲成「现在就在坏」。

### W8 发现的一条 schema 级分叉（未修，须与 T23 同批在安静工作树上做）

`node_runs.continuation_slot_key` / `lineage_slot_path_json` 的**补齐触发器只存在于 SQLite 的
迁移 0210 里，PostgreSQL 上没有**。后果：绕开生产工厂直插 `node_runs` 行时，两个引擎的
`readLineage` 结果不同——SQLite 有触发器兜底，PG 得到 null。

当前生产路径**够不着**（工厂本就显式写这两列，W8 的对拍已改成显式播种），所以不是正在发生的
故障；但它是一条**真正的能力不对等**：SQLite 有一层安全网，PG 没有。哪天有人新写一条忘了写这两列
的插入路径，SQLite 上被兜住、PG 上静默产出 null 行——正是本 RFC 要消灭的形态。

**为什么压后**：修它要动 `db/schema.ts` / 迁移，会开一个全仓 PostgreSQL 迁移历史漂移窗口
（`postgresql-migration-history-drift`，期间**所有** PG 泳道同时假红）。与 W6-T23（JSONB + GIN）
同性质，必须在**没有其他刀在跑**的安静工作树上一次做完并立刻
`bun run db:rfc349-postgresql-schema` 重生成历史。

**两条出路，实施时选一条**（都要先写双引擎判据）：①把触发器纳入 PG 的 DDL 投影，两侧都有安全网；
②把触发器从 SQLite 删掉，改为「插入点必须显式写这两列」的架构守卫兜底——与
`rfc359-w7-task-insert-lineage-completeness` 已经在做的事同形，那条守卫钉的正是
`insert(tasks)` 的三个 lineage 列。②更符合「面向代码最合理」：安全网写在守卫里对两个引擎同时生效，
而触发器天然只能属于一个方言。

## 6. 债与不做的事

- `legacySqlite*` 家族（clarify 子系统 3,401 行等）合一后仍带 legacy 命名与分层位置；
  **本 RFC 不迁**，随各 context 下一个 RFC 归位（design §1）。
- `workgroupTurns` 两侧是两套独立引擎（839 行 ↔ 2,801+561 行），**未做逐方法对拍**，
  分歧面可能比已发现的还大。**建议单独立一轮对账**，其结论可能给 W4-B1 增批。
- 前置对账的 5 条存疑项（Q1–Q5）不在本 RFC 范围，随 W4 各批顺带确认或销账。

### W7 发现的三处「合不了」，与「还没合」要分开记

这三处不是排期问题，是**结构上就绑死在一个引擎**，合一之前先要改形状。它们此前不在任何账本里
（成对账本只数「同名两份实现」，这三处不是那个形状），先记在这里：

- **`modules/integration/infrastructure/developmentToolConnectionStore.ts:43-53`** —— 读用
  bun:sqlite 的**同步** `.get()` / `.all()` 且**不 `await`**。换成 PostgreSQL 客户端时这两个
  方法返回的是 Promise，于是 `row === undefined` 永远不成立、`identityRow(promise)` 拿到垃圾。
  它**结构上只能跑 SQLite**——不抛错、不报警，只是悄悄产出错的数据。合一的前置是先把它改成
  异步读。（PG 侧另有自己的工厂，所以现状不是 bug；但那也意味着这一对永远是两份实现。）
- **`composeSqlite/PostgresqlResourcePackageApplyMaintenance` 的 API 不对称** —— SQLite 侧要调用方
  传 `activitySource`、不暴露 tracker；PG 侧自带内部注册表并多暴露一个 `activityTracker`。
  两者**调用点无法互换**，合一前要先把端口对齐。
- **`composePostgresqlTaskSourceTermination`** —— 两个引擎都构造得起来（组合根覆盖已证明），
  但它包的 participant 只在 PG 上真正 apply（`withPostgresqlSerializableTaskExecution`）。
  「装配得起来」不等于「跑得通」，这一对的覆盖要按后者写。

### 同步事务面是死代码清理的**前置**，不是可以往后放的债

W7 实测：`sqliteTerminalMaintenance.ts`（519 行）删不掉，唯一原因是三处服务要的是同步端口
（`assertClaimTx` / `transitionTx` 挂进各自的 `dbTxSync` 大事务），中立参与者是 async 进不去。
凡是「SQLite 侧薄壳 + 成熟同步机器」的形状都会撞到同一堵墙——**先清同步事务面，才轮得到删重复实现**。

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| W2 的单写者租约改变 SQLite 吞吐特征 | T13 基准实测；结果不可接受则回到「两套事务机制 + 上层一份实现」的退化方案（代价是 design §3 的统一性打折） |
| W4 体量大、跨 6 个 context、与并发 RFC 撞车 | 每 context 一个 PR；合一时只动 provider 维度，不顺手重构；撞车面按 CLAUDE.md 多人协作规则处置 |
| 合一过程中把 SQLite 侧的正确行为改坏 | 每对合一都带「合一前后 SQLite 行为逐字对拍」（AC-8） |
| P0 修复本身引入回归 | 每条先红后绿 + 修完再跑一次原变异确认转红（RFC-287 五轮门纪律） |
