# RFC-403 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`N` = `TE/composition/nodeMechanics.ts`，
`E` = `TE/composition/nodeExecution.ts`，`W` = `TE/composition/wrapperMechanics.ts`。行号以提交 `da5ad65b8` 为准，实施时按源码定位。
新路径与接口名为本设计的决定；形状沿用 RFC-402 的 script 试点（executor 接收 `NodeStepRequest`、返回 `NodeStepOutcome`，主体在 engine，
composition 只装配现有接收者、上下文、配置与平台适配）。

## 1. 文件与端口

### 1.1 每种 kind

| kind | 新文件（`TE/engine/node/…`） | 端口（`TE/application/ports/…`） | 绑定（`TE/composition/…`） |
| --- | --- | --- | --- |
| code-host-call | `code-host-call/codeHostCallNodeExecutor.ts`、`code-host-call/runCodeHostCallNode.ts` | `codeHostNodeExecution.ts`：task / 配置事实（provider 连接解析、请求超时、响应上限、fetch、repoUrl / repoCount、workflowVersion、executionLineageId、triggerContext）、输入端口、run ledger（run-row 解析、具名 `setNodeRunStatus`、输出写入、run 读取）、effect（attempt 计划与 `createCodeHostEffectAttemptObserver`）、code-host 请求（`executeCodeHostCall`、`probeCodeHostMutation`、`resolveProjectFallback`）、code-host 节点池、状态事件、日志 | `codeHostNodeExecution.ts`：转发到 `services/codeHost/*`、`application/codeHostEffectObserver` 与 persistence；不保留恢复循环（循环在 engine 主体） |
| input | `input/inputNodeExecutor.ts`、`input/runInputNode.ts` | `virtualIoNodeExecution.ts` 中的 `InputNodeExecutionPorts`：task 输入、run identity 与 mint、状态事件 | `virtualIoNodeExecution.ts` |
| output | `output/outputNodeExecutor.ts`、`output/runOutputNode.ts` | 同文件 `OutputNodeExecutionPorts`：definition 与 frame 链读取、源 port 行读取、archive 复制、consumed-input 编码、run identity 与 mint、状态事件 | 同上；input / output 合同分开，不合成一个大 bag |
| review | `review/reviewNodeExecutor.ts`（主体直接构造请求） | `humanGateNodeExecution.ts` 中的 `ReviewNodeExecutionPorts`：review 的 task / 工作区事实（scopeRoot、repo mount、appHome）、由 COL exact 合同派生的 `dispatchReviewNode`，执行上下文由绑定线程化 | `humanGateNodeExecution.ts` |
| clarify | `clarify/clarifyNodeExecutor.ts`、`clarify/settleIdleClarify.ts` | 同文件 `ClarifyNodeExecutionPorts`：当前 frame 行查询、跳过行写入（经 §2.1 的共享实现）、状态事件、日志 | 同上 |
| clarify-cross-agent | `clarify-cross-agent/crossClarifyNodeExecutor.ts`、`clarify-cross-agent/runCrossClarifyNode.ts` | 同文件 `CrossClarifyNodeExecutionPorts`：definition、live-row 查询、mint 与具名 CAS、idle 结算（复用 clarify 的同一实现）、COL 的 directive 读取与 inspect 能力、状态事件 | 同上 |

- 旧委托壳 `engine/node/{codeHostCallNodeExecutor,virtualIoNodeExecutors,humanGateNodeExecutors}.ts` 删除，不留 shim；`E` 直接以显式端口
  构造新执行器。`CollaborationNodeGatePort` 只保留 agent 路径仍在用的 `openAgentClarify`（RFC-405 再处理），review / clarify / cross 三项
  从中移除。
- COL 所需合同在一个消费端端口模块中集中派生（不在每种人工门端口里各复制一份 COL 接口或 factory），并按实测核对 offered-edge 文件项。
- `legacyArgs` 与 `OneNodeArgs` 仍服务 calls / agent，本 RFC 不删除。

### 1.2 依赖规则

engine 下新文件只 import：本模块 `domain/`、`application/`（端口与 §2 的共享实现）、`engine/kernel/`、`engine/node/shared/`、`platform/contracts/`、
`@agent-workflow/shared` 与 node 内建模块；不 import `composition/`、`infrastructure/`、`services/`、`TE/public/*` 与其他 context。
跨 context 的值接收者（COL participant、code-host connection participant）由现有 bootstrap / composition 注入。

## 2. 共享实现（只有一份）

| helper | 现位置 | 归属 | 消费者 |
| --- | --- | --- | --- |
| `judgeBranchActivation`、`recordSkippedRun` | `N:2371-2530` | `TE/application/nodeBranchActivation.ts`；gateway 经端口调用（`TE/engine/node/nodeExecutionGateway.ts:25-37` 的 abort → 分支判定 → 执行器顺序不变） | 所有 kind；idle / cross clarify 复用跳过行写入 |
| `readPortRowAtFrame` | `N:4253-4307` | `TE/application/nodeInputs.ts`（与 `resolveUpstreamInputs` 同文件，各自选择口径不变） | output、`W`、直接测试 |
| `pickString` | `N:4309` | `TE/domain/nodeFields.ts` | input、code-host、calls、agent、`W` |
| `NodeStatusEvents`、`ExecutionDiagnostics` 合同 | `TE/application/ports/scriptNodeExecution.ts:125-150` | `TE/application/ports/nodeExecutionSupport.ts`（中立）；script 改为从这里 import | 全部新执行器与 script；实现仍在 `TE/infrastructure/{nodeStatusEvents,executionDiagnostics}.ts` |
| 具名 ledger、run-row 解析、consumed-input 编码、工作区会话 | RFC-402 已归位 | 复用，不复制 | — |

`N` 中剩余的 calls / agent / host 以及 `W`、`executionMergeRecovery.ts` 改为直接引用真实 owner，不经 `N` 转导出。

## 3. 必须保持

| 不变量 | 证据 | 现有锁 |
| --- | --- | --- |
| 所有 kind：gateway abort → 分支判定 → 执行器；关闭分支结算 skipped 并保留 consumed provenance；review / clarify 不绕过分支判定 | `nodeExecutionGateway.ts:25-37`、`N:2371-2530` | `rfc306-scheduler-branch`、`rfc354-clarify-idle-skip` |
| run-row 前奏四线五项差异（code-host：不继承 review iteration、不清 agent override、不追 retryIndex、不广播 pending、不预解析 adoption；canceled 仍广播） | `N:2063-2085` | `rfc287-t8-run-row-prelude-single-source`（四线 × 五项矩阵，逐实际 owner 检查） |
| code-host 顺序：参数校验 → 上游输入 → run-row → running 写入与广播 → 连接解析（未配置即失败结算）→ timeout（节点覆写优先）→ 稳定 effect family / generation 与观察者 → 节点池 → send / probe 循环 → 释放 → 输出与终态 → 广播 | `N:2026-2334` | `rfc269-code-host-execution`、`rfc269-code-host-wiring-2026-08-10` |
| code-host 恢复：观察者按每次 HTTP send 记账；request hash、slot path、stable action ordinal、retained generation 不变；probe 判定已应用时合成原成功结果；只有 `retry-authorized` 才重发；已有 ambiguity 不被后续确定失败抹掉；终态优先 `settleTerminal`，回退时先输出后 done | `N:2147-2334`、`TE/application/codeHostEffectObserver.ts:83-263` | `rfc328-codehost-attempt-ledger` |
| code-host 不进 `runAssembly`、没有节点级重试，只取 code-host 节点池 | `N:2218` | `rfc287-t9-exemptions-and-extinction` |
| input：缺 `inputKey` 直接失败；缺输入值为空字符串；一次 mint 同时提交 done 行与输出，再广播 | `N:2676-2713` | 输入相关用例、`rfc287-t1-broadcast-sequence` |
| output：只收 `boundary === undefined` 的入边；lexical frame 解析、边界错误码在 mint 前；保留源 run provenance、archive、kind、active；单次 mint done 行与输出后再广播 | `N:2580-2674` | `rfc096-port-read-done-only`、`rfc395-a3-sites-a`、`rfc354-nested-frames-closure`、`rfc354-nested-failure-modes` |
| review：原始 definition / node / frame、scopeRoot、repo mount 与显式执行上下文进入 COL；原样返回执行 / park 结果 | `N:2715-2734` | `rfc370-review-explicit-execution-context`、`rfc370-port-artifact-bindings` |
| idle clarify：已有 pending / running / awaiting_human / awaiting_review 时不补 skipped 行，否则经共享跳过实现结算 | `N:2539-2578` | `rfc354-clarify-idle-skip` |
| cross clarify：缺 questioner 时 mint pending 后 `pending→failed`；持久 stop 与 stop 竞争取消 `pending→canceled`；live-row 防重仍按 task / node / iteration（不加 containerRunId 条件）；空闲路径回到唯一 idle 实现 | `N:2736-2880` | `scheduler-cross-clarify-no-runaway`、`scheduler-cross-clarify-dispatch`、`cross-clarify-stop-directive-scoped-to-cci-rerun` |
| 惰性读取时机：连接、runtime、工作区 factory、directive 在调用时读取，不提前冻结到 gateway 构造时 | `N:2120-2121` | 迁移后由行为用例与实现门核对 |
| 工作区会话仍按 mechanics state 对象选择（RFC-402 已接受的偏差） | `TE/composition/executionWorkspaceBinding.ts:5-41` | `rfc402-task-execution-kernel` |

## 4. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| RFC-328 effect 账本（`T/architecture/rfc328TaskExecutionLedger.ts`） | code-host 观察者调用移到 `engine/node/code-host-call/runCodeHostCallNode.ts` 的端口调用：按 RFC-402 对 script / kernel 的做法精确识别该 receiver / callee 为原站点；composition 绑定只允许补 persistence / context、原样转发策略，不另计站点；保留 resource-key、generation、per-send 分类；负例（改写策略、删观察者、删 act）进 RFC-403 结构锁 |
| RFC-328 act 边界（`T/rfc328-architecture-guards.test.ts` 的 `TASK_EFFECT_BOUNDARIES`）与 worker 分类 regex | `runCodeHostCallNode` 的 `executeCodeHostCall` / 观察者条目改到新主体；新 leaf 与绑定纳入分类，不落到未分类分支 |
| RFC-317 transition-table oracle | code-host `2088`、cross `2793`、`2858` 三个字面量 `setNodeRunStatus` 站点在新 owner 下仍被 `casSites` 识别；code-host 动态 settle（`2102`）保持动态；跳过实现的 `transitionNodeRunStatus`（`2475`、`2486`、`2518`）随归位；期望列表按 `file:line` 字符串序或在用例内显式按行号排序 |
| RFC-334 node-executor boundary | 新目录自动纳入递归扫描；补本 RFC 的 leaf 边界正反断言（新执行器不引用 `legacyArgs` / 旧主体 / `TaskMechanicsState`） |
| RFC-287（T1 广播与处置、T8 前奏矩阵、T9 例外、source-lock inventory） | 源码 helper 按「owner 文件 + 函数」取主体，不把多文件拼成大字符串后误匹配别的 kind；T8 四线中 code-host 一线改到新 owner；T9 继续锁「code-host 无节点重试、不进 assembly」 |
| RFC-292 trigger 锁 | code-host 的 `ctx: { ports: upstreamInputs, triggerContext: … }` 改到新主体，仍断言传入的是任务的冻结 trigger context |
| RFC-395（content / checkpoint / selection ledger） | `portFallbackMount` 的 review 使用位置改指；`readPortRowAtFrame` 归位后 selection ledger 的 file / symbol 同步 |
| RFC-370（port-artifact、review 显式上下文） | review dispatch 的精确接线改到新 owner 与绑定 |
| RFC-376 结构账本、RFC-294 offered-edge 基线 | `N` / `E` → COL 的精确文件边按新 owner 重采；不新建跨 context value 回边 |
| RFC-402 结构锁 | 保留 kernel / script 约束；新增 RFC-403 leaf 边界与 code-host effect 负例（可放新守卫 `T/architecture/rfc403-small-leaf-executors.test.ts`） |
| `.github/workflows/windows-platform.yml` | push 与 pull_request 两份 `paths:` 加入新 leaf / 端口 / 绑定 / 共享实现；`N` 仍有剩余主体时保留 `N` 项；适用的新测试加入 suite 命令 |
| `architecture/counts.json`、`commons-debt.json`、`guard-manifest.json`、`architectureReport.ts` | 完整候选完成后实测更新；只降不升；JSON 保持原序列化格式（只改实质字段） |

## 5. 测试

- 新增结构锁 `T/architecture/rfc403-small-leaf-executors.test.ts`：六种 kind 的执行器在 `engine/node/<key>/`、`N` 中对应主体不存在、
  新文件不引用 `legacyArgs` / `TaskMechanicsState` / `composition/` / `services/`、共享 helper 只有一份；code-host effect 站点识别与转发负例；
  各项带负例。
- 端口绑定用例：code-host 绑定把策略原样交给真实观察者并补上 persistence / context；review 绑定线程化执行上下文；不只测类转发。
- 搬迁涉及的既有用例只改 import、构造与源码锚点，不改断言意图；纯 helper 用例改指新 owner。
