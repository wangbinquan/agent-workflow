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
  **D19b ⛔ 已实现但未落地——需要用户先裁一个产品决策（任务房的「继续执行」语义不是持久化差异）**

  按计划做了完整实现（三份中立房间文件 + 一份装配 + 两个 bootstrap 切过去 + 两引擎行为测试，
  产物留在 scratchpad），双引擎房间测试本身四条全绿（房间聚合读 / 可见性 404 / 发言写入 + 广播 /
  终态拒绝）——**PostgreSQL 房间路径的第一份行为覆盖**。但受影响批次抓到 6 条真行为回归，全部指向同一处：

  - `rfc164-workgroup-room`「confirm 恢复失败时 gate、holder 与消息全部保持可重试」：期望 410，切换后得到 200。
  - `rfc167-dynamic-workflow-engine` 5 条：dw-confirm 的快照替换 + `phase=executing` 原子落地、
    holder 关闭、reject 的相位复位「骑在 resume 的 CAS 上」，切换后都不成立。

  **根因不是数据库**：legacy 的 SQLite 房间在请求内**同步**恢复任务——
  `taskActions.confirmGate` 走 `resumeTaskWithAtomicSideEffects(db, taskId, deps, (tx, transition) => …)`，
  把闸门关闭 / holder 关闭 / 消息写入放进**恢复自己的那笔事务**，恢复失败则整体回滚并以 410 打回，
  任务不会被搁浅（这几条锁正是 Codex P1「no stranding」审计的产物）。中立房间（PG 形状）走的是目标架构的
  **意图模型**：`participant.continueTask` 把任务置 `pending` 并提交继续意图，由 daemon 异步接手，
  请求同步返回 200，失败只能事后经任务状态浮现。PG daemon 是多进程、受理请求的进程未必持有该任务，
  **无法**在请求内同步恢复；所以这是「daemon 在不在同一个进程里」的部署形态差异，不是 provider 差异。

  **需要用户裁的决策**（三选一，都会改用户可见行为或工作量分布）：
  1. **统一到意图模型**：confirm 一律返回 200，恢复失败改由任务状态 + daemon 重试浮现；
     rfc164 / rfc167 的期望随之改写，前端「确认后立刻看到失败」的交互要重新设计。
  2. **给房间注入 `resume` 端口**：单进程部署（SQLite 单二进制）注入同步 resume 并保留 410，
     多进程 daemon 注入「提交意图」。一份房间实现、一处按**部署形态**（不是按数据库）分叉。
  3. **先做「继续执行语义统一」再回来合房间**：把同步恢复的原子性保证在意图模型里补齐
     （例如意图提交后由本进程 daemon 同步驱动一次并回传结果），代价最大但两种部署形态语义完全一致。

  在用户裁定前 D19b 不落地：现状是 SQLite 房间保留 legacy 同步恢复（行为更强、有 13 个套件盯着），
  PG 房间保留意图模型。

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
  D19b 已经实证了代价——任务房照 PG 形状合完，双引擎测试全绿，却撞出 6 条用户可见的行为回归
  （confirm 恢复失败从 410 变 200），根因是「daemon 是否与 API 同进程」的部署形态差异。
  **做法建议**：逐对先出「形态勘察 + 覆盖对比 + 行为差异清单」，呈用户裁定后再动手；不要按文件数排优先级。

  ### 乙类：同一判据的两种写法——端口已是异步，卡在**逐对的语义判断**上

  （初稿把这一类记成「同步宿主对」，逐对量过之后更正：`RuntimeSessionLeaseOperations`（9 个方法全
  `Promise`）、`HumanGateTaskLifecyclePersistence`（3 个全 `Promise`）等的**端口契约本来就是全异步**，
  SQLite 只是内部用 `dbTxSync` 实现——调用方能 await，所以它们和 D14–D18 一样**没有宿主阻塞**。）

  真正卡住的是**逐对的语义判断**，各不相同，必须一对一看清再动：

  - **事务隔离级别**：PG 侧的 `withPostgresqlSerializableTaskExecution`（SERIALIZABLE + 40001 重试）
    与中立的 `withTaskExecutionWrite`（`databaseSessionFor(db).transaction`，PG 上是 READ COMMITTED）
    不是同一条路。中立模块的注释论证过「owner 围栏本身是 owner 行上的条件 UPDATE，行锁已把同一任务的
    写手串起来」，但**每一对都要单独确认它没有跨行不变量**才能降级；`RuntimeSessionLeaseOperations`
    的合一就卡在这一条上。
  - **同步 / 异步的闭包冻结**：`TaskExecutionResourceSnapshots` 的 SQLite 侧走
    `freezeTaskExecutionCallClosureSync`、PG 侧走 `...Async`，application 层同时留着两份冻结器；
    合一要先确认异步那份能覆盖同步那份的所有调用点。
  - **真同步宿主**：只有 Intent 上下文授权那半是货真价实的——Intent 宿主在 SQLite 上确实跑在
    `dbTxSync` 回调里（D20 已把异步半合掉、同步半按债保留）。

  **共同的机会**：`assertPostgresqlTaskOwnerTx` 与中立的 `assertTaskOwnerTx` 又是一对**逐字重复**
  （D19a 已经这样去重掉 `assertPostgresqlTaskOwnerlessTx`），四个消费方改指中立模块即可，
  这一条不需要任何语义判断，可以随下一刀顺手清掉。

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

## 5b. W6 —— PostgreSQL 最高性能（design §10）

- **T23** DDL 投影：JSON 列在 PG 上渲染为 JSONB；热查询列建 GIN（D6，存量 PG 部署一次迁移）。
- **T24** 矩阵的 `jsonExtract` / `jsonContains` 渲染成 `->>` / `@>`；替换 `json_extract` shim 的热路径调用。
- **T25** 批量写：矩阵给出 `batchInsertMax`，逐行 INSERT 的热路径改按批。
- **T26** RFC-311 基准库在 PG 上跑 `EXPLAIN (ANALYZE, BUFFERS)`，逐热查询审执行计划，补 PG 独有索引
  （partial / expression / GIN）并经矩阵声明。
- **T27** 5 个性能守卫改 `describeEachProvider`；两个引擎各取 P95 基线；**PG 不劣于 SQLite**（AC-11）。
- **T28** 写法纪律审计：全仓「读—改—写中间不锁」的形状清单，逐条改成 `lockAggregateRoot`（design §10.1）。
  这类代码在 SQLite 上碰巧正确、在 PG 上是竞态——合一时必须改形状，不能原样搬。

## 6. 债与不做的事

- `legacySqlite*` 家族（clarify 子系统 3,401 行等）合一后仍带 legacy 命名与分层位置；
  **本 RFC 不迁**，随各 context 下一个 RFC 归位（design §1）。
- `workgroupTurns` 两侧是两套独立引擎（839 行 ↔ 2,801+561 行），**未做逐方法对拍**，
  分歧面可能比已发现的还大。**建议单独立一轮对账**，其结论可能给 W4-B1 增批。
- 前置对账的 5 条存疑项（Q1–Q5）不在本 RFC 范围，随 W4 各批顺带确认或销账。

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| W2 的单写者租约改变 SQLite 吞吐特征 | T13 基准实测；结果不可接受则回到「两套事务机制 + 上层一份实现」的退化方案（代价是 design §3 的统一性打折） |
| W4 体量大、跨 6 个 context、与并发 RFC 撞车 | 每 context 一个 PR；合一时只动 provider 维度，不顺手重构；撞车面按 CLAUDE.md 多人协作规则处置 |
| 合一过程中把 SQLite 侧的正确行为改坏 | 每对合一都带「合一前后 SQLite 行为逐字对拍」（AC-8） |
| P0 修复本身引入回归 | 每条先红后绿 + 修完再跑一次原变异确认转红（RFC-287 五轮门纪律） |
