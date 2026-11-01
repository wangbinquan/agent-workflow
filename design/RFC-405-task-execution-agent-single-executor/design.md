# RFC-405 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`N` = `TE/composition/nodeMechanics.ts`，
`E` = `TE/composition/nodeExecution.ts`，`W` = `TE/composition/wrapperMechanics.ts`，`AS` = `TE/engine/node/agent-single`。行号以 RFC-404 落库后的 `N`
为准，实施时按源码定位。形状沿用 RFC-402～404：executor 接收 `NodeStepRequest`、返回 `NodeStepOutcome`，主体在 engine，composition 只装配现有
接收者、上下文、配置与平台适配。

## 1. 文件与端口

### 1.1 文件

| 角色 | 文件 |
| --- | --- |
| 执行器 | `AS/agentSingleNodeExecutor.ts`：`AgentSingleNodeExecutor`（由 `TE/engine/node/agentNodeExecutor.ts` 迁入；`execute` 直接调主体，`executeHost` 仍转交 `WorkgroupHostExecutionPort`） |
| 主体 | `AS/runAgentSingleNode.ts`：`N:824-2170` 原样迁入，闭包上的跨 attempt 状态、`decideFollowupForRetry`、`prepareRetryAttempt`、`runOneAttempt` 与 `runAssembly` 调用保持在同一函数内 |
| 端口 | `TE/application/ports/agentNodeExecution.ts`：`AgentNodeExecutionPorts`（见 §1.2） |
| 绑定 | `TE/composition/agentNodeExecution.ts`：`createAgentNodeExecutionPorts(state)` |

`E` 以 `new AgentSingleNodeExecutor(createAgentNodeExecutionPorts(state), legacyHostPort(state, mechanics))` 构造；`legacyArgs`、`OneNodeArgs` 删除。
旧文件 `TE/engine/node/agentNodeExecutor.ts` 删除，不留 shim。

### 1.2 端口分组

| 分组 | 内容 | 绑定到 |
| --- | --- | --- |
| `task` | taskId、definition、triggerContext、repos（mountPath / worktreePath）、repoPath、baseBranch、worktreePath、gitUserName / gitUserEmail、是否带平台输入挂载；全部 getter | `state.*` |
| `policy` | appHome、defaultPerNodeTimeoutMs、defaultNodeRetries、sessionRestartBudget、defaultRuntime、executionContext、signal；getter | `state.opts.*` |
| `resources` | `injection(agentId)` | `state.taskExecutionResources` |
| `collaboration` | `resolveBorrowForNode`、`buildReviewPromptContext`、`getNodeClarifyDirective`、`buildClarifyQueueContext`、`openAgentClarify`：由 COL exact 合同一次派生（`Pick<CollaborationRuntimeMechanics, …>`），不复制接口 | `state.opts.collaborationRuntime` |
| `rules` | `agentRefOfNode`、`findClarifyNode`、`computeRemaining`、`resolveEffectiveClarifyChannel`、`shouldInjectStopNotice`、`parsePortValidationFailuresJson`、`isClarifyRerunCause`、`continuesClarifyLineage`、`decideResumeSessionId` | `services/*` 现有实现 |
| `input` | 上游输入解析、consumed-input 编码 | 同 script / calls |
| `ledger` | `listNodeRuns`、`resolveSchedulerRunRow`、`mintNodeRun`、`transitionNodeRunStatus`、`loadEnvelopeNonce`、`read`、`patch`、`appendEvent`、`countAgentTextEvents`；上下文由绑定补 | `nodeRunLedger(state)` 与 `persistence.nodeExecution` |
| `history` | `priorDoneGenerationsForRun`、`lineageCausesNewestFirst`、`readPriorAgentSessionId`、`freshestPriorRunWithOutput`、`composePriorOutputBlock`、`readStderrText`、`recordClarifyInlineEvent`（persistence 由绑定预置） | `TE/application/agentRunHistory.ts` |
| `runtime` | `ofSession` / `resolve`（runtime 冻结）、`runAgent(request, launch)`（engine 组装本节点请求，绑定补 memory 快照 / 注入查询、会话租约、runtime 注册表、persistence、观察调用、live capture、signal）、`detectSessionNotFound(protocol, stderr)` | `state.opts.taskAgentRuns`、`runTaskAgentWithFamily`、`getRuntimeDriver` |
| `workspace` | `createIsoUnderLock`、`persistIsoBase`、`mergeBackAndSettle`（含 `extraForcedContainerPaths`）、`markMergeFailed`、`discardNodeIso`（同 script 端口），`portFilePaths → container 相对路径` | `engine/kernel/*`、`portFallbackMount` + `toContainerRelative` |
| `agentSem`、`observer`、`status`、`diagnostics`、`conflicts`、`log` | agent 池、agent-run-settled 观察者（缺省 NOOP）、节点状态广播、iso 失败诊断、合并冲突解析、日志 | 现有实现 |

- 端口合同只声明结构类型或引用 `TE/application/ports/*` 的既有类型（`RunResult`、`TaskAgentRun` 请求类型去掉 task 级字段），不 import `services/`、
  `infrastructure/` 或其他 context（COL 合同的 `Pick` 派生在端口模块内完成，同 RFC-403 的 `humanGateNodeExecution.ts`）。
- `runAssembly`、`nodeRunMintIdentityForSlot`、`nodeRunAttemptIndex`、`retryAttemptCap`、`decideRetryShape` 等本模块与 kernel / contracts 的实现
  直接 import，不进端口。

### 1.3 依赖规则

与 RFC-403 §1.2 相同：`AS` 下文件只 import 本模块 `domain/`、`application/`、`engine/kernel/`、`engine/node/shared/`、`platform/contracts/`、
`@agent-workflow/shared` 与 node 内建模块；不 import `composition/`、`infrastructure/`、`services/`、`TE/public/*`、`@/util/*`、其他 context 或第三方包。
主体里 `err instanceof ConflictError` 的借壳拒绝判定改由 application 的一个小函数承担（同 RFC-404 `childCallErrors.ts` 的做法）。

## 2. 共享实现（只有一份）

| helper | 现位置 | 归属 | 消费者 |
| --- | --- | --- | --- |
| `PreviousAttemptShape`、`EnvelopeFollowupDecision`、`decideEnvelopeFollowup`、`shouldRetryNodeFailure`、`FRAMEWORK_AUDIT_EVENT_PREFIX` | `N:675-780` | `TE/domain/envelopeRetryPolicy.ts`（与 `decideRetryShape`、`EnvelopeFollowupOutcome` 同文件） | 主体、`W`、相关用例 |
| `countAgentTextEvents` | `N:744-749` | `TE/application/agentRunHistory.ts` | 主体（经 `ledger` / `history`）、RFC-313 用例 |
| `composePriorOutputBlock`、`freshestPriorRunWithOutput`、`lineageCausesNewestFirst`、`priorDoneGenerationsForRun`、`readPriorAgentSessionId`、`readStderrText`、`recordClarifyInlineEvent` | `N:2226-2496` | `TE/application/agentRunHistory.ts` | 主体、`W`、prior-output 与 picker 用例 |
| 借壳拒绝判定 | `N:859-866` 的 `ConflictError` 分支 | `TE/application/agentNodeErrors.ts` | 主体 |
| `Binding`、`readBindings` | `N:2189-2225` | 删除（无使用方） | — |

## 3. 必须保持

| 不变量 | 证据 | 现有锁 / 用例 |
| --- | --- | --- |
| 身份与注入：缺 canonical agentId → `agent-identity-missing`；非 id 引用 / 注入报 not-found → `agent-not-found`（摘要文本不变）；借壳重复执行以 ConflictError 的 code 作节点失败，不让 scope tick 抛出 | `N:832-867` | RFC-271 T6d 用例、借壳用例 |
| 两维预算：`followupBudget = defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET`，`restartBudget = sessionRestartBudget ?? DEFAULT_SESSION_RESTART_BUDGET`，`maxRetries = retryAttemptCap(...) - 1` | `N:908-910` | `rfc313-session-escalation` |
| 取行前奏 L4：继承 review iteration、清 agent override、追 retryIndex、广播 pending 与 canceled、无 preResolve；envelope nonce 在取行后加载 | `N:944-978` | `rfc287-t8-run-row-prelude-single-source`、`rfc200-source-lock` |
| 重试形状：RFC-042 五条判据（排除 `[rfc` 前缀的框架审计事件）→ RFC-313 链长 / 升级预算 → RFC-122 / 313 P1-1 模式翻转抑制升级；续跑留树、换会话丢树；`pendingRestartReason` 单写者 | `N:1047-1119` | `scheduler-envelope-followup-branch`、`scheduler-port-validation-followup-decide`、`rfc313-*`、`rfc092-followup-chain-rollback` |
| 重试前奏：按当前 slot 身份铸 `process-retry` 行（续跑时沿用 nonce）、抄 iso 列、广播 pending；`[rfc049/port-validation-followup]`（逐端口）/ `[rfc042/envelope-followup]` / `[rfc313/session-restart]` 审计事件写在新行上，载荷文本不变 | `N:1125-1232` | `rfc313-source-locks`、续跑用例 |
| 单次 attempt：clarify 代际按 id 序推导；会话模式取 cross 节点优先；inline 续跑只在 clarify rerun 首轮；directive 每轮重读；clarify 队列（inline 时只给增量）；生效通道按 lineage；stopped > optional > mandatory / suppressed；模式翻转绕开续跑 prompt 与会话；prior output 在 inline 时跳过、iterate 时只给目标端口；runtime 按会话继承冻结；`runNode` 请求字段与顺序不变；会话 id 落库；inline 失败时按 driver 能力判 session-not-found；异常收尾 `mark-failed`（`scheduler-node-threw`）；每轮广播结局并通知 agent-run-settled（done / failed，best-effort） | `N:1240-1857` | `rfc098-rerun-cause-gates`、`rfc123-*`、`rerun-prior-output-*`、`rfc131-*`、`runner-*`、`rfc366` 用例 |
| 装配窗口（模式 B）：`pools: [agentSem]`；iso 在窗口内建与持久化（`persistBase: 'in-window'`）；建树失败以 `iso-setup-failed` + 结构化诊断结算；`shouldRetry` 三条判据；`keepIf` 即续跑决策；换树失败回 `iso-recreate-failed`；`keepFromOutcome` 看 `processUnreaped`；合并相位 park / not-done / passthrough / merge；冲突转 awaiting_human；抛出走骨架默认处置并改写结局为 `merge-back-failed`；丢弃 iso | `N:1859-2043` | `rfc287-t1-merge-disposition-matrix`、`rfc287-t1-line-throw-disposition`、`rfc287-t1-discard-failure-paths`、`rfc287-t9-exemptions-and-extinction`、`rfc188-isolated-agent-run`、`rfc208-unbounded-git-and-permits`、`rfc210-publish-failure-hard-fails` |
| 结局与 clarify 落库：无结果 / canceled / 未 done（带 `processUnreaped`）的映射；cross 优先于 self；park 行落在提问 run 的 frame；self 的 iteration 为提问代际；无通道时 `clarify-no-channel` | `N:2044-2169` | `clarify-prompt-wire-up`、`rfc334-node-executor-boundary`、cross / self clarify 用例 |
| 惰性读取：signal、预算、默认 runtime、runtime 绑定、collaboration runtime 在调用时读取 | 全文 | 行为用例与实现门核对 |

## 4. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| RFC-287 T1（广播序列、合并处置矩阵、异常处置、discard 失败路径）、T5、T8、T9 | `runAgentSingleNode` 签名不变，`bodyOf` / 语料改从 `AS/runAgentSingleNode.ts` 取（`executionMechanismSources.ts` 增常量并并入 `LEAF_NODE_SOURCES`）；T8 L4 线、T9 迁移线表态不变 |
| RFC-188、RFC-208、RFC-292、RFC-345、RFC-282 B2、RFC-123 directive 单源 | 经 `LEAF_NODE_SOURCES` 自动覆盖新主体；计数与邻接断言按实测核对，不放宽（RFC-188 的 createIsoUnderLock / mergeBackAndSettle / markMergeFailed 计数应不变） |
| RFC-200、RFC-210、RFC-313 source locks、prior-output source guards、cross-clarify baseline | 读 `N` 的锚点改读新主体或 `agentRunHistory.ts`；`[rfc` 前缀三处 producer 一致性改在新主体上断言 |
| `clarify-prompt-wire-up`、RFC-334 | `collaboration.openAgentClarify(` 计数拆为新主体 2 处 + `N` 的 host 1 处；`satisfies CollaborationNodeGatePort` 绑定锚点随 `E` 核对 |
| 直接 import `N` helper 的用例（9 个：rerun-prior-output-injection、rfc123-stop-enforcement、rfc287-t1-line-throw-disposition、rfc313-session-escalation、rfc374-node-run-pickers、rfc395-a3-sites-b、rfc395-w2fix-nb-regressions、scheduler-envelope-followup-branch、scheduler-port-validation-followup-decide） | 改从 `domain/envelopeRetryPolicy.ts` / `application/agentRunHistory.ts` import，断言不变 |
| RFC-395 selection ledger（`T/fixtures/rfc395-selection-semantics-ledger.json`） | 历史读取函数的 file / symbol 改指 `agentRunHistory.ts` |
| RFC-317 transition oracle | 主体与历史读取里的字面量 `setNodeRunStatus` / `transitionNodeRunStatus` 站点随 owner 改指；偏离账本按实测核对 |
| RFC-328 账本与 worker 分类、RFC-376 结构账本 | 新主体、执行器、绑定纳入 worker 分类；`N` → collaboration 的文件边随之变化按实测重采 |
| RFC-403 / RFC-404 结构锁 | 负例里的 `OneNodeArgs` 仍作为禁用名保留（它在 leaf 中出现即违规），`legacy-body` 清单不变 |
| 新结构锁 `T/architecture/rfc405-agent-single-executor.test.ts` | 见 §5 |
| `.github/workflows/windows-platform.yml` | 两份 `paths:` 加入新执行器、主体、端口、绑定与共享实现，删去 `engine/node/agentNodeExecutor.ts`；新测试按适用性加入 suite |
| `architecture/counts.json`、`commons-debt.json`、`guard-manifest.json`、`architectureReport.ts` | 完整候选完成后实测更新；只降不升 |

## 5. 测试

- 新增结构锁 `T/architecture/rfc405-agent-single-executor.test.ts`：执行器在 `AS/` 并直接调主体、`executeHost` 只转交 host 端口；`N` 中主体与全部
  helper、`legacyArgs`、`OneNodeArgs`、`readBindings`、旧执行器文件不存在；`AS` 只 import 允许的层；共享 helper 各一个 owner 且不被 re-export；
  `E` 以显式端口构造执行器。每项带负例；逐文件扫描按 `SourceUnit` 缓存。
- 端口绑定用例 `T/rfc405-port-bindings.test.ts`：`runtime.runAgent` 只补 task 级字段、不改写 engine 给出的请求；collaboration 五项原样转交并带上下文；
  `history` 预置当前 persistence；`workspace` 的额外 forced paths 按 `portFallbackMount` 换算。
- 共享实现用例：`decideEnvelopeFollowup` / `shouldRetryNodeFailure` 的既有真值表改从 domain import；借壳拒绝判定的正反例。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图。
