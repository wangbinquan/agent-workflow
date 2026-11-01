# RFC-408 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`C` = `TE/composition/taskEngineApplication.ts`，
`ET` = `TE/engine/task`，`P` = `TE/application/ports/taskRun.ts`。行号以 RFC-407 落库后的 `C`（898 行）为准，实施时按源码定位。形状沿用
RFC-405～407：主体在 engine，composition 只装配；端口只用 task-execution 自有的结构类型。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| 任务控制面主体 | `ET/runTask.ts`：`runTask(ports)`——`C:196-680` 的载入、归属、授权、工作区排除配置、快照解析、触发器预检、认领、人工提问 park、节点校验、准备驱动、引擎选择与驱动、只读成员巡检，原样迁入 |
| 终态结算 | `ET/taskSettlement.ts`：`failTaskRun` / `cancelTaskRun`（原 `failRuntimeTask` / `cancelRuntimeTask`，`C:50-169`，含 `taskStopCauseFromUnknown`）与 `settleTaskScopeOutcome`（`C:695-898` 的人工提问 settle、failed / canceled / awaiting_review / awaiting_human / done 结算） |
| DAG 结构图 | `TE/engine/scope/dagGraph.ts`：`composition/taskDagGraph.ts` 原样迁入；`composition/taskDagScope.ts`、`services/dispatchFrontier.ts` 与 `ET/runTask.ts` 共用 |
| 端口 | `P`：`TaskRunPorts<Admission>`（§1.2） |
| 绑定 | `C`：`createTaskRunPorts(opts, topology, runtimeComponents)` 与 `driveTaskEngineApplication`（执行上下文包装与许可回收，不变） |

### 1.2 端口

| 分组 | 能力 | 绑定到 |
| --- | --- | --- |
| 事实 | `taskId`、`log`（`opts.log ?? createLogger('scheduler')`）、`settlementLog`（终态写入 helper 原用的 `createLogger('scheduler')`）、`execution`、`signal`（读调用时的 `opts`） | `opts` |
| `persistence` | `drive`、`ownership`、`runtimeLifecycle`、`humanGateLifecycle`（类型均为 `application/ports` 既有的 persistence 分组） | `opts.persistence.*` |
| `admission` | `admit({ ownerUserId, taskId }): Promise<Admission \| null>`：执行授权可用时返回资源会话 | `identityAccess.delegatedRequests.forTaskExecution` + `createTaskAgentResourceSession` |
| `workspace` | `ensureProfiles`、`project(task, rows): TaskRepositoryMount[]`、`ensureExcludeProfile({ workspaceRef, directChildMounts })` | `opts.ensureWorkspaceProfiles`、`projectStoredTaskRepositoryMounts`、`bindWorkspaceExcludeProfile(...).ensure` |
| `rules` | `triggerPreflightIssue`、`dynamicWorkflowOrchestratorNodeId` | `services/execution/triggerPreflight`、`services/orchestratorAgent` |
| `dynamicWorkflow` | `loadTask(taskId)`（未装配时为 `undefined`） | `opts.dynamicWorkflow?.persistence` |
| `reviewMutation` | `run(fn)` | `withTaskReviewMutationLock(taskId, fn)` |
| `prepare` | `prepare(input): PreparedTaskDrive`：用 engine 算好的事实装配 `TaskMechanicsState`；返回 `recoverBeforeScope()`、三个引擎主体 `bodies`（各返回原始 scope 结果）、`runtimeConfig()`、`inspectReadonlyRepos()` | `C` 内原装配代码、`runtimeComponents.mergeRecoveryFactory`、`runScope` / `opts.workgroupTurns.drive` / `runDynamicWorkflowGenerate`、`resolveTaskDriveConfig`、`inspectReadonlyRepos` |

`Admission` 是端口的类型参数（资源会话的类型属于 `services/`）：engine 只把它原样交回 `prepare`。仓库挂载用 domain 已有的
`TaskRepositoryMount`。注册表在 engine 内以三个 `bodies` 构造（与 `C` 原闭包同为 `taskEngineOutcomeFromScope(await body())`），ownerless 测试接缝
直接调用 `bodies[engine]()`。

### 1.3 依赖规则

`ET` 与 `engine/scope/` 只 import 本模块 `domain/`、`application/`、`engine/`、`public/types`、`@agent-workflow/shared` 与 node 内建模块；
不 import `@/services`、infrastructure、composition 或其他 context。

## 2. 必须保持

| 不变量 | 证据 | 现有锁 / 用例 |
| --- | --- | --- |
| 载入失败、owner 不匹配、ownerless 但已 claimed：只记日志并返回 | `C:204-225` | RFC-328 / RFC-332 用例 |
| 授权不可用、工作区排除配置失败、快照非法、触发器预检、节点 kind / 重复 id / 容器非法 / 顶层环：`failTaskRun` 的摘要与文本逐字不变，检查顺序不变 | `C:227-422` | RFC-146、RFC-292、RFC-308、RFC-354 用例 |
| 认领：只从 pending CAS 到 running，失败返回；认领后先 settle 人工提问 park | `C:315-342` | RFC-097、RFC-333 T7 |
| 装配在驱动 try 之外，合并恢复、动态工作流阶段读取、引擎选择、dw 阶段不变量、注册表构造与驱动在 try 之内；try 抛出改判 `scheduler error` | `C:433-672` | scheduler-boundary-wrapper-resume-interrupted |
| ownerless 接缝直接调引擎主体，生产路径经注册表与 `resolveTaskDriveConfig` | `C:611-667` | RFC-332 / RFC-339 用例 |
| 结算：handoff 返回；只读巡检每条终态路径都跑且吞错；cancel 优先；awaiting_review / done 的人工提问重试循环与 unpark 边；awaiting_human 的原子 park 识别 | `C:674-898` | RFC-005、RFC-097、RFC-248、RFC-333 用例 |
| `driveTaskEngineApplication` 的执行上下文包装与 finally 回收两个许可注册表 | `C:171-194` | RFC-098 B1、RFC-266 |

## 3. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| 按 `C` 路径取语料的源码锁（RFC-333 human gate、RFC-248、RFC-202、RFC-146、RFC-098 写锁、RFC-266、RFC-339、RFC-359 W5-T19b 等） | 改读新 owner；缺席断言把新 owner 并入语料；计数按实测 |
| import `taskDagGraph` 的用例 | 改 import 路径 |
| RFC-317 站点（`C` 的 CAS 站点）、RFC-328 账本（`C` 的写站点分类）、RFC-395 task-definition 边界 | 站点随主体迁移，条数与边不变 |
| `services/dispatchFrontier.ts` → `taskDagGraph` 的 legacy 文件边 | 改指新文件，按实测核对账本，只降不升 |
| RFC-334 边界、RFC-376 counts、commons-debt、guard-manifest、Windows paths | 随 owner 改指，按实测更新 |

## 4. 测试

- 新增结构锁 `T/architecture/rfc408-task-control-plane.test.ts`：`runTask` / `failTaskRun` / `cancelTaskRun` / `settleTaskScopeOutcome` /
  `buildScopeUpstreams` / `findScopeCycle` 的 owner 唯一；`C` 不再含认领与结算流程（`'runTask-start'` 等 reason 只在 `ET`）；`ET` 与
  `engine/scope/` 的 import 层级；每项带负例，逐文件扫描按 `SourceUnit` 缓存。
- 端口绑定用例 `T/rfc408-port-bindings.test.ts`：事实与 persistence 读调用时的 `opts`；`admit` 在授权不可用时返回 null、可用时返回资源会话；
  `ensureExcludeProfile` 原样转交；`rules` 为共享实现；`prepare` 装配出的状态字段与原装配一致（池、写锁、扇出池、scopeRoot、repos 等）。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
