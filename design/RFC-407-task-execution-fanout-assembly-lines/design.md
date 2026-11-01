# RFC-407 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`W` = `TE/composition/wrapperMechanics.ts`，
`AS` = `TE/engine/node/agent-single`，`P` = `TE/application/ports/agentNodeExecution.ts`，`B` = `TE/composition/agentNodeExecution.ts`。行号以
RFC-406 落库后的 `W`（1954 行）为准，实施时按源码定位。形状沿用 RFC-405 / 406：主体在 engine，composition 只装配；端口只用 task-execution 自有的
结构类型。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| 分片线 | `AS/runFanoutShard.ts`：`dispatchFanoutShard` / `dispatchFanoutShardAttempt`（`W:471-1089`，含 `DispatchShardArgs` 等局部类型）原样迁入，参数对象的 `state` 换成 `ports` |
| 聚合线 | `AS/runFanoutAggregator.ts`：`dispatchFanoutAggregator` / `dispatchFanoutAggregatorAttempt`（`W:1090-1616`）原样迁入，结果类型改用 domain 的 `NodeStepOutcome` |
| 端口实现 | `AS/fanoutAttempts.ts`：`createFanoutAttempts(ports, log): FanoutAttemptPort`（原 `W` 内 `fanoutAttempts` 对象的参数整理与子 logger 命名搬入） |
| 源端口 kind | `sourcePortKindOf`（`W:1937-1954`）原样迁入 `B` 并导出：分片线经 `resources.sourcePortKind` 读取，`W` 的 data 绑定直接 import（`W` 本就依赖 `B`，无环；`B` 本就 import 它用到的两个 `services/` 模块，不新增文件边） |
| 端口 | `P`：补 fanout 能力（§1.2） |
| 绑定 | `B`：补对应实现；`W` 的 `createWrapperMechanicsPorts` 以 `createFanoutAttempts(createAgentNodeExecutionPorts(state), executionLog)` 构造 `fanoutAttempts` |

`fanoutInnerAgentKey`、data / scopeDriver / workspace 绑定与 git wrapper 的工作区 helper 留在 `W`。

### 1.2 端口增补

| 分组 | 新增 | 绑定到 |
| --- | --- | --- |
| 顶层 | `subprocessSem` | `state.subprocessSem`（getter，访问时读取） |
| `ledger` | `listOutputs`、`shardSet`（候选行选择读取） | `persistence.nodeExecution.listOutputs`、`persistence.selection.shardSet` |
| `workspace` | `completeInterruptedMerge(run, log)`（RFC-370 中断合并补完）、`adoptedExecution(handle)`（是否接管了仍在执行的旧进程）、`undoShard(handle, input)`（RFC-130 D9 撤销到基线） | `composition/executionMergeRecovery`；后两者读 `infrastructure/isolationWorkspaceView` 的 `workspaceRecord(handle)` |
| `workspace` | `createIsoUnderLock` / `mergeBackAndSettle` / `markMergeFailed` / `discardNodeIso` 增加可选 `log` | 各线传自己的子 logger，缺省为任务 logger（与迁移前一致） |
| `resources` | `sourcePortKind(nodeId, portName)` | `B` 的 `sourcePortKindOf` |
| `rules` | `shardValueHash`（RFC-098 B3 跨代复用身份） | `util/hash` 的 `sha256Hex` |

`workspaceRecord` 不整个暴露给 engine：两条线只需要「是否接管」与「撤销」两种语义能力，端口按语义给出，engine 不接触工作区记录的形状。

其余能力沿用 RFC-405 / 406 的端口：`runtime.resolve` / `runAgent`、`ledger.mintNodeRun` / `setNodeRunStatus` / `read` / `patch` / `list`、
`history.freshestPriorRunWithOutput` / `composePriorOutputBlock`、`workspace.createIsoUnderLock` / `persistIsoBase` / `mergeBackAndSettle` /
`markMergeFailed` / `abandonMerge` / `discardNodeIso` / `portFileContainerPaths`、`conflicts`、`status`、`resources.injection`、`agentSem`、`log`、
`policy`。`computeShardScope`、`taskCheckpointRefs`、`nodeRunAttemptIndex`、`nodeRunMintIdentityForSlot`、`shouldRetryNodeFailure`、
`describeEffectError`、`pickString`、`runAssembly` 由主体直接 import。

### 1.3 依赖规则

与 RFC-405 相同：`AS` 下文件只 import 本模块 `domain/`、`application/`、`engine/kernel/`、`engine/node/shared/`、`platform/contracts/`、
`@agent-workflow/shared` 与 node 内建模块。

## 2. 必须保持

| 不变量 | 证据 | 现有锁 / 用例 |
| --- | --- | --- |
| 外层重试：全局预算（`defaultNodeRetries` 或协议默认）、只对带重试载荷且可重试的失败重试、重试轮禁复用并铸新 process-retry 行 | `W:525-544`、`W:1090-1111` | RFC-094 / 287 T1 异常处置、scheduler-default-retries |
| 候选行：跨代按 (task, node, iteration, shard) 锚定、值哈希复用、中断合并补完后才可复用、rerun-in-place、撤销基线、铸行身份与 retryIndex | `W:561-711`、`W:1203-1303` | RFC-098 B3、RFC-130 D9、RFC-370、node-run-mint |
| 输入：广播输入在前、分片值注入源端口；边界端口 kind；聚合按 shard 收集 done 行并记录参与行 | `W:713-757`、`W:1119-1201` | RFC-060、RFC-103、RFC-354 |
| 注入失败、prior output（仅聚合，RFC-119 D9） | `W:759-777`、`W:1305-1357` | RFC-119、rerun-prior-output |
| 装配：两池、iso 在 setup 持久化、合并相位与处置（冲突 abandon 且不保留、抛出保留并标记合并失败）、未兜住的抛出改判为带重试载荷的失败、processUnreaped 保留 iso | `W:779-1088`、`W:1358-1616` | RFC-287 T1 / T3 / T4 / T14、RFC-188、RFC-208 |
| 惰性读取：同 RFC-405 | 全文 | 行为用例与实现门核对 |

## 3. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| RFC-287 T1 / T3 / T4 / T9 / T14（`bodyOf('async function dispatchFanout…')`、`WRAPPER_MECHANICS` 语料） | 语料加入两条线的新文件（`executionMechanismSources.ts` 增常量并入 `LEAF_NODE_SOURCES`），签名锚点不变 |
| 按 `W` 路径取语料的源码锁（RFC-188 计数、RFC-208、RFC-066 / 067、RFC-292、RFC-345 / 282 B2 的注入计数、live capture、RFC-370 发起点等） | 改读新 owner 或并入语料；计数按实测核对，不放宽 |
| 按显式文件清单做缺席扫描的守卫（RFC-395 checkpoint 边界等） | 把两条线的新文件加进清单 |
| RFC-317 allowTerminal 账本、transition oracle 偏离账本（`wrapperMechanics.ts:pending`） | 站点随主体迁移，条数与边不变 |
| RFC-334 边界、RFC-376 counts、commons-debt、guard-manifest、Windows paths | 随 owner 改指，按实测更新，只降不升 |

## 4. 测试

- 新增结构锁 `T/architecture/rfc407-fanout-assembly-lines.test.ts`：两条线与 `createFanoutAttempts` 的 owner 唯一、在 `AS`；`W` 中不再有
  `dispatchFanout*`；`createWrapperMechanicsPorts` 以端口绑定构造 `fanoutAttempts`；每项带负例，逐文件扫描按 `SourceUnit` 缓存。
- 端口绑定用例 `T/rfc407-port-bindings.test.ts`：`listOutputs` / `shardSet` 原样转交且读调用时的 persistence；`subprocessSem` 访问时读取；
  `shardValueHash` 即 `sha256Hex`；`sourcePortKind` 的 agent / 非 agent / 缺节点 / 解析失败四种分支；`adoptedExecution` / `undoShard` 读句柄登记的
  工作区记录；`completeInterruptedMerge` 与可选 `log` 的委托形状。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
