# RFC-417 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`CS` = `TE/infrastructure/crewstation`，
`TRS` = `TE/composition/crewstationTaskRunSelection.ts`，`CXE` = `TE/composition/crewstationExecution.ts`，`TMP` =
`TE/composition/taskAgentMaterialPreparation.ts`。行号以 RFC-416 落库后的源码（`80b715e95`）为准。形状沿用 RFC-413～416：主体原样迁移，只做
落位；装配留在 composition。

## 1. 文件

| 来源                                                                                                                 | 去向                                                                                                                | 说明                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRS` 的 `open(scope)` 主体（65–158 行）                                                                             | `CS/taskAgentRunScope.ts` 的 `openHostedTaskAgentRun(input, run, scope)`                                            | 原样迁移；`run` = `{ binding, physical, participants }`（`binding` 取 `nodeRunPrompts` / `portArtifacts`，`physical` 为确保过的物理工作区）               |
| `TRS` 的 `composeHostedTaskMaterialReferences`（172–209 行）                                                         | `CS/taskMaterialReferences.ts` 的 `createHostedTaskMaterialReferences()`                                            | 原样迁移，改名                                                                                                                                            |
| `TMP` 全部                                                                                                           | 函数 → `TE/application/taskAgentMaterialPreparation.ts`；两个接口 → `TE/application/ports/taskAgentMaterial.ts`     | 原样迁移；`TMP` 删除，本地 run family、托管运行范围与四个用例改 import                                                                                    |
| `CXE` 的 `createCrewStationExecutionWorkspaces`（31–58 行）与 owner 改写的 helper（126–133 行）                      | `CS/executionWorkspaces.ts`：`createHostedExecutionWorkspaces`、`createOwnerRoutedWorkspaceHelper(commands, owner)` | 原样迁移，改名                                                                                                                                            |
| `CXE` 的 `CAPABILITY_CACHE_MS`、`createCachedHostedCapabilities`（60–82 行）与 `capability(name)` 判定（135–146 行） | `CS/hostedCapabilities.ts`：`createCachedHostedCapabilities`、`hostedProfileCapability(capabilities)`               | 原样迁移；判定函数返回 `(name) => (agentProfileId) => Promise<boolean>`                                                                                   |
| `CXE` 的 `SETTLEMENT_INTERVAL_MS` 与命令对账 background owner（202–224 行）                                          | `CS/workspaceCommandReconciliation.ts` 的 `createHostedWorkspaceCommandReconciliation({ commands, log })`           | 原样迁移，返回 `{ id: 'hosted-workspace-command-reconciliation', run(signal) }`                                                                           |
| `CXE` 的 `composeCrewStationIntentScratchRelease` 中的释放逻辑（281–295 行）                                         | `CS/intentScratchRelease.ts` 的 `createHostedIntentScratchRelease({ executions, helper, workspaces })`              | 原样迁移；`executions` 只用 `workspaceSettled`。composition 的同名函数保留，只构造 store / 托管执行（含 `workspaceTaskId` 映射）后交给它（proposal §6.2） |

迁移后 `TRS` 只剩 `composeCrewStationTaskRunSelection` 的装配：`taskAgentRunsFor(binding)` 确保物理工作区，返回
`{ runtimeBindings, materialReferences, open: (scope) => openHostedTaskAgentRun(input, { binding, physical, participants }, scope) }`。`CXE` 只剩
`composeCrewStationExecutionOwner` 与 `composeCrewStationIntentScratchRelease` 的构造与注入；恢复证明闭包留在 `CXE`（RFC-328 只允许
`composition/bootRecovery.ts` 铸造证明，见 proposal §6.3）。

## 2. 接口

```ts
// CS/taskAgentRunScope.ts
/** 原 composeCrewStationTaskRunSelection 的入参，原样搬到这里声明；composition 引用它（infrastructure 不反向依赖 composition）。 */
export interface HostedTaskRunSelectionInput {
  /* db、fence、api、executions、helper、profiles、materialEnvironment、pluginFiles、materialFiles、四个能力判定、skills、
     nodeRunPrompts、portArtifacts、workspaces、locate、reference、runtimeBindingsFor —— 与原文逐字段相同 */
}
export function openHostedTaskAgentRun(
  input: HostedTaskRunSelectionInput,
  run: {
    readonly binding: Pick<TaskRunFamilyBinding, 'nodeRunPrompts' | 'portArtifacts'>
    readonly physical: { readonly businessTaskId: string }
    readonly participants: HostedAgentParticipants
  },
  scope: TaskAgentRunScope,
): TaskAgentRunPurpose
```

`TaskAgentRunScope` / `TaskAgentRunPurpose` 是 `application/ports` 里 `TaskAgentRunFamily.open` 的既有参数与返回类型。托管调用准备仍以 `...input`
展开完整入参（与原文相同）。

## 3. 依赖规则

- `CS/` 下的新文件不 import 本模块或他模块的 composition。
- `TE/application/taskAgentMaterialPreparation.ts` 不 import infrastructure / composition。
- `CS/taskAgentRunScope.ts` 调用 application 的 `createTaskAgentMaterialPreparation`（proposal §6.1）。
- 迁移后 `TRS` 与 `CXE` 不再含：helper 的 `write-seeds` / `git-control` / `validate-output` / `system-workspace` 调用、`setTimeout` 循环、能力缓存
  窗口、技能暂存规则与托管引用前缀。

## 4. 必须保持

| 不变量                                                                                                      | 现有锁 / 用例                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 运行目录、工作区引用、写种子文件的 `operationId`、git 控制面与输出校验的 helper 参数、调用 ID、技能暂存规则 | `rfc370-m1-agent-material`、`rfc370-task-run-root-selection` 等                                            |
| 托管材料引用（技能 / 插件）                                                                                 | `rfc370-m1-agent-material`                                                                                 |
| 逻辑子执行借用父工作区、不为子执行建空卷                                                                    | `rfc370-m2-inherited-workspace`                                                                            |
| 能力缓存 30 秒与并发去重、能力版本判据                                                                      | `rfc370-m2-*` 托管用例，以及本 RFC 的端口绑定用例                                                          |
| 恢复证明的世代字段 `daemonGeneration: lease.instanceId`                                                     | RFC-385 证明锚点                                                                                           |
| 对账循环：每轮不等待上一次 `reconcile`、失败只记 warn、60 秒间隔、abort 立即退出                            | 本 RFC 的端口绑定用例                                                                                      |
| Intent scratch：未结算抛错、无 parent 直接返回、释放失败抛错、helper 参数与 `operationId`                   | 本 RFC 的端口绑定用例                                                                                      |
| 任务材料准备：注入字段、可选字段的「有则带」、诊断转交                                                      | `rfc370-task-agent-material-preparation`、`rfc370-task-agent-selected`、`rfc370-m2-task-startup-inventory` |

## 5. 守卫与账本

- RFC-414 端口绑定用例读 `CXE` 的 `readTaskWorkspaceRef` 锚点，改读 `CS/executionWorkspaces.ts`。
- 四个用例改 import：`rfc370-m1-agent-material`、`rfc370-m2-inherited-workspace`、`rfc370-task-agent-material-preparation`、`rfc370-task-agent-selected`、
  `rfc370-m2-task-startup-inventory`（后三者为 `TMP`）。
- guard-manifest 新增一条；Windows paths 与 suite 按惯例补上。

## 6. 测试

- **新增结构锁** `T/architecture/rfc417-hosted-run-execution-infrastructure.test.ts`，各项都带负例：
  - 被迁符号与新符号的 owner 唯一；
  - `TMP` 不复活，也不被引用；
  - `TRS` / `CXE` 不含 §3 列出的步骤记号；
  - infrastructure 新文件不 import composition；
  - application 新文件不 import infrastructure / composition。
- **端口绑定用例** `T/rfc417-port-bindings.test.ts`：
  - 能力缓存（窗口内不重读、并发共享一次读取、过期后重读）与能力判定；
  - owner 改写的 helper；
  - 对账循环（失败记 warn 后继续、abort 退出）；
  - Intent scratch 释放的三条分支与成功参数；
  - 运行范围（工作区引用、写种子文件与两类 helper 调用的参数、调用 ID、技能暂存规则）。
- 搬迁涉及的既有用例只改 import 与源码锚点。
