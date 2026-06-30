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

> 用户 2026-06-30 拍板**深度重构**（非最小补丁）。方案详见 `design.md §5.2`（5.2.0 勘误 / 5.2.3 四项 clean-path / 5.2.4 五项满足表 + ④裁决 / 5.2.5 double-injection / 5.2.6 黄金锁 / 5.2.7 P5b 单路径 / **5.2.11 readiness gate / 5.2.12 rerun-cause 契约 / 5.2.13 mixed-role grouping**）。**Codex 对抗设计 gate（2026-06-30）4 findings 已 fold**：F1〔high〕→ P5-B+P5-C 合并为 **P5-BC**（一个 rollback 单元，park 与 dispatch release path 不可分拆回退）；F2〔high〕→ P5-BC 内新增 **readiness gate**（unsealed self/q → reject）；F3〔high〕→ **rerun-cause 契约 + collapse 推翻**（早稿「同 agent 放行 collapse」作废）；F4〔medium〕→ **mixed-role grouping**（per-origin designer-scoped）。**Codex 设计 gate 第二轮（2026-06-30）4 闭环 findings 已 fold**（方向第一轮已确认对、本轮闭环细节，下一轮〔第三轮〕须 CLEAN=ship-design）：R2-1〔high〕→ **rollback playbook**（P5-BC 回退点改写：代码可回退、live self/q dispatch 状态须先 drain，`design.md §5.2.9`）；R2-2〔high〕→ **in-flight gate 扩域**（`assertNoInFlightDispatch` 去 designer-only，`design.md §5.2.12` contract 3）；R2-3〔medium〕→ **route auto-split 推进契约**（同 home 混 cause 不整批 reject、自动分安全批，`design.md §5.2.13` + §11.1）；R2-4〔medium〕→ **黄金锁注入条件**（full-round 同批=无 sibling/status 块逐字回落 legacy，`design.md §5.2.6`）。Codex 同轮确认 **F2 readiness 放服务层 / F4 per-origin designer-scoped + self/q per-home 方向正确、不再改**。分 **P5-0 / P5-A / P5-BC / P5-D** 四子阶段：**P5-0 可独立合**；每阶段独立验收 + 回退点；**P5-BC 失败：代码可单独回退而 P1–P4 + P5-0/A 留存；但 live self/q dispatch 状态须先 drain（或迁移）否则不可无数据回退**（R2-1，`design.md §5.2.9` rollback playbook）。**无新列 / migration**（复用 `trigger_run_id` / `dispatched_at` / `sealed_at` / `agent_override_name` / `rerun_cause`；journal 维持 68）。

#### RFC-128-P5-0（stranding **硬拒** seal-without-path，先行、可独立合）

- **P5-0-T1**：堵 `design.md §5.2.1` latent bug——deferred 任务 self/q 全题 seal 当前会**越过提问节点静默推进 + rerun 永不触发**（park 源 `loadUndispatchedDesignerTargets` / `dispatchTaskQuestions` 皆 designer-only）。**取「显式拒 seal-without-path」而非 park**（Codex 设计 gate F1）：dispatch 放开在 P5-BC 才到位，P5-0 此刻若 park 会无 release path → 永久 park（与 F1 同根）；故 P5-0 **硬拒**「无 dispatch path 时 full-seal self/q」（4xx 可观测 error），保证 **P5-BC 落地前绝无 stranded full-sealed self/q**。park 留到 P5-BC（与 dispatch release path 同单元）。
- 测：deferred self/q 在无 path 时 full-seal → reject（红→绿）；非 deferred 零影响（黄金锁）。
- **可独立合**（不依赖后续 clean-path），先消线上隐患 + 作 P5-BC 兜底。

#### RFC-128-P5-A（锁网，无生产改动）

- **P5-A-T1**：补 self/questioner **整轮**续跑全链路回归网作动刀基线——live 路径 `buildPromptContext`（`clarifyRounds.ts:355`）←`scheduler:2417/2442`、整轮消费戳 `markClarifyRoundsConsumedBy`（`clarifyRounds.ts:97`）←`runner:1551`、`resolveImmediateBorrowForNode`（`taskQuestionDispatch.ts:774`）即时账本。**先有网再动刀**（[hotspot-fortify-refactor]）。
- 测：整轮 self 单 rerun / questioner cascade / immediate borrow 全绿（动刀前快照）。

#### RFC-128-P5-BC（park 源 + 读侧相位 + dispatch 放开 + 注入 + 消费 + 借壳，**核心**，**一个 rollback 单元**，单独 Codex gate）

> **Codex 设计 gate F1 合并**：早稿 P5-B（park 源）与 P5-C（dispatch 放开）拆两个回退点 → 若 P5-B 留、P5-C 回退，deferred self/q **永久 park / 永久 awaiting_human**（park 无 release path）。**合并为 P5-BC，不可分别回退**：每个 parked state 在**同一**单元里有 dispatch release path。
>
> **Codex 设计 gate 第二轮 R2-1 + 第三轮 R3-1（live state 回退）**：上「合并消除 stranded」是**代码级**；**一旦 P5-BC 在生产产生 self/q live 状态——`dispatched_at` 戳 / `trigger_run_id` 绑 / partial in-flight，**或（R3-1）`sealed_at` 戳但 `dispatched_at` 仍 NULL（sealed/staged 待下发，被 `loadUndispatchedSelfQuestionerTargets` park）——代码-only 回退仍 strand 它**（旧代码无 self/q park/dispatch/per-entry consume path、不认 `sealed_at`、P5-0 narrowed 只拒未来 non-deferred 不清既有）。**P5-BC 回退点措辞从「可单独回退」改为「代码可回退；live self/q 状态〔dispatched in-flight **或** sealed-未-dispatch——R3-1〕须先 drain（或迁移）否则不可无数据回退」**——安全回退须先 **drain-then-rollback**（**同时**禁写 self/q answer/stage/dispatch 三入口〔R3-1：不只关 dispatch〕 → (a) 等所有 in-flight self/q dispatched 跑到 consumed〔done+output，判据同 `isDispatchedEntryConsumed`，`taskQuestionDispatch.ts:566`〕 + **(b) R3-1：把 sealed/staged-但-未-dispatch 的 self/q 条目〔`sealed_at IS NOT NULL + dispatched_at IS NULL`〕也 dispatch 到 consumed〔或迁移〕** → 队列清空判据扩为「无 unconsumed dispatched **且** 无未被旧整轮 path 接管的 `sealed_at` 条目」再回退）或 **migrate-then-rollback**（清 self/q `dispatched_at`/`trigger_run_id`/**`sealed_at`** + 轮重置整轮戳〔含 sealed-未-dispatch 轮〕）。**「无 dispatched in-flight」≠「live self/q 可回退」（R3-1）。** 详见 `design.md §5.2.9` rollback playbook。

- **P5-BC-T1（park 源，原 P5-B-T1）**：新增 `loadUndispatchedSelfQuestionerTargets`（镜像 `loadUndispatchedDesignerTargets`（`taskQuestions.ts:598`），**按 `sealed_at`、不 join 轮 status**）；union 进 `scheduler:811-812` 的 `deferredHandlerNodeIds`；自门控 deferred flag（clean-path ③）。**回退耦合**：与 dispatch 放开（T4）同单元落、绝不单独先合。
- **P5-BC-T2（读侧相位，原 P5-B-T2）**：`selectAnsweredRoundsForConsumer`（`clarifyRounds.ts:226`）self / cross-questioner 分支加 per-round 排除子句（`NOT EXISTS` dispatched 逐题条目，**判据 `dispatched_at`**）——double-injection 读侧半（§5.2.5）。
- **P5-BC-T3（per-question 注入，原 P5-C-T2）**：新增 `buildClarifyNodeQueueContext`（镜像 `buildNodeQueueExternalFeedback`（`crossClarify.ts:1412`），**渲染走 `ClarifyPromptContext` 形态**、零归属）；**兄弟题状态块按 partial 条件附加（R2-4，`design.md §5.2.6`）**——dispatched 集**覆盖该轮全部题**（full-round 同批）→ **不附** sibling/status 块、**不加**「只处理本题」指令、逐字回落 legacy `buildPromptContext`（黄金锁注入轴前提）；仅 partial（有兄弟题未同批下发）→ 才附「兄弟题状态标注块 + 只处理本题」；scheduler 对 deferred self/q 节点在整轮 `buildPromptContext` 与逐题 builder 间**二选一 suppress**（double-injection scheduler 半）（clean-path ①）。
- **P5-BC-T4（dispatch 放开 + 五契约〔三 + 第二轮 R2-2/R2-3〕，原 P5-C-T1 + F2/F3/F4 + 第二轮新增）**：`dispatchTaskQuestions`（`taskQuestionDispatch.ts:198`）去 designer-only（`:240` / `:258`），放开 deferred self/q 批量下发；**带五契约**：
  - **(a) readiness gate（F2，§5.2.11）**：dispatch 前校每条 clarify-derived 条目 `sealed_at != null`（或所属轮 answered）否则**整批 reject**——self/q 条目无条件建（`shared/task-questions.ts:99-117`），不校验会让未 seal 条目被下发+绑（答案不存在）→ 空 rerun + 误抑整轮。判据用 `sealed_at` 不用 `answerSummary`（partial 不可靠）。
  - **(b) rerun-cause 契约（F3，§5.2.12）**：`buildFrontierMintPlan`（`:946-984`）的 cause 从硬编码 `cross-clarify-answer` 改**按角色派生**（self→`clarify-answer`、questioner→`cross-clarify-questioner-rerun`、designer→`cross-clarify-answer`）；一个 home 本批须 cause 同质，混 cause → reject。
  - **(c) mixed-role grouping（F4，§5.2.13）**：per-origin 单 target 校验（`:269-279`）**保持 designer-scoped**（勿 broaden 到 self/q）；self/q 另设 per-home single-borrow 校验（镜像 immediate P2-1 `:829-845`）；questioner+designer 同 origin 异 home → 允许一批下发。
  - **(d) in-flight gate 扩域（第二轮 R2-2，`design.md §5.2.12` contract 3）**：把 `assertNoInFlightDispatch`（定义 `:591`，call `:352`）的 `eq(taskQuestions.roleKind,'designer')` 过滤（`:602`）**去 / 扩**，使 in-flight 查询拉**任一 deferred role（self/questioner/designer）** 的 `dispatched_at IS NOT NULL` 条目；`findOpenDispatchTarget`（`:551`）+ `isDispatchedEntryConsumed`（`:566`）随之把任一 deferred role 同 home 未-consumed dispatched 条目判 blocker；ConflictError 文案（`:614`）泛化。依赖 T5（self/q 绑 `trigger_run_id`，`isDispatchedEntryConsumed` 才能分类）。**否则**同 home 先 self/q、后 designer 仍双 mint（gate 看不到在飞 self/q）。这是 (b) 串行化的**跨批**物理实现。
  - **(e) route auto-split 推进契约（第二轮 R2-3 + 第三轮 R3-2，`design.md §5.2.13` + §11.1）**：§11.1 删了 per-card checkbox + 「批量下发=全部 staged」，故同 home 混 cause 全 staged 时 route **不得整批 reject**（否则前端全量提交→全量 reject 死循环）。route 收「全部 staged」后对**同 home 混 cause**（仅此类）**自动分安全批**——每 home 一时刻只下发一个 cause 类，其余留 staged，**response 新增「已下发 / 延后（下一批）分组 + 原因」字段**；前端展示「待第一批续跑完成后可下发」，第一批 done+output 后再下发（届时 (d) in-flight gate 已放行）。**cause 选序 = aging 公平规则（R3-2，防饿死）**：选**最老 `staged_at??created_at` 的 cause 类**先下发、同龄按 `CAUSE_PRIORITY`（self/q 先）破平——固定 self/q-first 会让反复涌入的新同 home self/q **无限延后老 designer**；aging 保证延后的 cause 一旦比新涌入的老就必被先释放。**precondition 违例（unsealed〔a〕/ per-origin〔c〕/ per-home multi-borrow / not-ready）仍 fail-fast 整批 reject**；检查序：先 precondition 拒类、全通过才 auto-split。这是 (b) 串行化的**同批**物理实现。前端落点配合 §11.1 / P4。
- **P5-BC-T5（per-entry 消费戳，原 P5-C-T3）**：续跑逐条目绑 `trigger_run_id`；`markClarifyRoundsConsumedBy`（`clarifyRounds.ts:97`）deferred suppress（不整轮 stamp）；读侧 `resolveEntryHandler` 对 deferred self/q 走 `resolveDispatchedEntryHandler`（`taskQuestions.ts:334`，原节点框 lineage）（clean-path ②）。
- **P5-BC-T6（三账本借壳 + collapse 拒，原 P5-C-T4，F3 推翻 collapse）**：新增 `resolveDeferredSelfQuestionerBorrowForNode`（镜像 `resolveDesignerBorrowForNode`（`taskQuestionDispatch.ts:706`））；接进 `resolveBorrowForNode`（`:672`）；**冲突规则（F3 推翻早稿 collapse）**——deferred-selfQ vs deferred-designer 同 home **一律拒（不 collapse、不论同异 agent）**，与既有 immediate×designer 拒（`:692-697`）同规则（cause 单值且互斥，§5.2.12），由 single-cause gate（T4-b）+ `assertNoInFlightDispatch`（`:342-352`）串行化。**早稿「同 agent 放行 collapse 一条 rerun」作废。** **串行化物理实现依赖 T4-(d) in-flight gate 扩域（R2-2）+ T4-(e) auto-split（R2-3）**——`assertNoInFlightDispatch` 须扩到 self/q dispatched entries，否则跨批仍双 mint；同批由 auto-split 拆。
- 测：§5.2 五项自检各红→绿；park 源逐题分类（undispatched / in-flight / consumed）+ partial 轮（awaiting_human）下 self/q 被 park（不靠轮 answered）+ 读侧排除不漏注 sealed-未-dispatch 轮；三坑回归；double-injection（读侧排除 + scheduler XOR 双锁）；**五契约（三 + 第二轮 R2-2/R2-3 闭环）**——(a) unsealed self/q entryIds → reject；(b) deferred self/questioner/designer mint cause 各对 + `rfc098-rerun-cause-gates` 真值表不破 + 同 home 混 cause 拒；(c) 整轮 cross round（questioner+designer 异 home）一批下发成功 / designer 多 handler 仍拒 / self/q home==designer home 触串行化；**(d) in-flight gate 扩域（R2-2）**：同 home 先 self/q dispatched〔rerun 未 done+output〕→ 后 designer 同 home 第二批 → `assertNoInFlightDispatch` reject、done+output 后放行；**(e) route auto-split（R2-3）**：同 home self/q+designer 全 staged 一次「批量下发」→ 下发 self/q 半 + designer 半留 staged + response 含延后分组（不 reject、无全量死循环），第一批 done+output 后再下发成功；混入 unsealed → 仍 readiness 整批 reject（precondition 优先）；**(e2) auto-split aging 防饿死（R3-2）**：同 home 老 designer（staged 早）+ 新 self/q（staged 晚）一次「批量下发」→ 下发**老 designer**、新 self/q 留 staged（aging 胜过 self/q-first 默认）——反复涌入 self/q 不能无限延后老 designer；三账本冲突矩阵（deferred-selfQ×designer 同 home 拒〔不论 agent〕；immediate×designer 仍拒）；**黄金锁**（deferred 全 seal 批量下发 = 旧整轮逐字：注入〔**含 R2-4 条件：full-round 同批 builder 走 legacy byte-compatible〔无 sibling/status 块〕逐字回落、partial 才加块**〕/ mint〔含 cause 对齐〕/ 消费 / 级联四面对齐）；非 deferred 零改字节级。
- **单独 Codex 对抗 gate**（落码前对 §5.2.4 五项满足表 + §5.2.11/12/13 五契约〔含 R2-2 in-flight gate 扩域 / R2-3 route auto-split〕 + R2-4 黄金锁注入条件 + R2-1 rollback playbook 跑一次，第三轮须 CLEAN）；若复现 RFC-125 级致命问题 → 回退**整个 P5-BC**、与用户重新权衡（P1–P4 + P5-0/A 不受影响；**回退前按 `design.md §5.2.9` rollback playbook 处理 live state——R2-1**）。

#### RFC-128-P5-D（快通道 seal + autodispatch）

- **P5-D-T1**：deferred 任务的 self/q「快通道」——seal 即自动 dispatch（`defer` 决定自动 vs 手动触发 dispatch，**不引入第二路径**，§5.2.7 P5b 单路径裁决）；手动控制通道（集中回答面，P4）仍走显式 dispatch。
- 测：AC-9 全过；快通道 seal→自动续跑；与手动通道互不混路（per-round 单路径）；RFC-125 单路径不变量。

## PR 拆分

- **PR-A**：P0（锁网）。
- **PR-B**：P1（落库地基）。
- **PR-C**：P2+P3（端点+gate+designer 逐题下发）。
- **PR-D**：P4（两入口 UI）。
- **PR-E**：P5（self/questioner 逐题重跑，深度重构）→ **拆 3 子 PR**（Codex 设计 gate F1 后 B+C 合并；每子 PR 独立验收 + 回退点；**P5-PR2 = P5-BC 失败：代码可单独回退而 P1–P4 + P5-PR1 留存；但 live self/q dispatch 状态须先 drain 或迁移，否则不可无数据回退**——R2-1，`design.md §5.2.9`）：
  - **P5-PR1**（= PR-1）= **P5-0 + P5-A**（stranding 硬拒 + 锁网；P5-0 部分亦可更早单独合）。
  - **P5-PR2**（= PR-2）= **P5-BC**（park 源 + 读侧相位 + dispatch 放开 + readiness gate + rerun-cause 契约 + mixed-role grouping + **in-flight gate 扩域〔R2-2〕** + **route auto-split〔R2-3〕** + 注入〔含 R2-4 注入条件〕 + 消费 + 借壳，**核心**，**一个不可分拆的 rollback 单元**，单独 Codex gate）。
  - **P5-PR3**（= PR-3）= **P5-D**（快通道 seal + autodispatch）。

## 验收清单

proposal `AC-1`~`AC-13` 全绿；门槛 typecheck+test+format:check + CI；**Codex 双 gate**（设计 gate 落码前对全 RFC 跑一次、**P5-BC 实现前单独**再跑一次对抗审 `design.md §5.2.4` 五项满足表 + §5.2.11/12/13 五契约〔含 R2-2 in-flight gate 扩域 / R2-3 route auto-split〕 + R2-4 黄金锁注入条件 + R2-1 rollback playbook；**第三轮设计 gate 须 CLEAN=ship-design 才进实现**）；push 后查 CI。每 P5 子阶段以**黄金锁**（非 deferred 零改字节级 / deferred 全 seal 批量下发 = 旧整轮逐字，含 cause 对齐 + R2-4 注入条件）为回归基准。**若 P5-BC Codex gate 复现 RFC-125 级致命问题 → 回退整个 P5-BC、与用户重新权衡，P1–P4 designer 主线 + P5-0/A 不受影响**——**但回退前须按 `design.md §5.2.9` rollback playbook 处理 live state（R2-1）**：P5-BC 一旦在生产产生 self/q dispatch 状态，**代码可回退 ≠ live state 可无数据回退**，须先 **drain（禁写 + 等 in-flight self/q dispatched consume 清空）或迁移**，否则既有 self/q dispatch 状态 stranded。
