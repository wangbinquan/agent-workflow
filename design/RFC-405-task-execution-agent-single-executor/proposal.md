# RFC-405 task-execution agent-single 节点迁入 engine/node（RFC-294 S6，design §5.5 第 3 步之三）

- **状态**：Done（2026-11-01；AC-6 以后继 CI 证据关闭，见 plan「CI（AC-6）」）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。RFC-404 落库后转 In Progress 开始实施（两者都改 `nodeMechanics.ts`）。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.5 第 3 步
- **前序**：[RFC-403](../RFC-403-task-execution-small-leaf-executors/proposal.md)、[RFC-404](../RFC-404-task-execution-child-call-executors/proposal.md)
- **落位**：task-execution `engine/node/agent-single/`（执行器与主体）、`domain/`（重试与续跑判定）、`application/`（运行历史读取）、
  `application/ports`（窄合同）、`composition/`（端口绑定）

## 1. 背景

RFC-294 design §5.5 第 3 步依次迁 code-host、input / output、call-workflow / call-workgroup、agent、workgroup host。RFC-403、RFC-404 迁完了前三组。
本 RFC 迁 agent-single。

现状（行号以 RFC-404 落库后的 `N` = `TE/composition/nodeMechanics.ts` 为准，2496 行）：

- agent-single 经 `engine/node/agentNodeExecutor.ts` 的 `AgentSingleNodeExecutor` → `executeAgent` 委托 → `legacyArgs` → `N` 的
  `runAgentSingleNode`（`N:824-2170`，1347 行）执行。同一个执行器还经 `executeHost` 承接 workgroup host lane（RFC-406 的范围）。
- 主体分九段：代理身份与资源注入、借壳重复执行拒绝 → 上游输入 → 两维重试预算（同会话追问 / 换会话）→ review 与 clarify 通道上下文 →
  取行前奏 L4 → 重试形状（RFC-042 续跑、RFC-049 端口校验、RFC-313 会话升级、RFC-122 模式翻转）与重试前奏（铸 process-retry 行、抄 iso 列、
  审计事件）→ 单次 attempt（clarify 代际、会话模式与 inline 续跑、directive、clarify 队列、生效通道、prior output、runtime 冻结、`runNode`、
  会话 id 落库、session-not-found 告警、异常收尾、agent-run-settled 观察者）→ `runAssembly` 模式 B（一次许可 + 一棵 iso 贯穿全部 attempt、
  合并处置）→ 结局映射与 clarify 落库（self / cross）。
- 配套 helper：重试与续跑判定（`N:675-780`：`PreviousAttemptShape`、`decideEnvelopeFollowup`、`shouldRetryNodeFailure`、
  `FRAMEWORK_AUDIT_EVENT_PREFIX`、`countAgentTextEvents`）、运行历史读取（`N:2226-2496`：`composePriorOutputBlock`、
  `freshestPriorRunWithOutput`、`lineageCausesNewestFirst`、`priorDoneGenerationsForRun`、`readPriorAgentSessionId`、`readStderrText`、
  `recordClarifyInlineEvent`）。其中 `composePriorOutputBlock`、`freshestPriorRunWithOutput`、`shouldRetryNodeFailure` 还被
  `wrapperMechanics.ts`（fanout 分片 / 聚合）从 `N` 引用；`Binding` / `readBindings`（`N:2189-2225`）已无任何使用方。
- 主体直接调用 `services/` 的纯判定（`agentRefOfNode`、`findClarifyNode`、`computeRemaining`、`resolveEffectiveClarifyChannel`、
  `shouldInjectStopNotice`、`parsePortValidationFailuresJson`、`isClarifyRerunCause`、`continuesClarifyLineage`、`decideResumeSessionId`）与
  `getRuntimeDriver(...).detectSessionNotFound`。
- agent 线是 RFC-287 收编进 `runAssembly` 的五条装配线之一（L4，模式 B），迁目录时装配骨架、重试策略与合并处置的形状都不能变。

## 2. 目标

- **G1 agent-single 迁入 engine**：执行器与主体在 `engine/node/agent-single/`，经显式端口执行，不再经过 `legacyArgs` 或 `TaskMechanicsState`；
  `N` 中主体删除，`engine/node/agentNodeExecutor.ts` 迁入新目录后删除；`legacyArgs` 与 `OneNodeArgs` 随之消失（design §5.5 第 5 步退出门之一）。
- **G2 共享实现各一份**：重试与续跑判定归 domain（与 `decideRetryShape` 同文件），运行历史读取归 application，`wrapperMechanics.ts` 改指真实
  owner；死代码 `Binding` / `readBindings` 删除。
- **G3 跨 context 只走 exact 合同**：collaboration 的五项能力（借壳拒绝、review 上下文、clarify directive、clarify 队列、开 clarify 门）在一个
  消费端端口里集中派生；资源注入、runtime 绑定与 `runNode` family、agent-run-settled 观察者由 composition 绑定注入。
- **G4 守卫不缩**：按 `N` 路径或函数名取语料的守卫（RFC-287 T1 / T5 / T8 / T9、RFC-188、RFC-200、RFC-208、RFC-292、RFC-313、RFC-306、RFC-334、
  RFC-395、prior-output、clarify 系列等）精确改指并保留负例；Windows 两份 `paths:` 同步；账本按实测更新，只降不升。
- **G5 纯结构**：取行、预算、重试形状、审计事件、prompt 组装、会话续跑、runtime 冻结、装配窗口、合并处置、结局映射与 clarify 落库的顺序与
  文本都不变。

## 3. 非目标

- workgroup host（RFC-406）：`executeHost` 仍经现有 `legacyHostPort` 承接，本 RFC 只把它随执行器类一起搬目录。
- design §5.5 第 4、5 步（fanout 装配线、引擎编排、删除 `nodeMechanics.ts`、`TaskMechanicsState` 只留装配、协调器只在 bootstrap 构造）。
- `services/clarifyRounds`、`services/sessionModeFallback`、`services/nodeRunMint` 等纯判定的归属迁移（本次经端口注入）；`runNode` family、
  runtime driver、资源注入的实现改动。
- 安全相关改动。

## 4. 用户可见变化

无。HTTP / MCP / WS 合同、数据库结构、prompt 文本、发布二进制的行为均不变。

## 5. 验收标准

- **AC-1 迁移**：agent-single 的执行器与主体在 `engine/node/agent-single/`，只 import RFC-403 允许的层，不引用 `TaskMechanicsState`、`legacyArgs`；
  `nodeExecution.ts` 以显式端口构造执行器；`N` 中主体、`legacyArgs`、`OneNodeArgs`、旧执行器文件与 `readBindings` 不存在（结构锁锁定，含负例）。
- **AC-2 共享**：重试与续跑判定、运行历史读取各只有一份实现，`wrapperMechanics.ts` 与主体改指真实 owner，不留 re-export。
- **AC-3 行为不变**：RFC-287 T1 广播序列 / 合并处置矩阵 / 异常处置、T8 前奏矩阵、T9 装配线、RFC-042 / 049 续跑、RFC-313 会话升级、RFC-122 / 123
  clarify 开关、RFC-026 inline 续跑、RFC-119 / 131 prior output、RFC-200 envelope nonce、RFC-306 分支、RFC-366 观察者、clarify 落库与 P0 变异
  lane 全部通过，断言意图不变。
- **AC-4 守卫**：RFC-317 站点与偏离账本、RFC-328 账本与 worker 分类、RFC-376 结构账本、RFC-334 边界随 owner 改指；新结构锁覆盖执行器 / 主体
  owner、显式绑定、删除项与 helper owner，均带负例。
- **AC-5 账本**：`architecture/counts.json`、`commons-debt.json`、`guard-manifest.json`、`architectureReport.ts` 映射、Windows `paths:` 按完整
  候选实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一个主体文件，闭包状态不拆**：重试前奏、单次 attempt 与装配窗口共享十余个跨 attempt 的可变量（`nodeRunId`、`envelopeNonce`、续跑决策、
   重试形状、模式翻转观察值、`lastResult` 等），RFC-287 T7 正是按「闭包上的 let」写成的。本次原样搬进 `runAgentSingleNode.ts`，不另造状态对象，
   以免把结构迁移变成语义重写。
2. **执行器类搬目录、保留 host 委托**：`AgentSingleNodeExecutor` 迁到 `engine/node/agent-single/`，`execute` 改为直接调主体，`executeHost` 仍转交
   `WorkgroupHostExecutionPort`（RFC-406 再换实现）。
3. **`services/` 纯判定经端口注入**：与 RFC-403 对 code-host transport 的处理一致；engine 不 import `@/services`，归属迁移另立 RFC。
4. **task 级参数由绑定补齐**：`runNode` 的 memory / 会话租约 / runtime 注册表 / persistence / 观察调用 / live capture / signal 等 task 级字段由绑定
   填入，engine 只组装本节点的运行请求（与 RFC-404 的发起臂分工相同）。
5. **重试判定归 domain、历史读取归 application**：前者是纯函数，与 `decideRetryShape` 同属 `domain/envelopeRetryPolicy.ts`；后者读 persistence，
   落 `application/agentRunHistory.ts`，fanout 与主体共用。
6. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
