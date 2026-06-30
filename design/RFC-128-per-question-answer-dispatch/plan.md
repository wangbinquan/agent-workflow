# RFC-128 — 任务分解 / plan

> 依赖 **RFC-127**（借壳执行）。动 clarify「整轮 seal」核心 → 分阶段 P0–P5，**self/questioner 逐题重跑（P5）末位、可独立回退而不影响 P1–P4 的 designer 主线**。
> migration 号取落地时下一个空号（现存最新 0066；RFC-127 的 `node_runs` 列在前，本 RFC 的 `task_questions.sealed_at` 取其后）。

## 阶段与子任务

### RFC-128-P0（锁网，先行，无生产改动）

- **T0**：补「整轮 seal 全链路」回归网——self 单 rerun（`clarify.ts:473`）、cross questioner cascade、§18 部分下发、RFC-126 `failed→resume` answered 存活、RFC-070 整轮 aging。**先有网再动刀**（[hotspot-fortify-refactor] 同法）。

### RFC-128-P1（落库地基，纯后端 golden-lock）

- **T1**：`task_questions` 加 `sealed_at` 列（+ `sealed_by`）+ migration（journal +1 → bump `upgrade-rolling.test.ts`；`--> statement-breakpoint`）。
- **T2**：`reconcileDesiredEntries`（`shared/task-questions.ts:113`）门控 `roundAnswered`→逐题 `questionSealed[qid]`；幂等 upsert 不变。
- **T3**：`answers_json` 逐题 merge 写；`sealAnswersServerSide`（`clarify.ts:1010`）去「空数组抛错」（`:1014`）、改「只 seal 传入子集并 merge」。
- **T4**：轮 `awaiting_human→answered` 仅「全题 seal」时翻；partial 纯派生（不新增 DB status，护 RFC-126）。
- 测：AC-1/2/3 + 破坏面 §8 全套绿（黄金锁：无 override/单题全答 = 旧整轮行为逐字一致）。

### RFC-128-P2（逐题 seal 端点 + defer 意图 + 待下发 gate）

- **T5**：`POST /api/tasks/:id/questions/answer`（`requireTaskMember`）seal 单题 merge + 落 `sealed_at`；或扩 `POST /api/clarify/:nodeRunId/answers` 接受 `questionIds` 子集 + `defer`（复用 `ensureClarifyMember`/`resumeTask`，改动更小）——实现 gate 二选一。
- **T6**：`defer=true`（集中界面）→ 不立即续跑、进待指派；`defer=false`（反问页）→ 现状立即。
- **T7**：`stageTaskQuestion`（`taskQuestions.ts:790`）加「该题已 seal」gate（未 seal 4xx）；前端 `hasStage`（`TaskQuestionList.tsx:344`）加 answered 条件。
- **T7b（待下发即下发）**：staged 列去每卡 checkbox + 选择 state；「批量下发」下发**全部** staged（非所选）；后端 dispatch 端点不变。把 §18「勾选→下发所选」测试改为「批量下发→全部 staged」。
- 测：AC-5/7/12。

### RFC-128-P3（designer 域逐题下发，低风险）

- **T8**：designer 逐题答→reconcile 出该题 designer 条目→走既有 `dispatchTaskQuestions`（§18）+ RFC-127 借壳；部分下发、`dispatched_at IS NULL` CAS 防重（`taskQuestionDispatch.ts:416`）。
- 测：AC-8。

### RFC-128-P4（两入口 UI）

- **T9**：集中回答面——任务详情新 pane，`listTaskQuestions` 取待答题、按 `originNodeRunId` 分组平铺多个 `QuestionForm`；逐题草稿（已支持跨轮）+ 逐题/批量「确定」调 T5 端点（`defer=true`）；scope 仅 cross 渲染、directive 按轮呈现；改派下拉 `ClarifyQuestionHandler`。复用公共原语、无原生 chrome；i18n 中英对称；视觉对齐自查。
- **T10**：`/clarify`（`clarify.detail.tsx`）读 `listTaskQuestions` per-question 态，已 seal/已下发题置灰只读 + 提交排除（防重复下发靠 CAS）。
- 测：AC-4/6（前端 vitest）。

### RFC-128-P5（self/questioner 逐题重跑，**深度重构**；最高风险，单独 Codex gate）

> 用户 2026-06-30 拍板**深度重构**（非最小补丁）。方案详见 `design.md §5.2`（5.2.0 勘误 / 5.2.3 四项 clean-path / 5.2.4 五项满足表 + ④裁决 / 5.2.5 double-injection / 5.2.6 黄金锁 / 5.2.7 P5b 单路径）。分 **P5-0~P5-D** 五子阶段：**P5-0 可独立合**；每阶段独立验收 + 回退点；P5-C 失败可单独回退而 P1–P4 + P5-0/A/B 留存。**无新列 / migration**（复用 `trigger_run_id` / `dispatched_at` / `sealed_at` / `agent_override_name`；journal 维持 68）。

#### RFC-128-P5-0（stranding hotfix，先行、可独立合）

- **P5-0-T1**：堵 `design.md §5.2.1` latent bug——deferred 任务 self/q 全题 seal 当前会**越过提问节点静默推进 + rerun 永不触发**（park 源 `loadUndispatchedDesignerTargets` / `dispatchTaskQuestions` 皆 designer-only）。落 guard：deferred + 存在 sealed-无-path 的 self/q 条目时**不静默推进**——park 提问节点或显式拒 seal-without-path，把 strand 变可观测（park / error）。
- 测：deferred self/q 全题 seal 不再越过提问节点（红→绿）；非 deferred 零影响（黄金锁）。
- **可独立合**（不依赖后续 clean-path），先消线上隐患。

#### RFC-128-P5-A（锁网，无生产改动）

- **P5-A-T1**：补 self/questioner **整轮**续跑全链路回归网作动刀基线——live 路径 `buildPromptContext`（`clarifyRounds.ts:355`）←`scheduler:2417/2442`、整轮消费戳 `markClarifyRoundsConsumedBy`（`clarifyRounds.ts:97`）←`runner:1551`、`resolveImmediateBorrowForNode`（`taskQuestionDispatch.ts:774`）即时账本。**先有网再动刀**（[hotspot-fortify-refactor]）。
- 测：整轮 self 单 rerun / questioner cascade / immediate borrow 全绿（动刀前快照）。

#### RFC-128-P5-B（park 源 + 读侧相位，纯后端 golden-lock）

- **P5-B-T1**：新增 `loadUndispatchedSelfQuestionerTargets`（镜像 `loadUndispatchedDesignerTargets`（`taskQuestions.ts:598`），**按 `sealed_at`、不 join 轮 status**）；union 进 `scheduler:811-812` 的 `deferredHandlerNodeIds`；自门控 deferred flag（clean-path ③）。
- **P5-B-T2**：`selectAnsweredRoundsForConsumer`（`clarifyRounds.ts:226`）self / cross-questioner 分支加 per-round 排除子句（`NOT EXISTS` dispatched 逐题条目，**判据 `dispatched_at`**）——double-injection 读侧半（§5.2.5）。
- 测：park 源逐题分类（undispatched / in-flight / consumed）；partial 轮（awaiting_human）下 self/q 题被 park（不靠轮 answered）；读侧排除不漏注 sealed-未-dispatch 轮；非 deferred 零改（golden-lock）。

#### RFC-128-P5-C（dispatch + 注入 + 消费 + 借壳，**核心**，单独 Codex gate）

- **P5-C-T1（dispatch 放开）**：`dispatchTaskQuestions`（`taskQuestionDispatch.ts:198`）去 designer-only（`:240` / `:258`），放开 deferred self/q 批量下发（per-origin 单 target 等校验保留）（clean-path ④ 配套）。
- **P5-C-T2（per-question 注入）**：新增 `buildClarifyNodeQueueContext`（镜像 `buildNodeQueueExternalFeedback`（`crossClarify.ts:1412`），**渲染走 `ClarifyPromptContext` 形态** + 兄弟题状态标注块、零归属）；scheduler 对 deferred self/q 节点在整轮 `buildPromptContext` 与逐题 builder 间**二选一 suppress**（double-injection scheduler 半）（clean-path ①）。
- **P5-C-T3（per-entry 消费戳）**：续跑逐条目绑 `trigger_run_id`；`markClarifyRoundsConsumedBy`（`clarifyRounds.ts:97`）deferred suppress（不整轮 stamp）；读侧 `resolveEntryHandler` 对 deferred self/q 走 `resolveDispatchedEntryHandler`（`taskQuestions.ts:334`，原节点框 lineage）（clean-path ②）。
- **P5-C-T4（三账本借壳）**：新增 `resolveDeferredSelfQuestionerBorrowForNode`（镜像 `resolveDesignerBorrowForNode`（`taskQuestionDispatch.ts:706`））；接进 `resolveBorrowForNode`（`:672`）；**冲突规则**——deferred-selfQ vs deferred-designer 同 home **同 agent 放行 / 异 agent 拒**（一条 rerun 两 context 槽；区别于 immediate×designer 的一律拒 `:692-697`）（clean-path ④）。
- 测：§5.2 五项自检各红→绿；三坑回归；double-injection（读侧排除 + scheduler XOR 双锁）；三账本冲突矩阵（deferred-selfQ×designer 同 agent 放行 / 异 agent 拒；immediate×designer 仍一律拒）；**黄金锁**（deferred 全 seal 批量下发 = 旧整轮逐字：注入 / mint / 消费 / 级联四面对齐）。
- **单独 Codex 对抗 gate**（落码前对 §5.2.4 五项满足表跑一次）；若复现 RFC-125 级致命问题 → 回退 P5-C、与用户重新权衡（P1–P4 + P5-0/A/B 不受影响）。

#### RFC-128-P5-D（快通道 seal + autodispatch）

- **P5-D-T1**：deferred 任务的 self/q「快通道」——seal 即自动 dispatch（`defer` 决定自动 vs 手动触发 dispatch，**不引入第二路径**，§5.2.7 P5b 单路径裁决）；手动控制通道（集中回答面，P4）仍走显式 dispatch。
- 测：AC-9 全过；快通道 seal→自动续跑；与手动通道互不混路（per-round 单路径）；RFC-125 单路径不变量。

## PR 拆分

- **PR-A**：P0（锁网）。
- **PR-B**：P1（落库地基）。
- **PR-C**：P2+P3（端点+gate+designer 逐题下发）。
- **PR-D**：P4（两入口 UI）。
- **PR-E**：P5（self/questioner 逐题重跑，深度重构）→ **拆 4 子 PR**（每子 PR 独立验收 + 回退点；P5-PR3 失败可单独回退而 P1–P4 + P5-PR1/2 留存）：
  - **P5-PR1**（= PR-1）= **P5-0 + P5-A**（stranding hotfix + 锁网；P5-0 部分亦可更早单独合）。
  - **P5-PR2**（= PR-2）= **P5-B**（park 源 + 读侧相位）。
  - **P5-PR3**（= PR-3）= **P5-C**（dispatch + 注入 + 消费 + 借壳，**核心**，单独 Codex gate）。
  - **P5-PR4**（= PR-4）= **P5-D**（快通道 seal + autodispatch）。

## 验收清单

proposal `AC-1`~`AC-13` 全绿；门槛 typecheck+test+format:check + CI；**Codex 双 gate**（设计 gate 落码前对全 RFC 跑一次、**P5-C 实现前单独**再跑一次对抗审 `design.md §5.2.4` 五项满足表）；push 后查 CI。每 P5 子阶段以**黄金锁**（非 deferred 零改字节级 / deferred 全 seal 批量下发 = 旧整轮逐字）为回归基准。**若 P5-C Codex gate 复现 RFC-125 级致命问题 → 回退 P5-C、与用户重新权衡，P1–P4 designer 主线 + P5-0/A/B 不受影响**。
