# RFC-420 技术设计

路径缩写：

| 缩写  | 路径                                       |
| ----- | ------------------------------------------ |
| `S`   | `packages/backend/src`                     |
| `TE`  | `S/modules/task-execution`                 |
| `T`   | `packages/backend/tests`                   |
| `WM`  | `TE/composition/wrapperMechanics.ts`       |
| `ANE` | `TE/composition/agentNodeExecution.ts`     |
| `CCN` | `TE/composition/childCallNodeExecution.ts` |
| `TEA` | `TE/composition/taskEngineApplication.ts`  |
| `TMS` | `TE/composition/taskMechanicsState.ts`     |

行号以 RFC-419 落库后的源码（`1cd551c10`）为准。

## 1. 文件

| 来源                                                       | 去向                                                                                         | 说明                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `WM` `readPort`（92–120）                                  | `TE/application/nodeInputs.ts` 的 `readPortInScope(input, nodeId, portName, frame)`          | 原样迁移；`input` = `{ persistence, taskId, definition, parents }`                                                                           |
| `WM` `priorFanoutConsumed`（145–162）                      | `TE/application/nodeInputs.ts` 的 `priorFanoutConsumedJson(persistence, taskId, …)`          | 原样迁移；编码函数直接取 `domain/consumedInputs` 的 `encodeConsumedEdges`（infrastructure 的 codec 是它的再导出）                            |
| `WM` `resolveFanoutAgent`（60–65）                         | `TE/application/fanoutAgentResolution.ts` 的 `resolveFanoutAgent(resources, node)`           | 原样迁移；`resources` = `FanoutAgentResources`（`definition`、`agentKey`、`injection`）                                                      |
| `ANE` `sourcePortKindOf`（67–92）                          | `TE/application/fanoutAgentResolution.ts` 的 `sourcePortKindOf(resources, nodeId, portName)` | 原样迁移；`state.definition` → `resources.definition`，规范键与解析经 `resources`                                                            |
| `WM` `scopeDriver.drive`（195–235）                        | `TE/engine/wrapper/wrapperBodyScope.ts`                                                      | 挂载映射原样成为 `wrapperBodyMounts(outer, handle, kind)`（passthrough 返回 null）；进入与驱动成为 `createWrapperScopeDriver<S>(ports, log)` |
| `CCN` 无 owner 兼容 actor 与 `delegatedCallActor`（36–67） | `TE/application/childCallInheritance.ts`                                                     | 原样迁移；入参改为 `(delegated, { kind, ownerUserId, parentTaskId, parentNodeRunId })`                                                       |
| `CCN` `buildChildRuntime`（69–77）                         | `TE/application/childCallInheritance.ts`                                                     | 原样迁移；入参为窄类型 `ChildRuntimeParent`（`triggerContext`、`task.ownerUserId`、`opts`），执行状态结构上满足                              |
| `CCN` `restoreIso` 主体（249–269）                         | `TE/engine/kernel/mergeRecovery.ts` 的 `restoreNodeIso(ports, input)`                        | 经 `IsolationMechanicsPorts`；任务仓库 HEAD 由同文件的 `scopeBaseHeads` 取                                                                   |
| `TEA` 协作者投影（136–142）                                | `TE/domain/taskCollaborators.ts` 的 `collaboratorUserIdsOf(members)`                         | 原样迁移                                                                                                                                     |
| `TMS` `NodeMechanicsResult`（27–32）                       | 删除                                                                                         | 零引用                                                                                                                                       |
| `TMS` `TaskScopeArgs`（12–25）                             | `export type TaskScopeArgs = DagScopeArgs`                                                   | 两者字段逐一相同                                                                                                                             |

迁移后的绑定：

- **`ANE`** 新增 `agentResolutionResources(state)`，返回带 getter 的 `FanoutAgentResources`：
  - `definition` 取 `state.definition`；
  - `agentKey` 为 `fanoutInnerAgentRefKey`；
  - `injection` 为 `(agentId) => state.taskExecutionResources.injection(agentId)`。

  `resources.sourcePortKind` 改为 `sourcePortKindOf(agentResolutionResources(state), nodeId, portName)`。

- **`WM` 的 `data` 端口**：
  - `resolveFanoutAgent` / `sourcePortKind` 经 `agentResolutionResources(state)` 调用 application；
  - `readPort` 调 `readPortInScope({ persistence, taskId, definition, parents: state.containerOf }, …)`；
  - `priorFanoutConsumed` 调 `priorFanoutConsumedJson(state.opts.persistence.nodeExecution, state.taskId, …)`。

  其余方法（进度、输出、消费记录写入）本来就是端口转发，不动。

- **`WM` 的 `scopeDriver`** = `createWrapperScopeDriver<TaskMechanicsState>(ports, executionLog)`，`ports` 为：

  | 成员             | 绑定                                                                                           |
  | ---------------- | ---------------------------------------------------------------------------------------------- |
  | `outer`          | `state`                                                                                        |
  | `outerRepos`     | getter，取 `state.repos`                                                                       |
  | `resolve`        | `workspaceScenes.resolve`                                                                      |
  | `enter`          | `(mounts) => ({ ...state, ...mounts })`                                                        |
  | `completeMerges` | `(inner, frame, log) => completeFrameMerges(createIsolationMechanicsPorts(inner), frame, log)` |
  | `drive`          | `(inner, args) => state.driveScope(inner, args)`                                               |

- **`CCN`** 的三处：
  - `resolveActor` 调 `delegatedCallActor(state.opts.identityAccess.delegatedRequests, { kind, ownerUserId: state.task.ownerUserId, parentTaskId: state.taskId, parentNodeRunId })`；
  - 两条发起臂与续跑仍写 `buildChildRuntime(state)`；
  - `restoreIso` 为 `(input) => restoreNodeIso(createIsolationMechanicsPorts(state), input)`。
- **`TEA`**：`collaboratorUserIds: collaboratorUserIdsOf(collaborators)`。

### 1.1 `createWrapperScopeDriver` 的执行顺序

与原 `drive` 逐步相同：

1. `resolve` 场景；
2. `wrapperBodyMounts` 为 null（passthrough）时用 `outer`，否则 `enter(mounts)`；
3. 标签 `kind === 'wrapper-loop' ? 'loop' : 'git'`，`executionLog.child(\`${label}:${wrapperId}\`)`；
4. `completeMerges(inner, { containerRunId, iteration }, scopeLog)`；
5. 然后 `drive(inner, { scopeId, scopeIds: new Set(directNodeIds), containerRunId, iteration, log: scopeLog })`。

### 1.2 `restoreNodeIso` 与原写法的对照

原写法直接调 `workspaceSessionFor(state)` 的 `scope()` 与 `restore()`，自己循环取 HEAD。新写法走 `IsolationMechanicsPorts`：

- **`workspace.scope`**：即 `workspaceSessionFor(state).scope()`。
- **`repos`**：即 `state.repos`，`scopeBaseHeads` 的循环体与原文相同。
- **`workspace.restore`**：在 `submodules` 有值时做 `restoredSubmodules` 转换。`parseIsoSubmodules` 总是返回对象，因此转换必发生，与原写法
  相同。
- **`persistence.artifactPaths` 与 `taskId`**：即原写法读的两个值。

调用顺序（scope、各仓库 HEAD、恢复键、restore，restore 参数里最后读强制路径）不变。

## 2. 依赖规则

- **新增 / 改动的文件**：`application/nodeInputs.ts`、`application/fanoutAgentResolution.ts`、`application/childCallInheritance.ts`、
  `engine/wrapper/wrapperBodyScope.ts`、`engine/kernel/mergeRecovery.ts`、`domain/taskCollaborators.ts`。
- **这些文件不 import**：composition、infrastructure、`@/services`、`@/routes`、`@/ws`、`@/mcp`。
- **它们可以 import 的**：
  - `childCallInheritance.ts`：`@/auth/actor` 的 `Actor` 类型、identity-access public 的 `DelegatedRequestAuthorityFactory` 类型（application
    已有同类先例）；
  - `fanoutAgentResolution.ts`：`@agent-workflow/shared` 的 `declaredPorts`。
- **规范键不由 application 引入**：fan-out 规范键 `fanoutInnerAgentRefKey` 在 `@/services/ref/runtimeRef`，由 composition 作为 `agentKey`
  注入。
- **`WM` / `ANE` / `CCN` / `TEA` 不再含以下记号**：
  - `closure-binding-unresolved`、`familyHistory(`、`resolveSourceFrameInScope`；
  - `handle.passthrough`、`isoWorktreePath`；
  - `declaredPorts(`；
  - `OWNERLESS_SYSTEM_USER_ID`、`.forCall(`；
  - `recoverKey(`、`parseIsoSubmodules`；
  - `member.role !== 'owner'`。

## 3. 必须保持

| 不变量                                                                                                  | 现有锁 / 用例                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 闭包端口读：读者 frame 的环境链、不可见时的错误文本、在解析出的 frame 读 done / skipped 行并带 `active` | RFC-354 环境链用例、`rfc395-a3-sites-a`、loop 退出条件 / 输出绑定用例               |
| 上一次 fan-out 尝试：同轮、排除本次、只取顶层且有消费记录的最新一行，编码不变                           | fan-out 复用 / 新鲜度用例、`rfc395-a2-checkpoint-bytes`                             |
| fan-out agent：name-only 返回 missing，失败原样返回、不抛                                               | RFC-223 / RFC-271 用例、`scheduler-wrapper-fanout-routing`                          |
| 源端口种类：agent 取 `outputKinds`，其余取声明端口表，未知节点为 null                                   | RFC-354 fan-out 源种类用例、`rfc407-port-bindings`                                  |
| wrapper body：挂载规则、容器根、scope 日志标签、先补合回再驱动                                          | `rfc370-isolation-workspace-bindings`、`rfc193-wrapper-review`、loop / git 嵌套用例 |
| 委托 actor：NULL owner 的兼容 actor（无权限）、`forCall` 入参、admission 为空返回 null                  | `rfc404-port-bindings`、RFC-285 B3 / RFC-305 / RFC-347 锁                           |
| 子运行时：触发上下文（有才带）、`actorUserId`、`pickInheritableRunConfig(opts)`；两条发起臂与续跑共用   | `rfc404-port-bindings`、RFC-284 T20 锁                                              |
| 调用行 iso 重建：调用顺序与参数                                                                         | 调用节点续跑用例；本 RFC 端口绑定用例                                               |
| 协作者：去 owner 与空 userId，按首次出现去重                                                            | `rfc408-port-bindings`、`task-collab-launch`                                        |

## 4. 守卫与账本

- **RFC-285 B3**：`delegatedCallActor(` 的定义与 `delegated.forCall({` 改为在 `childCallInheritance.ts`；绑定里只剩一次调用（端口方法）。
  续跑臂判据不变。
- **RFC-284 T20**：`function buildChildRuntime` 的段落改读 `childCallInheritance.ts`，`runConfig: pickInheritableRunConfig(parent.opts)`；
  三处 `buildChildRuntime(state)` 仍在绑定。
- **RFC-305**：`.delegatedRequests` 仍在绑定；`.forCall({` 与两种调用 kind 改读 `childCallInheritance.ts`。
- **RFC-347**：`.forCall(` 唯一调用点改为 `src/modules/task-execution/application/childCallInheritance.ts`。
- **RFC-305 identity-access 合同消费方账本**：登记 `childCallInheritance.ts` 对 identity-access `public/participants` 的类型 import
  （委托授权工厂类型），与 application 既有的跨模块 public 类型消费同型。
- **RFC-292 触发上下文锁**：子运行时里的 `{ triggerContext: parent.triggerContext }` 改读 `childCallInheritance.ts`，绑定侧锁
  `runtime: buildChildRuntime(state)`。
- **RFC-271**：
  - `resolveFanoutAgent` 的段落改读 `fanoutAgentResolution.ts`（`resources.injection(agentId)`、`resolution.kind === 'ok'`、`: resolution`、不抛）；
  - 绑定侧改为锁 `agentResolutionResources(state)` 里的 `state.taskExecutionResources.injection(agentId)`。
- **RFC-193**：`scopeRoot: handle.containerPath` 与 `kind === 'wrapper-loop'` 改读 `wrapperBodyScope.ts`。
- **RFC-345**：catalog session 的字面读取：
  - wrapper 绑定 0 处，agent 绑定 3 处（`resources.injection`、`hostInjection`、`agentResolutionResources`）；
  - 端口读取方仍为 3 处；
  - `resolution.kind === 'ok'` 的两处断言改读 `fanoutAgentResolution.ts`。
- **结构锁的符号 owner**：
  - RFC-407 的 `sourcePortKindOf` 改为 `fanoutAgentResolution.ts`；
  - RFC-404 的 `buildChildRuntime` 改为 `childCallInheritance.ts`。
- **RFC-395 选择语义账本**（`T/fixtures/rfc395-selection-semantics-ledger.json`）：上一次 fan-out 尝试的 `familyHistory` 站点改为
  `src/modules/task-execution/application/nodeInputs.ts#priorFanoutConsumedJson:1`，归一化调用文本随 `state.taskId` → `taskId` 更新；帧语义说明
  不变。
- **`T/helpers/executionMechanismSources.ts`**：`WRAPPER_MECHANICS_SOURCE` 补入 `engine/wrapper/wrapperBodyScope.ts`、
  `application/fanoutAgentResolution.ts`。
- **guard-manifest 与 Windows**：guard-manifest 新增一条；Windows `paths:` 与 suite 补上。其余账本按实测更新。

## 5. 测试

- **新增结构锁** `T/architecture/rfc420-execution-state-residue.test.ts`，各项都带负例：
  - 被迁符号的 owner 唯一；
  - `WM` / `ANE` / `CCN` / `TEA` 不含 §2 的记号；
  - 新文件不 import composition / infrastructure / `@/services`；
  - `TMS` 不再声明 `NodeMechanicsResult`。
- **端口绑定用例** `T/rfc420-port-bindings.test.ts`：
  - `readPortInScope`：可见源在解析出的 frame 读行；不可见源抛 `closure-binding-unresolved`。
  - `priorFanoutConsumedJson`：排除本次、取最新有消费记录的顶层行；没有时返回 null。
  - `resolveFanoutAgent`：name-only → missing；ok → agent；failed 原样返回。
  - `sourcePortKindOf`：agent 的 `outputKinds`、非 agent 的声明种类、未知节点 null。
  - `wrapperBodyMounts`：passthrough 为 null；loop 保留外层挂载与只读；git 用 iso 挂载、非只读；容器根。
  - `createWrapperScopeDriver`：先补合回再驱动、日志标签、驱动参数、passthrough 用外层状态。
  - `delegatedCallActor`：NULL owner 的兼容 actor 无权限、admission 的 actor、admission 为空 → null。
  - `buildChildRuntime`：有无触发上下文、`actorUserId`、继承配置。
  - `restoreNodeIso`：调用顺序与参数（含 submodule 拓扑与强制路径）。
  - `collaboratorUserIdsOf`：去 owner / 空 userId，按首次出现去重。
- **搬迁涉及的既有用例**：只改 import 与源码锚点。
