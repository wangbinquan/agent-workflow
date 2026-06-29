# RFC-122 技术设计 — clarify directive toggle

## 接口核实（PHASE 0，源码引用）
- `hasPersistentStop`（`crossClarify.ts:1064`）读 `cross_clarify_sessions` 的 `directive='stop'`，在**cross 节点**dispatch 读（`scheduler.ts:1689`）——键在 cross 节点、非提问 agent，故是**并行**机制、不在其上扩展。
- 强制 ask-back 在**提问 agent dispatch**由 `effectiveHasClarifyChannel`（`scheduler.ts:2440`）门控，threaded → `runNode` → `renderUserPrompt`（`shared/prompt.ts:579`）：true 追加强制 ask-back 块、false 走输出协议。STOP CLARIFYING 文案来自 `renderClarifyDirectiveTrailer('stop')`（`shared/clarify.ts:277`），由 `buildPromptContext`（`clarifyRounds.ts:392`）烘进 `answersBlock`（首跑无 prior 轮时返 undefined）。
- `agentHasClarifyChannel` **同时覆盖 self 与 cross-questioner**（都接同一 `__clarify__` 源口，`clarify.ts:345` vs `:640`），故调度器可在已算的 `hasClarifyChannel` 上门控开关读取。

## 数据
新表 `task_node_clarify_directives(task_id, node_id, directive, set_by, updated_at)`，PK `(task_id,node_id)`，FK task ON DELETE cascade（migration `0064`，statement-breakpoint）。缺行 ⇒ `continue`（golden-lock）。`set_by` = 任务成员 user id，**仅审计/UI**。

## 注入三缝（避免双注入 / 漏注入）
1. **effective-channel oracle**：抽纯函数 `resolveEffectiveClarifyChannel(hasClarifyChannel, nodeStopOverride)`（`clarifyRounds.ts`）——`stop` ⇒ 强制 false（self+cross 同口）；无 override ⇒ 复现 RFC-122 前布尔。
2. **首跑 STOP notice**：`renderUserPrompt` 新增 `clarifyStopNotice`（`prompt.ts`）——首跑（无 prior clarify 轮）时由调度器置，注入 STOP CLARIFYING。
3. **有 prior 轮 directiveOverride**：`buildPromptContext` 新增 `directiveOverride` 参数——有 prior clarify 轮时重建 trailer 为 stop。
- **per-attempt 读取**（Codex H1 fold）：`getNodeClarifyDirective` 在**每次尝试的 prompt-build 路径**读（retry 行 mint 后），非 `scheduleAgentNode` 调用一次——保证 retry 取最新。
- **review-rerun STOP 兜底**（Codex H2 fold）：live `nodeStopOverride='stop'` 时无论 `applyLatestDirective` 真假都强制 STOP 文案（恰一次），堵「review 重跑带 prior clarify 轮 + 开关 stop 却两路都漏注 STOP」缝。

## API
`POST/GET /api/tasks/:id/nodes/:nodeId/clarify-directive`（`routes/taskClarifyDirective.ts`，`services/taskClarifyDirective.ts`）：成员门控（任务成员）+ 校验 node 是提问 agent 节点（`isClarifyAskingNode` = `agentHasClarifyChannel || findCrossClarifyNodeForQuestioner`）+ ACL。GET 返当前 `(node_id→directive)` map 供画布回显。注册 `contracts/registry.ts`。

## 前端
`ClarifyDirectiveToggle.tsx`（画布节点），仅提问 agent 节点显（镜像 `questionCount` badge 线：per-node directive map → `CanvasNodeData` → `AgentNode`）；点击 POST + invalidate；`.segmented` 风格。`useTaskSync` WS/refetch 反映当前态。i18n zh/en 对称。

## 失败模式 / 测试策略
- golden-lock：无 override 行 ⇒ `resolveEffectiveClarifyChannel` 逐字复现旧布尔、无 STOP 注入、画布逐字不变（self + cross）。
- stop override：dispatch（首跑 + retry）压制 ask-back + 注入 STOP（恰一次）；retry 取最新；review 重跑带 prior 轮也注 STOP。
- 归属不进 prompt（`set_by` 仅库/UI）。
- route 鉴权（成员、提问节点校验、ACL、registry）。

## 已知限制（窄边角，立后续专项修 — 2026-06-29 用户拍板「先上线」）
**残留**：mode-flip（开关在某次重试窗口翻转）走 same-session followup 时，**rollback-to-pre_snapshot + 重拍 pre-snapshot 未执行**（仍 gate 在 `followupDecision.followup`，scheduler.ts ~1976/~2100）。故一个 **writer 反问 agent**（`readonly:false`）attempt-0 改了工作区 + 以 followup-eligible envelope-format 错失败（干净退出 + 捕获 session + ≥1 text 事件，非崩溃）+ 中途翻开关 → attempt-1 在 attempt-0 **未回滚的脏工作区**上跑、潜在带走半成品改动。
**已缓解（已上线）**：facet-1 让 mode-flip 走**新 session**（`effectiveResumeSessionId` gate `followup && !clarifyModeFlip`，scheduler.ts ~2585）+ 全 prompt 路径（round-3）。残留仅「脏工作区未回滚」这一面。
**为何未当场修**：`clarifyModeFlip` 需 `effectiveHasClarifyChannel`（scheduler.ts:2480-2486，**真依赖** `clarifyContext.directive` = 最新已答轮 directive，需 post-mint shardKey/loopIter/clarifyGeneration/resumeDecision）→ 要在 rollback（mint 前）前算它，须把 mint 重排到 rollback 前（大改最敏感重试/快照/clarify-resume 核心）或在 2510 复制回滚+多仓 pre-snapshot+缺快照升级逻辑（drift / byte-identical 风险）→ 风险（广泛工作区损坏）> 该窄边角。属 CLAUDE.md「比看上去更纠缠 → STOP green」情形。
**不回退 round-3**：round-3 是**常见** followup（只读 / 未改写的 writer）的正确性修；回退使窄写边角变「响亮失败（无端口表）」却牺牲广泛正确性，net-worse（且 output→clarify 方向的脏工作区残留**本就 predates round-3**）。
**后续专项修配方**（独立 PR、单独评审，retry-path 专项）：抽 `buildPromptContext` 的 directive 解析为 loop-top 可调助手 → 在 rollback 前算 `effectiveHasClarifyChannel`+`clarifyModeFlip` → 三处 gate（rollback/pre-snapshot/session）统一改 `followupDecision.followup && !clarifyModeFlip`（**复用既有 fresh-retry 站点、不新增回滚逻辑**）+ writer 脏工作区回归 + 多仓 + 缺快照升级测试。
