# RFC-404 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`N` = `TE/composition/nodeMechanics.ts`，
`E` = `TE/composition/nodeExecution.ts`，`W` = `TE/composition/wrapperMechanics.ts`，`CC` = `TE/engine/node/shared/child-call`。行号以提交
`2874dd182` 为准，实施时按源码定位。形状沿用 RFC-402 / RFC-403：executor 接收 `NodeStepRequest`、返回 `NodeStepOutcome`，主体在 engine，
composition 只装配现有接收者、上下文、配置与平台适配。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| 执行器 | `TE/engine/node/call-workflow/callWorkflowNodeExecutor.ts`、`TE/engine/node/call-workgroup/callWorkgroupNodeExecutor.ts`（各一个类，调用同一主体） |
| 共享主体 | `CC/runChildCallNode.ts`：选择器与冻结闭包、上游输入、取行与领养、两道门、iso 派生、发起、等待、终态映射、输出投影、合并（`N:965-1633`）以及调用行结算 `failCallRow`（`N:1636-1661`） |
| 发起臂 | `CC/launchChildCall.ts`：workflow 与 workgroup 两条发起臂（`N:1763-1846`、`N:1904-1982`）、`renderCallGoal`（`N:1856-1901`）、`inheritedCallSpace`（`N:1707-1760`）、limits 与子任务名称 |
| 等待支撑 | `CC/childCallWatch.ts`：观察间隔与关停确认窗口常量、`isShutdownAbort`、`awaitShutdownAbort`（`N:938-941`、`N:1663-1696`） |
| 端口 | `TE/application/ports/childCallNodeExecution.ts`：`ChildCallNodeExecutionPorts`（见 §1.2） |
| 绑定 | `TE/composition/childCallNodeExecution.ts`：`createChildCallNodeExecutionPorts(state)`；`buildChildRuntime`（`N:1698-1705`，文本不变）与 `delegatedCallActor` / 历史 NULL owner 投影（`N:146-177`）随之迁入 |

旧委托壳 `TE/engine/node/childCallNodeExecutors.ts` 删除，不留 shim；`E` 以 `new CallWorkflowNodeExecutor(createChildCallNodeExecutionPorts(state))`
与 `new CallWorkgroupNodeExecutor(createChildCallNodeExecutionPorts(state))` 直接构造。`legacyArgs` 与 `OneNodeArgs` 仍服务 agent，本 RFC 不删除。

### 1.2 端口分组

| 分组 | 内容 | 绑定到 |
| --- | --- | --- |
| `task` | taskId、名称、工作流锚点 id、`refClosureJson`、`invocationDepth`、`parentTaskId`、`ownerUserId`、worktreePath、branch、repos（mountPath / worktreePath）、成员、triggerContext；全部 getter，调用时读取 | `state.task` / `state.repos` / `state.collaboratorUserIds` / `state.triggerContext` |
| `policy` | `signal`（getter） | `state.opts.signal` |
| `input` | 上游输入解析、consumed-input 编码、`copyPortArchive` | 同 script / output 的现有实现 |
| `ledger` | `listNodeRuns`、`resolveSchedulerRunRow`、具名 `setNodeRunStatus` / `transitionNodeRunStatus`、`patch`（childTaskId 戳、台账）、`upsertOutputs`、`read`；上下文由绑定补 | `nodeRunLedger(state)` 与 `persistence.nodeExecution` |
| `closure` | `frozenWorkflow`、`frozenWorkgroup`、`childClosureSubset` | `TE/infrastructure/legacyCallClosure.ts`（不再经 `services/execution/closure.ts` 转导出） |
| `budget` | `maxInvocationDepth()`、`ensureBudget()`（返回 `acquire(ancestors, { signal })`）、`parentTaskId(taskId)`、`registerKnownChildTask(id)` | `services/execution/childBudget.ts`、`persistence.childBudget`；`ensureBudget` 仍在祖先链遍历之前调用 |
| `children` | `newChildTaskId()`、`resolveActor(kind, parentNodeRunId)`、`launchWorkflow` / `launchWorkgroup`（请求不含 runtime 与 scheduler driver，由绑定以 `runtime: buildChildRuntime(state)` 与 `state.topology.schedulerDriver` 补齐）、`resumeChild(childTaskId)`（绑定内 `const childRuntime = buildChildRuntime(state)`）、`cancelChild(childTaskId)`（cause 固定为 parent-cascade，错误原样抛出）、`isTaskActive`、`findStatus`、`watchTerminal`、`outcome` | `ulid`、identity-access 委托请求、`state.opts.childLaunch`、`state.topology.schedulerDriver`、`persistence.reads`、`services/execution/{executionWatch,outcome}.ts` |
| `workspace` | `createIsoUnderLock`、`persistIsoBase`、`mergeBackAndSettle`、`markMergeFailed`、`discardNodeIso`（同 script 端口），`restoreIso`（领养后重建：scope → 逐仓 HEAD → recoverKey → restore，含 forced paths 与 submodules 还原） | `engine/kernel/*`、`workspaceSessionFor(state)`、`restoredSubmodules` |
| `conflicts`、`status`、`log` | 合并冲突解析、节点状态广播、日志 | 现有实现 |

- 端口合同只声明结构类型或引用 `TE/application/ports/*` 的既有类型（`ChildWorkflowLaunchRequest` 去掉 runtime / scheduler driver 等），不
  import `services/` 或 `infrastructure/`。
- 子任务名、limits、工作区、闭包子集、目标渲染与 `call-owner-inactive` 判定在 engine；actor 的取得方式（委托请求、NULL owner 投影）在绑定。

### 1.3 依赖规则

与 RFC-403 §1.2 相同：engine 下新文件只 import 本模块 `domain/`、`application/`（端口与 §2 的共享实现）、`engine/kernel/`、`engine/node/shared/`、
`platform/contracts/`、`@agent-workflow/shared` 与 node 内建模块；不 import `composition/`、`infrastructure/`、`services/`、`TE/public/*`、
`@/util/*`、`@/auth/*`、其他 context 或第三方包。

## 2. 共享实现（只有一份）

| helper | 现位置 | 归属 | 消费者 |
| --- | --- | --- | --- |
| `parseIsoSubmodules` | `N:897-923` | `TE/domain/isoSubmodules.ts` | `CC/runChildCallNode.ts`（经 `restoreIso` 绑定）、`W:1787`、`executionMergeRecovery.ts:126/214/349` |
| 人工等待台账 | `N:943-963`（`parseCallLedger`）与 `TE/domain/resourceLimitUsage.ts`（`decodeCallHumanWait`） | `resourceLimitUsage.ts`：沿用 `decodeCallHumanWait`，补 `encodeCallHumanWait`（输出 `{"callHumanWaitMs":…,"callHumanWaitSince":…}`，键序不变） | calls 主体、资源用量统计 |
| 发起错误码、取消竞态容忍、拒绝错误 | `N:1231-1234`、`N:1322-1330`、发起臂与目标渲染里的 `new ValidationError(...)` | `TE/application/childCallErrors.ts`：`childLaunchFailureCode`、`isToleratedChildCancelRace`、`childCallRefusal` | calls 主体与发起臂 |
| 具名 ledger、run-row 解析、consumed-input 编码、工作区会话、节点状态与诊断合同 | RFC-402 / RFC-403 已归位 | 复用，不复制 | — |

`N` 中剩余的 agent / host 以及 `W`、`executionMergeRecovery.ts` 改为直接引用真实 owner，不经 `N` 转导出。

## 3. 必须保持

| 不变量 | 证据 | 现有锁 / 用例 |
| --- | --- | --- |
| 选择器缺失与冻结闭包缺项都以 `workflow-call-ref-missing` 失败；v2 闭包按「本任务工作流锚点 + 节点 id」取边，v1 由访问器回退按名 | `N:973-998` | `rfc243-call-workflow`、`rfc271-call-edge-closure`、`rfc395-a2-subject-call-closure` |
| 取行前奏 L8：继承 review iteration、清 agent override、追 retryIndex、广播 pending 与 canceled、带 preResolve；领养状态集 pending / running / interrupted / canceled 且有 childTaskId；非 running 领养行以 `call-adoption` 转 running（allowedFrom 三态、allowTerminal）并广播；领养区绝不 mint（RFC-243-LOCK 标记成对保留） | `N:1017-1095` | `rfc287-t8-run-row-prelude-single-source`、`rfc243-executor-facade`、RFC-317 偏离账本 |
| 非领养：mark-running 并广播；深度门在预算门之前，均在任何副作用之前；预算等待不持锁、可被 signal 取消（以 canceled 结算） | `N:1090-1142` | `rfc243-call-workflow`、`rfc243-parent-child-lifecycle` |
| iso 先取槽后快照；建树失败释放预算并以 `iso-setup-failed` 结算；非 passthrough 持久化 base | `N:1144-1174` | `rfc287-t9-exemptions-and-extinction`（calls 走 `createIsoUnderLock`，不进 assembly） |
| 子任务 id 预铸并先戳到调用行，再发起；成功后 bind 预算并登记已知子任务；失败时释放、清戳、丢弃 iso、按错误类型取码并以 `child launch failed: …` 结算 | `N:1176-1239` | `rfc243-call-workflow` 恢复矩阵 |
| 发起臂：子任务名 `${父任务名} › ${节点标题}` 截 255；成员即父任务成员；limits 只取数值字段；继承工作区按挂载布局判单 / 多根且 cleanup 借用；workflow 臂 `autoCommitPush: false`、闭包子集用子工作流 id；workgroup 臂目标模板的内置 token 描述子任务 iso；actor 为 null 时 `call-owner-inactive` | `N:1707-1982` | `rfc284-t20-child-inheritance`、`rfc285-b3-inherited-actor`、`rfc292-trigger-source-locks`、`single-nonroot-member-workspace`、`rfc395-checkpoint-boundary` |
| 子任务 runtime 只经 `buildChildRuntime`：`runConfig: pickInheritableRunConfig(state.opts)`，两条发起臂与续跑共用 | `N:1698-1705` | `rfc284-t20-child-inheritance`、`rfc103-launch-config-passthrough`、`scheduler-subagent-live-capture-passthrough` |
| 等待：台账只在领养同一行时沿用，新 mint 从零开始；5 s 观察、尽力持久化；watch 20 s 轮询；用户取消级联取消子任务（容忍 not-cancelable / NotFound）后以 canceled 结算；关停保持 running；子任务行消失 `child-deleted`；关停期终态不收尾；interrupted 子任务只续跑一次，续跑失败按 TypeError 重抛 / 他人已复活 / 仍有活跃 driver / daemon 重启确认 / `child-interrupted` 的顺序判定；Q6：续跑不重建 owner | `N:1250-1425` | `rfc243-parent-child-lifecycle`、`rfc285-b3-inherited-actor`（Q6 段） |
| 终态映射：canceled 区分父级级联与直接取消；interrupted 先判关停确认；非 done 以 `child-task-failed` 携带摘要与消息 | `N:1427-1484` | `rfc243-call-workflow` |
| 输出：workgroup 只投影 `result`（无则把原始端口按名排序拼成 `## name` 段）；archive 复制、active 保留；未 done 才以 `call-child-done` 转 done 并广播，先 done 后合并 | `N:1486-1533` | `rfc243-call-workflow`、RFC-317 站点 |
| 合并按 merge_state 分级：conflict-human 直接 awaiting_human；无 merge_state 且无 live iso 视为 passthrough 完成；否则用 live iso 或按持久列重建（base 缺失即 `merge-back-failed`），冲突转 awaiting_human，异常 markMergeFailed；最后丢弃 iso | `N:1535-1632` | `rfc243-call-workflow`、合并相关用例 |
| 不占节点池名额（不出现 agentSem / scriptSem）、不进 `runAssembly`、没有节点级重试 | `N:965-1633` | `rfc243-executor-facade`、`rfc287-t9-exemptions-and-extinction` |
| 惰性读取：signal、深度上限、子任务上限、trigger context、run config、scheduler driver 都在调用时读取，不提前冻结到 gateway 构造时 | `N:1099-1131`、`N:1698-1705` | 行为用例与实现门核对 |

## 4. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| `T/rfc243-executor-facade.test.ts` | 主体切片改为 `CC/runChildCallNode.ts` 的 `runChildCallNode`（到 `failCallRow` 为止）；节点池与领养区零 mint 断言不变 |
| `T/rfc243-parent-child-lifecycle.test.ts` | 台账源码锁改指新主体：`adoptedChildTaskId !== null` 与「新 mint 从零开始」的解码调用 |
| `T/rfc284-t20-child-inheritance.test.ts`、`T/rfc103-launch-config-passthrough.test.ts`、`T/scheduler-subagent-live-capture-passthrough.test.ts` | `buildChildRuntime` 主体改从绑定文件读取（文本不变）；发起臂与续跑「只经 `buildChildRuntime(state)`」改为在绑定的 `launchWorkflow` / `launchWorkgroup` / `resumeChild` 三处断言；live-capture 的直传计数不含 calls，语料文件改为把绑定计入 picker 断言 |
| `T/rfc285-b3-inherited-actor.test.ts` | 「伪造 actor 归零」：绑定含 `delegatedCallActor` 定义与 `delegated.forCall({`，engine 发起臂各调用一次 `resolveActor` 并各判一次 `call-owner-inactive`；Q6：engine 续跑段（保留注释锚点）不调 `resolveActor`，绑定的 `resumeChild` 用 `buildChildRuntime(state)` |
| `T/rfc287-t8-run-row-prelude-single-source.test.ts` | L8 线签名改为 `async function runChildCallNode(`，源文件映射到新主体；五项表态不变 |
| `T/rfc287-t9-exemptions-and-extinction.test.ts` | calls 主体改指新文件，继续锁「不进 assembly、走 `createIsoUnderLock`」 |
| `T/rfc292-trigger-source-locks.test.ts` | 目标渲染断言改指 `CC/launchChildCall.ts`，仍要求传入任务的冻结 trigger context |
| `T/architecture/rfc395-checkpoint-boundary.test.ts` | 两个继承工作区站点（`const space = inheritedCallSpace({`）与挂载布局判定改从 `CC/launchChildCall.ts` 计数；不检查标量 / 目录别名的文件清单加入新主体与绑定 |
| `T/rfc395-a2-subject-call-closure.test.ts`、`T/single-nonroot-member-workspace.test.ts` | 直接调用改为经 `createChildCallNodeExecutionPorts(state)` 构造的执行器 / 主体；`inheritedCallSpace` 改从新 owner import |
| RFC-317 transition-table oracle | 偏离账本 `nodeMechanics.ts:running`（call 领养）改为新主体的 `:running`，offTable 不变；新增用例列出新主体的字面量站点（running / done）并断言 writer 为具名方法 |
| RFC-376 结构账本 | setInterval 站点 `nodeMechanics.ts#runCallWorkflowNode.obsTimer#setInterval#1` 改为新主体对应站点，计数不变；`N` → 其他 context 的精确文件边按实测重采 |
| RFC-334 node-executor boundary | 新目录自动纳入递归扫描；补本 RFC 的正反断言 |
| RFC-403 结构锁 | 不变；它的 `HELPERS` 不含本 RFC 的 helper |
| 新结构锁 `T/architecture/rfc404-child-call-executors.test.ts` | 见 §5 |
| `.github/workflows/windows-platform.yml` | push 与 pull_request 两份 `paths:` 加入新执行器、主体、端口、绑定与共享实现，删去旧委托壳；新测试按适用性加入 suite |
| `architecture/counts.json`、`commons-debt.json`、`guard-manifest.json`、`architectureReport.ts` | 完整候选完成后实测更新；只降不升；JSON 保持原序列化格式 |

## 5. 测试

- 新增结构锁 `T/architecture/rfc404-child-call-executors.test.ts`：两种 kind 的执行器在各自 registry key 目录并调用共享主体；`N` 中 calls 主体与
  全部 helper 不存在；旧委托壳与对它的引用不存在；新文件只 import 允许的层；`parseIsoSubmodules`、台账编解码、发起错误分类各只有一份 owner 且
  不被 re-export；`E` 以显式端口构造两个执行器。每项带负例。逐文件扫描按 `SourceUnit` 缓存，避免负例重复全量遍历（RFC-403 在 Windows
  超时的教训）。
- 端口绑定用例 `T/rfc404-port-bindings.test.ts`：`launchWorkflow` / `launchWorkgroup` 补上 `buildChildRuntime` 的 runtime 与 scheduler driver、
  不改写 engine 给出的字段；`resumeChild` 只传 taskId 与 runtime；`cancelChild` 的 cause 为 parent-cascade；`resolveActor` 对 NULL owner 返回
  无权限的历史投影、对非 NULL owner 走委托请求；`budget.ensureBudget` 用当前配置的上限。
- 共享实现用例：`encodeCallHumanWait` 与 `decodeCallHumanWait` 往返、键序与旧 `JSON.stringify` 输出逐字节一致；`childLaunchFailureCode` /
  `isToleratedChildCancelRace` 的正反例。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
