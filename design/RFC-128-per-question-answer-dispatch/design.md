# RFC-128 — 技术设计：任务级集中回答 + 反问 per-question 独立答/下发

> 读法：先 `proposal.md` 再本文，并需对照 `RFC-127`（借壳执行）。本文给接口契约、数据流、三坑缓解、失败模式、破坏面、迁移、测试策略。证据 file:line 基于 2026-06-29 HEAD，**行号以符号名为锚**（并发改动后可能漂移）。
> 本文由 4 路只读子代理回源浓缩；代码为权威（多个 RFC 文档 `状态` 头已过期）。

## 0. 现状「两半分裂」（设计起点）

| 半            | 现状                                                                                                                                                                                                                                                                                                                                   | 本 RFC                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **下发**      | 已 per-question：`task_questions` per-(问题×角色) 行，`dispatched_at`/`staged_at`/`override` 逐题列（`db/schema.ts:1754-1772`）；`dispatchTaskQuestions` 支持部分下发（`taskQuestionDispatch.ts:211-222`，`dispatched_at IS NULL` CAS `:416-419`）——但**仅 cross designer 角色 + 整轮 answered 后 + deferred 任务**                    | 扩到全角色 + 配合逐题 seal         |
| **回答/seal** | 整轮 blob `clarify_rounds.answers_json`（`db/schema.ts:1171`），submit 一次翻 `awaiting_human→answered`（`clarify.ts:486-495`/`crossClarify.ts:445-454`），status 枚举无 `partial`（`schemas/clarify.ts:338-344`）；唯一入口 `/clarify`；逐题**草稿**已有（`draft_answers_json` + `PUT /draft`，`clarifyRounds.ts:841`）但 submit 整轮 | **新建逐题 seal + 任务级回答入口** |

> 角色二分（`shared/task-questions.ts:27-29`）贯穿全文：**designer（修订型）逐题答+下发约 70% 已建**；**self/questioner（阻塞-产出型）逐题重跑是高风险新建（§5.2）**。

## 1. 整轮 seal 全链路 + 改 per-question 的改点

**self**（`services/clarify.ts`）`submitClarifyAnswers`（`:336`）一次完成：① `clarify-already-answered` 锁（`status!=='awaiting_human'` 抛，`:357-362`）；② `sealAnswersServerSide`（`:1010`，**空数组直接抛错 `:1014`**——逐题 seal 须改）；③ mint **一条** source rerun（cause `clarify-answer`，`:473-481`）；④ 整轮 `answers_json`+`status='answered'` 写 `clarify_sessions`（`:486-495`）**且 dual-write** `clarify_rounds`（`:509-519`）；⑤ stop→`setNodeClarifyDirective`（`:527-535`）；⑥ clarify node_run `awaiting_human→done`（`:540-545`）。严格写序（先 mint 再翻 session，`:376-398`）。

**cross**（`crossClarify.ts`）`submitCrossClarifyAnswers`（`:381`）同构：锁（`:401-406`）→seal→整轮写 `cross_clarify_sessions`（`:445-454`）+dual-write `clarify_rounds`（`:470-480`）→directive 分支（stop `:506-517` / continue→deferred `reconcile` `:580-590` / 多源就绪 `triggerDesignerRerun` `:636`）。

**答案存三表 `answers_json`**：`clarify_sessions`/`cross_clarify_sessions`（legacy）+ `clarify_rounds`（统一 SoT），create 时双写空壳（`clarify.ts:217-239`/`crossClarify.ts:258-280`）。

**改点**：(a) seal 入口从「整轮一次」→「逐题 merge」；(b) `sealAnswersServerSide` 去掉空数组抛错、改「只 seal 传入子集并 merge」；(c) status 翻转拆出——仅「全题 seal」才 `→answered`（§2）；(d) rerun mint 时机分角色（§5）；(e) `clarify-already-answered` 锁从整轮降为逐题（同题不可重 seal、兄弟题仍可答）。

## 2. 轮 status 语义：partial 纯派生，不新增 DB status

现状 `awaiting_human→answered` 整轮原子（`schemas/clarify.ts:338-344` 无 partial）。**RFC-126 把整轮 answered 钉死**：`failed→resume` 后轮须保持 `answered` 才能让 designer 重跑再消费（`RFC-126/design.md:18-27`），`closed` 终态已删（`shared/task-questions.ts:42-49`、migration 0066）。**新增 DB `partial` 会直接撞 RFC-126**。

**设计**：不新增 DB status。轮保持 `awaiting_human` 直到全题 seal；「部分答」是**派生态**——`deriveQuestionPhase`（`shared/task-questions.ts:152`）本就逐条派生，逐题 seal/dispatch 标记天然表达「某题 processing、某题仍 pending」。`answered` 仍只在全题 seal 翻一次 → RFC-126 resume 不变量、questioner cascade 依赖整轮 answered（`RFC-120/design.md:402`）全部成立。RFC-070 整轮消费戳（`clarifyRounds.ts:97-191`）+ `selectAnsweredRoundsForConsumer` 的 `status='answered'` 过滤（`:226-301`）对 designer 已被 §18 per-node queue 旁路、对 self/questioner 仍整轮——保持。

## 3. directive：保持节点级，不下沉逐题

directive 是**节点级**（RFC-123 单一事实源 `task_node_clarify_directives`，`taskClarifyDirective.ts:95`）+ 答题期 per-round `rowDirective`（`clarify_rounds.directive`，`clarifyRounds.ts:405/420`），**从无逐题 directive**。designer 重跑不读 directive（它是「带反馈修订」，`crossClarify.ts:824`）→ designer 逐题下发与 directive 正交。**设计：directive 仍节点级，逐题重跑继承当前 directive，不做逐题 directive**（逐题 directive 会撞 RFC-123「两开关一套理念/单一事实源」`RFC-123/proposal.md:19`）。

## 4. scope + designer 条目时序：reconcile 门控改逐题

scope 已逐题（`question_scopes_json` Record，`db/schema.ts:1205`），现状整轮一次写。designer 条目「答该题才出现」由 `reconcileDesiredEntries`（`shared/task-questions.ts:113-124`）的 `roundAnswered && directive!=='stop' && scope==='designer'` 门控。

**设计**：把门控从整轮 `roundAnswered` 改为**逐题 `questionSealed[qid]`**（`shared/task-questions.ts:113` 这一行是关键改点）——每 seal 一题（scope=designer）即 reconcile 出该题 designer 条目，scope 在答该题时定。`reconcileTaskQuestionsForRound` 幂等 upsert（`taskQuestions.ts:116-162`），增量调用安全。时序：答 Q1→出 Q1 designer 条目→可单独 stage/dispatch。

## 5. 续跑注入：designer 现成，self/questioner 三坑缓解

### 5.1 designer 逐题注入（已建，复用）

`buildNodeQueueExternalFeedback`（`crossClarify.ts:1365`）按「effective handler==本节点 + `dispatched_at` set + 未消费」选**逐题**，rerun 时绑 `trigger_run_id`（`:1422-1428`）、从来源轮 `answers_json` **只取被下发的 questionId**（`:1461-1467`）。`buildClarifyPromptBlock`（`shared/clarify.ts:236`）逐题渲染、缺答案题显示「User did not answer this question.」。**designer 逐题答+下发+借壳（RFC-127）= 低风险主线**。

### 5.2 self/questioner 逐题重跑（高风险，三坑缓解 —— Codex gate 头号审查）

现状 self 续跑 `buildClarifyPromptContext`（`clarify.ts:660`）读整条 session `answers_json`（`:703-704`）、mint **一条** rerun；questioner `buildQuestionerCrossClarifyContext`（`crossClarify.ts:1595`）+ `mintQuestionerRerun`（`:985`）同构整轮。**逐题重跑撞三坑（= RFC-125 被否决区）**：

**坑1 半答案续跑** → **渐进式缓解**：

- 逐题下发时 mint 一条借壳 rerun（node_id=原节点，agent=改派 X 或默认；RFC-127 借壳），注入 **= 本题问题+答案 + 显式「兄弟题清单及其状态（pending/in-queue/已处理）」标注块**（新 builder，输入收窄到 `{thisQuestion, thisAnswer, siblingStates}`），明确指示「只处理本题、未答兄弟题在队列中、勿重复追问」。
- 中间态靠 **worktree 累积**（cwd=worktree，契合平台「cross-iter state via worktree files」）；每次 rerun 在前次基础上渐进。
- 下游靠 **freshness 取最终产出**（`freshness.ts` 最新 done 胜）——逐题 rerun 多次产出，下游 stale 级联取最新；**v1 接受下游可能多跑（最终正确）**，design gate 评估是否要「仅末题产出」优化。

**坑2 directive** → 节点级继承（§3），不下沉。

**坑3 provenance** → **条目级消费戳缓解**：把 RFC-120 §2.4 的「per-条目反馈渲染 + per-条目 `trigger_run_id` + 排除已消费」从 designer 扩到 self/questioner——每条逐题 rerun 只 stamp 它那题的条目、只注入那题答案；`resolveHandlerRun`（`shared/task-questions.ts:264`）的 lineage 框窗对 self/questioner 条目按**原节点**框（RFC-127 §5 同款）。

> **设计 gate 自检表**（采纳 `RFC-125/plan.md:26` 指明的「v2 design 全套硬化」）：① 逐题 rerun 的 provenance 戳唯一且不串题；② 同节点多题逐题下发不互相误抑/误 park；③ 兄弟题标注块不泄漏归属（RFC-099）；④ stop directive 与未下发兄弟题共存时不死锁；⑤ 末题产出与中间产出的下游级联次数可控。**任一不过 → 回退与用户重新权衡（proposal §6）**。

## 6. 反问页协调（`clarify.detail.tsx`）

现状提交把**全部问题**拼 `arr` 一次 POST（`:422-435`，带 `ifMatchIteration`/`directive`/cross 整张 `scopes` map `:439-441`），`readonly` 仅按整轮 `status!=='awaiting_human'`（`:610`）。**逐题草稿已铺路**：debounce 后**逐题** `PUT /draft`（只发变化题，`:284-305`）+ `clarify.draft.updated` WS 协作（`clarifyRounds.ts:896`）+ 归属冻结（`:953`）+ 远端合并（`clarify.detail.tsx:324-353`）。

**改点**：① 读 `GET /api/tasks/:id/questions`（`listTaskQuestions`，`taskQuestions.ts:274`）拿逐题 `phase`/`dispatched`，按 questionId 交叉 → 已 seal/已下发题**置灰只读、提交排除**；② submit 从「整轮 arr」→「只 seal 本次未处理题子集」（走 §10 的逐题 seal 端点）；③ 防重复下发靠 `dispatched_at IS NULL` CAS（`taskQuestionDispatch.ts:416-419`）天然兜底。**逐题草稿（含协作/归属冻结）是最大现成红利——seal ≈ 把某题 draft 提升为 answer**。

## 7. 落库方案：推荐 C（answers_json 逐题 merge + task_questions 逐题态）

|                  | (A) answers_json 增量写+轮不锁 | (B) 答案搬 task_questions 做逐题 SoT                                   | **(C) 推荐：blob 增量内容 + 逐题 seal/dispatch 态落 task_questions + partial 派生** |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 答案内容 SoT     | blob（读侧不动）               | 逐题列（读侧全改）                                                     | blob（读侧不动）                                                                    |
| 改动面           | 中                             | **极大**（4 个 prompt builder + RFC-070 aging + 三表 dual-write 全改） | 中                                                                                  |
| dual-write(3 表) | 兼容                           | **冲突严重**                                                           | 兼容                                                                                |
| RFC-126 resume   | 保                             | 需重写                                                                 | 保                                                                                  |
| 历史回填         | 易                             | 难                                                                     | 易                                                                                  |

**推荐 C**：保留 `answers_json` 作内容 SoT、改逐题 merge 写；`task_questions` 加逐题 seal 标记（如 `sealed_at`，与既有 `dispatched_at`/`prior_answer_snapshot_json`/`reopen_count` 残留列同层，`db/schema.ts:1781/1783`）；轮 `answered` 仅全 seal 翻；partial 纯派生。理由：把爆炸面挡在 `task_questions` 人工覆盖层内（RFC-120 本为「zero-touch clarify 后端」设计 `taskQuestions.ts:1-6`），4 个 prompt builder + dual-write + RFC-070 全不动。(B) 留远期。

## 8. 破坏面清单（依赖「整轮 seal」的 RFC/路径 + 回归锁）

- **RFC-023 self**：`submitClarifyAnswers` 单 rerun+整轮 seal（`clarify.ts:336-587`）、空数组抛错（`:1014`）。锁 `clarify-service.test.ts`、`clarify-rerun-write-ordering.test.ts`。
- **RFC-056/059 cross**：整轮 answered 驱动 questioner cascade + 多源就绪（`crossClarify.ts:445-671`）、scope 整轮提交（`:427`）。锁 `cross-clarify-service.test.ts`、`cross-clarify-multi-source-wait.test.ts`、`cross-clarify-question-scope*.test.ts`、`cross-clarify-questioner-cascade-no-skip.test.ts`。
- **RFC-120 §18**：`reconcileDesiredEntries` 门控（`shared/task-questions.ts:113`）、`deriveQuestionPhase` 入参 roundStatus（`:152`）、park gate `loadUndispatchedDesignerTargets`（`taskQuestions.ts:447`）。锁 `rfc120-*` 全套。
- **RFC-070 aging**：整轮消费戳（`clarifyRounds.ts:97-191`）。锁 `rfc070-aging-stamp-behavior.test.ts`、`rfc070-migration-backfill.test.ts`。
- **RFC-123 directive**：stop 写 directive 紧跟 answered flip（`clarify.ts:527`/`crossClarify.ts:506`）。锁 `rfc123-*`、`clarify-stop-directive-scoped-to-clarify-rerun.test.ts`。
- **RFC-125 deferred**：默认 deferred（launch 恒发 true）。锁 `launch-deferred-dispatch`；**绝不混合两投递路径 / 不翻在飞任务 flag**（`RFC-125/proposal.md:25`）。
- **RFC-126 resume**：`failed→resume` 轮保持 answered（`lifecycleInvariants` checkCR1）、无新 `closed`/`abandoned`。锁 `lifecycle-invariants-clarify.test.ts`、migration 0066。
- **RFC-099 隔离**：逐题草稿/归属冻结（`clarifyRounds.ts:841/953`）；seal 改逐题须保归属冻结 + prompt 隔离。锁 `rfc099-*`、prompt-isolation 双锁。
- **dual-write**：`clarify-dual-write-consistency.test.ts`、`cross-clarify-dual-write-consistency.test.ts`。

## 9. 迁移（migration 0067）

存量 `answered` 轮（整轮 `answers_json`）**天然映射「全题已 seal」**：给每题在 `task_questions` 落 `sealed_at=round.answeredAt`（或派生「answered⇒全 sealed」免落列）；已 reconcile 的 designer 条目保留 `dispatched_at`。`awaiting_human` 轮=全题未 seal（draft 不变）。RFC-126 已回填历史 abandoned→answered（migration 0066），无需再处理。**遵循 RFC-125 教训：绝不中途翻在飞任务 `deferred_question_dispatch`**（`RFC-125/proposal.md:25`）；老任务按其 flag 既有分支走。多语句 migration 注意 `--> statement-breakpoint`（[migration-statement-breakpoint]）；journal +1 同步 bump `upgrade-rolling.test.ts`（[migration-bumps-journal-count-test]）。

## 10. 两入口 + defer 意图 + 逐题 seal 端点

- **新端点**：`POST /api/tasks/:id/questions/answer`（成员鉴权 `requireTaskMember`），body `{ originNodeRunId, questionId, answer, scope?, defer }`——seal 单题 merge 进 `answers_json` + 落 `task_questions.sealed_at`；`defer=true`（集中界面）→ 不立即 mint 续跑、进待指派；`defer=false`（反问页快通道）→ 现状立即（self/questioner 整轮答完续跑、designer 按现状）。或扩既有 `POST /api/clarify/:nodeRunId/answers` 接受 `questionIds` 子集 + `defer`（复用 `ensureClarifyMember`/`resumeTask`，改动更小）——实现 gate 二选一。
- **集中回答界面**（前端，净新）：任务详情新 pane，`listTaskQuestions` 取**未 seal 题**（**按 per-question `sealed_at` 判定、不能用 `answerSummary===null`，Codex 设计 gate F3**——partial 下 Q1 已 seal 但轮仍 `awaiting_human` 时 `summarizeAnswer` 对未 answered 轮恒返回 null，用 answerSummary 会把已 seal 题误判未答、被重复显示/提交）。**DTO 须新增 per-question `sealed`（源自 `sealed_at`）字段、答复摘要改为独立于轮 status 计算**。按 `originNodeRunId` 分组平铺多个 `QuestionForm` 块；逐题草稿（已支持跨轮）+ 逐题/批量「确定」调上面端点（`defer=true`）；scope 仅 cross 轮渲染、directive 按轮呈现；改派下拉 `ClarifyQuestionHandler`（designer 条目答后可用）。复用 `QuestionForm`/`Select`/`Dialog`/`Card`/`StatusChip`/`EmptyState`/`ErrorBanner`/`LoadingState`，无原生 chrome。

### 10.1 集中回答入口 + 单一提交（用户 2026-06-29 追加）

- **入口**：看板（`TaskQuestionList`）工具栏在**存在「待指派(pending)」问题时**显示一个「处理待指派问题」按钮（无待指派则不显示）→ 打开集中回答页面（任务详情 pane / 全屏 `Dialog`）。
- **反问界面功能一致 + 单一提交**：平铺**该任务所有待指派问题**（§10 分组渲染），每题复用反问回答 UI（`QuestionForm` + scope 段控 + directive + 改派下拉）+ 逐题草稿 autosave；但**只有一个「提交」按钮**——一次提交全部已填答案。提交语义：按 `originNodeRunId` 分组、对每个反问轮调一次 §10 的 seal 端点（`defer=true`），把每题草稿提升为 sealed（per-question seal）；未填的题不提交（留待指派）。提交后这些题进待指派/待下发，由看板继续选 agent + 下发。

## 11. 待下发 gate（D5）

`stageTaskQuestion`（`taskQuestions.ts:790-805`，现零答案校验）加：该题须已 seal（**按 `sealed_at!=null` 判定——不用 `answerSummary`，partial 下它不可靠，Codex 设计 gate F3**）否则 4xx；前端隐藏未 seal 题的 stage 按钮（`TaskQuestionList.tsx:344` 的 `hasStage` 加 per-question `sealed` 条件）。

### 11.1 待下发即下发（简化批量下发，用户 2026-06-29 追加）

现状看板「待下发(staged)」列每卡有勾选 checkbox（`tq-select-${id}`）+ 批量下发栏下发**所选**（`entryIds: selected`，`TaskQuestionList.tsx` §18 批量下发块）。**改为**：① staged 卡**去 checkbox**（删 `tq-select-*` + 局部 selection state）；② 「批量下发」收集**全部 staged 条目** id 下发——语义「进待下发=已确定，批量下发=全下」。后端 `POST /api/tasks/:id/questions/dispatch` **不变**（仍接 `entryIds`，前端传全部 staged）。golden-lock：无 staged → 不渲染批量下发栏（保留现有）。回归：把 §18 的「勾选→下发所选」测试改为「批量下发→全部 staged 下发」。

## 12. 测试策略（必写；先红后绿）

**纯函数/oracle**：`reconcileDesiredEntries` 门控改逐题 `questionSealed`（含「答 Q1 出 Q1 designer 条目、Q2 未答不出」）；`deriveQuestionPhase` 同轮逐题不同相位；`resolveHandlerRun` self/questioner 条目按原节点框 lineage；`sealAnswersServerSide` 接受子集/不再空数组抛错。
**service/集成**：逐题 seal（单题 merge、轮不翻、同题不可重 seal、兄弟可答）；全题 seal 才 answered（RFC-126 resume 不变量）；defer=true 进队列不续跑 / defer=false 立即；designer 逐题下发借壳（部分下发、CAS 防重）；**self/questioner 逐题重跑三坑回归**（兄弟题标注注入、条目级消费戳不串题、节点级 directive 继承、下游 freshness 取最终）；stage gate 拒未答；prompt-isolation 双锁；§8 破坏面全套绿。
**前端 vitest**：集中回答面平铺/分组/逐题确定；`/clarify` 已 seal/已下发题置灰只读+提交排除；stage 按钮对未答题隐藏。
**门槛**：typecheck+test+format:check 全绿 + CI + Codex 双 gate（[feedback-codex-review-after-changes]）+ push 后查 CI（[feedback-post-commit-ci-check]）。

## 13. 落地顺序 + PR 拆分（详见 plan.md）

1. **P0 锁网**：先补整轮 seal 全链路回归网（self 单 rerun / cross cascade / §18 部分下发 / RFC-126 resume / RFC-070 aging），再动刀。
2. **P1 落库地基**（纯后端 golden-lock）：`task_questions` 加 `sealed_at`；`reconcileDesiredEntries` 门控改逐题；`answers_json` 逐题 merge；轮 answered 仅全 seal 翻。
3. **P2 逐题 seal 端点 + defer 意图**：新 answer 端点 / 扩 `/answers`；待下发 gate。
4. **P3 designer 逐题下发**（复用 §18 + RFC-127 借壳）。
5. **P4 两入口 UI**：集中回答面（看板）+ `/clarify` 置灰协调。
6. **P5 self/questioner 逐题重跑**（最高风险、单独 PR、单独 Codex gate）：三坑缓解 + §5.2 自检表。
   > 强约束：先 P0 锁网再改；self/questioner（P5）末位、可独立回退而不影响 P1–P4 的 designer 主线。
