# RFC-399 设计：恢复 context 值级 DAG 与 platform 单向依赖

研究基线 HEAD `d7c5d5462`（行号只作定位提示，以实施时源码为准）。研究由 Codex 只读完成（2026-10-31，任务
`task-mvw245au-8m6xgp`），本会话逐条对源码复核并在 §2 定稿；与研究建议不同之处在各条注明。

缩写：`src/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`；context 简称 TE（task-execution）、COL（collaboration）、
RC（resource-catalog）、MEM（memory）、RM（runtime-management）、XC（execution-contract）、DE（digital-employee）、
INTEG（integration）、DA（development-automation）、SC（source-control）、SO（system-operations）。
计数口径与 `T/architecture/rfc294Gates.ts` 一致：值级 context 对只数值级 import（含 `export … from` 与动态 import，不含
`import type`）；`platform` → `modules` 与跨 context 内部文件对含类型 import。

## 1. 现状

### 1.1 越出 DAG 的值级 import（9 对、28 处）

| # | context 对 | 文件 → 目标 | 导入与用途 |
| --- | --- | --- | --- |
| A1 | COL→RC | `collaboration/infrastructure/collaborationTaskAccess.ts`、`reviewTaskAccess.ts`、`taskCollab.ts` → `resource-catalog/application/resourceDefaults`、`resource-catalog/domain/resourceAccess` | `resolveTaskRole`、`hasResourceAclBypass`：任务成员角色与「全局任务权限」判定 |
| A2 | DA→INTEG | `development-automation/infrastructure/developmentDeliveryProvider.ts` → `integration/composition/codeHostEffects` | `matchRepoProvider`：按仓库远端 URL 选代码托管连接 |
| A3 | INTEG→DE | `integration/infrastructure/integrationTriggerResources.ts` → `digital-employee/composition` | 在当前事务里构造 DE 的触发器参与者，交给 RC 的快照工厂 |
| A4 | MEM→RM | `memory/application/distillQueries.ts`、`memory/infrastructure/memoryDistillSessionEventSink.ts` → `runtime-management/public/types` | 常量 `DISTILL_CAPTURE_FAILED_KIND`（蒸馏会话 capture 失败标记行的 kind） |
| A5 | RC→XC | `resource-catalog/application/agents/digitalEmployeeAgentTemplateCatalog.ts`、`infrastructure/agentPersistenceSemantics.ts`、`infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts`、`infrastructure/legacy/agent.ts` → `execution-contract/public/commands` | `reconcileCreated/UpdatedAgentExecutionContractPorts`：Agent 写入时按执行契约声明规整输出端口 |
| A6 | RC→TE | `resource-catalog/application/workgroups/workgroupTurnsDriver.ts` → `task-execution/public/commands`（导入并转导出） | 两个宿主节点 ID 常量；其余 9 个是类型 |
| A7 | RC→TE | `resource-catalog/composition/crewstationMcpDiagnostics.ts` → `task-execution/composition/crewstationMcpDiagnosticRunner` | 托管 MCP 诊断构造 TE 的 runner，并以 `Parameters<typeof …>` 取它的整包输入类型 |
| A8 | TE→COL | `task-execution/composition/gateContinuationPreDrive.ts`、`composition/providerRuntime.ts`、`composition/taskClarifyDirectiveRoutes.ts`、`infrastructure/humanGateTaskLifecyclePersistence.ts`、`infrastructure/taskRouteOperations.ts` → COL 的 infrastructure / composition / public | 续跑前置步骤与澄清收敛、两个修复参与者、澄清指令路由、人工门开门参与者与操作日志、评审人配置读写 |
| A9 | TE→DE | `task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts` → `digital-employee/public/types` | `normalizeDispatchRouteDefinitionsJson`；整个文件是 DE 的内置工具目录，与任务执行无关 |
| A10 | TE→MEM | `task-execution/application/taskAgentRun.ts`、`infrastructure/taskRouteOperations.ts` → `memory/public/types` | 追问时按首轮快照重建记忆片段；REST 投影解码 `injected_memories_json` |

### 1.2 `platform` → `modules`（19 个文件对、5 个文件）

| # | 文件 | 对数 | 内容 |
| --- | --- | --- | --- |
| B1 | `platform/background/maintenanceJobRunner.ts` | 9 | 按作业键分派的 `switch`：解析 payload、调用模块命令、换算计数 / 续跑游标；另 import 三个 `services/` 实现 |
| B2 | `platform/background/maintenanceWorkerEffects.ts` | 5 | 托管效果 selection 的业务类型、逐 family 的完整性检查，与中立的描述符 / 作用域 / 构造释放机制混在一起 |
| B3 | `platform/content/local/workspaceUploads.ts` | 3 | 把原生上传计划转成任务上传请求（调用 TE public 命令与查询） |
| B4 | `platform/persistence/sqlite/systemMaintenanceDisk.ts` | 1 | SO 的磁盘诊断与清理（SQLite PRAGMA + 文件系统） |
| B5 | `platform/workspace/local/isolation.ts` | 1 | `repoRelForcedPaths`（9 行纯函数，定义在 SC domain） |

`platform/background/maintenanceSystemOperations.ts` 不计入（它只 import 本目录），但它是系统维护的业务组合，随 B1 处理。

### 1.3 drizzle 再导出桶（B6）

`modules/task-execution/infrastructure/legacySqliteTransportMechanisms.ts`：`export * from 'drizzle-orm'` 加两个类型别名。
消费者：`services/task.ts`（值 `eq` 只用于一处 cached-repo 本地路径查询；两个类型别名）、`services/taskDelete.ts` 与
`services/taskLaunchGate.ts`（只用中立类型别名）、`T/helpers/startTaskDeps.ts`。

## 2. 设计

### 2.0 通用形状

- **consumer 自有端口**：合同定义在 consumer 的 `application/ports/<name>.ts`；需要 provider 实现时，由 consumer 的
  `composition/required-ports.ts` 以 `export type` 转出（没有该文件的模块新建）。consumer 自己的 infrastructure / application
  只 import `application/ports`，不 import 本模块 composition。
- **provider 实现**：放在 provider 的 `application/adapters/<consumer>-adapter.ts`（沿用现有命名，已有文件就追加），只
  `import type` consumer 的 `composition/required-ports`；provider 内部对象由 provider 的 `composition.ts` 构造后交给 adapter 的
  `compose*` 函数。现有样例：`resource-catalog/application/adapters/collaboration-adapter.ts`、
  `collaboration/application/adapters/task-execution-adapter.ts`。
- **注入点**：`bootstrap/crossContextClosure.ts`（会话内的跨域闭包）与 `bootstrap/daemonModules/*.ts`、
  `bootstrap/daemonHttpComposition.ts`、`bootstrap/crewstation.ts`。bootstrap 只调用各模块 composition 出口并传参，不写业务分支。
- **测试构造入口**：测试用的便利构造函数同样显式接收注入；不保留「没传就静态 import provider」的默认分支。
- **禁止绕门**：不把被删的跨域 import 换成 `@/services/*` facade、不写同形的本地类型、不在原位置留 re-export facade、不在
  `public/*` 转导出 composition 内部实现。纯常量 / 纯函数换 owner 后，原 public 的具名出口可以保留（指向新定义），以免无谓改动
  其他消费者，但不得成为新的跨域值依赖。
- **行为保持**：同步函数保持同步；事务内的调用保持在同一事务、同一位置、同一次序；实例范围（每会话 / 每实例 / 每事务）不变；
  错误类型、错误码与文本不变；惰性构造不提前。

### 2.1 Part A：context DAG

**A1 COL→RC：任务角色判据经 COL 自有端口注入。**

- 合同 `collaboration/application/ports/collaborationTaskRolePolicy.ts`：
  `CollaborationTaskRolePolicy { resolveTaskRole(actor, ownerUserId, isMember): TaskActorRole | null; hasResourceAclBypass(actor): boolean }`，
  同步，签名与现函数一致。
- RC 在 `application/adapters/collaboration-adapter.ts` 增 `composeCollaborationTaskRolePolicy`，委托 RC 现有判据，不复制逻辑；
  若分层门不允许 adapter 直接 import RC application 文件，则由 RC `composition.ts` 取得两个函数后传入。
- COL 侧：`createCollaborationTaskAccessPort`、`createReviewTaskAccessPort` 增加 policy 参数；`taskCollab.ts` 中用到判据的
  `requireTaskMember`、`requireTaskOperator`、`getTaskMembers`、`updateTaskMembers` 改为显式接收 policy（参数或工厂闭包均可，
  不设模块级默认）。COL `composition/commandContext.ts`、`composition.ts` 接收并下传。
- TE 的 `infrastructure/taskRouteOperations.ts` 现经 `@/services/taskCollab`（`export *` facade）调用 `canViewTask`、
  `getTaskMembers`、`requireTaskOperator`、`updateTaskMembers`、`assertCanReplaySourceTask`。改为 TE 自有端口
  `application/ports/taskMembershipOperations.ts`（`TaskMembershipOperationsPort`：上述 5 个操作，形状取 TE 实际用法），由 COL 在
  `application/adapters/task-execution-adapter.ts` 用本域实现 + 注入的 policy 实现，bootstrap 注入。
  这样 TE 不再经 facade 依赖 COL；`services/taskCollab.ts` 保留给其余 legacy 消费者。
- 接线：`bootstrap/crossContextClosure.ts` 构造一次 policy；`daemonModules/taskExecution.ts` 与 `daemonHttpComposition.ts` 复用。
- 覆盖：`rfc359-w4-b3a-adapters`、`rfc395-q1-clarify-history`、`rfc359-w5-t19b-collaboration-composed-review-access`、
  `rfc359-w9-task-members-conformance`、`rfc099-task-members`、`rfc099-membership-attribution`、`rfc212-revalidation-behavior`、
  `task-collab-launch`、`rfc326-review-decision-transaction`、`rfc326-tx-primitives-equivalence`、`rfc324-task-observer`、
  `change-narrative`。

**A2 DA→INTEG：`matchRepoProvider` 归 DA domain。** 函数与它专用的私有辅助原样迁到
`development-automation/domain/repositoryProviderMatch.ts`；`integration/composition/codeHostEffects.ts` 不再导出它（其余导出不动）。
保持最长前缀选择、同长度候选次序、GitLab project 编码与解析失败返回 `null`。覆盖与改路径：`rfc310-code-host-binding`；
另 `rfc359-w4-d13-adapters`。

**A3 INTEG→DE：快照工厂经 INTEG 自有端口注入。**

- 合同 `integration/application/ports/integrationTriggerSnapshots.ts`：
  `IntegrationTriggerSnapshotFactory { inTransaction(tx, pair): { loadAuthorized(authority, requests) } }`；新建
  `integration/composition/required-ports.ts` 类型转出。
- RC 新增 `application/adapters/integration-adapter.ts` 实现它：RC composition 接收 bootstrap 给的
  `digitalEmployeesInTransaction(tx)`（取自 DE composition 的现有工厂），在同一 `tx` 里构造 DE 参与者，再交给 RC 现有快照工厂。
- `integrationTriggerResources.ts` 与 `integration/composition/scheduledTasks.ts` 只认识 INTEG 自有端口，同时消掉它们对
  `resource-catalog/composition/integrationTrigger` 的类型依赖。
- 接线：`bootstrap/daemonModules/scheduledTasks.ts`（现有资源工厂与定时任务运行时的装配处）。
- 不变量：DE 参与者仍在当前事务内构造；工厂不另开事务。覆盖：`rfc359-w4-d1-adapters`、`rfc359-w7-catalog-composition-roots`、
  `rfc349-integration-provider-adapters`。

**A4 MEM→RM：capture 失败标记归 memory。** 常量迁到 `memory/domain/distillCapture.ts`，字面量 `rfc043/distill-capture-failed`
不变；从 `runtime-management/public/types.ts` 删除；`services/runtime/index.ts` 的旧转导出删除。改路径：
`rfc367-distill-session-event-sink`、`routes-memory-distill-job-detail`；另覆盖 `memory-distill-job-detail`。

**A5 RC→XC：Agent 执行契约端口规整归 RC domain。** `execution-contract/public/commands.ts` 的规整纯函数（含私有辅助）原样迁到
`resource-catalog/domain/agentExecutionContractPorts.ts`；`EXECUTION_CONTRACT_RESULT_PORT = 'agent-result'` 提到
`packages/shared/src/` 新文件并从 shared 入口导出，XC `domain/model.ts` 与 RC 规整函数共用它（XC 已有的合法出口可保留具名转导出）。
四个调用者改读本域；XC 的 `public/commands.ts` 迁空后删除。保持：无声明 / 声明无效时原样返回入参、sparse update 的
`undefined` 与空 map 处理、删除最后一条声明时移除托管端口、输出次序与去重次序。覆盖：
`rfc345-digital-employee-agent-template-catalog`、`digital-employee-agent-template-reconcile`、`rfc359-w4-d14-adapters`、
`rfc359-w4-d14-d15-regressions`、`rfc349-resource-catalog-postgresql-adapters`、`rfc359-w44-agent-dependency-json-conformance`、
`rfc395-a5-reference-writers`、`agents`、`execution-contract-platform`、`rfc359-w14-agent-commit-sequence`。

**A6 RC→TE（workgroup）：两个宿主节点 ID 进 shared。** `__wg_leader__`、`__wg_member__` 原样迁到 `packages/shared/src/` 新文件；
`workgroupTurnsDriver.ts` 从 shared 取值，其余 9 个 TE 类型改为显式 `import type`；TE `public/commands.ts` 与 driver 原有的具名
常量出口保留并指向 shared。覆盖：`rfc369-workgroup-mint-receipt`、`rfc369-workgroup-internal-error`、`rfc359-w4-d19c-adapters`、
`rfc187-leader-clarify-park`。

**A7 RC→TE（托管 MCP 诊断）：RC 定义执行端口，bootstrap 闭包注入。**（研究建议同时把两个文件迁到各自 infrastructure 并加 TE
adapter；本 RFC 只换依赖方向，文件归位留给 S6。）

- 合同 `resource-catalog/application/ports/mcpDiagnosticExecution.ts`：RC 实际使用的 runner 成员（`workspaceReference`、
  `workspaceExists`、`cleanup`、`hasExecution`、`settled`、`run`；`run` 的请求只含 RC 实际传入的字段），以及
  `McpDiagnosticExecutionFactory`：RC 在每次构造诊断效果时调用一次，传入它自己算出的 `startupInventoryAvailable`。
- `crewstationMcpDiagnostics.ts` 的 `HostedInput` 改为 RC 自有字段（`createExecution`、`db`、`fence`、`helper`、`capabilities`、
  `locate` 等），不再 `Parameters<typeof createCrewStationMcpDiagnosticRunner>`。
- `bootstrap/crewstation.ts` 提供闭包：`createExecution: (extra) => createCrewStationMcpDiagnosticRunner({ ...runnerInput, ...extra })`，
  由 TypeScript 在 bootstrap 处校验 runner 满足 RC 端口。
- 不变量：每次构造诊断效果恰好构造一个 runner（与现状相同）；`starts` / `targets` 两个 WeakMap 的实例范围、
  `beforeStart → acknowledgeStarted` 次序、失败后的 settlement / cleanup 不变；不提前到进程启动时构造。
- 覆盖：`rfc370-m2-mcp-diagnostics`、`rfc370-hosted-mcp-probe`。

**A8 TE→COL：五处分别注入，Task 仍拥有事务与驱动。**

| 现场 | 处置 |
| --- | --- |
| `composition/gateContinuationPreDrive.ts` 构造 `DatabaseHumanGateOperationPersistence` 与 `createClarifyContinuationConvergence` | 改为接收已构造的对象：TE 现有的 `GateWorkspaceRollbackExecutor`（TE public/participants 已导出该接口）与 TE 自有的澄清收敛端口（`finish`）。COL 实现：`services/humanGateContinuationEffects.ts` 里解读 COL manifest 的 `GateWorkspaceRollbackExecutorAdapter` 迁到 `collaboration/infrastructure/`（用本域 decoder），由 COL composition 构造；`createGateContinuationPreDriveStep` 改收 executor。bootstrap 在 `daemonModules/taskExecution.ts` 注入；`services/task.ts` 的 legacy 调用经 COL composition 出口取得同样的对象 |
| `composition/providerRuntime.ts` 现造 `createClarifyRepairParticipant` / `createReviewRepairParticipant` | TE 自有 `application/ports/collaborationRepair.ts`（Clarify：`hasOpenForNodeRun`、`latestClosedForNodeRun`、`reopen`；Review：`inspect`、`completeApproved`、`unapprove`，形状取现用法）；COL adapter 实现；bootstrap 构造后传入。`taskRouteOperations.ts` 对这两个类型的 import 改指 TE 端口 |
| `composition/taskClarifyDirectiveRoutes.ts` 调 COL public 命令与查询 | 实现迁入 COL（由 COL composition 构造，实现 TE 的 `TaskClarifyDirectiveRouteOperations`）；`providerRuntime.ts` 改收已构造的路由操作 |
| `infrastructure/humanGateTaskLifecyclePersistence.ts` 构造 COL 的 `DatabaseHumanGateOperationJournal` 与每事务的 `DatabaseHumanGateOpenParticipantInTx` | TE 自有工厂端口（DAG 已登记的 `HumanGateOpenParticipantInTx`）：`inTransaction(tx, taskParticipants)` 返回 `consumePreparedGateTx`、`listPreparedManualQuestionParksTx`、`consumeManualQuestionParkTx`；TE 把本域的 mint / lifecycle / consumed-inputs 参与者作为参数传入。journal 由 COL 工厂持有，实例范围与现状（每个 lifecycle 实例一份）相同；它需要的 TE 人工门持久化参与者工厂由 TE 在构造时传入 |
| `infrastructure/taskRouteOperations.ts` 调 `replaceReviewNodeReviewers` / `getReviewNodeReviewerConfig` | TE 自有 `application/ports/taskReviewers.ts`（`get`、`replace`）；COL adapter 绑定本域命令 / 查询 |

不变量：Task 仍开启原来的 `withTaskExecutionAggregateWrite`、按原次序取 owner / task 锁；COL 工厂收到的是**同一个** tx，不另开
事务；已准备的门消费、任务迁移与事件引用收集仍在原事务内，发布仍在提交后；rollback executor 的 WeakMap 仍按实例；
澄清 `finish`、失败释放与随后的效果执行次序不变。覆盖：`rfc382-gate-continuation-bundle`、`rfc386-task-drive-coordinator-factory`、
`rfc359-w4-b1-batch2d-adapters`、`rfc128-p5-d-autodispatch`、`rfc359-w12-collaboration-context-contracts`、
`rfc359-w5-t19b-composition-placeholders-removed`、`rfc349-task-execution-provider-runtime`、`rfc122-clarify-directive-route`、
`rfc382-http-task-execution-injection`、`rfc333-task-participants`、`rfc333-sibling-gate-park`、`rfc359-w4-d25-adapters`、
`rfc395-task-aggregate-races`、`api-task-review-round-start`、`rfc359-w7-task-route-conformance`。

**A9 TE→DE：内置工具目录归 DE。** `digitalEmployeeBuiltinToolCatalog.ts` 整体迁到
`digital-employee/application/builtinToolCatalog.ts`，由 DE `composition.ts` 提供构造入口；唯一生产导入者
`bootstrap/daemonModules/digitalEmployee.ts` 改用该入口。保持 `#loading ??=` 与失败 Promise 的缓存方式、descriptor thunk 在
`load()` 时求值、模板就绪后才加载、`digital-employee-tool-catalog-not-loaded` 错误。它对 `services/digitalEmployeeAgentTemplates`
的现有依赖随文件迁移，不新增。改路径：`rfc310-digital-employee-authoring`、`digital-employee-builtin-tool-catalog-cache`、
`rfc379-passive-composition`。

**A10 TE→MEM：快照渲染 / 解码经 TE 自有端口。** 合同 `task-execution/application/ports/taskMemorySnapshots.ts`：
`TaskMemorySnapshotPort { renderSnapshot(snapshot, nonce): string; parseSnapshotJson(raw): InjectedMemorySnapshot[] | null }`，同步。
MEM 新增 `application/adapters/task-execution-adapter.ts`，委托现有 `memory/domain/injectionRendering.ts`（含
`memoryFencingForNonce` 的空 nonce 判断），不搬算法。`bootstrap/daemonModules/memory.ts` 构造，`daemonModules/taskExecution.ts`
同时注入 agent-run 选项与路由依赖。保持原字节渲染、原快照次序、非法 JSON 降级为 `null`、异常处理位置。覆盖：
`memory-inject-snapshot`、`memory-inject`、`rfc248-memory-inject-repo-group`、`api-task-injected-memories`。

### 2.2 Part B：platform 与再导出桶

**B1 维护作业：处理器归 owner，bootstrap 装配表，platform 只分派。**

- `platform/contracts/maintenanceJob.ts`：中立的 `MaintenanceJobHandler`（入参：payload、cursor、`appHome`）与
  `MaintenanceJobExecutionResult`（计数、delta、续跑游标）；`platform/background/maintenanceJobRunner.ts` 只按作业键查表调用
  注入的处理器，表缺键时报与现状同义的错误。
- 作业体（payload 解析、命令调用、计数 / 续跑换算）按 owner 迁到各模块的 `application/maintenanceJobs.ts`，经该模块
  `public/commands` 的维护命令出口交给 bootstrap（实施时改经各模块 `composition.ts` 交出，理由见 proposal §6 第 13 条）：
  - SC：`worktreeGc`（五个阶段与游标）、`workspaceRecovery`；
  - INTEG：`webhookDeliveryGc`（游标 v1、两阶段）；
  - DA：`developmentUploadGc`、`developmentRetentionSweep`；DE：`employeeInputGc`；
  - INTENT：`intentScratchGc`、`intentRecovery`（先 `intent.recovery` 再 AtomicApply 收敛，次序不变）；
  - RC：`pluginGenerationGc`（执行围栏仍由 TE 提供，作为处理器的注入参数）；
  - TE：`taskArchive`、`lifecycleInvariants`、`stuckTaskDetector`；
  - SO：`backupPrune`、`hostedObjectRecovery` 与系统维护组合（`maintenanceSystemOperations.ts` 迁到
    `system-operations/infrastructure/`，由 SO composition 给出工厂）；`eventsArchive`、`retentionSweep`、`walCheckpoint` 走 SO 的
    系统维护组合；
  - `tokenAuditGc` 的 owner 是 legacy `auth/`（不是模块）：处理器放在 `auth/application/`，由 bootstrap 装配；
  - `humanGateRecovery`（历史行的 no-op 结算）：处理器保留在 platform 分派层，结果不变（不涉及任何模块）。
- `bootstrap/maintenanceJobBindings.ts`：只把各模块的处理器按作业键装进表；`bootstrap/maintenanceWorkerGraph.ts` 把表交给 Worker
  运行时。bootstrap 不含 payload 解析、游标或计数逻辑。
- 不变量：1,000 行写切片、25 ms 续跑间隔、GC 阶段次序、游标版本与错误码（`maintenance-*-cursor-invalid`）、
  `intent.recovery` 先于收敛、历史 `humanGateRecovery` 的 `{ retired: 1 }` 结果，全部逐段搬移、不合并、不重排。
- 覆盖与改动：`rfc338-maintenance-slices`（改为经装配表构造输入，原 `runMaintenanceJob` 入口可保留）、
  `rfc338-maintenance-mutations`（变异改指搬迁后的真实实现，保留能失败的断言）、`rfc261-webhook-delivery-pagination`、
  `rfc271-impl-gate-fixes`、`rfc389-maintenance-worker-graph`。

**B2 维护 Worker 效果：业务 selection 进 bootstrap。** `platform/background/maintenanceWorkerEffects.ts` 只保留中立部分：
描述符（`moduleSpecifier`、`exportName`、`configurationJson`、`capabilities: readonly string[]`、`workerEntry?`）、效果模块注册 /
导入、作用域与构造 / 释放机制，selection 以类型参数 / 注入的选择器表达。业务 selection 类型（含各 family 的端口类型）、
逐 family 的完整性检查与选择逻辑迁到 `bootstrap/maintenanceWorkerEffects.ts`；`maintenanceWorkerRuntime.ts` 经注入的
`openEffectsScope` 取效果，交还 bootstrap 的图工厂；`maintenanceWorkerEffectsProtocol.ts`、`maintenanceWorkerSupervisor.ts`
只用中立描述符。不变量：每个 Worker 实例一份注册表、动态导入的原回退、factory 应答前即建立生命周期、ready 失败后的释放、
重复释放复用同一个 Promise、全部错误文本。改路径：`rfc389-maintenance-worker-graph`、`rfc370-maintenance-worker-effects`、
`rfc370-v9-maintenance-worker-entry`、`rfc370-m2-resource-artifact-wiring`。

**B3 原生上传归 TE。** `platform/content/local/workspaceUploads.ts` 迁到
`task-execution/infrastructure/local/nativeWorkspaceUploads.ts`（`entryExists` 仍取 platform）；生产导入者
`task-execution/infrastructure/taskWorkspaceUploads.ts`、`services/upload.ts` 改路径；不留原位置转导出。保持同步命名探测、
输入次序、可变 `Map` 结果与错误 `Native uploads require their mutable result`。改路径：`rfc370-workspace-upload-content`；另覆盖
`rfc370-workspace-upload-bindings`。

**B4 磁盘维护归 SO。** `platform/persistence/sqlite/systemMaintenanceDisk.ts` 迁到
`system-operations/infrastructure/local/systemMaintenanceDisk.ts`；唯一生产导入者 `system-operations/composition/maintenanceDisk.ts`
改路径。保持同步 API、默认 `Paths.root`、递归深度、PRAGMA 换算与清理结果。改路径：`rfc311-maintenance-disk`。

**B5 `repoRelForcedPaths` 归 platform。** 函数原样迁到 `platform/workspace/forcedWorkspacePaths.ts`；`isolation.ts` 改用它；
SC domain 原文件删除；SC / TE public 原有的具名出口保留并指向 platform 的实现（若 public surface 守卫不允许转导出 platform，
则改为各消费者直接 import platform）。保持空 mount 返回新数组、输入次序、只按 `mountPath + '/'` 前缀匹配。覆盖：
`rfc370-isolation-native-compatibility`、`rfc370-v3-isolation-submodule-agent-paths`、`rfc370-isolation-cleanup-context`。
（研究建议放 shared；前端不用它，本 RFC 放 platform。）

**B6 删除再导出桶。**

- `services/task.ts` 里唯一的 drizzle 查询（按 cached repo id 取本地路径）改经 TE 自有端口
  `application/ports/repositoryPreparationLookup.ts`（`findLocalPath(cachedRepoId): Promise<string | null>`）；SC 在
  `infrastructure/` 实现原查询（`select / where(eq) / limit(1)`，只返回 `localPath`），经 `application/adapters/task-execution-adapter.ts`
  交给 bootstrap，在 `daemonModules/taskExecution.ts` 与既有测试构造入口注入；`reclaimStalePrepArtifacts` 在原清理阶段、
  原循环位置调用，失败传播与缺行处理不变。
- 两个 SQLite 类型别名的使用点改用已有的中立类型 `PersistenceDb`（`platform/persistence/persistenceDb`）；`services/taskDelete.ts`、
  `services/taskLaunchGate.ts`、`T/helpers/startTaskDeps.ts` 同。
- 删除桶文件；删除 `T/architecture/rfc349-provider-cutover.test.ts` 里相应的精确旧条目，`databaseMechanismDependencies` 判据不变。
- 覆盖：`repo-prep-retry-secretbox`、`rfc386-task-drive-coordinator-factory`、`rfc222-task-delete`、`tasks-multipart`、
  `rfc331-task-execution-topology`。

### 2.3 DAG 文档与结构锁的同步

- **新增的 required-SPI 虚线**（RFC-294 design §3.1 mermaid 与 `T/architecture/rfc294Target.ts` 的 `REQUIRED_CONTEXT_EDGES`
  同一提交）：
  - `RC -. "implements CollaborationTaskRolePolicy" .-> COL`
  - `COL -. "implements TaskMembershipOperationsPort" .-> TE`
  - `RC -. "implements IntegrationTriggerSnapshotFactory" .-> INTEG`
  - `TE -. "implements McpDiagnosticExecution" .-> RC`（由 bootstrap 闭包适配）
  - `COL -. "implements GateWorkspaceRollbackExecutor/TaskClarifyContinuationPort" .-> TE`
  - `COL -. "implements CollaborationRepairPorts" .-> TE`
  - `COL -. "implements TaskClarifyDirectiveRouteOperations" .-> TE`
  - `COL -. "implements TaskReviewersPort" .-> TE`
  - `MEM -. "implements TaskMemorySnapshotPort" .-> TE`
  - `SC -. "implements RepositoryPreparationLookup" .-> TE`

  端口名以实施时的实际类型名为准，两处保持一致。人工门开门工厂沿用已登记的
  `HumanGatePreparationPort/HumanGateOpenParticipantInTx`。实线边集不变。RFC-294 design §3.1 的「现状偏差」段落同步改写。
- **精确清单**：`rfc376-structural-guards.test.ts` 的提交基线（三个 S5 清单清空、跨 context 内部与越界 offered 文件对按实测删除
  条目、`export *` 桶删一条）；`architecture/counts.json` 对应 max 压到实测；`rfc294-review-offered-edge-dag.test.ts` 的例外清单与
  `EXACT_REQUIRED_SPI_BINDINGS`、`T/architecture/rfc294Gates.ts` 中同名清单删去失效条目（两份保持一致）；`SUCCESSORS` 中已清空的
  门改指或删除。
- **源码路径字符串**：以下测试含被移动文件的路径或变异目标，随移动改写：`rfc294-architecture-preflight`、
  `rfc331-task-execution-topology`、`rfc338-maintenance-mutations`、`rfc370-hosted-mcp-probe`、
  `architecture/rfc294-review-offered-edge-dag`、`architecture/rfc376-structural-guards`、`architecture/rfc349-provider-cutover`、
  `architecture/rfc359-w5-t17-provider-file-location`、`architecture/rfc395-session-table-imports`、
  `architecture/rfc389-maintenance-worker-root`、`architecture/rfc395-o3-cross-context-closure`、
  `architecture/rfc359-converged-twins`。以实施时全量搜索为准。

## 3. 测试

- **既有用例**：§2 各条列出的用例全部通过，不改断言意图；只因路径或构造方式变化而改写。
- **结构门**：`T/architecture/` 全部用例与仓根的守卫 / policy / ledger 用例；`rfc294-design-parity`。
- **新增结构锁** `T/architecture/rfc399-context-dag-platform.test.ts`（顶端注释写明锁定 RFC-399）：
  1. 三个 S5 清单为空，且再导出桶文件不存在（直接调 `rfc294Gates.ts` 的门函数）；
  2. 本 RFC 新增的每个 required-SPI provider 文件只以 `import type` 引用 consumer 的 `composition/required-ports`；
  3. 本 RFC 移动的实现在原位置不存在（`platform/content/local/workspaceUploads.ts`、`platform/persistence/sqlite/systemMaintenanceDisk.ts`、
     `task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts`、`task-execution/composition/taskClarifyDirectiveRoutes.ts`、
     `execution-contract/public/commands.ts`、`source-control/domain/forcedWorkspacePaths.ts`）；
  4. `platform/background/maintenanceJobRunner.ts` 不含任何作业键字面量以外的模块知识：不 import `modules/`、`services/`；
  5. 负例：对一个构造的语料（platform 文件 import modules、模块经 `@/services/*` 转道）门函数确实报出（证明锁会红）。
- **行为对拍**：维护作业每个作业键至少一条「搬迁前后计数 / 续跑一致」的用例（`rfc338-maintenance-slices` 已覆盖的不重复）；
  `TaskMemorySnapshotPort` 的渲染结果与直接调用 memory domain 函数逐字节一致。
- **验证范围**（全部实现完成后集中执行一次）：后端 typecheck（6144 MiB 堆）、lint、`T/architecture/` + 仓根守卫、上述受影响用例、
  SQLite 全量后端套件；PostgreSQL 只跑受影响文件；`bun run build:binary` 冒烟（维护 Worker 入口在编译态可加载）。CI 为准。

## 4. 已知存量（不在本批）

- 经 `services/` facade 的间接依赖：`collaboration/infrastructure/review.ts` 经 `@/services/resourceAcl` 用 RC 的 `resolveTaskRole`；
  `knowledge-evolution/inbound/fusionRoutes.ts` 经 `@/services/resourceAcl` 用 `hasResourceAclBypass` 等。归 W9-D。
- 只剩类型的越界 offered 依赖（例如 TE 对 `memory/public/queries` 的 `MemoryInjectionQueries`、RC 对 TE workgroup 合同类型），
  不进值级环，本批不清。
- COL 对 TE 内部的 17 个文件对、`services/humanGateComposition.ts`、public 合同里的 legacy `Actor`：S5 第二步。
- composition 子文件里的实现（托管 MCP 诊断两个文件、TE `providerRuntime.ts` 等）：S6。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 跨域参与者被提前构造、换了事务或实例范围 | §2.0 行为保持条款；A8 不变量逐条列入实施提示；既有事务竞态用例（`rfc395-task-aggregate-races` 等）必须通过 |
| 维护作业搬迁时顺手合并 / 重排 | 逐段原样搬移；变异用例改指新位置后仍须能红 |
| 以 facade / 同形类型消门 | AC-2 与新增结构锁 2、4、5；审核时逐文件检查新增 import |
| 与并发会话改动面冲突 | RFC-398 在改 `main.ts`、`bootstrap/daemonStart.ts`、`bootstrap/epochMigration*`、`platform/persistence/*`；本 RFC 不碰这些文件。实施前按路径核对工作树，冲突时停下说明 |
| 测试只改路径、丢了断言意图 | 审核时对比改动前后的断言集合 |
