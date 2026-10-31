# RFC-402 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`。行号以 2026-10-31 研究时的源码为准，
实施时按源码定位。新路径与接口名为本设计的决定。

## 1. Part A：执行机制库 `TE/engine/kernel/`

### 1.1 文件与合同

| 新路径 | 导出 | 来源与边界 |
| --- | --- | --- |
| `engine/kernel/assembly.ts` | `runAssembly`、`AssemblySpec`、`ASSEMBLY_MAX_ATTEMPTS`、`PoolLike`、`IsoLike`、`MergeSkipKind`、`MergePhase`、`Disposition` | 从 `S/services/schedulerAssembly.ts` 原样迁入；不新增任务状态判断 |
| `engine/kernel/isolation.ts` | `createIsoUnderLock`、`persistIsoBase`、`persistIsoNodeTree` | 从 `TE/infrastructure/isolatedAgentRun.ts` 拆出；工作区、checkpoint / merge ledger、artifact 路径、effect 工厂、写锁都作为输入 |
| `engine/kernel/merge.ts` | `mergeBackAndSettle`、`markMergeFailed`、`MergeSettleOutcome` | 同上；保留 live / replay、checkpoint 顺序、原样抛出与短写锁窗口；`persistPendingSubResolves` 作为私有 helper 同迁；冲突解决是输入回调 |
| `engine/kernel/isolationCleanup.ts` | `discardNodeIso` | 从 `TE/infrastructure/isolationCleanup.ts` 迁入；cleanup 的参与条件由调用方传入，不再从 `composition/sqliteTaskExecutionContext` 读取 |
| `engine/kernel/isolationEffectRequest.ts` | 现有三个 request 构造函数 | 纯构造逻辑搬迁，字段、序列化与 hash 输入不变 |
| `engine/kernel/permits.ts` | `createExecutionPermitRegistry()`：worktree / question 写锁、`agent` / `script` / `code-host` 三类节点池、fanout 池的获取、resize 与空闲 GC | 合并三个 `services/` 文件的机制；各池与生命周期独立；Map 是实例闭包私有 |
| `engine/kernel/nodeRunLedger.ts` | `bindNodeRunLedger(...)`：`mintNodeRun`、`setNodeRunStatus`、`transitionNodeRunStatus`、`loadEnvelopeNonce` 等窄方法 | 绑定既有 lifecycle 端口与执行上下文（现状 helper 见 `nodeMechanics.ts:207`）；不复制 SQL，不拥有 run-row 选择策略 |

配套：

| 路径 | 作用 |
| --- | --- |
| `TE/application/ports/executionKernel.ts` | kernel 消费的窄合同：工作区、checkpoint / effect、冲突解决回调、ledger；具名方法，不收整个 `TaskExecutionPersistence` 或 `TaskMechanicsState` |
| `TE/application/ports/taskExecutionPermits.ts` | 许可注册表的消费合同；跨 context 消费者经 TE exact public 合同（`public/participants` 或 `public/types`）拿到它 |
| `S/platform/contracts/isolationWorkspace.ts` | 只抽出 native isolation 与 TE 端口共用的中立 DTO 类型定义（`IsoHandle`、`IsoRepo`、`MergeBackResult`、`DiscardLock` 等实际用到的），物理实现仍在 `platform/workspace/local/isolation.ts` 并改为 import 这里的定义 |
| `TE/infrastructure/isolationWorkspaceView.ts` | 保留 provider / native 转换；scope 选择改为显式构造参数，不再在未绑定时调用 `selectIsolationWorkspaceFactory()` |
| `TE/infrastructure/executionWorkspaceSession.ts` | 接收 factory 与 binding，承接 `composition/isolationWorkspaceScene.ts` 的惰性 Promise、identity 比较（factory identity + `JSON.stringify(binding)`）与失败清缓存；原文件删除 |

kernel 的 import 只允许：本模块 `domain/`、`application/ports/`、`engine/kernel/` 自身、`platform/contracts/`、`@agent-workflow/shared` 与
node 内建模块。kernel 不 import `TE/public/*`（避免 kernel → public → composition → kernel 的环）、`composition/`、`infrastructure/`、
`services/` 与 platform 的物理实现。

### 1.2 状态规则

| 现状 | 目标 |
| --- | --- |
| worktree / question / fanout 三组按 taskId 的模块级 Map（`services/taskWriteLocks.ts:23`、`taskFanoutPools.ts:31`） | 注册表实例私有；**每个 daemon scope 一个实例**，bootstrap 构造并注入所有消费者。今天共享这些 Map 的调用链（TE 引擎、COL 的 `taskQuestions.ts` / `taskQuestionDispatch.ts` / `clarify/autoDispatch.ts` / `gateWorkspaceRollbackExecutor.ts`、`TE/infrastructure/taskDeleteRecovery.ts`、`services/taskDelete.ts`）必须拿到同一实例；不得每次 drive、每个 executor 或每个 provider adapter 新建 |
| `WeakMap<daemonScope, pools>`（`processNodeConcurrency.ts:39`） | 进入同一注册表；保留 daemon scope identity、三池独立、任务启动 `seed-only` 与配置热更新 `set` 两种语义、原位 resize |
| 嵌套顺序与 GC | worktree 外层、question 内层；GC 只删完全空闲的实例（`taskWriteLocks.ts:51`、`:76`）；fanout 原位 resize 与空闲 GC（`taskFanoutPools.ts:54`、`:60`） |
| workspace scene / binding 旁表 | 选择哪个会话变成显式依赖；会话内可缓存 Promise，保持 lazy bind、复用与失败重试时机 |
| owner / context | 线程化现有 context 与 token；observer 在原 `beforeStart` / `beforeAct` 时点建立；kernel 不查全局 Map 猜 owner，不新建第二套 context 或 registry |
| assembly 局部变量、attempt 结果与 receipt | 保持调用私有 |

两种「任务锁」不能混用：`HumanGateTaskLockPort`（`collaboration/composition/required-ports.ts:11`）是数据库事务锁；许可注册表是进程内信号量。

### 1.3 改指

- 五个 assembly 调用点改 import `engine/kernel/assembly`（script 一处随 Part B 迁到 `engine/node/script/`）。
- 隔离 / 合并 / 清理的其余生产消费者：`TE/composition/nodeMechanics.ts`、`wrapperMechanics.ts`、`executionMergeRecovery.ts`（manual
  call-workflow 隔离、wrapper restore / rebuild、合并恢复）。
- `TE/public/participants.ts` 中现有的隔离实现转导出（约 `:431-446`）随消费者改指收回；不改成新的 kernel facade。
- `services/taskExecutionParticipants.ts` 的外部生产消费者（`services/task.ts`、`taskDelete.ts`、`commitPushRunner.ts`、`codeHost/call.ts`、
  `codeHost/recoveryProbe.ts`、COL `clarify/service.ts`、`review.ts`）改用已有的 exact public 合同；TE 自用点（`nodeMechanics.ts`、
  `taskEngineApplication.ts`）改用本模块 domain / ports。
- `services/nodeIsolation.ts` 的 28 个测试消费者与 `isolatedAgentRun` / assembly / 许可的直接测试消费者逐个改指真实 owner（native 操作与
  类型指向 platform 或 `platform/contracts`，TE 清理指向 kernel 或显式实例端口）。

## 2. Part B：script 节点 `TE/engine/node/script/`

### 2.1 文件

| 路径 | 内容 |
| --- | --- |
| `engine/node/script/scriptNodeExecutor.ts` | 实现 `NodeExecutor<'script'>`，调用同目录主体；删除旧 `engine/node/scriptNodeExecutor.ts`，不留 shim |
| `engine/node/script/runScriptNode.ts` | 输入、run-row 选择、interpreter、重试、assembly、合并 disposition |
| `engine/node/script/runOneScriptAttempt.ts` | 依赖安装、进程回调、输出、NodeRun / effect 结算 |
| `engine/node/script/types.ts` | attempt 输入 / 结果与 script 执行策略 |
| `TE/application/ports/scriptNodeExecution.ts` | 下表端口 |
| `TE/composition/nodeExecution.ts` | 仍负责实例装配与 registry map；script 项改为 `new ScriptNodeExecutor(explicitPorts)`，不再调用 `legacyArgs`；其余 kind 暂留旧接线 |

### 2.2 端口

| 端口 / 数据 | 职责 |
| --- | --- |
| `ScriptExecutionPolicy` / `ScriptTaskFacts` | 重试次数、两个超时、interpreter 覆写、content-home、fallback 工作区、Git author；signal 取自当前 request |
| `ScriptInputPort` | 上游输入与 consumed-input provenance（内部绑定 definition、parents、frame reader） |
| `ScriptRunLedger` | `resolveSchedulerRunRow`、`mintNodeRun`、`setNodeRunStatus`、nonce、appendEvent、upsertOutputs；事务参与方式不变 |
| `ScriptWorkspacePort` | 隔离创建、baseline / checkpoint、合并、丢弃（内部连接 kernel 与 provider adapter） |
| `ScriptProcessPort` | 复用 `TaskScriptRunFamily` 的 interpreter / content / deps / execute / receipt；`execute` 绑定为 `runScriptProcess` 方法（保持 RFC-328 守卫认得的 act callee） |
| `ScriptEffectPort` | 在原 `beforeStart` 时点创建进程 observer（`createProcessEffectAttemptObserver`），保留 beforeSpawn → receipt → settle |
| `ScriptOutputPort` | `extractScriptPorts({ node, rawStdout, nonce })`，装配注入现有实现 |
| `NodeStatusEvents` / `ExecutionDiagnostics` | 语义状态事件与隔离失败描述；WS payload 与 native 进程诊断留在 adapter |
| `MergeConflictResolver` | 绑定共享合并冲突解决；script 只传冲突与 run / node / frame 事实 |

`TaskMechanicsState` 中 script 用到的字段只有 `task`（Git author、task id / baseBranch）、`taskId`、`definition`、`opts`（9 项直接 + 隔离 1 项 +
合并解决 9 项）、`log`、`scriptSem`、`writeSem`、`containerOf`、`repos`、`scopeRoot`、`repoGroupName`（仅经合并解决）；其余 11 个字段不进入
script 端口。retry、进程回调、输出与结算主体全部在新目录，不是把 `executeScript(state, args)` 换名塞进端口。

### 2.3 共享 helper（只有一份）

| helper | 归属 |
| --- | --- |
| `resolveUpstreamInputs`（`nodeMechanics.ts:5206`，119 行） | `TE/application/nodeInputs.ts`；script 经 `ScriptInputPort` 使用，其余 node / wrapper 同时改指 |
| `resolveMergeConflicts`（`:1071`，148 行） | `TE/engine/node/shared/resolveMergeConflicts.ts`，显式 agent / runtime / template / workspace / ledger 端口；node、wrapper、合并恢复共用 |
| `broadcastNodeStatus`（`:5179`） | `TE/infrastructure/nodeStatusEvents.ts`，`node.status` payload 不变 |
| `describeIsoFailure`（`:994`） | infrastructure 诊断 adapter；native 进程树查询不进入 engine |
| `executionContextInput`、`setRunStatus`、`transitionRunStatus`、`mintRun` | 改为 `nodeRunLedger` 的绑定；新方法名见 §1.1 |
| `isolatedRunBinding`、scene / session | 明确的工作区 / ledger / effect 绑定；其余 mechanics 同时改用同一实例 |
| `prepareConsumedInputs` | script 经输入 / ledger 端口拿到同一编码结果，不从 engine import infrastructure，也不复制 codec |
| `runScriptWithFamily`（`composition/taskScriptRunFamily.ts`，9 行） | 删除；唯一调用点改为显式 family 方法绑定 |

## 3. 必须保持

| 不变量 | 证据 | 现有锁 |
| --- | --- | --- |
| 许可获取顺序、反向释放、释放先于清理；清理失败只 warn 不覆盖结果 | `schedulerAssembly.ts:192`、`:299` | `rfc287-t2-assembly-skeleton`、`rfc287-t1-release-before-discard` |
| 两种 persistBase 异常边界；默认 / L1 merge disposition；sticky keep 不被后续 phase 下调 | `schedulerAssembly.ts:197`、`:253` | assembly skeleton、`rfc287-t1-line-throw-disposition`、`merge-disposition-matrix`、`rfc287-t5-script-merge-throw` |
| script 一次持有 script 许可、每次重试换树；`preAttempt` 在 discard / create / mint 之前；永久失败不重试；retry index、frame、consumed inputs 不变 | `nodeMechanics.ts:2800`、`schedulerAssembly.ts:221` | assembly skeleton `:311`、`:389`；`rfc370-task-script-family`；`rfc287-t14-impl-gate-fixes` |
| create 的写窗口、generation 选择、beforeAct / create 顺序；merge 的 snapshot / persist → 写锁 → merge；replay 用已有 nodeTrees | `isolatedAgentRun.ts:117`、`:247` | `rfc188-isolated-agent-run`、`rfc356-iso-key-generations`、`rfc130-*`、`rfc144-stale-replay-regression`、`rfc210-*`、`rfc370-v3-interrupted-merge-recovery` |
| 进程 record-before-act，durable receipt 先于激活与输出 | `nodeMechanics.ts:3081`、`:3098` | `rfc253-script-execution`、`rfc370-process-effect-projection`、`rfc328-process-preactivation` |
| 同一 ownership token 贯穿 prepare / receipt / settle；unreaped 与 child-unkillable 留 recovery-required | `processEffectObserver.ts:89`、`:124` | `rfc328-durable-ownership`、`rfc359-w8-task-execution-recovery-conformance`、P0-1 / P0-2 |
| 取消与 daemon 中断区分；超时预算原值透传；依赖安装默认 10 分钟；合并 agent 在写窗口内、绕过节点池并收到 signal / timeout | `nodeMechanics.ts:2993`、`:3150`、`:1131`、`:1175` | script family 的 aborted / timeout、`rfc370-m1-hosted-script-family`、`rfc208-unbounded-git-and-permits` |
| 单输出的原始 stdout 字节；envelope 失败、inactive ports、截断失败；outputs 在 done 前；readonly merge-state 在 done 前 | `scriptPorts.ts:49`、`nodeMechanics.ts:3187`、`:3254` | `rfc253-script-execution`、`rfc276-readonly-script-stall-regression` |
| clarify park、passthrough、merge-conflict-human 各自 disposition（通用 assembly 仍服务支持 park 的其他线） | `schedulerAssembly.ts:40` | `rfc287-t1-merge-disposition-matrix`、`rfc313-session-escalation`、`rfc334-retry-contract` |
| 清理 receipt 的 provider 参与条件 | `sqliteTaskExecutionContext.ts:41` | `rfc370-isolation-cleanup-context` |
| 许可共享语义（同一 daemon scope 同一实例、嵌套顺序、空闲 GC、原位 resize） | §1.2 | `rfc098-write-lock-registry`、`process-node-concurrency`、`rfc266-*`、`rfc287-t10-quota-live-apply` |

## 4. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| `T/rfc328-architecture-guards.test.ts`：`TASK_EFFECT_BOUNDARIES`、`WORKER_MUTATION_CALLABLES` | isolation / cleanup / merge 路径改到 kernel；script 改到新 attempt 文件（callable `runOneScriptAttempt`，act `runScriptProcess`，observer `createProcessEffectAttemptObserver`）；`persistPendingSubResolves` 随 merge 改指；用删除 observer / 替换 act 的负例证明仍命中 |
| `T/architecture/rfc328TaskExecutionLedger.ts` 的 worker 分类 | 新 kernel / node 文件登记同一语义分类，不因旧 regex 搬走而少算写入站点 |
| `T/rfc284-spawn-site-ratchet.test.ts` | `services/schedulerAssembly.ts` 的 `not-a-spawn` 项（count 3）改为 kernel 路径，等价搬迁时仍为 3；不得靠改名隐藏站点 |
| `T/architecture/rfc317-transition-table-oracle.test.ts` | 新 ledger 方法用 `setNodeRunStatus` 等已识别名，逐条核对新识别的站点与表外边；不放宽为通用 `.set()` |
| `T/architecture/rfc334-node-executor-boundary.test.ts` | 改为递归扫描 `engine/`，加嵌套负例（services / composition / `TaskMechanicsState` 依赖被拒），语料下限按新文件数 |
| RFC-287 源码锁（`rfc287-t1-*`、`rfc287-t5-script-merge-throw`、`rfc287-t8-run-row-prelude-single-source`、`rfc287-t9-exemptions-and-extinction`、`rfc287-t14-impl-gate-fixes`）与 `process-node-concurrency`、`rfc253-script-execution`、`rfc208-*`、`rfc210-publish-failure-hard-fails`、`rfc200-source-lock` 等 | 新 node / attempt / kernel 文件分别纳入原断言；不把多文件拼成大字符串后降低断言 |
| `T/architecture/rfc395-checkpoint-boundary.test.ts` | 新 script、kernel、工作区会话纳入扫描；旧文件删除后才移出 |
| `architecture/counts.json`、`architecture/commons-debt.json`、`T/rfc294-architecture-preflight.test.ts`（隔离 public 闭包 13 条 + 清理 3 条签名债）、`rfc376-structural-guards` 基线、`T/architecture/architectureReport.ts` 映射、`architecture/commons-manifest.json`（`runassembly-assemblyspec`）、`architecture/guard-manifest.json` | 完整候选完成后实测更新；只降不升；不按推算预填 |
| `rfc399-context-dag-platform`、`rfc400-top-level-await-guard`、RFC-310 锁 | 不变；kernel / node 不成为 platform 的依赖，新文件不带入口块 |

`services/nodeRunMint.ts` 不移动，RFC-317 R1 / R2 中与它相关的条目不应消失；三个 facade 经 public 转导出，删除它们不推导出等量 R1 减少。

## 5. 测试

- 新增结构锁 `T/architecture/rfc402-task-execution-kernel.test.ts`：七个 `services/` 文件不存在且无引用；kernel import 白名单；script 执行器
  不引用 `TaskMechanicsState` / `legacyArgs` / `composition/` / `services/`；许可注册表无模块级单例、生产只在 bootstrap 构造；各项带负例。
- 许可注册表：同一实例共享、嵌套顺序、空闲 GC、原位 resize、`seed-only` 与 `set` 两种语义的行为用例（迁移既有用例为主）。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
