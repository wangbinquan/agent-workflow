# RFC-123 任务分解

单 PR（backend：stop 两写点 + 重启用两改点 B1/B2 + 测试；零 migration / 零新 API / 前端仅确认失效覆盖）。设计经 2026-06-29 用户反问澄清「两开关本是一套理念/语义」+ 拍板「**也把重启用纳入本 RFC**」。Codex 设计 gate 4 轮 fold（P2 重启用纠缠三轮揭示→纳入交付 + P3 GET 路径），实现后过 impl gate（[feedback_codex_review_after_changes]）。

- **RFC-123-T1** self-clarify 写点：`submitClarifyAnswers` `directive==='stop'` → `setNodeClarifyDirective(db, sessionRow.taskId, sessionRow.sourceAgentNodeId, 'stop', answeredBy)`。
- **RFC-123-T2** cross-clarify 写点：`submitCrossClarifyAnswers` stop 分支 → `setNodeClarifyDirective(args.db, row.taskId, row.sourceQuestionerNodeId, 'stop', answeredBy)`。
- **RFC-123-T3** 前端反映：确认 `useTaskSync` / 画布 clarify-directive 查询在 clarify-answered WS 事件后失效刷新；若未覆盖则把该 query key 纳入失效集。
- **RFC-123-T5**（重启用 B1，prompt 路径）：`scheduler.ts` ~2348 读 `nodeDirective`（替 `nodeStopOverride` 单布尔）+ :2370/:2384 把 `directiveOverride` 泛化为 `nodeDirective !== undefined ? nodeDirective : 无`（toggle='continue' → ask-back 重开、覆盖 stale stop 轮）。`buildPromptContext` 不改（`clarifyRounds.ts:401` 本就通用）。
- **RFC-123-T6**（重启用 B2，cross 节点闸）：`dispatchCrossClarifyNode`（`crossClarify.ts:1040`）+ `scheduler.ts:1694` 解析 questioner toggle（`findQuestionerNodeForCrossClarify` + `getNodeClarifyDirective`），`qToggle==='continue'` 覆盖 `hasPersistentStop`。
- **RFC-123-T4** 测试：service（self+cross：stop 写 / continue 不写）+ stop 行为差异锁（self review 重跑 STOP）+ **重启用锁 B1（已答 stop 轮 + toggle continue → promptText 含 ask-back 不含 STOP；self + cross-questioner）** + **重启用锁 B2（cross stop session + questioner toggle continue → 不短路）** + 幂等 + golden-lock（无 toggle 行逐字：B1 不传 override / B2 走 hasPersistentStop / 答题 continue 不写表）+ 归属不进 prompt（+ 最小前端 toggle 渲染 stop/continue）。

## 依赖

- RFC-122（表 `task_node_clarify_directives` + `setNodeClarifyDirective` + `nodeStopOverride` 通道）已 **Done**。本 RFC 在其上 additive。

## 验收清单

- [ ] T1/T2 stop 两写点（**仅 stop 写、continue 不写**）+ T5/T6 重启用两改点落地。
- [ ] T4 测试全绿（stop 行为差异锁 + 重启用锁 B1/B2 + golden-lock）。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿 + 单二进制 smoke + 前端 vitest。
- [ ] Codex 设计 gate（提交前）+ impl gate（提交后）fold。
- [ ] push origin/main + CI 全绿（[feedback_post_commit_ci_check]）。

## 与 RFC-122 的关系

RFC-122 非目标第 19–20 行明确「答题 stop 与画布开关**并行、不同步**」。本 RFC **有意修订**该非目标：经用户确认「两者本是一套语义」，把 per-(任务,提问节点) directive 做成**双向单一事实源**（答 stop → 写 stop；手点 continue → 覆盖 stale stop、重启用）。RFC-122 其余设计（per-attempt 读、`resolveEffectiveClarifyChannel` oracle、首跑 / prior 轮注入、归属隔离、route 鉴权）保留；本 RFC 把 `directiveOverride` 从「只 stop」泛化为「toggle 显式值」（D6）+ 给 cross `hasPersistentStop` 加 questioner toggle 闸（D7），均 golden-lock（无 toggle 行逐字不变）。RFC-122 「writer mode-flip 脏工作区未回滚」窄边角与本 RFC 无关、不在范围内（重启用复用既有 `clarifyModeFlip`）。
