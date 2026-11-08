# RFC-470 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`RC/` = `S/modules/resource-catalog/`，`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：facade 清仓——consumer 归零后删除。`legacy-thin-facades` 的最后两个与一个 `services/` 旧实现删除。
- 端口归消费方、实现归提供方、装配根接线：task-execution 的启动资源端口留在 task-execution，实现迁入 resource-catalog（它是这些能力的 owner：
  agent 与工作流的可见性、工作流的静态校验与读取），由装配根把 resource-catalog composition 的结果交给 task-execution。task-execution 不再取
  resource-catalog 的内部文件（跨 context 内部文件对 −3），resource-catalog 不取 task-execution（resource-catalog → task-execution 不在目标 DAG 上）。
- 不新增 public 导出：两边的类型按结构对齐，由用例编译期锁住（RFC-468 先例）。

## 1. 端口：`TE/application/ports/agentLaunchResourceOperations.ts`

- `AgentLaunchValidationIssue` 补 `readonly code: string`（resource-catalog 的校验问题本来就带，shared `WorkflowValidationIssue` 的 `code` 是必填）。
- `AgentLaunchWorkflowValidationCandidate` 补 `readonly frozenClosureJson?: string | null`：同步预览按候选的冻结调用闭包判 call 规则
  （resource-catalog 的 `loadWorkflowValidationContext` 本来就收这一格）。
- `AgentLaunchResourceOperations` 补 `readWorkflow(workflowId: string): Promise<WorkflowDetail | null>`（shared 的 `WorkflowDetail`；不判可见性）。

## 2. resource-catalog 实现

- `RC/infrastructure/agentLaunchResourceOperations.ts`：`createAgentLaunchResourceOperations` 由 task-execution 原样迁入（三个方法的函数体不变），
  import 改为同模块（`./legacy/agent`、`./legacy/workflow.validator`、`../composition/resourceAcl`）；补
  `readWorkflow: (workflowId) => getWorkflow(db, workflowId)`（`./legacy/workflow`，即被替换的同一个函数）。端口形状的类型在本文件写一份同形的
  （不 import task-execution）。
- `RC/composition/agentLaunchResources.ts`：`composeAgentLaunchResourceOperations` 原样迁入；转出 `assertWorkflowSnapshotLaunchable`。
- `RC/infrastructure/workflowSnapshotLaunchGate.ts`：`services/taskLaunchGate.ts` 的 `assertWorkflowSnapshotLaunchable(db, wf)` 原样迁入（同名、同参、
  同函数体），import 改为 `./legacy/workflow.validator`。
- resource-catalog 的 infrastructure 取自己的 composition 有先例（`legacy/agent.ts`、`workflowPersistenceSemantics.ts` 等）。

## 3. task-execution 消费方

- 删除 `TE/infrastructure/agentLaunchResourceOperations.ts` 与 `TE/composition/agentLaunchResources.ts`。
- `TE/infrastructure/taskRouteOperations.ts`：删去 `import { getWorkflow } from '@/services/workflow'`；路由依赖（`TaskRouteOperations` 的依赖、
  同步预览与同步门的依赖、`TaskWorkflowSyncDependencies`）补 `readWorkflow`，同步预览的依赖再补 `validateHostWorkflow`；两处
  `getWorkflow(dependencies.db, task.workflowId)` 改为 `dependencies.readWorkflow(task.workflowId)`；同步预览把 `validateHostWorkflow` 交给
  `computeWorkflowSyncPreview`。
- `TE/composition/providerRuntime.ts`：路由依赖补 `readWorkflow`，与 `canViewWorkflow` / `validateHostWorkflow` 同形取自同一份启动资源。

## 4. `services/task.ts`

- `computeWorkflowSyncPreview(db, task, workflow, resourceAuthority, validateHostWorkflow)`：删去 `services/workflow.validator` 的 import；静态校验改为
  `await validateHostWorkflow(newDef, { definition: newDef, currentWorkflow: { id, name }, frozenClosureJson: candidateClosureJson })`——生产注入的
  就是 §2 那一份（`validateWorkflowDef(definition, await loadWorkflowValidationContext(db, candidate))`，`buildWorkflowValidationContext` 是
  `loadWorkflowValidationContext` 的别名），同一个库句柄。参数类型在本文件按结构写（`services/` 文件取模块内部记 `R1`）。

## 5. 装配根

- `S/bootstrap/daemonModules/taskExecution.ts`：`composeAgentLaunchResourceOperations` 改取 `@/modules/resource-catalog/composition/agentLaunchResources`。
- `S/bootstrap/daemonModules/scheduledTasks.ts`：`assertWorkflowSnapshotLaunchable` 改取同一个 composition。
- 两个文件都在 `BOOTSTRAP_FILES`（取模块 composition 不记 `R1`）。

## 6. 两个薄转出与 `PLUGIN_DISABLED_SITES`

- 删除 `S/services/workflow.ts`、`S/services/workflow.validator.ts`。用例里取它们的 import（别名与相对路径两种写法）改指
  `@/modules/resource-catalog/infrastructure/legacy/workflow` / `…/legacy/workflow.validator`：`export *` 转出，符号逐个相同。
- `S/services/execution/resourcePolicy.ts` 的 `PLUGIN_DISABLED_SITES`：`'services/workflow.validator.ts'` 改为
  `'modules/resource-catalog/infrastructure/legacy/workflow.validator.ts'`（`plugin-disabled` 真正的产出点）。

## 7. 精确清单与账本

- RFC-345 兼容登记表（`T/rfc345-resource-acl-facade-retirement.test.ts`）：三条边销账；退役清单补三个文件；注释记明改经启动资源端口（§3 非目标）。
- 跨 context 内部文件对的精确清单（`rfc294-architecture-preflight`、`rfc376-structural-guards`、`rfc328-architecture-guards`）去掉 task-execution
  适配器的 3 条；`rfc376-structural-guards` 的 export-star 基线去掉两个转出。
- RFC-454 用例「留下的转出」去掉两项；RFC-466 用例读 task-execution 适配器源码与 `services/taskLaunchGate.ts` 的锁改读 resource-catalog 的新位置；
  RFC-359 W58 同步预览对拍用例读适配器源码的锁改读新位置。
- 架构报告 legacy owner 表去掉三个文件。
- `architecture/commons-debt.json` 的 `R1` 按实测销账（预期 66 → 64）；guard-manifest 刷新改到的守卫文件行数。

## 8. 用例

- **新用例** `T/rfc470-workflow-facades-retirement.test.ts`：三个文件与 task-execution 的两个适配器文件不在，src / 用例 / 脚本零 import（`preProcessFile`，
  带负对照）；编译期锁 resource-catalog 的实现与 task-execution 端口逐项相同；端口有 `readWorkflow`、候选有 `frozenClosureJson`；`taskRouteOperations.ts`
  不再取 `getWorkflow`，同步预览与同步门经 `dependencies.readWorkflow` 读；`services/task.ts` 不取 validator、经 `validateHostWorkflow` 校验且透传
  `frozenClosureJson`；装配根取 resource-catalog composition；`PLUGIN_DISABLED_SITES` 的锚点文件都在。
- 行为用例：`readWorkflow` 读到行与不存在时回 `null`；快照校验门在 resource-catalog 的位置对非法快照抛 `workflow-invalid`（带 `issues`）、合法的不抛。
- 受影响用例改 import 或改读新位置；伪造整个端口的用例补 `readWorkflow`。

## 9. 失败模式

- 漏改的消费方：tsc 兜底（文件删除后取不到）；新用例的零引用断言兜底；按路径读源码的锁按文件名全仓搜。
- 两边类型漂移：编译期锁。
- 校验语义变化：同一份实现、同一个库句柄；同步预览的候选透传冻结闭包（新用例锁住）。

## 10. 留下的债

- RFC-345 登记表为这三条边点名的继任合同（`TaskExecutionResourceBinding`、`WorkflowValidationQueries`）未采用，理由见 proposal §3；若日后同步预览改按
  权威装载，再随那一步改。
- `services/task.ts`（`R1` 9）、`services/runtime/**`。

## 11. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §8；P0 变异 lane 两引擎各 17 阶段。
