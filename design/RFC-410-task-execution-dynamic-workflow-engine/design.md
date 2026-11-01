# RFC-410 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`DWR` = `S/services/dynamicWorkflowRunner.ts`，
`OA` = `S/services/orchestratorAgent.ts`，`SH` = `packages/shared/src/dynamicWorkflow.ts`。行号以 RFC-409 落库后的源码为准，实施时按源码定位。
形状沿用 RFC-405～409：主体在 engine，composition 只装配；端口只用 task-execution 自有类型与 shared 类型。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| 生成引擎 | `TE/engine/task/dynamicWorkflowGenerate.ts`：`runDynamicWorkflowGenerate(ports, args)`——`DWR` 的生成 pass 与私有 helper（`loadDwDbState`、`resolvePool`、`openDwGate`、`AWAITING_CONFIRM_RESULT`）原样迁入，`persistence` / `nodeRuns` / `validationContext` / `hooks` 与 `validateWorkflowDef`、`triggerPreflightIssue` 换成端口 |
| 生成判定 | `TE/domain/dynamicWorkflowGeneration.ts`：`DWR` 的常量（`DW_MAX_GENERATE_ATTEMPTS`、`DW_MAX_REJECT_ROUNDS`、`DW_GENERATE_CAUSE`、`DW_GATE_CAUSE`）、`extractJsonPayload`、`dwCallNodeRejections`、`evaluateGeneratedWorkflow`（第三个参数改为第一层校验函数） |
| 编排代理 | `TE/domain/dynamicWorkflowOrchestrator.ts`：`OA` 除第二层校验外的全部（`ORCHESTRATOR_WORKFLOW_PORT`、`DW_ORCHESTRATOR_NODE_ID`、`buildDynamicWorkflowGenerateSnapshot`、`buildOrchestratorAgent`、`DwPoolMember`、`buildDwPoolMembers`、`dwPoolTokenMap`、`buildOrchestratorPrompt`）原样迁入；身份常量改从 `./orchestratorAgentIdentity` 取；无人使用的再导出（`DW_PHASES` / `DynamicWorkflowPhase`、`ORCHESTRATOR_AGENT_ID` / `NAME`）不再保留 |
| 第二层校验 | `SH`：`validateDynamicWorkflowDef` 与它的私有 helper `readNodeString` 原样迁入（经 shared index 的 `export *` 导出） |
| 端口 | `TE/application/ports/dynamicWorkflowGenerate.ts`：`DynamicWorkflowGeneratePorts`、`DynamicWorkflowGenerateArgs`、`DynamicWorkflowLayerOneValidation`、`DynamicWorkflowLayerOneValidator` |
| 绑定 | `TE/composition/taskEngineApplication.ts` 的 `dw-generate` 主体改为 `runDynamicWorkflowGenerate(createDynamicWorkflowGeneratePorts(…), args)`；端口构造放在同文件（替换现 `dynamicWorkflowArgs`） |
| 校验端口构造 | `S/modules/resource-catalog/composition/workflowOperations.ts` 增加 `composeDynamicWorkflowLayerOneValidation(db)`：载入当次库存上下文，返回 `(definition) => validateWorkflowDef(definition, context)` |
| 删除 | `DWR`、`OA` |

### 1.2 端口

| 分组 | 能力 | 绑定到 |
| --- | --- | --- |
| `persistence` | `loadTask`、`loadAgent`、`saveState`、`countNodeRuns`、`hasAwaitingConfirmationRun`（现 `DynamicWorkflowPersistence`） | `opts.dynamicWorkflow.persistence` |
| `nodeRuns` | `mint`、`set`、`loadEnvelopeNonce`（现 `NodeRunLifecyclePersistence`） | `opts.persistence.nodeRuns` |
| `validation` | `load(): Promise<DynamicWorkflowLayerOneValidator>`；校验器 `(definition: WorkflowDefinition) => WorkflowValidationResult` | `opts.dynamicWorkflow.validation` |
| `rules` | `triggerPreflightIssue({ root, closureJson, source })` | `services/execution/triggerPreflight.ts`（同 RFC-408） |
| `host` | `runHost(request)`（现 `WorkgroupTurnHostOperations`） | `buildNodeExecutionWorkgroupHooks(state, factory)` |
| args | `taskId`、`log`（`application/ports/executionKernel` 的 `Logger`）、`signal?` | 调用时 |

现有 `dynamicWorkflowArgs()` 在 `opts.dynamicWorkflow` 缺席时抛 `dynamic-workflow-operations-not-composed`；端口构造保持同一个检查与文本。

### 1.3 校验端口的接线

- 参与者与运行选项的字段 `dynamicWorkflow.validationContext: DynamicWorkflowValidationContextSource` 改为
  `dynamicWorkflow.validation: DynamicWorkflowLayerOneValidation`（`TE/composition/taskEngineRuntimeOptions.ts`、
  `TE/infrastructure/taskExecutionRuntimeParticipants.ts`）。
- `S/bootstrap/daemonModules/taskExecution.ts` 以 `composeDynamicWorkflowLayerOneValidation(db)` 构造它；同文件交给工作组任务房的
  `validationContext`（`composeDynamicWorkflowValidationContext`）保持不变。
- 测试拓扑（`T/helpers/taskExecutionTestTopology.ts` 两处）同样改用新 composition 函数。
- `T/helpers/eachProviderTaskExecution.ts` 的 `createTestDynamicWorkflowOperations` 以夹具库存构造校验上下文：库存载入抽成同文件导出的
  `loadTestDynamicWorkflowInventory(db)`，`validation` 由它与校验器构成。RFC-359 W8 参与者一致性用例对库存内容的断言改对这份载入函数，
  并补一条经 `validation.load()` 得到的校验器确实按当次库存判定（夹具代理可解析、缺失代理报 `agent-not-found`）。

### 1.4 任务控制面

`TaskRunPorts.rules.dynamicWorkflowOrchestratorNodeId` 删除，`engine/task/runTask.ts` 直接 import `domain/dynamicWorkflowOrchestrator` 的
`DW_ORCHESTRATOR_NODE_ID`；`composition/taskEngineApplication.ts` 的绑定随之删去该项。

### 1.5 其他调用方

| 调用方 | 改为 |
| --- | --- |
| `TE/infrastructure/{taskRouteLaunchOperations,childExecutionLaunchOperations}.ts` 的 `buildDynamicWorkflowGenerateSnapshot` | `../domain/dynamicWorkflowOrchestrator` |
| `S/modules/resource-catalog/composition/workgroupTaskRoom.ts` 的 `validateDynamicWorkflowDef` | `@agent-workflow/shared` |

### 1.6 依赖规则

`TE/engine/task/dynamicWorkflowGenerate.ts` 只 import 本模块 `domain/`、`application/`、`engine/`、`@agent-workflow/shared` 与 node 内建模块；
两个 domain 文件只 import 本模块 `domain/` 与 `@agent-workflow/shared`。

## 2. 必须保持

| 不变量 | 现有锁 / 用例 |
| --- | --- |
| 检查点幂等：`awaiting_confirm` 重入只补铸确认门不重新生成；`executing` 拒绝；耗尽后人工恢复重置预算 | RFC-167 引擎用例 |
| 生成次数上限、错误注入提示词的字节、`dw-runtime-child-unreaped` / canceled / 耗尽的结局与文本 | RFC-167、retry-budget-single-source |
| token 只经 `dwGeneratedToWorkflowDef` 转换；未知 token 只报 token；call 节点先于通用两层被拒 | RFC-223 PR-3b、RFC-243 用例 |
| 第一层 + 第二层错误按原顺序合并、只取 error 级；触发器预检在两层通过后执行 | RFC-167、RFC-292 用例 |
| 生成阶段快照、编排代理与提示词的字节 | RFC-167 编排代理用例、builtin-workflow-auto-layout |
| 确认前复核（resource-catalog）的三层判据 | 工作组任务房用例 |

## 3. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| 读 `DWR` / `OA` 源码的锁（RFC-200 source lock、retry-budget-single-source、RFC-243 call 节点前置、RFC-167 编排点、RFC-349 execution peripheral、RFC-395 任务定义读取侧） | 改读新 owner；守卫文件在文件内读 owner |
| RFC-345 门面账本 `services/workflow.validator.ts → services/dynamicWorkflowRunner.ts`（`validateWorkflowDef`） | 消费方删除，账本由 AST 实测减一条；新增的 resource-catalog composition 直接 import 本上下文的校验器，不经门面 |
| commons-debt：`DWR` 的 4 条 R1-inbound-module-internals | 随文件删除销账，note 记一行 |
| `architectureReport.ts` legacy 归属表 | 删去两个已删文件 |
| services 业务实现计数、RFC-376 counts、guard-manifest、Windows paths | 按实测更新，只降不升 |

## 4. 测试

- 新增结构锁 `T/architecture/rfc410-dynamic-workflow-engine.test.ts`：生成引擎、生成判定、编排代理、第二层校验 owner 唯一；两个已删文件不
  复活、不被引用；引擎与 domain 文件的 import 层级；task-execution 不出现 resource-catalog 校验器类型；任务控制面不再有编排节点常量端口；
  每项带纯伪造输入的负例。
- 端口绑定用例 `T/rfc410-port-bindings.test.ts`：端口读调用时的状态；`dynamic-workflow-operations-not-composed` 检查保留；校验端口经
  composition 函数构造出的校验器与直接调用校验器结果一致。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
