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
