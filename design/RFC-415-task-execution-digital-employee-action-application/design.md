# RFC-415 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`DEE` = `TE/composition/digitalEmployeeExecution.ts`，
`AER` = `TE/composition/actionExecutionRunners.ts`。行号以 RFC-414 落库后的源码为准，实施时按源码定位。形状沿用 RFC-405～414：主体原样迁移，
只做落位与端口替换；装配在 composition。

## 1. 文件

| 来源                                                                                                                                                                                                                                                           | 去向                                                                                                 | 说明                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEE` 的 schema（`exactRefSchema` … `attemptSchema`）、`resultFailure`、`programSourceFailure`、`buildDigitalEmployeeFixedPrompt`、`buildDigitalEmployeePlanPrompt`、`digitalEmployeeExecutionIsLive`、`parsedPlanOutputPath`、`buildDigitalEmployeeExecution` | `TE/application/digitalEmployeeExecution.ts`（核心改名 `createDigitalEmployeeExecutionCore(ports)`） | 原样迁移；启动尾段（actor → 资源授权 → `launch.launch({...})`）换成 `ports.launchHost(request)`                                                                                                          |
| 核心的依赖                                                                                                                                                                                                                                                     | `TE/application/ports/digitalEmployeeExecution.ts` 的 `DigitalEmployeeExecutionPorts`                | 与 composition 的 `DigitalEmployeeExecutionDependencies` 相同的读端口，外加 `launchHost`、必填的 `programs`；不含 `appHome` / `resolveActor` / `resourceAuthorityFor` / `launch`                         |
| 启动尾段（`resolveActor`、`resourceAuthorityFor`、`invoker`、`RootTaskLaunchSubject` 组装、`internal` 与 `borrowedPostgresqlWorkspace`）                                                                                                                       | `DEE` 的 `launchDigitalEmployeeHost(deps, request)`                                                  | 原样迁出；`DigitalEmployeeExecutionDependencies` 对外形状不变                                                                                                                                            |
| `AER` 全部（类型 + `fail` / `parseScriptRef` / `assertWorkspace` / `watchTerminal` / `fetchOutcome` / `cancel` / 两个 `create*Runner`）                                                                                                                        | 类型 → `TE/application/ports/actionExecution.ts`；函数 → `TE/application/actionExecutionRunners.ts`  | `readTaskStatus(env.db, ref)` → `env.taskStatus(ref)`；`env.workspaceEntries ?? 本地实现` → `env.workspaceEntries`（端口必填）                                                                           |
| `TE/composition/actionExecutionEnvironment.ts`                                                                                                                                                                                                                 | 原地                                                                                                 | 环境绑定补 `taskStatus: (ref) => readTaskStatus(deps.db, ref)` 与 `workspaceEntries: deps.workspaceEntries ?? localActionWorkspaceEntries`；`ActionExecutionEnvironment` 等类型改从 application ports 取 |

`DEE` 保留 `composeDigitalEmployeeExecutionCore` / `composeReactionExecutionProvider` / `composeDatabaseDigitalEmployeeExecutionPorts`，前两者改为
「把 deps 映射成 ports 后交给 application 核心」；纯函数与类型从 application 再导出，现有 import 不变。`AER` 删除，`agentActionExecution.ts` /
`scriptActionExecution.ts` 改从 application 取运行器。

## 2. 端口

```ts
// application/ports/digitalEmployeeExecution.ts
export interface DigitalEmployeeHostLaunch {
  readonly taskId: string // admission 预分配的执行身份
  readonly roundRef: string
  readonly caseId: string
  readonly task: TaskStartOptions
  readonly subject:
    | {
        readonly kind: 'workflow'
        readonly workflowId: string
        readonly workflowName: string
        readonly workflowVersion: number
        readonly workflowSnapshot: WorkflowDefinition
      }
    | { readonly kind: 'digital-employee'; readonly workflowSnapshot: WorkflowDefinition }
  readonly repository: {
    readonly platformInputPaths: readonly string[]
    readonly workspacePath: string
    readonly baselineSha: string
  } | null
}
export interface DigitalEmployeeExecutionPorts {
  readonly programs: ProgramToolSource
  launchHost(request: DigitalEmployeeHostLaunch): Promise<{ readonly id: string }>
  // tasks / readModels / resourceUsage / agents / workflows / executionMetadata / humanReview /
  // workspace? / committedProgress? / executionContracts：与 DigitalEmployeeExecutionDependencies 同形
}
```

绑定的 `launchDigitalEmployeeHost` 按原文组装：`subject.kind === 'workflow'` → `{ subject: { kind: 'workflow', sourceId }, workflowName, workflowVersion,
workflowSnapshot, builtin: false }`，否则 `{ subject: { kind: 'digital-employee', sourceId: null }, workflowVersion: 1, workflowSnapshot, builtin: true }`；
`internal` 为 `catalogVisibility: 'internal'`、`preallocatedTaskId`、`digitalEmployeeLaunch: { actionRunId: roundRef, caseId }`，有仓库场景时加
`platformInputPaths` 与 `borrowedPostgresqlWorkspace(...)`。

`application/ports/actionExecution.ts`：`AER` 的类型原样迁入；`ActionExecutionEnvironment` 增 `taskStatus(executionRef): Promise<TaskStatus | null>`，
`workspaceEntries` 改为必填。

## 3. 依赖规则

- `TE/application/digitalEmployeeExecution.ts`、`TE/application/actionExecutionRunners.ts` 不 import infrastructure / composition（`composition/required-ports`
  的类型除外，RFC-294 gates 的既有例外）；可用 shared、domain、本模块 public、其它模块 public、platform contracts。
- composition 绑定不含两个执行器的流程。

## 4. 必须保持

| 不变量                                                                                     | 现有锁 / 用例                      |
| ------------------------------------------------------------------------------------------ | ---------------------------------- |
| 解析失败、implementation 种类不符、精确引用不可用、结果端口缺失、计划 Agent 校验的错误文本 | RFC-310 / 359 / 368 数字员工用例   |
| 启动请求：任务名、输入键、预算、环境字段、主体与 builtin、`internal` 字段、借用工作区      | RFC-319 / 368 源码锁、RFC-294 E9-C |
| 检查：stopped 判定、pending 活性判据、结果端口投影、计划路径校验、工作区语义校验           | RFC-359 / 368 / 396 用例           |
| 动作执行：校验顺序与错误码、宿主快照、任务名、终态观察、取消的三种结算                     | RFC-359 T3、RFC-370 V18 用例       |

## 5. 守卫与账本

按旧路径取语料的锁改读新 owner（`rfc319-task27`、`rfc368-reaction-execution-adapter`、`rfc370-v4-program-tools`、`rfc310-digital-employee-authoring`、
`rfc414-port-bindings` 等）；RFC-376 / commons-debt / architectureReport 中点名 `DEE` / `AER` 的条目按实测改记；guard-manifest、Windows paths。

## 6. 测试

- 新增结构锁 `T/architecture/rfc415-digital-employee-action-application.test.ts`：被迁符号 owner 唯一；`AER` 不复活不被引用；application 新文件的
  import 层级；composition 的 `DEE` 不含核心流程（不出现 `planSchema.parse(` / `deps.launch.launch(` 之外的启动——启动只在绑定里）；带负例。
- 端口绑定用例 `T/rfc415-port-bindings.test.ts`：`launchDigitalEmployeeHost` 两种主体与有无仓库场景的请求映射；环境绑定的 `taskStatus` 与缺省入口检查；
  核心经伪造端口的启动请求字段。
- 搬迁涉及的既有用例只改 import、构造与源码锚点（`rfc359-t3` 的伪造环境补 `taskStatus` / `workspaceEntries`）。
