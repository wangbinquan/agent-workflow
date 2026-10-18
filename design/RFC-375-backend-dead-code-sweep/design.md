# RFC-375 设计：后端死代码清扫

基线 HEAD `b76a88e70`。路径约定：`SRC/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，
`TA/` = `packages/backend/tests/architecture/`。行号仅作定位提示，实施时以当时源码为准。

## 1. 判定方法

- **入口**：`scripts/build-binary.ts:39-59` 列出的 `SRC/main.ts`；Worker 入口 `services/backupVacuumWorker.ts`、
  `platform/background/maintenanceWorker.ts`、`bootstrap/maintenanceWorkerEntry.ts`、`platform/persistence/sqliteLogicalSourceWorker.ts`；
  独立打包助手 `platform/execution/local/managedProcessLauncher.ts`、`util/gitCredentialHelper.ts`；嵌入资产
  `services/runtime/opencode/plugin/aw-inventory-dump.mjs`（不是死代码）。
- **边**：静态 import / `export … from`（含 type-only 与副作用 import）、字面量 `import()` / `require()`、`import('x').T`、
  Worker 的 `new URL('./x.ts', import.meta.url)`；`mock.module` 只算测试边。唯一非字面量动态 import 是
  `platform/background/maintenanceWorkerEffects.ts:62` 的 `import(specifier)`，其唯一生产描述符在
  `bootstrap/maintenanceWorkerEntry.ts:12-15` 以字面量 `import('./crewstationMaintenance')` 登记，已被图跟踪。
- **解析**：`@/*` → 本包 `src`；相对路径依次尝试 `.ts`、`.tsx`、`/index.ts`、`.js→.ts`；`@agent-workflow/shared` →
  `packages/shared/src/index.ts` 与 `…/schemas/*`；`@agent-workflow/system-mocks/*` 按其 package.json `exports`。
- **删除判据**：生产 importer = 0（经上述全部边类型），且不经字符串 / 注册表 / 动态查找被引用，且不在 §5 的排除清单。
  每项在动手前以当时 HEAD 复核；文件若有他人未提交改动（`git status --porcelain -- <path>` 非空）则跳过并在报告中说明。

## 2. 删除清单

### 2.1 development-automation

- 删除 `SRC/modules/development-automation/composition/required-ports.ts`（7 个无实现无调用的端口与 21 个只在文件内使用的
  DTO；同时消除 `PipelineEvidencePort` 的重复定义，保留 `application/ports/reconcilerPorts.ts` 中的那份）。
- 删除 `SRC/modules/development-automation/domain/refs.ts`（只被上一个文件与 `T/rfc310-pr0-codecs.test.ts` 使用）。
- 删除 `ReconcilerPorts.effectExecutor` 成员与 `MissionEffectExecutorPort`（`reconcilerPorts.ts:61-67`、`:686`）；
  `composition.ts:326-415` 从未提供该成员。`application/missionReconciler.ts:536-544` 中依赖它的分支删除——它在生产中恒为
  `continue`，删除后循环只使 `prepared` effect 失效、已派发 effect 保持未结算并返回 `fence-pending`，与现行行为一致。
  `PortOutcome` 仍有其他 10 处引用，保留。

### 2.2 digital-employee 投机合同

- 删除 `SRC/modules/digital-employee/public/queries.ts`（零 import）。
- `public/commands.ts`：删除 `DigitalEmployeeCommandPort`、`EmployeeCaseCommandPort`、`DigitalEmployeeAuthoringCommand` 及只为
  它们服务的 import；保留 `DigitalEmployeeMaintenanceCommands`（被 `platform/background/maintenanceJobRunner.ts` 与
  `composition.ts` 使用）。
- `public/types.ts`：删除只被上述端口使用的 `DigitalEmployeeResourceReceipt`、`DigitalEmployeeProjectionPage`、
  `DigitalEmployeeProjectionDocument`，以及零使用的 `EmployeeContextRef`。
- 级联：`EmployeeCaseLaunchInput`、`EmployeeCaseProjectionDocument`、`EmployeeCaseRef`、`EventSubjectInput` 只剩本模块
  `composition.ts`（`DigitalEmployeeModule.runtime` 接口）使用 → 移入模块内部文件 `application/ports/caseRuntime.ts`；
  `ExactResourceRef` 改用 `domain/model.ts` 中已有的同名类型。`EmployeeTypeRef` 仍被公开类型使用，保留。

### 2.3 collaboration 无跨域 consumer 的 public 符号

- 删除完全无人使用的 18 个：`public/commands.ts` 中再导出的 `canonicalHumanGateJson`、`canonicalHumanGateRequestHash`、
  `deriveHumanGateCompatibilityKey`、`encodeGateDecisionReceipt`、`gateDecisionReceipt`、`preparedHumanGateRef`（domain 函数本身
  保留）；`public/participants.ts` 中的 `HumanGateOpenParticipantResult`、`CollaborationTaskRuntimeOperations`、
  `CollaborationClarifyDraftEventPublisher`、`CollaborationTaskQuestionView`；`public/queries.ts` 中的
  `REVIEW_ANCHOR_CONTEXT_CHARS`、`REVIEW_ANCHOR_DEFAULT_BUDGET_CHARS`、`REVIEW_ANCHOR_MESSAGE_CANDIDATE_LIMIT` 与零引用的本地函数
  `getCollaborationClarifyDirective`；`public/types.ts` 中的 `ReviewAnchorBlock`、`ReviewAnchorHeading`、`ReviewAccessInputs`、
  `QuestionDispatchActorSnapshot`。
- 另删 `public/queries.ts` 的 `listRecentTaskFeedback` 及其唯一再导出 `SRC/services/taskFeedback.ts:5`（只删这一行再导出）。
- 只被测试使用的 4 个（`paragraphIdxAt`、`sectionPathAt`、`REVIEW_ANCHOR_CANDIDATE_LIMIT`、`REVIEW_ANCHOR_SUGGESTION_LIMIT`）：
  删除 public 再导出，测试改从 owner 取。
- 只被本模块使用、且能直接从 owner 取的再导出：删除 `public/queries.ts` 中 `buildReviewAnchorDocument`、
  `createReviewAnchorBudget`、`resolveReviewAnchor` 的再导出（consumer 改从 `../domain/reviewAnchor` 取）；`public/types.ts` 中
  `ClarifyDecisionCommandPort`、`QuestionDispatchCommandPort`、`ReviewDecisionCommandPort`、`ReviewGateOpenDocumentDraft`
  的再导出（consumer 改从 `application/ports/*` 与 `application/prepareReviewGateOpen` 取）；`public/events.ts` 的
  `COLLABORATION_COMMITTED_SOURCE_REF` / `COLLABORATION_COMMITTED_EVENT_REF` 移到 `domain/collaborationCommittedEvents.ts`，
  `public/events.ts` 保留跨域使用的 `collaborationCommittedEventCatalogJson` 并从 domain 取常量。
- 随之失去公开 consumer 的类型从 `public/types.ts` 移除再导出（consumer 改从 owner 取）：`CanonicalHumanGateRequest`、
  `HumanGateRequestPayload`、`ClarifyGateDirective`，以及 `ReviewAnchor*` 家族中除 `ReviewAnchorRequest` 之外的类型。
- **不在本 RFC 处理**：`public/commands.ts:126-218` 的 `prepareReviewGateOpen` 等 7 个本地函数与 `public/queries.ts` 的
  `resolveReviewAccess` 等 6 个本地函数——它们调用 `../composition/commandContext` 的 `require*` 助手，直接移入 application
  会违反分层；留给 S5（恢复 context DAG）。`T/rfc333-human-gate-source-locks.test.ts:157-226` 按函数名计数，保持不变。

### 2.4 `services/` 中零生产 importer 的文件

- **无 importer**：`services/accountAuthPolicy.ts`、`services/clarifyDecisionComposition.ts`、`services/questionDispatchComposition.ts`、
  `services/reviewDecisionComposition.ts`。
- **只被测试使用的纯再导出门面**（删除并把测试 import 改指 origin）：`services/clarifyAutoDispatch.ts` →
  `@/modules/collaboration/infrastructure/clarify/autoDispatch`；`services/clarifyQueue.ts` 与 `services/clarify/queue.ts` →
  `…/clarify/queue`；`services/clarifySeal.ts` 与 `services/clarify/seal.ts` → `…/clarify/seal`；`services/execution/agentProcess.ts` →
  `@/platform/execution/local/agentProcess`；`services/maintenanceDisk.ts` → `@/platform/persistence/sqlite/systemMaintenanceDisk`；
  `services/maintenanceRetention.ts` → `@/platform/persistence/sqlite/systemMaintenanceRetention`；`services/maintenanceState.ts` →
  `@/platform/persistence/maintenanceState`；`services/nodeRunPrompt.ts` → task-execution `public/{commands,queries}`；
  `services/portArtifacts.ts` → task-execution `public/{commands,queries,types}` 与 `@/platform/content/local/rootFileQueries`；
  `services/review.ts` → `@/modules/collaboration/infrastructure/review`。
- **死实现**：
  | 文件 | 现行替代 / 处置 |
  | --- | --- |
  | `services/taskArchive.ts`（1,018 行） | 已被 `TaskArchiveMaintenanceCommand`（`modules/task-execution/application/ports/taskArchiveMaintenanceCommand.ts`，经 `composition/taskArchiveMaintenance.ts` 与 `infrastructure/taskArchiveContentCoordinator.ts`）取代 |
  | `services/capabilityTemplates.ts`（506 行） | 已被 `modules/code-capability/application/capabilityTemplateOperations.ts` 的 `createCapabilityTemplateOperations` 取代 |
  | `services/codeReviewAgentCaller.ts` | 无现行替代（RFC-304 review 阶段已退役） |
  | `services/codeCapabilityParams.ts` | 无生产调用；`createCapabilityParamRead` 仍经 `composition/legacyCodeReads.ts` 存活 |
  | `services/ownerIdentity.ts` | 仅再导出 `OWNER_IDENTITY_SQL_BATCH_SIZE`；测试改从 `@/modules/identity-access/public/operations` 取 |
  | `services/webhook/webhookGc.ts` | 含死的 `startWebhookDeliveryGc`；投递 GC 主体经 `maintenanceJobRunner` 运行 |
  | `services/terminalSweep.ts` | 包装 collaboration 的 `HumanGateTerminalSweep` 端口 |
  | `services/humanGateContinuationRecovery.ts` | 恢复经 collaboration 的 worker 运行 |

### 2.5 `services/scheduler.ts`

删除 `failTask`、`cancelTaskRow`、`cancelTaskRowUnlocked`、`taskStopCauseOf`（HEAD `:378-512`）及因此不再使用的 import
（`DAEMON_RESTART_ERROR_SUMMARY`、`isDaemonInterruptionAbortReason`、`TaskExecutionContextRef`、`SchedulerRuntimeTopology`、
`taskStopProjection` / `TaskStopCause`、`withTaskReviewMutationLock`、`createLogger`〔保留 `type Logger`〕、
`TaskRuntimeLifecyclePersistence`；`buildWorkflowScopeParentMap` 保留），更新 `:4` 的头注释。现行实现是
`modules/task-execution/composition/taskEngineApplication.ts` 的 `failRuntimeTask` / `cancelRuntimeTask`；其他文件里同名的
`failTask` 方法是不同函数。`isFresherNodeRun` 的再导出（`:81-85`）不动（RFC-374 负责）。

### 2.6 其他从入口不可达的模块 / platform 文件

- **无 importer**：`modules/collaboration/application/ports/taskDecisionParticipant.ts`、
  `modules/collaboration/composition/humanGateRecoveryTicker.ts`、`modules/event-center/public/events.ts`、
  `modules/integration/composition/resourceCatalogAcl.ts`、`modules/intent/infrastructure/intentScratchFilesystem.ts`、
  `modules/resource-catalog/composition/required-ports.ts`、
  `modules/runtime-management/infrastructure/local/fileRuntimeManagementConfiguration.ts`、
  `modules/task-execution/application/ownedTaskMutation.ts`、`…/application/ports/taskOwnershipStore.ts`、
  `…/application/ports/taskRouteLaunchOperations.ts`、`…/application/ports/taskRouteOperations.ts`、
  `…/composition/fusionEngineTasks.ts`、`…/composition/taskWorkspaceCommit.ts`、`…/domain/executionLineage.ts`、
  `…/infrastructure/legacySqliteTaskDatabase.ts`、`platform/persistence/identityPackets.ts`、`platform/persistence/jsonPathText.ts`、
  `platform/persistence/transactionScope.ts`。
- **纯再导出门面**（测试改指 origin）：`modules/resource-catalog/infrastructure/resourcePackageArtifacts.ts` →
  `local/fileResourcePackageArtifacts`；`modules/source-control/infrastructure/repositoryPreparationEffects.ts` →
  `local/fileRepositoryPreparationEffects`；`modules/task-execution/infrastructure/taskArchiveMaintenanceCommand.ts` →
  `composition/taskArchiveMaintenance` 与 `infrastructure/taskArchiveContentCoordinator`；
  `platform/persistence/sqlite/systemMaintenanceState.ts`（只经已删除的 `services/maintenanceState.ts` 触达）。
- **死实现**：
  - code-capability：`domain/configScale.ts`、`domain/frameworkRelease.ts`、`infrastructure/readinessFactsRead.ts`、
    `infrastructure/reviewerResolutionRead.ts`、`application/ports/reviewerResolutionRead.ts`，以及
    `modules/task-execution/application/ports/reviewAgentAttemptOperations.ts`；符号级删除
    `application/readinessFacts.ts` 的 `gatherReadinessFacts` 及只为它服务的私有助手（之后 `ReadinessFactsReadPort` 若无人
    使用一并删除）。
  - development-automation 配置簇（RFC-310 从未挂载）：`application/commands/assignmentCommands.ts`、
    `application/commands/automationPolicyCommands.ts`、`application/commands/digitalEmployeeCommands.ts`、
    `application/commands/configurationUpgrade.ts`、`application/queries/configResourceQueries.ts`、`domain/configPackage.ts`、
    `engine/policy/configUpgradePlanner.ts`。
  - `modules/development-automation/composition/legacyMissionDrain.ts`（现行 drain 报告在
    `modules/digital-employee/infrastructure/writerCutoverPersistence.ts`）。
  - `modules/resource-catalog/domain/resourceRevision.ts`。
  - `modules/resource-catalog/infrastructure/skillZipArchive.ts`（现行解码是 `infrastructure/legacy/skill-zip.ts` 的 `decodeZip`）。

### 2.7 没有生产调用方的定时器启动函数

下列函数（及只为它们存在的 handle 类型）删除；它们的作业主体仍经 maintenance Worker、`providerBackground` 或 provider
runtime session 运行，删除不改变任何后台行为：

- 直接 `setInterval`：`modules/digital-employee/application/osWorker.ts` 的 `startDigitalEmployeeOsWorker`（及
  `composition.ts:101` 的再导出）；`modules/event-center/application/eventCenterWorker.ts` 的 `startEventCenterWorker`（及
  `event-center/composition.ts:45` 再导出）；`modules/knowledge-evolution/application/fusionOrchestration.ts` 的
  `startFusionReconcileLoop`（及 `public/operations.ts:16` 再导出）；`services/autoKill.ts` 的 `HeartbeatKillLoopHandle` /
  `startHeartbeatKillLoop`；`services/autoRepair.ts` 的 `AutoRepairLoopHandle` / `startAutoRepairLoop`；
  `services/scheduledTaskScheduler.ts` 的 `startScheduledTaskLoop`；`services/stuckTaskDetector.ts` 的
  `startStuckTaskDetectorLoop`；`platform/background/providerBackupScheduler.ts` 的 `WalCheckpointOptions` / `startWalCheckpointLoop`。
- 经 `startMaintenanceTicker`：`platform/persistence/sqlite/systemEventsArchive.ts` 的 `startEventsArchiver`；
  `…/systemMaintenanceRetention.ts` 的 `startRetentionSweeper`；`…/systemWorkspaceGc.ts` 的 `startWorktreeGc`；
  `services/pluginGenerationGc.ts` 的 `startPluginGenerationGc`；`services/lifecycleInvariants.ts` 的
  `startLifecycleInvariantsLoop`。（`startBatchImportGc` 仍在使用，保留。）
- 删除后清理因此不再使用的 import（lint `--max-warnings 0` 会报）。

## 3. 测试改动

### 3.1 整文件删除（只测死代码）

`T/rfc304-framework-release.test.ts`、`T/rfc304-reviewer-slot-resolution.test.ts`、`T/rfc349-code-readiness-postgresql-adapter.test.ts`
（同时删除 `TA/rfc359-w5-postgresql-fake-runtime.test.ts` 中它的条目）、`T/rfc310-pr2-config-upgrade.test.ts`、
`T/rfc310-pr1b-config-package.test.ts`、`T/rfc310-pr1b-config-upgrade-planner.test.ts`、`T/rfc311-maintenance-boot-tick.test.ts`、
`T/lifecycle-shutdown.test.ts`；`T/helpers/legacyCapabilitySeed.ts` 若此后无人 import 也删除。

### 3.2 删除个别用例 / 编辑

- `T/rfc310-architecture-lock.test.ts`：删除读取已删文件的 `:220-242`，保留 `:55` 与 `:129-151`（继续防止重建），修正
  `:2-14`、`:190-195` 注释。
- `T/rfc310-pr0-codecs.test.ts`：删除 `:26-29` 的 import 与 `developmentMissionRef` / `missionRevisionRefSchema` 用例。
- `T/rfc310-pr2-recovery.test.ts`：删除 executor 存在时的用例（`:21`、`:39-43`、`:91-97`），重写 `:46` 标题与 `:3-5` 头注释；
  executor 缺失时的用例（`:86-89`）就是现行行为，保留。
- `T/rfc213-wal-checkpoint.test.ts`：删除 `:56-63` 并从 `:16` 去掉 `startWalCheckpointLoop`。
- `T/rfc333-human-gate-artifact-recovery.test.ts:638-649`：去掉读 ticker 源码的一半。
- `T/rfc338-maintenance-architecture.test.ts:62-78`：可从禁止名单中去掉已删名字（保留亦无害）。
- code-capability：`T/rfc304-config-and-view-scale.test.ts` 删 `configScale` 用例、保留 `stateViewScale`；
  `T/rfc304-readiness-facts.test.ts` 删 `gatherReadinessFacts` / 适配器用例、保留 `deriveReadiness`；`T/rfc304-cell-params.test.ts`
  改指 `createCapabilityParamRead`（无法等价时删除）；`T/rfc359-w4-b5a-adapters.test.ts` 删 readinessFactsRead 用例；
  `T/rfc359-w4-b5b-adapters.test.ts` 删 reviewer 用例；`T/rfc359-w7-module-composition-roots.test.ts:32` 删 reviewer 用例。
- `T/rfc310-pr1b-action-template.test.ts:24` 删 `getConfigResource` / `listConfigResources` 用例；
  `T/rfc345-resource-catalog-contracts.test.ts:55` 删 `resourceSummaryRevisionEquals` 用例。

### 3.3 只改 import（行为与符号不变）

- `services/clarifyAutoDispatch` → `@/modules/collaboration/infrastructure/clarify/autoDispatch`（约 38 个测试，以 grep 为准）；
  `services/clarifyQueue` → `…/clarify/queue`；`services/clarifySeal` → `…/clarify/seal`；`services/review` →
  `@/modules/collaboration/infrastructure/review`（约 51 个测试，含 `findAllOccurrences`）。
- 其他门面：`agentProcess`（`T/rfc280-managed-process-adapter.test.ts`、`T/rfc370-process-effect-projection.test.ts`）、
  `maintenanceDisk`、`maintenanceRetention`、`maintenanceState`、`nodeRunPrompt`（11 个测试）、`portArtifacts`（含
  `T/rfc193-wrapper-review.test.ts:314` 的动态 import）、`resourcePackageArtifacts`、`repositoryPreparationEffects`
  （`T/fixtures/rfc363-preparation-crash-worker.ts`）、`taskArchiveMaintenanceCommand`、`ownerIdentity`。
- collaboration：`T/rfc326-review-anchor-domain`、`T/rfc326-anchor-canonicalize`、`T/rfc326-review-comment-simplified-anchor` 改从
  `@/modules/collaboration/domain/reviewAnchor` 取；`T/rfc333-task-participants`、`T/rfc341-collaboration-committed-events`、
  `T/rfc359-w12-collaboration-context-contracts`、`T/rfc359-t2-question-dispatch-command`、`T/rfc359-t2b-clarify-decision`、
  `T/rfc359-t2c-review-decision`、`T/rfc340-review-access` 按 §2.3 的新位置改指。
- 源码锁改指实现文件（逐个确认负向断言仍成立）：`T/rfc128-p5-0-stranding-guard.test.ts:406-407` →
  `modules/collaboration/infrastructure/clarify/seal.ts`；`T/rfc279-database-redundancy-cleanup.test.ts:299-300` → `…/clarify/queue.ts`；
  `T/rfc341-collaboration-source-locks.test.ts:15-17,49-51` → `modules/collaboration/infrastructure/{reviewDecisionCommand,clarifyDecisionCommand,questionDispatchCommand}.ts`。
- 注意：`T/rfc370-*` 测试只做 import 改指，不改其断言；`T/helpers/eachProviderTaskExecution.ts` 有他人在制改动，**不得修改**。

### 3.4 改指另一个现行实现（逐例判断）

- `taskArchive`：`T/rfc311-task-archive.test.ts`、`T/rfc328-durable-ownership.test.ts:62`、`T/rfc350-idle-timeout-integration.test.ts:30`、
  `T/rfc350-interrupted-archive.test.ts:24`、`T/rfc359-w7-terminal-maintenance-sync-cutover.test.ts:51` 改用
  `TaskArchiveMaintenanceCommand` 的 `runSweep` / `preview` / `runManual` / `recover`；已被
  `T/rfc359-w8-task-archive-conformance.test.ts` 覆盖的单树崩溃注入用例删除。
- `capabilityTemplates`：`T/rfc304-capability-templates.test.ts`、`T/rfc304-template-upstream.test.ts`、
  `T/rfc309-template-upstream-wiring.test.ts` 改经 `createCapabilityTemplateOperations` / `composeCapabilityTemplateOperations`
  的操作 API；不为测试新增导出——无法经操作 API 断言的私有细节用例删除。
- `legacyMissionDrain`：`T/rfc317-cross-context-ports.test.ts`、`T/rfc359-w4-d13-adapters.test.ts` 中的用例改指
  digital-employee `writerCutoverPersistence` 的 drain 报告。
- `skillZipArchive`：`T/rfc345-skill-zip-provider-neutral.test.ts:5` 改指 `legacy/skill-zip.ts` 的 `decodeZip`。
- `terminalSweep`：`fusion-engine`、`lifecycle-repair-R1`、`review-cancel-concurrency`、`rfc202-lifecycle-exits` 改指 collaboration
  的 `HumanGateTerminalSweep` 实现。
- `webhookGc`：`T/rfc261-webhook-delivery-pagination.test.ts:26` 改指 `maintenanceJobRunner` 使用的现行投递 GC 主体。
- `humanGateContinuationRecovery`：`T/rfc333-human-gate-continuation-recovery.test.ts`、`T/rfc341-human-gate-continuation-worker.test.ts`
  改指 collaboration 的续跑 worker / 恢复端口。

判据：改指后覆盖的必须是现行实现的同一行为；现行实现已有等价覆盖（例如 conformance 套件）时删除重复用例。

### 3.5 守卫与清单（手维护、双向）

实施方在**测试文件**中完成：

- `TA/rfc294-canonical-manifests.test.ts` 的 thin-facade 清单删去已删除文件的行；
- `TA/rfc294-review-public-consumer-ledger.test.ts`：`UNCONSUMED_PUBLIC_SYMBOL_DEBT` 删去本 RFC 移除的 collaboration / DE /
  event-center 条目；`DEAD_REQUIRED_PORT_DEBT` 删去 7 条 development-automation 条目（保留生成器硬编码的
  `ReconcilerPorts-legacy-aggregate`）；
- `T/rfc305-architecture-lock`、`T/rfc347-identity-access-runtime`、`T/rfc349-auth-provider-contract`、
  `T/rfc349-owner-identity-provider`、`T/rfc345-provider-neutral-classic-facades`、`T/rfc345-mcp-plugin-provider-neutral-facades`、
  `T/rfc284-batchc-resource-dedup`、`T/rfc292-trigger-source-locks`、`TA/rfc359-w5-t17-provider-file-location`、
  `TA/rfc349-provider-cutover`、`T/rfc349-null-ordering-parity`、`T/rfc346-system-operations-contracts.test.ts:377`（锚点改为仍存在的
  `packages/backend/src/services/taskDelete.ts`）、`T/rfc321-repository-publication-ratchet.test.ts:253-255`（期望变为 `[]`）、
  `TA/rfc359-w5-unattended-void-promise`（删去被删启动函数的条目）、`T/rfc331-task-execution-topology.test.ts:48`（若
  `autoRepair.ts` 失去相应 import）中指向已删文件 / 符号的条目。
- CI 路径过滤（`T/test-suite-policy.test.ts:521-544` 要求 workflow 中的字面路径存在）：`.github/workflows/maintenance-soak-nightly.yml`
  的已删路径改为 `platform/persistence/sqlite/systemMaintenanceRetention.ts` 与
  `modules/task-execution/infrastructure/taskArchiveContentCoordinator.ts`（加 `composition/taskArchiveMaintenance.ts`）；
  `windows-platform.yml` 中指向已删文件的路径删除（保留指向 §5 保留文件的条目）。

实施方**不改**、而在最终报告中给出精确改动供审核方在提交时应用（这些文件被 RFC-294 生成器在工作树中读取或属于生成物目录，
共享工作树上留着未提交改动会污染其他会话的投影）：

- `TA/rfc294Canonical.ts` 的 `LEGACY_BACKEND_FILE_OWNERS`：删除每个已删 `services/` 文件对应的行（逐行列出）；
- `architecture/ledger-baselines.json`：测试文件型基线的新值（`rfc294-review-dead-required-ports`、
  `rfc294-review-unconsumed-public-symbols`、`rfc359-w5-provider-named-file-location`、
  `rfc349-provider-specific-business-dependencies`、`rfc359-w5-unattended-void-promise`、`rfc331-preexisting-deep-imports`、
  `rfc359-w5-postgresql-fake-runtime`、`rfc359-w5-test-engine-hardcoding` 等，以实际重数为准）；
- `architecture/guard-manifest.json`：被改动的守卫（如 `rfc310-architecture-lock`）用 `census.ts` 函数重算的四个字段。

若 RFC-376 先于本 RFC 落地，上述旧账本条目不再存在，审核方改为删除 RFC-376 双向例外清单中对应的过期条目。

## 4. 保留清单（仍不可达，有理由保留）

| 文件 | 理由 | 后继 |
| --- | --- | --- |
| `services/driverLease.ts` | RFC-108 历史合同的可复现保留（文件头注释） | 需用户决定 |
| 注入 oracle 七件套：`modules/task-execution/infrastructure/legacyTaskExecutionInjectionResolver.ts`、`services/execution/resolveInjection.ts`、`services/agentDeps.ts`、`services/mcpClosure.ts`、`services/pluginClosure.ts`、`services/skillBootVerify.ts`、`services/skillIdentityPaths.ts` | RFC-349/359 决定退役前作为行为 oracle；`T/rfc345-resource-acl-facade-retirement.test.ts` 要求七件同删 | 需用户决定 |
| `modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts` | RFC-359 §5hn「不删」（方言参考） | — |
| `modules/resource-catalog/application/portableImportReferences.ts`、`composition/portableImportReferences.ts` | 现存债务边的声明后继 owner | W4 |
| `modules/task-execution/application/submitTaskContinuation.ts` | 被 RFC-294 生成器登记为 RFC-328 控制网关 | RFC-376 |
| `modules/intent/domain/teaching/reconciliation.ts` | RFC-348 测试驱动的守卫数据 | — |
| `services/userIdentities.ts` | `T/rfc212-revalidation-behavior.test.ts` 的锚点在其上，删除需另行决定 | 需用户决定 |
| `services/runner.ts`、`modules/task-execution/infrastructure/local/nativeTaskAgentRun.ts`、`nativeTaskAgentRunOptions.ts`、`modules/event-center/infrastructure/customEventObserverProgram.ts`、`modules/resource-catalog/infrastructure/mcpDiagnosticsEffects.ts`、`modules/task-execution/composition/systemAgentRun.ts`、`services/scriptDepsEnv.ts`、development-automation `infrastructure/{actionWorkspace,pipelineEvidenceImport,verificationRunner}.ts` | RFC-370 兼容地址或只被 RFC-370 测试使用 | RFC-370 收口 |
| `modules/intent/application/maintenance.ts`、`modules/system-operations/infrastructure/crewstation/standbyExecutionAuthority.ts` | 2026-10-14 后被 RFC-370 改动 | RFC-370 收口 |
| `services/runtime/opencode/plugin/aw-inventory-dump.mjs` | 嵌入资产，不是死代码 | — |

实施方在最终报告中给出删除完成后重算的不可达文件清单，应与本表一致（若有出入逐条说明）。该清单将作为 RFC-376
入口可达性门的初始例外。

## 5. 排除与冲突面

- 排除 §4 全部文件；排除 git 族（`util/git.ts`、`services/git*.ts`，RFC-377 独占）；排除 RFC-374 的 node-run 新旧判定文件
  （`services/freshness.ts`、`services/nodeRunMint*`、`modules/task-execution/domain/nodeRunSupersession.ts`、按
  `nodeRuns.id` 排序的文件中的相应片段）；排除 RFC-376 的治理文件（`tests/architecture/rfc294Canonical.ts`、`census.ts`、
  根目录 `architecture/**`、`scripts/architecture-*.ts`、`scripts/depcheck.ts`）。
- 与 RFC-374 共用 `services/scheduler.ts`：本 RFC 只动 `:378-512` 与其 import，不动 `:81-85` 的 `isFresherNodeRun` 再导出。
- 动手前对每个文件检查 `git status --porcelain -- <path>`；有他人未提交改动的文件跳过并报告。当前已知他人在制：
  `bootstrap/crewstation.ts`、source-control crewstation 基础设施、`task-execution/composition/providerRuntime.ts`、
  `T/helpers/eachProviderTaskExecution.ts` 与若干 rfc359 / rfc370 测试——均不是本 RFC 的目标。

## 6. 与 RFC-294 目标架构的对齐

本 RFC 只删除，不新增结构；它减少 S5（collaboration public 面）、S6（task-execution 端口与 composition）、W4-E8
（development-automation 端口）、W9-D（`services/` 门面）的待迁移面。无偏离项。

## 7. 测试策略

- 无新增行为，不新增功能测试；正确性由「删除对象无生产 consumer（§1 的图证据）」与「改指后的测试在现行实现上通过」两部分保证。
- 集中验证：受影响测试文件（§3 列出的全部，加上被删 import 所在模块的直接测试）、三包 typecheck、改动文件 eslint / prettier、
  `bun run depcheck`。
- 重算入口可达性，确认只剩 §4 保留清单。
