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
| T3 | **F-H2-2** development mission 的 `agentLauncher` / `scriptLauncher` 未注入 + 终态观察者零调用 | `agentActionOrchestrator.ts:274-279` |
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
- **T12** 事务体软超时 + 结构化诊断；lint 规则禁止事务体内 import 进程/网络/fs（design §3.4）。
- **T13** RFC-311 基准库上实测吞吐前后对比，结果写回 proposal §6 的 **C-2**。

## 3. W3 —— 统一启动序列

- **T14** 删除 `servePostgresqlDaemon` 的永不返回形态；PG 与 SQLite 汇入同一条 boot 序列。
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
- **T16** `cli/start.ts` 里 `provider === 'sqlite'` 的执行分支归零（**AC-2**）。
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

## 5. W5 —— 防复辟

- **T17** provider 命名文件只允许在 `platform/persistence/`（棘轮到 0）。
- **T18** 裸 `db.transaction(` 只允许在事务原语文件。
- **T19** `provider === ` 只允许在 `platform/persistence/`，其余全仓 exact 账本为空。
- **T19b** 组合根全量：`cli/` 与 `*/composition*` 下禁 `*-not-bound` 与晚绑定 holder。
- **T19c** 启动序列恰有一个调用方，`cli/start.ts` 无 provider 执行分支。
- **T19d** 覆盖率对等棘轮（过渡期，可在 W1 后立即上）：同一 port 两侧行覆盖率差超阈值即红。
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
