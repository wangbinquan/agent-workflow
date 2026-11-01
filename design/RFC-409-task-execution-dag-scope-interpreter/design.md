# RFC-409 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`ES` = `TE/engine/scope`，
`P` = `TE/application/ports/dagScope.ts`，`DF` = `S/services/dispatchFrontier.ts`。行号以 RFC-408 落库后的源码为准，实施时按源码定位。
形状沿用 RFC-405～408：主体在 engine，composition 只装配；端口只用 task-execution 自有的结构类型。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| scope 循环 | `ES/runScope.ts`：`runScope(ports, args)`——`composition/taskDagScope.ts` 的 `runScope` 与 `detailFor` 原样迁入，`state` / `opts` / `executeNode` / `maybeRunCommitPush` 换成端口 |
| frontier | `ES/dagFrontier.ts`：`composition/dagFrontier.ts` 原样迁入（已是纯函数） |
| frontier 判定 | `ES/frontierRules.ts`：`DF` 中读取运行历史的判定（`WRAPPER_KINDS`、`isReviewSupersededRow`、`wrapperRevivalEvidence`、`wrapperHasFreshInnerWork`、`isDispatchable`、`decideScopeOutcome` 及其类型）原样迁入，import 改为本模块 application / domain |
| 定义图纯函数 | `TE/domain/wrapperGraph.ts`：`DF` 的 `wrapperInnerDescendants`、`wrapperExternalUpstreamSources`（只读定义） |
| 端口 | `P`：`DagScopePorts`、`DagScopeArgs`、`DagNodeOutcome`（与 `services` 的 `TaskScopeArgs` / `NodeMechanicsResult` 同形） |
| 绑定 | `composition/taskDagScope.ts` 改为 `createDagScopePorts(state, wrapperRuntimeFactory)` 与 `driveDagScope(state, args, factory)`（两个调用方不改签名） |
| 删除 | `DF`；`services/runLiveness.ts` 经 `public/queries` 的 `wrapperInnerDescendantIds`（返回 `ReadonlySet`）取用，`composition/wrapperRunLifecycle.ts` 直接 import `domain/wrapperGraph` |

### 1.2 端口

| 分组 | 能力 | 绑定到 |
| --- | --- | --- |
| `task` | `taskId`、`rowId`（`state.task.id`）、`definition`、`autoCommitPush`、`topLevelIds`、`containerOf` | `state.*`（读调用时） |
| 事实 | `execution`、`signal` | `state.opts.*` |
| `persistence` | `selection`（`familyHistory`、frontier 的选择读取）、`nodeExecution.list`、`nodeRuns.transition`、`intents.hasPendingGateSuccessor` | `state.opts.persistence.*` |
| `collaboration` | `autoDispatchDeferredQuestions`、`loadOpenClarifyEvidence`、`loadUndispatchedParkTargets` | `state.opts.taskDagCollaboration` |
| 行为 | `executeNode({ node, containerRunId, iteration, log })`、`commitPush(node, iteration, log)` | `executeNode(state, …, factory)`、`maybeRunCommitPush(state, …)` |

递归：`state.driveScope(nestedState, args)` 的实现改为 `runScope(createDagScopePorts(nestedState, factory), args)`。

### 1.3 依赖规则

`ES` 只 import 本模块 `domain/`、`application/`、`engine/`、`@agent-workflow/shared` 与 node 内建模块（同 RFC-408 对 `engine/task/` 的规则）。

## 2. 必须保持

| 不变量 | 现有锁 / 用例 |
| --- | --- |
| 每拍重读 node_runs 并重新派生 frontier；新 ready 节点立即派发，`Promise.race` 等首个完成 | RFC-076、dispatch-frontier 用例 |
| scope 内环检查、提交推送的合成 in-flight 项与串行尾链、取消时排空提交推送 | RFC-075、RFC-098 B1、scheduler-boundary 用例 |
| RFC-370 中断提交推送的一次性续跑（按持久 cause 取历史、退休可接管会话） | RFC-370 用例 |
| handoff、processUnreaped 不再派生、park / 首个失败 / 结局判定优先级（`decideScopeOutcome`） | RFC-095、RFC-332、RFC-333 用例 |
| frontier 判定与 wrapper 复活证据、定义图函数的结果 | RFC-098 B3、RFC-306、scheduler-audit S03 / S07 / S12 用例 |

## 3. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| 按 `composition/taskDagScope.ts` / `dagFrontier.ts` 路径取语料的锁（RFC-332、RFC-334 `executeNode` 计数、RFC-146 frontier 等） | 改读新 owner；缺席断言把新 owner 并入语料；守卫文件在文件内读 owner |
| import `DF` 的用例与 `runLiveness` | 改 import 路径；`public/queries` 增加 `wrapperInnerDescendantIds` 导出 |
| RFC-317 / RFC-328 / RFC-395 选择语义账本（`familyHistory` 站点随 `runScope` 迁移） | 站点随主体迁移，条数不变 |
| legacy 文件边、services 业务实现计数、RFC-376 counts、commons-debt、guard-manifest、Windows paths | 按实测更新，只降不升 |

## 4. 测试

- 新增结构锁 `T/architecture/rfc409-dag-scope-interpreter.test.ts`：`runScope` / `deriveFrontier` / frontier 判定 / 定义图函数 owner 唯一；`DF` 已删除且
  不被引用；`ES` 的 import 层级；每项带纯伪造输入的负例。
- 端口绑定用例 `T/rfc409-port-bindings.test.ts`：事实与 persistence 读调用时的状态；`executeNode` / `commitPush` 转交；递归经绑定为嵌套状态造端口。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
