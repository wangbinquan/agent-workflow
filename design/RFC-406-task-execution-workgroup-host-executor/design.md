# RFC-406 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`N` = `TE/composition/nodeMechanics.ts`，
`E` = `TE/composition/nodeExecution.ts`，`AS` = `TE/engine/node/agent-single`，`P` = `TE/application/ports/agentNodeExecution.ts`，
`B` = `TE/composition/agentNodeExecution.ts`。行号以 RFC-405 落库后的 `N`（598 行）为准，实施时按源码定位。形状沿用 RFC-402～405：主体在 engine，
composition 只装配现有接收者、上下文、配置与平台适配；端口只用 task-execution 自有的结构类型（RFC-405 实施记录）。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| host 主体 | `AS/runWorkgroupHost.ts`：`N:49-548` 原样迁入，改名 `runWorkgroupHost(ports, request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult>`，原 `req` 即 `request.host`。`legacyHostPort` 原先把 `hostOutputPorts` 复制成可变数组再传入，主体只读它（投影时本来就再复制一次），改为直接读 |
| 执行器 | `AS/agentSingleNodeExecutor.ts`：构造参数只剩 `ports`，`executeHost` 直接调 `runWorkgroupHost(this.ports, request)` |
| 端口 | `P`：在 `AgentNodeExecutionPorts` 上补 host 才用的能力（§1.2） |
| 绑定 | `B`：补对应实现 |
| 引擎钩子 | `E`：`legacyHostPort` 删除；`buildWorkgroupEngineSupport`（`N:550-575`）并入 `E`，作为 `buildNodeExecutionWorkgroupHooks` 用的私有函数 |
| 别名 | `wrapperMechanics.ts`、`wrapperRunLifecycle.ts`、`executionMergeRecovery.ts` 改用 `TaskMechanicsState`（`@/services/execution/taskMechanicsState`）与 `NodeMechanicsResult` |
| 删除 | `N`（含尾部描述已迁走代码的注释） |

### 1.2 端口增补

| 分组 | 新增 | 绑定到 |
| --- | --- | --- |
| `task` | `repoMounts`：canonical 仓库的 mountPath 列表（host 的 `templateMeta.repos` 用它覆盖 iso 的 mountPath，RFC-248） | `state.repos` |
| `resources` | `hostInjection(agent)`：orchestrator 走合成注入，其余走资源会话（原 `N:55-58` 的分支） | `resolveSyntheticTaskAgentInjection` + `state.taskExecutionResources` |
| `collaboration` | `isTaskClarifySuppressed`、`dismissOpenClarifyParksForAutonomous`（结构类型） | `state.opts.collaborationRuntime` |
| `ledger` | `setNodeRunStatus`（含 `allowTerminal`；执行上下文由绑定补） | `nodeRunLedger(state)` |
| `workspace` | `abandonMerge(nodeRunId, reason)`（执行上下文由绑定补）；`mergeBackAndSettle` 的 `extraForcedContainerPaths` 改为可选（host 不传） | `persistence.mergeStates.tryTransition`、`engine/kernel/merge` |
| `rules` | `clarifyForbiddenPrefix` | `services/envelope` 的 `CLARIFY_FORBIDDEN_PREFIX` |

其余能力沿用 RFC-405 的端口：`runtime.resolve` / `runAgent`（task 级运行字段由 `withTaskRunFields` 补）、`ledger.read`、`history.priorDoneGenerationsForRun`、
`workspace.createIsoUnderLock` / `persistIsoBase` / `discardNodeIso`、`conflicts`、`status`、`agentSem`、`log`、`policy.defaultRuntime` /
`defaultPerNodeTimeoutMs`、`collaboration.buildClarifyQueueContext` / `openAgentClarify`。`describeEffectError`、`runAssembly`、
`findClarifyNodeForAgent` 由主体直接 import。

### 1.3 依赖规则

与 RFC-405 相同：`AS` 下文件只 import 本模块 `domain/`、`application/`、`engine/kernel/`、`engine/node/shared/`、`platform/contracts/`、
`@agent-workflow/shared` 与 node 内建模块。

## 2. 必须保持

| 不变量 | 证据 | 现有锁 / 用例 |
| --- | --- | --- |
| 注入失败：pending → failed（`wg-injection-failed`，`errorMessage` 原文）、广播 failed、结果带原消息；orchestrator 走合成注入 | `N:55-74` | RFC-164、RFC-167 用例 |
| 装配：`pools: [agentSem]`；iso 以 host run id 建树，`persistBase: 'in-setup'`，passthrough 不持久化 base；建树失败为 `iso-setup-failed: <msg>` | `N:90-119` | RFC-287 T1 / T9（L1）、RFC-208 |
| spawn：runtime 冻结用 agent runtime + 默认 runtime、不继承；clarify 队列按 run shard（leader null → undefined）、iteration 0、带 envelope nonce；端口投影（outputs = hostOutputPorts、清 outputKinds）；运行请求字段与顺序（`triggerContext: null`、投影时不落库输出且不告警缺端口、`expandPromptTemplate: false`、protocol block、超时、`clarifyChannel` self / delegated、`clarifySuppressed` 的派发期下限与实时读、clarify Q&A、依赖与 MCP、`log`）；发起参数（iso 首仓或 worktree、material、runtime binding） | `N:120-281` | RFC-172、RFC-184、RFC-207、workgroup host 输出隔离 |
| 早退：`processUnreaped` 置 keep；广播结局；canceled；clarify 先查压制 → 晚到压制（done → failed，`allowTerminal`，`wg-clarify-suppressed-late`，failureCode `clarify-forbidden`，消息含丢弃题数）；无通道 `clarify-no-channel`；代际按 shard 计 done 代；self 门落在提问 run 的 frame；落库后再查压制、遣散成功才改判；`awaiting` 带题数；非 done 带 failureCode / processUnreaped | `N:282-438` | RFC-181、RFC-182、RFC-207、RFC-369 |
| 投影输出丢弃空串（仅投影时） | `N:444-449` | RFC-184 |
| 合并相位：早退 park（keep 取 keepHookIso）；非 passthrough 的 `discardWrites` abandon（`discard-writes`）后 done；passthrough settle；其余 merge；冲突 abandon（`wg-merge-conflict-unresolved`）且不保留、消息原文；抛出保留并重抛；未兜住的抛出记 error 并失败；丢弃 iso；settle 返回投影输出 | `N:451-547` | RFC-167、RFC-187 T8、RFC-210、RFC-287 T1 合并矩阵 |
| 引擎钩子：广播绑定任务 id；canonical delta 按每个有 base 的仓库求和，没有任何 base 时抛错 | `N:550-575` | RFC-187 §4 |
| 惰性读取：同 RFC-405 | 全文 | 行为用例与实现门核对 |

## 3. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| RFC-287 T1（广播序列、合并处置、异常处置、discard）、T9（L1 迁移线）、T14 / RFC-187（`wg-merge-conflict-unresolved`） | `bodyOf('async function runWorkgroupHost(')`，语料取 `AS/runWorkgroupHost.ts`（`executionMechanismSources.ts` 增常量并入 `LEAF_NODE_SOURCES`），表态不变 |
| 读 `N` 作语料或锚点的源码锁（RFC-164、167、181、188、208、292、345、282 B2、live capture、RFC-370 两份、prior-output、clarify 系列、`AGENT_MECHANICS_SOURCE` 等） | 改读 host 主体 / 绑定 / `E`；`AGENT_MECHANICS_SOURCE` 去掉 `N`、并入 host 主体；计数与邻接断言按实测核对，不放宽 |
| RFC-317 allowTerminal 账本、transition oracle 偏离账本（`N:failed`） | 站点随 host 主体迁到 `AS/runWorkgroupHost.ts`，条数与边不变 |
| RFC-294 offered-edge 债务账本、RFC-376 counts | `nodeMechanics.ts → collaboration` 一条销账（off-dag-offered-file-context-pairs 实测下降，max 不动） |
| RFC-403～405 结构锁 | 针对 `N` 内容的判据改为「`N` 不存在」并带负例（重建即红）；RFC-405 的执行器锚点改为两条 lane 直接调主体 |
| RFC-334 边界 | `collaboration.openAgentClarify(` 计数改为两条 lane 各自的主体；边界清单加 host 主体 |
| `.github/workflows/windows-platform.yml` | 两份 `paths:` 删去 `N`、加入 host 主体与新测试；suite 同步 |
| `architecture/counts.json`、`commons-debt.json`、`guard-manifest.json` | 完整候选完成后实测更新；只降不升 |

## 4. 测试

- 新增结构锁 `T/architecture/rfc406-workgroup-host-executor.test.ts`：`N` 不存在且不得重建；host 主体 owner 唯一；执行器两条 lane 都直接调主体、不再持
  host 端口；`legacyHostPort`、`SchedulerState`、`OneNodeResult` 不出现在生产源码；`AS` 只 import 允许的层。每项带负例，逐文件扫描按 `SourceUnit` 缓存。
- 端口绑定用例并入 `T/rfc405-port-bindings.test.ts`（或新增 `T/rfc406-port-bindings.test.ts`）：`hostInjection` 的两个分支；`setNodeRunStatus`、
  `abandonMerge` 带执行上下文；压制查询与遣散原样转交；`repoMounts` 调用时读取。
- 引擎钩子：`getCanonicalFilesChanged` 无 base 时抛错、多仓求和（随 `E` 迁移改指现有用例，缺则补）。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
