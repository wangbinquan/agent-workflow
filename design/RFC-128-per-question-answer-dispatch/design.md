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

### 5.2 self/questioner 逐题重跑（**深度重构** —— 用户拍板；Codex gate 头号审查）

> 本节为 P5 的**深度重构方案**（用户 2026-06-30 拍板深度重构，**非**最小补丁）。Codex feasibility 诊断（§5.2.2）判定：最小 delta 下 §5.2 五项自检全 FAIL + double-injection 结构 blocker + 无 minimal-delta clean path；但**复用 designer per-question 基建**（§5.1）有 clean path。本节给该 clean path 的接口契约 + 裁决 + 黄金锁 + 测试。落地分阶段见 `plan.md §RFC-128-P5`。证据 file:line 基于 2026-06-30 HEAD，**以符号名为锚**。
>
> **Codex 对抗设计 gate（2026-06-30）verdict = needs-attention，追加 4 findings（方案层漏洞，已 fold，下一轮重过 gate 须 CLEAN 才实现）**：F1〔high〕P5-B 非独立回退点 → P5-B+P5-C **合并为 P5-BC** 一个 rollback 单元（§5.2.3 ③ 回退耦合 + §5.2.9）；F2〔high〕dispatch broadening 缺 self/q seal gate → 新增 **dispatch readiness gate**（§5.2.11）；F3〔high〕三账本 collapse 缺 rerun-cause semantics → **rerun-cause 契约 + collapse 推翻**（§5.2.12，早稿「同 agent 放行 collapse」作废）；F4〔medium〕mixed questioner/designer 同 origin 撞 per-origin single-target → **mixed-role grouping**（§5.2.13）。fold 落点集中在 §5.2.3 ③/④ + 新 §5.2.11/12/13 + §5.2.9 分阶段。
>
> **Codex 对抗设计 gate 第二轮（2026-06-30）verdict = needs-attention，追加 4 个闭环 findings（方向第一轮已确认对，本轮为闭环细节；已 fold，下一轮〔第三轮〕须 CLEAN = ship-design 才实现）**：R2-1〔high〕P5-BC「可回退」只解决代码拆分、未解决 **live state 回退** → 补 **rollback playbook**（drain-then-rollback；§5.2.9 + 回退闸 §5.2.10 + §5.2.3 ③ 注）；R2-2〔high〕串行化所依赖的 in-flight gate（`assertNoInFlightDispatch`）现为 **designer-only**、未扩域 self/q dispatched entries → **硬写 in-flight gate 扩域契约**（§5.2.12 contract 3）；R2-3〔medium〕同 home 混 cause 的**用户推进路径未闭环**（与「批量下发=全部 staged」冲突、会陷「全量提交→全量 reject」死循环）→ **route auto-split 推进契约**（§5.2.13 + §11.1）；R2-4〔medium〕黄金锁**注入逐字一致缺显式条件** → **full-round 同批=legacy byte-compatible（无 sibling/status 块）、仅 partial 才加**（§5.2.6 + clean-path ①）。Codex 同轮确认 **F2 readiness predicate 放 `dispatchTaskQuestions` 服务层、F4 per-origin designer-scoped + self/q per-home 方向正确、不再改**。

#### 5.2.0 勘误（醒目）：live 调度路径 ≠ §5.2 早稿所指函数

§5.2 早稿与 §5.1 把 self/questioner 整轮注入指向 `buildClarifyPromptContext`（`services/clarify.ts:677`）/ `buildQuestionerCrossClarifyContext`（`crossClarify.ts:1660`）。**这两个函数在 live 调度路径已死**——全仓除自身定义外的调用点**全在测试**（`clarify-service.test.ts` / `cross-clarify-questioner-context.test.ts` / `scheduler-clarify-baseline.test.ts` 等；src 内只剩注释引用，RFC-058 T13 已统一）。**真正的 live self/questioner 整轮注入**链路是：

```
buildPromptContext(clarifyRounds.ts:355)                ← 统一读侧（consumerKind = self | cross-questioner）
  ↑ scheduler.ts:2417 / 2442                            ← 唯一 live 调用点
  ↑ selectAnsweredRoundsForConsumer(clarifyRounds.ts:226) ← 整轮选答（status='answered' + consumed IS NULL）
```

整轮**消费戳**的 live 入口是 `markClarifyRoundsConsumedBy`（`clarifyRounds.ts:97`）← `runner.ts:1551`（节点 done+output 后整轮 stamp `consumed_by_consumer_run_id` / `consumed_by_questioner_run_id`）。

**P5 改的是这些 live 函数**，不是死的 `buildClarifyPromptContext` 系（删死函数属独立清理、不在本 RFC 范围）。

#### 5.2.1 latent bug（§0 stranding）：defer 控制通道对 self/q 不设防 —— P5-0 前置 hotfix

`deferred_question_dispatch=true` 控制通道（RFC-120 §18 park gate + RFC-125 默认 deferred）**只对 designer 角色设防**：park 源 `loadUndispatchedDesignerTargets`（`taskQuestions.ts:598`）仅扫 designer 条目；`dispatchTaskQuestions`（`taskQuestionDispatch.ts:198`）仅下发 designer（`roleKind='designer'` 过滤 `:240` / `:258`）。于是 **deferred 任务下 self/questioner 全题 seal 会 strand**：

- 中间 clarify node 关 done（§1 步骤 ⑥）+ 建 self/q `task_questions` 条目，但 **不 mint rerun**（deferred 下 self/q 续跑本应延到 dispatch，却无 dispatch 入口接它）；
- `dispatchTaskQuestions` **拒** self/q（designer-only）；
- **无任何 park 源**把提问节点钉在 frontier 外（designer park 源不认 self/q 条目）；
- **结果**：任务越过提问节点继续推进 / 收尾，self/q **rerun 永不触发** → 答案石沉、下游用未续跑的旧产出。

**P5-0 前置 hotfix**（可独立合、先于深度重构）：堵这条 strand——deferred 任务遇 sealed-无-path 的 self/q 条目时**不静默推进**。**取「显式拒 seal-without-path」而非 park**（Codex 设计 gate F1 修订）：dispatch 放开要到 **P5-BC**（§5.2.9）才到位，P5-0 此刻若改 park 会把提问节点钉在 frontier 外却**无 release path** → 永久 park / 永久 awaiting_human（与 F1 同根，§5.2.3 ③）。故 P5-0 **硬拒**「无 dispatch path 时 full-seal self/q」（4xx 可观测 error），保证 **P5-BC 合并单元落地前绝无 stranded full-sealed self/q**；park 留到 P5-BC（与其 dispatch release path 同单元落）。详见 `plan.md §RFC-128-P5-0`。

#### 5.2.2 Codex feasibility 诊断结论

对「最小 delta」（只在 self/q 续跑处加逐题分支）做对抗诊断：

- **§5.2 五项自检全 FAIL**：整轮 mint 一条 rerun + 整轮消费戳 + 整轮注入三者强耦合，逐题切入会令 provenance 串题（①）、多题互相误抑/误 park（②）、注入泄漏或漏答（③）、stop 与未下发兄弟死锁（④）、级联失控（⑤）。
- **double-injection blocker**：整轮读侧 `selectAnsweredRoundsForConsumer` 与任何 per-question 注入并存 → 同答案注两遍（§5.2.5）。
- **no minimal-delta clean path**：最小补丁无法同时满足五项 + 不破 double-injection。
- **但深度重构有 clean path**：designer 域的 per-question 基建（§5.1：`buildNodeQueueExternalFeedback` 逐题注入 + `dispatched_at` / `trigger_run_id` 逐题消费 + `loadUndispatchedDesignerTargets` park + `resolveDesignerBorrowForNode` 借壳）已被 RFC-120/127 打磨过——self/questioner 逐题**镜像**这套即得 clean path。下节给四项精确设计。

#### 5.2.3 四项 clean-path 精确设计（镜像 designer 已验证基建）

每项给 file:line + 改点 + 对抗检查。

**① 整轮注入 → per-question 注入**

- 现状 live：`buildPromptContext`（`clarifyRounds.ts:355`）← `scheduler.ts:2417/2442` 整轮注入 self/q。
- 改：新增 `buildClarifyNodeQueueContext`——**镜像 designer 的 `buildNodeQueueExternalFeedback`**（`crossClarify.ts:1412`）：按「effective handler==本节点 + `dispatched_at` set + 未消费」选**逐题**，rerun 时绑 `trigger_run_id`（step2，见 ②），只取被下发 `questionId` 的答案；但**渲染走 `ClarifyPromptContext` 形态**（`buildPromptContext` / `buildClarifyPromptBlock` 同款，使 self/questioner prompt 装配保持 drop-in）。**兄弟题状态块按「是否 partial」条件附加（Codex 设计 gate 第二轮 R2-4）**：当本批 dispatched 集**覆盖该轮全部题**（full-round 同批下发）→ **不附** sibling/status 块、**不加**「只处理本题」指令，逐字回落 legacy `buildPromptContext` 渲染（黄金锁 §5.2.6 注入轴的前提）；仅当**存在未同批下发的兄弟题**（partial）→ 才附「兄弟题状态标注块（pending / in-queue / 已处理）+ 只处理本题、勿重复追问」。条件判据 = 「round 内是否有题不在本次 dispatched 集」。
- **scheduler 二选一 suppress**：deferred self/q 节点续跑时，scheduler 在 `buildPromptContext`（整轮）与 `buildClarifyNodeQueueContext`（逐题）之间**二选一、绝不并用**（与 §5.2.5 读侧排除子句双向锁死 double-injection）。
- 对抗检查：兄弟题标注块**不含归属**（owner / 角色 id），过 RFC-099 prompt-isolation 双锁（自检 ③）。

**② 整轮消费戳 → per-entry `trigger_run_id`**

- 现状 live：`markClarifyRoundsConsumedBy`（`clarifyRounds.ts:97`）← `runner.ts:1551` 整轮 stamp。
- 改三处：
  - **step2 绑定**：① 的新 builder 续跑时**逐条目**绑 `trigger_run_id`（自此 self/q 消费 per-entry，不再整轮）。
  - **`markClarifyRoundsConsumedBy` deferred suppress**：deferred 且该轮 self/q 走了逐题下发时，**不整轮 stamp** `consumed_by_consumer_run_id` / `consumed_by_questioner_run_id`（逐题 `trigger_run_id` + `resolveDispatchedEntryHandler` 成为消费预言；整轮戳会误抑兄弟题）。
  - **`resolveEntryHandler` 放开**：读侧对 deferred self/q 条目改走 `resolveDispatchedEntryHandler`（`taskQuestions.ts:334`）——designer 同款 dispatched-entry lineage（`resolveHandlerRun`（`shared/task-questions.ts:271`）按**原节点**框窗，RFC-127 §5 同款），而非 round-stamp 的 immediate 路径（`resolveTriggerForEntry`（`taskQuestions.ts:303`））。
- 对抗检查：每条逐题 rerun 只 stamp/消费它那题，provenance 唯一不串题（自检 ①）。

**③ 新增 `loadUndispatchedSelfQuestionerTargets` park 源**

- 镜像 `loadUndispatchedDesignerTargets`（`taskQuestions.ts:598`），但**判据按 `sealed_at`、不 join 轮 status**：partial 下轮恒 `awaiting_human`（§2），designer park 源的 `eq(clarifyRounds.status,'answered')` join（`:627`）+ `directive='continue'`（`:630`）会漏掉所有 partial 的 self/q 题——故新源**不 join `clarifyRounds.status`**，改以 `sealed_at IS NOT NULL` + `dispatched_at IS NULL` 判「已答未下发」。其余 undispatched / in-flight / consumed 分类与 designer 逐字同构（`dispatched_at` NULL→park；dispatched 未绑（`trigger_run_id` NULL）→in-flight；dispatched 绑了但 handler 未 done+output→in-flight；consumed→释放）。
- **union 进 `scheduler.ts:811-812`**：与 `loadUndispatchedDesignerTargets` 并集进 `deferredHandlerNodeIds`；自门控 deferred flag（非 deferred 恒空 → 黄金锁）。
- **回退耦合（Codex 设计 gate F1）**：此 park 源**不得单独先于「dispatch 放开」（④ / §5.2.13）落地**——park 把提问节点钉在 frontier 外，唯一 release path 是 dispatch→mint rerun→consume；若 park 已落而 dispatch 未落（或被单独回退），sealed self/q **永久 park → 永久 awaiting_human**（把已知 strand 变成不可恢复态）。故 **park 源（③）与 dispatch 放开（④）必须同属一个 shippable / rollback 单元（P5-BC，§5.2.9），不可分别回退**；P5-0 硬拒（seal-without-path）兜底「P5-BC 落地前无 full-sealed self/q」。
- **注（Codex 设计 gate 第二轮 R2-1）：代码回退 ≠ live state 回退**。F1 合并消除的是**代码级** stranded（park 与 release path 同单元）；但「P5-BC 可回退」仅指**代码可回退**——一旦 P5-BC 在生产已产生 self/q 的 `sealed_at` / `dispatched_at` / in-flight dispatch 状态，旧代码无 self/q park / dispatch / per-entry consume path、P5-0 只拒未来 seal-without-path 不清既有状态 → 既有 self/q dispatch 状态 stranded。安全回退须先 **drain（或迁移）live 状态**，详见 §5.2.9 rollback playbook。
- 对抗检查：同节点多题不互相误 park（自检 ②），逐题 in-flight 不 strand 兄弟（沿用 designer Codex H1 分类）；park 与 release path 同单元（F1）。

**④ 三账本 borrow + 配套 dispatch 放开（Codex 设计 gate 修订：collapse 推翻 + 三契约）**

- 现状：`resolveBorrowForNode`（`taskQuestionDispatch.ts:672`）合 `resolveImmediateBorrowForNode`（`:774`，self/q **即时**续跑账本）+ `resolveDesignerBorrowForNode`（`:706`，designer **deferred** 账本）=**两账本**，且**任何同 home 双账本重叠一律拒**（`:692-697`，**含同 agent**）——comment 言明即便同 agent 也拒，因 immediate 与 designer 是**两条独立 pending node_run**、跑起来重复执行（"round 2 caught the deeper duplicate-execution hazard"）。
- 改：新增**第三账本** `resolveDeferredSelfQuestionerBorrowForNode`——**镜像 `resolveDesignerBorrowForNode`**（deferred / `dispatched_at` 消费判据 `isDispatchedEntryConsumed`，**非** immediate 的 round-stamp 路径）；接进 `resolveBorrowForNode` 成三账本。
- **冲突规则（关键裁决，Codex 设计 gate F3 推翻早稿 collapse）**：deferred-selfQ vs deferred-designer 同 home——**一律拒（不 collapse、不论同异 agent）**，与既有 immediate×designer 同规则。**早稿「同 agent→放行（一条 rerun 两 context 槽）」作废**，根因：**一条 `node_run` 只有一个 `rerun_cause` 列**，而 self/q 与 designer 的 cause **互斥**——self→`clarify-answer`、questioner→`cross-clarify-questioner-rerun`（`isClarifyRerunCause` TRUE：inline resume + directive gating）vs designer→`cross-clarify-answer`（`isClarifyRerunCause` FALSE：retry-agnostic update mode，`nodeRunMint.ts:239-240`）。坍缩成一条 rerun 必然给错 cause → 自检①provenance / scheduler mode 至少一方错（详见 §5.2.12）。早稿据以区分二者的「immediate 已 mint vs deferred 延 mint」**不是** blocker——cause 单值且互斥才是；「延到 dispatch」**不**能让它们共用一条 rerun。故同 home 由 dispatch-time per-home **single-cause** gate（§5.2.13）+ `assertNoInFlightDispatch`（`:342-352`）**串行化**（先下发一角色、其 rerun done+output 后再下发另一个）。
- **配套 `dispatchTaskQuestions` 去 designer-only**：放开 `:240` / `:258` 的 `roleKind='designer'` 过滤，使 deferred self/q 条目也能批量下发。但放开**带三个新契约**（早稿缺，Codex 设计 gate F2–F4 补）**+ 第二轮 2 闭环细化（R2-2 (d) / R2-3 (e)）**，详见对应小节：
  - **(a) dispatch readiness gate**（F2，§5.2.11）：self/q 条目**无条件**建（`task-questions.ts:99-117`，**非** designer 的 seal-gated），故放开后 `dispatchTaskQuestions` 必须自校每条 clarify-derived 条目 `sealed_at != null`（或所属轮 answered）否则 reject——否则一条未 seal self/q 条目可被下发+绑（答案还不存在）→ 空/未答 rerun + 经读侧 dispatched 排除（§5.2.5）抑整轮路径。
  - **(b) rerun-cause 契约**（F3，§5.2.12）：dispatch mint cause 从硬编码 `cross-clarify-answer`（`taskQuestionDispatch.ts:984`）改为**按角色派生**（self→`clarify-answer`、questioner→`cross-clarify-questioner-rerun`、designer→`cross-clarify-answer`）；一个 home 本批须 **cause 同质**，混角色 cause → reject（串行化）。
  - **(c) mixed-role grouping**（F4，§5.2.13）：per-origin 单 target 校验（`:269-279`）**保持 designer-scoped**（designer session 整轮单一 handler 消费）；self/q 另设 per-home single-borrow 校验（镜像 immediate ledger P2-1，`:829-845`）；questioner+designer 同 origin 但 home 合法不同 → 允许一起 dispatch（整轮 sealed cross round 一个 batch 下发）。
  - **(d) in-flight gate 扩域**（第二轮 R2-2，§5.2.12 contract 3）：上 (b) 串行化所依赖的 `assertNoInFlightDispatch`（`:591`）现 designer-only（`:602`）→ 必扩到**任一 deferred role** 的 dispatched 条目，否则同 home 先 self/q、后 designer **跨批**仍双 mint。串行化的**跨批**物理半。
  - **(e) route auto-split 推进**（第二轮 R2-3，§5.2.13 + §11.1）：§11.1「批量下发=全部 staged」+ 删 checkbox → 同 home 混 cause 全 staged 时 route **不整批 reject**，而是**自动分安全批**（一 home 一时刻一 cause 类、余留 staged + 回延后分组），免「全量提交→全量 reject」死循环。串行化的**同批**物理半。
- 对抗检查：stop 与未下发兄弟不死锁（自检 ④，见 §5.2.4 裁决）；同 home 双角色不重复执行（三账本拒 + single-cause gate + in-flight gate 扩域〔R2-2〕 + auto-split〔R2-3〕）；整轮 cross round 不被 per-origin 校验误拒（§5.2.13）。

#### 5.2.4 §5.2 五项自检满足表 + ④裁决

五项自检（采纳 `RFC-125/plan.md` 的「v2 design 全套硬化」），逐项落到上面 clean-path：

| #   | 自检项                                | 满足来源                                                                                                                                                                                                    |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 逐题 rerun provenance 戳唯一、不串题  | clean-path ②（per-entry `trigger_run_id` + deferred suppress + `resolveDispatchedEntryHandler` 按原节点框 lineage）**+ §5.2.12 role-appropriate cause（保 scheduler mode 与 provenance 一致，非串 cause）** |
| ②   | 同节点多题不互相误抑 / 误 park        | clean-path ③（`loadUndispatchedSelfQuestionerTargets` undispatched/in-flight 分类）+ §5.2.5 per-round 排除                                                                                                  |
| ③   | 兄弟题标注块不泄漏归属（RFC-099）     | clean-path ①（新 builder 走 `ClarifyPromptContext` 形态、标注块零归属字段；prompt-isolation 双锁）                                                                                                          |
| ④   | stop directive 与未下发兄弟共存不死锁 | **④裁决**（下）                                                                                                                                                                                             |
| ⑤   | 末题 / 中间产出的下游级联次数可控     | freshness 取最终（`freshness.ts` 最新 done 胜）+ 黄金锁（全 seal 批量下发=一条 rerun=一次级联，§5.2.6）；v1 接受多 dispatch 批=多级联（最终正确），批数由用户控                                             |

**④裁决（节点级 directive，不下沉逐题）**：directive 保持**节点级**（RFC-123 单一事实源，§3）。逐题「停某题」**不引入 per-question directive**，而用「**不-seal / 不-dispatch 该题**」表达（缺席即停）——park 源（③）只认 `sealed_at` + 未下发条目，被停（未 seal）的题**不进 park 源**，故不死锁；节点级 stop directive 对整轮仍如旧。**不做 per-question directive 以护 RFC-123 单一事实源**；该裁决已记入**非目标**（proposal §2.2 / D3）。

> **dispatch-broadening 半的三契约（Codex 设计 gate F2/F3/F4，护本表 ①/②/⑤）**：去 designer-only 过滤不是单点改——配套 **dispatch readiness gate**（§5.2.11，护①②：未 seal 条目不得下发/绑/误抑整轮）+ **rerun-cause 契约**（§5.2.12，护①⑤：role-appropriate cause、collapse 推翻、cause 单值）+ **mixed-role grouping**（§5.2.13，护④⑤：per-origin designer-scoped、整轮 cross round 一批下发）。三者落 P5-BC（§5.2.9），单独 Codex gate 复审。**第二轮（R2）再补 2 个闭环细化**：**in-flight gate 扩域**（§5.2.12 contract 3 / R2-2，护①串行化跨批不双 mint）+ **route auto-split 推进**（§5.2.13 / R2-3，护用户路径不死锁）；合计五契约同落 P5-BC、第三轮 gate 复审。

#### 5.2.5 double-injection 结构性根除

per-question 注入（§5.2.3 ①）与整轮读侧 `selectAnsweredRoundsForConsumer`（`clarifyRounds.ts:226`）并存会令同答案注两遍（一次整轮、一次逐题）。**结构性根除（非靠时序）**：

- **读侧 per-round 排除子句**：`selectAnsweredRoundsForConsumer` 的 self（`:229-249`）/ cross-questioner（`:283-300`）分支各加「该轮**无任何 dispatched 逐题条目**」（`NOT EXISTS` dispatched self/q `task_questions`）——有逐题下发的轮从整轮读侧排除，逐题 builder 成唯一注入者。
- **判据用 `dispatched_at`、非 `sealed_at`**：sealed-未-dispatched 的题尚未被逐题注入（dispatch 才触发逐题注入），用 `sealed_at` 会误排「已 seal 待下发」轮 → 漏注。
- **scheduler 二选一**（§5.2.3 ① 的 suppress）：scheduler 对一个 (节点, 轮) 选整轮 XOR 逐题。**读侧排除 + scheduler XOR 双向锁死**：每轮答案恰好一条注入路径。

#### 5.2.6 黄金锁（golden-lock）

- **非 deferred 任务：零改字节级**。所有新路径（③ park 源、④ deferred-selfQ 账本、② deferred suppress、⑤ 读侧排除）**自门控 deferred flag**——非 deferred 恒空 / 不活、走旧整轮 self/q 续跑逐字不变。
- **deferred 任务全 seal + 一次批量下发 = 旧整轮逐字**：一轮所有题一次 seal 并在一个 batch 全下发时，逐题 builder（①）覆盖该轮全部题 = 旧整轮 `buildPromptContext` 注入逐字相同；**四面对齐**——注入（全题=整轮）/ mint（一条 rerun，**cause 按角色派生 = 旧整轮 cause**：self `clarify-answer`〔`clarify.ts:494`〕、questioner `cross-clarify-questioner-rerun`〔`crossClarify.ts:1055`〕，§5.2.12）/ 消费（等价整轮戳）/ 级联（一次下游）。**「mint 对齐」以 §5.2.12 role-appropriate cause 为前提**——若沿用早稿硬编码 `cross-clarify-answer`，self/q rerun 的 cause 与旧整轮不一致、`isClarifyRerunCause` 翻 FALSE，黄金锁即破。这条是 P5 的回归基准（§5.2.10）。
- **注入轴逐字的显式条件（Codex 设计 gate 第二轮 R2-4）**：上「四面对齐」的**注入轴**仅在新 builder（clean-path ①）对 **full-round 同批**走 **legacy byte-compatible 渲染**时成立——即 dispatched 集**覆盖该轮全部题**时 builder **不附** sibling/status 块、**不加**「只处理本题」指令，prompt 文本与旧整轮 `buildPromptContext` 逐字相同。若 builder **无条件**附 sibling/status 块（即便 full-round），则即便 mint / 消费 / 级联三轴对齐、**注入轴在文本层即破**黄金锁（新增的兄弟题状态块/指令是旧整轮没有的字节）。故黄金锁的成立前提 = builder 的「**partial 才加 sibling/status**」条件（§5.2.3 ①）：sibling/status 块**只在 partial（有兄弟题未同批下发）出现**，full-round 同批一律不出。

#### 5.2.7 RFC-125 遵守 + P5b 单路径裁决

- **任务级 deferred flag 是唯一路径源、终生不变**（RFC-125：launch 恒发、绝不翻在飞任务 flag）。
- **deferred 任务的 self/q 也延迟**；`defer` 只决定「**自动 vs 手动触发 dispatch**」，**不引入第二投递路径**。
- **不翻在飞 flag、不单轮混路**：§5.2.5 的 per-round 排除保证**单轮单路径**（一轮要么整轮、要么逐题，不混）。
- 此即 **P5b 裁决**：P5 在 self/q 上严守 RFC-125「单任务单投递路径」，不重蹈 RFC-125 6 findings 的混路根因。

#### 5.2.8 无新列 / 无 migration

P5 **不加列、不加 migration**：复用既有 `trigger_run_id` / `dispatched_at` / `sealed_at`（migration 0068，P1 已落）/ `agent_override_name`（`schema.ts:802`）。journal **维持 68**（`upgrade-rolling.test.ts:231`），不触发 [migration-bumps-journal-count-test]。

#### 5.2.9 分阶段路线（详见 `plan.md §RFC-128-P5`）

P5-0（stranding **硬拒** seal-without-path，可独立合）→ P5-A（锁网）→ **P5-BC（park 源 + 读侧相位 + dispatch 放开 + readiness gate + rerun-cause 契约 + mixed-role grouping + in-flight gate 扩域〔R2-2〕 + route auto-split〔R2-3〕 + 注入〔含 R2-4 注入条件〕 + 消费 + 借壳，合一个 rollback 单元，核心，单独 Codex gate）** → P5-D（快通道 seal + autodispatch）。

**回退点重画（Codex 设计 gate F1）**：早稿把 park 源（P5-B）与 dispatch 放开（P5-C）拆成两个回退点 → 若 P5-B 留、P5-C 回退，deferred self/q 会**永久 park / 永久 awaiting_human**（park 无 release path，把已知 strand 变成不可恢复的永久 awaiting_human）。故铁律：**每个 parked state 必须在同一 shippable / rollback 单元里有 dispatch release path**——P5-B+P5-C **合并为 P5-BC，不可分别回退**；P5-0 硬拒（seal-without-path）兜底「P5-BC 落地前无 stranded full-sealed self/q」。**回退点由五个（P5-0/A/B/C/D）收为四个（P5-0 / P5-A / P5-BC / P5-D）**；每阶段独立验收 + 回退点；子 PR 拆分见 plan。

**rollback playbook（live state 回退，Codex 设计 gate 第二轮 R2-1 + 第三轮 R3-1）**：F1 把 park 源 + dispatch release path 合并进 P5-BC，消除了**代码级** stranded；但「P5-BC 可单独回退到 P1–P4 + P5-0/A」**仅对代码成立**。一旦 P5-BC 在**生产**已产生 self/q **live 状态**（任一 self/q 条目 `dispatched_at` 已戳 / `trigger_run_id` 已绑 / 轮处 partial in-flight，**或** —— R3-1 —— 任一 self/q 条目 `sealed_at` 已戳但 `dispatched_at` 仍 NULL〔sealed/staged 待下发，被 `loadUndispatchedSelfQuestionerTargets` 按 `sealed_at IS NOT NULL + dispatched_at IS NULL` 收住 park〕），**代码-only 回退会 strand 这些状态**——回退后的旧代码：(i) 无 `loadUndispatchedSelfQuestionerTargets` park 源 → 不再把 asking 节点钉在 frontier 外（节点可能已推进越过，**含 R3-1 的 sealed-未-dispatch 条目**——它原本靠这条 park 源把持）；(ii) `dispatchTaskQuestions` 恢复 designer-only → 不再下发 self/q；(iii) 无 per-entry consume path（整轮戳 + immediate ledger 不认 self/q 的 `dispatched_at`）→ 已 dispatched 的 self/q 条目**永不 consume**；(iv) P5-0 narrowed 只**拒未来** non-deferred full-seal、**不清既有**状态，且 deferred 任务的 full-seal 已关闭中介 node_run + 翻轮 answered（释放 asking-run park）→ **sealed-未-dispatch 的 self/q 条目失去唯一 release path**；(v) 旧整轮 path 不认 `sealed_at`（它只读 round-level answered + 整轮戳）→ **R3-1: sealed/staged-但-未-dispatch 的 self/q live 条目无人接管**。⟹ 既有 self/q live 状态（dispatched **或** sealed-未-dispatch）石沉。

> **铁律：P5-BC 一旦在生产产生 self/q live 状态即不可「无数据处理」回退。「无 dispatched in-flight」≠「live self/q 状态可回退」（R3-1）——sealed/staged-但-`dispatched_at` NULL 的条目同样 strand。** 安全回退须前置以下任一：
>
> - **drain-then-rollback（首选）**：① **禁写**——**同时** quiesce self/q 的 **answer / stage / dispatch** 三条入口（R3-1：不只关 dispatch——还须停止新 self/q 控制通道 seal + 停止 stage，否则边 drain 边产生新 sealed-未-dispatch 条目），不再产生**任何**新 self/q live 状态；② **drain**——(a) 等所有 in-flight self/q dispatched 条目跑到 consumed（handler rerun done+output，判据同 `isDispatchedEntryConsumed`〔`taskQuestionDispatch.ts:566`〕）；**(b) R3-1：把所有 sealed/staged-但-未-dispatch 的 self/q 条目（`sealed_at IS NOT NULL + dispatched_at IS NULL`）也 dispatch 到 consumed**（或按下「migrate」清掉）——否则它们回退后无 park/release path；③ **队列清空判据扩为「无 unconsumed dispatched self/q 条目 **且** 无 `sealed_at IS NOT NULL` 未被旧整轮 path 接管的 live self/q 条目」**，满足后方可代码-only 回退。
> - **migrate-then-rollback（备选）**：对既有 self/q live 状态做数据迁移——清 self/q 条目的 `dispatched_at` / `trigger_run_id` / `sealed_at`、把相关轮按 RFC-070 整轮戳重置为「整轮消费」语义（**含把 sealed-未-dispatch 的轮还原成旧整轮 path 能接管的形态**——R3-1），使旧整轮 path 能接管；较重、需单独 migration + 回归。
>
> 故 plan 的 P5-BC 回退点措辞从「可单独回退」改为「**代码可回退；但 live self/q 状态（dispatched in-flight **或** sealed-未-dispatch——R3-1）须先 drain（或迁移），否则不可无数据回退**」（plan `§RFC-128-P5` 顶 + `§RFC-128-P5-BC` 标题注 + 验收清单）。

#### 5.2.10 测试清单

§5.2 五项自检各一条红→绿 + 三坑回归（兄弟题标注注入、条目级消费戳不串题、节点级 directive 继承、下游 freshness 取最终）+ double-injection（per-round 排除 + scheduler XOR）+ **五契约（三 + 第二轮 R2-2/R2-3 闭环）**（§5.2.11 readiness gate：unsealed self/q entryIds → reject；§5.2.12 rerun-cause：role-appropriate cause 三角色各对 + 同 home 混 cause/双角色拒 + `rfc098-rerun-cause-gates` 真值表不破，**+ R2-2 in-flight gate 扩域：同 home 先 self/q dispatched〔rerun 未 done+output〕→ 后 designer 同 home 第二批被 `assertNoInFlightDispatch` 挡、done+output 后放行**；§5.2.13 mixed-role：整轮 cross round〔questioner+designer 异 home〕一批下发成功 / designer 多 handler 仍拒 / self/q home==designer home 触串行化，**+ R2-3 auto-split：同 home self/q+designer 全 staged 一次「批量下发」→ 下发 self/q 半 + designer 半留 staged + response 含延后分组、不 reject、无全量死循环；混入 unsealed → 仍 readiness 整批 reject〔precondition 优先〕**）+ 黄金锁（非 deferred 零改 / deferred 全 seal 批量下发 = 旧整轮逐字，**含 cause 对齐 + R2-4 注入条件：full-round 同批 builder 走 legacy byte-compatible〔无 sibling/status 块〕逐字回落、partial 才加块**）+ **不破存量**（rfc098 rerun-cause 真值表 + rfc120 / 125 / 126 / 127 全套 + 本 RFC P0–P4）。详见 `plan.md §RFC-128-P5` 各子阶段验收。

> **回退闸**：任一自检不过 / Codex gate 复现 RFC-125 级致命问题 → 带证据回退 **P5-BC**（P1–P4 designer 主线 + P5-0/A 不受影响），与用户重新权衡（proposal §6）。**P5-BC 是最小回退单元**（park + dispatch release path 同单元，F1，不可再拆）。
> **回退闸（live state，Codex 设计 gate 第二轮 R2-1）**：上「回退 P5-BC」的「P1–P4 + P5-0/A 不受影响」仅指**代码层**；若 P5-BC 已在生产产生 self/q dispatch 状态，回退**前**须按 §5.2.9 rollback playbook 先 **drain（禁写 + 等 in-flight self/q dispatched consume 清空）或迁移**，否则既有 self/q dispatch 状态 stranded。**代码可回退 ≠ live state 可无数据回退**。

#### 5.2.11 dispatch readiness gate（Codex 设计 gate F2）

**问题**：self/questioner 的 `task_questions` 条目对每题**无条件**建——`reconcileDesiredEntries` 的 self（`shared/task-questions.ts:99-108`，恒一条提问节点承接条目）/ questioner（`:110-117`，「反问者条目恒有，永远自我续跑，与 scope 无关」）分支恒 push，与 seal / scope 无关；**不像 designer 条目 seal-gated**（`:118-132` 仅 `questionSealed[qid] && directive!=='stop' && scope==='designer'` 才出）。现 `dispatchTaskQuestions`（`taskQuestionDispatch.ts:198`）只按 `roleKind='designer'` + `dispatched_at IS NULL` 选（`:232-244`），**无 seal 校验**——因 designer 条目存在即已 seal，故无需校。一旦 §5.2.3 ④ 去 designer-only 过滤、route 接任意 `entryIds`，一条**未 seal** 的 self/q 条目即可被传入下发 + 绑 `trigger_run_id`（**答案还不存在**）→ ① 空/未答 rerun（注入「User did not answer this question.」却已消费）；② 经 §5.2.5 读侧 dispatched 排除，把整轮从整轮注入路径剔除 → **整轮路径被一条未 seal 条目误抑**（empty/unanswered rerun + suppress 整轮）。

**契约**：`dispatchTaskQuestions` 加 **readiness predicate**——每条 clarify-derived 条目（含 self / questioner / designer）必须 `sealed_at != null`（或其所属 `clarify_rounds.status='answered'`，二者择一即可；可选再要求 `staged_at != null` 与 §11 待下发 gate 对齐）否则**整批 reject**（fail-fast、不部分下发，与既有 per-origin 校验同风格、同 4xx 形态）。designer 条目天然满足（seal 才被 reconcile 出）；新增校验真正约束的是放开后的 self/q 条目。

- **判据用 `sealed_at`、不用 `answerSummary`**（与 §10/§11 的 Codex 设计 gate F3 同源）：partial 下轮恒 `awaiting_human`，`summarizeAnswer` 对未 answered 轮恒返回 null，用 answerSummary 会把已 seal 题误判未 seal。
- **测**：「unsealed self/q entryIds → reject（4xx，nothing stamped / minted）」红→绿；「sealed self/q entryIds → 正常下发」；readiness gate 与 per-origin / per-home 校验并行不被绕过。

#### 5.2.12 rerun-cause 契约 + collapse 裁决（Codex 设计 gate F3）

**根因**：早稿（§5.2.3 ④ 原文）称 deferred-selfQ + deferred-designer 同 home **同 agent** 可「collapse 成一条 rerun 携两 context 槽」。**该假设错**，证据链（代码权威）：

- dispatch mint 现**硬编码** `cause: 'cross-clarify-answer'`（`taskQuestionDispatch.ts:984`，`buildFrontierMintPlan`）。
- scheduler 的 self/q 语义（inline session resume + review/directive gating，`scheduler.ts:2297` `isClarifyRerun`）按 `isClarifyRerunCause` 判，**只认** `clarify-answer` + `cross-clarify-questioner-rerun`（`nodeRunMint.ts:239-240`），**故意排除** `cross-clarify-answer`（designer 走 retry-agnostic `isCrossClarifyTriggeredRerun` update-mode，`nodeRunMint.ts:225-229`）。
- 一条 `node_runs` 行**只有一个** `rerun_cause` 列。
- ⟹ 把 self/q 与 designer 坍缩成一条 rerun：cause 取 `cross-clarify-answer` → self/q 半失去 inline resume + latest-directive（**文本可能对、scheduler mode 错**）；取 `clarify-answer` / `cross-clarify-questioner-rerun` → designer 半误入 inline-resume 路径。**无单 cause 能同时正确服务两角色**。

**契约（三条：2 原 + R2-2 扩域）**：

1. **role-appropriate cause**：deferred self/q dispatch mint **必须按角色派生 cause**——self→`clarify-answer`、questioner→`cross-clarify-questioner-rerun`、designer→`cross-clarify-answer`（**不是**统一 `cross-clarify-answer`）。落点：`buildFrontierMintPlan`（`taskQuestionDispatch.ts:946-984`）按本 home 本批条目的 `roleKind` 选 cause（mint factory `buildMintNodeRunValues` 已收 cause 入参，零手抄 / 零 drift）。这也是 §5.2.6 黄金锁的前提——旧整轮 self mint `clarify-answer`（`clarify.ts:494`）、questioner mint `cross-clarify-questioner-rerun`（`crossClarify.ts:1055`），deferred 路径须 mint **同 cause** 才能「四面对齐」。
2. **cause 同质 / collapse 不成立**：一条 rerun 须 **cause 单一**。**collapse 裁决：不成立**——self/q 与 designer cause 互斥（一 TRUE 一 FALSE 于 `isClarifyRerunCause`），不能共一条 rerun；分别 mint 两条 pending rerun 又撞 `assertNoInFlightDispatch`（`:342-352`）同 (node, iteration) freshness 重复执行 hazard（ULID 取新、旧者 strand）。故同 home self/q+designer **一律拒（串行化）**，与既有 immediate×designer P2-2 拒（`:692-697`）**同规则**——早稿据以区分二者的「immediate 已 mint vs deferred 延 mint」**不是** blocker，cause 单值且互斥才是。**P5-0/P5-BC 的「延到 dispatch」不改变此结论。**

3. **in-flight gate 扩域（Codex 设计 gate 第二轮 R2-2，硬实现契约）**：上「串行化」所依赖的 in-flight gate **现为 designer-only**——`assertNoInFlightDispatch`（定义 `taskQuestionDispatch.ts:591`，call 点 `:352`）的查询带 `eq(taskQuestions.roleKind,'designer')`（`:602`），只检 designer dispatched 条目。**P5-BC 必须把它扩域**：去 / 扩 `:602` 的 designer-only 过滤，使该 in-flight 查询拉**任一 deferred role（self / questioner / designer）** 的 `dispatched_at IS NOT NULL` 条目；`findOpenDispatchTarget`（`:551`）+ `isDispatchedEntryConsumed`（`:566`，判 `trigger_run_id`→`resolveHandlerRun` done+output）随之把**任一 deferred role 在同 home 的未-consumed dispatched 条目**判为 blocker；ConflictError 文案（`:614`）从「dispatched designer question」泛化为「dispatched question（任一 deferred role：self/questioner/designer）」。（依赖 §5.2.3 ② / P5-BC-T5：self/q dispatched 条目须已绑 `trigger_run_id`，`isDispatchedEntryConsumed` 才能按 lineage 分类它。）**否则**：同 home 先下发 self/q（其条目 `dispatched_at` 已戳、rerun 未 done+output）、后下发 designer 时——gate 只看 designer 条目、看不到在飞的 self/q → **放行 → 双 mint**（同 (node, iteration) 两 pending rerun，ULID 取新、旧者 strand），串行化失效。扩域后第二批被挡到第一批 rerun done+output，串行化才物理成立。**这条与 §5.2.13 的「同批 auto-split（R2-3）」互补**：**同批内** auto-split（一 home 一时刻一 cause 类）、**跨批间** in-flight gate 挡（本条），二者合起来才完整串行化同 home 混 cause（缺同批半 → 同批双 mint；缺跨批半 → 跨批双 mint）。

**结论（回答「collapse 还成不成立」）**：**不成立**。deferred-selfQ 与 deferred-designer **不 collapse 成一条 rerun**；改为「同 home 时按 single-cause gate 串行化（一次只下发一个 role-cause 类）+ 异 home / 不同 origin 正常各自 mint 各自 cause 的 run」。这与既有 `resolveBorrowForNode` 的 dual-ledger 拒（P2-2）一致，且把它从两账本推广到三账本。**串行化的物理实现（Codex 设计 gate 第二轮）= 同批 auto-split（一 home 一时刻只下发一个 cause 类、剩余留 staged，§5.2.13 R2-3）+ 跨批 in-flight gate 扩域（上 contract 3 R2-2，第二批挡到第一批 done+output）**；二者缺一则同批双 mint 或跨批双 mint。

- **测**：(1) deferred self mint cause=`clarify-answer` / questioner=`cross-clarify-questioner-rerun` / designer=`cross-clarify-answer`（断言 mint 行 `rerun_cause` 列）；(2) `isClarifyRerunCause` 三者真值表不变（`rfc098-rerun-cause-gates.test.ts` 不破）；(3) 同 home self/q+designer 同批 → auto-split（R2-3，下发一 cause 类 + 余留 staged，§5.2.13）；分两批 → 第二批待第一批 done+output（in-flight gate 串行化，**须验扩域后的 `assertNoInFlightDispatch`〔contract 3 / R2-2〕能看到在飞 self/q dispatched 条目、未 done+output 时 reject 同 home 第二批**）；(4) golden-lock：deferred 全 seal 批量下发的 self round rerun cause 与旧整轮 `clarify.ts:494` 逐字一致。

#### 5.2.13 mixed-role grouping（Codex 设计 gate F4）

**问题**：§5.2.3 ④ 去 designer-only 后，若把 dispatch 的所有角色过滤**一并**放开，per-origin 单 target 校验（`taskQuestionDispatch.ts:269-279`，原为 designer-only 写：「一个 cross round 的 designer 问题须单一 handler，cross round 整轮作为一个单位消费」）会开始把 **questioner 条目**也计入：一个 cross round 同 origin 同时有 questioner 条目（home=questioner 节点）+ designer 条目（home=designer 节点），二者 home **合法不同** → 校验见「>1 target」**误拒整轮**，sealed cross round 无法作为一个 batch 下发；若反向「仍 designer-only」→ self/q 的 multi-target 冲突不被覆盖。

**契约（三分）**：

- **designer single-target 校验 scope 到 designer**：per-origin 单 target 校验（`:246-279`）**保持只扫 `roleKind='designer'`**（如现 `:258` 过滤），语义是「designer session 整轮单一 handler 消费」——放开 dispatch 时**不要**把它 broaden 到 self/q。
- **self/q 另设 per-home single-borrow 校验**：deferred self/q 条目走独立的 per-home 校验（镜像 immediate ledger P2-1，`:829-845`：同 home 的 open self/q 条目须同一 borrow 决定）+ §5.2.12 的 per-home single-cause gate。
- **questioner + designer 同 origin、home 合法不同 → 允许一起 dispatch**：整轮 sealed cross round 一个 batch 下发——questioner 重跑 questioner 节点（cause `cross-clarify-questioner-rerun`）、designer 重跑 designer 节点（cause `cross-clarify-answer`），**不同 home、不同 cause、无重叠**，与 §5.2.12「**同 home** 才拒」一致（此处 home 不同，放行）。
- 仅当 self/q home **恰等于** designer home（一个节点在 R1 是 consumer、R2 是 asker 的跨轮巧合）才触 §5.2.12 拒 / 串行化。
- **用户推进路径闭环（Codex 设计 gate 第二轮 R2-3）**：§11.1 把看板「批量下发=全部 staged」、且 T7b **删了 per-card checkbox**（前端**无法**手选子集）——于是同 home self/q+designer 都 staged 时，若 dispatch route 对同 home 混 cause **整批 reject**，前端只能反复全量提交 → **「全量提交→全量 reject」死循环**（无从拆批）。**契约（route auto-split）**：dispatch route 收到「全部 staged」`entryIds` 后，对**同 home 混 cause** 这一类（**仅此类**）**不整批 reject**，而是**自动分安全批**——每个 home 同一时刻只下发**一个 cause 类**（确定性序，见下 R3-2 公平规则），其余同 home 跨-cause 条目**留 staged**；response 返回「**已下发 / 本批延后（下一批可下发）分组 + 延后原因（待同 home 第一批 rerun done+output）**」。前端据此把已下发标 已下发、延后标 仍 staged + 提示「待第一批续跑完成后可下发」，**第一批 rerun done+output 后**再次「批量下发」即下发剩余（届时 in-flight gate〔R2-2〕已放行）——**无死循环**。
- **cause 选序 = aging 公平规则（Codex 设计 gate 第三轮 R3-2，防饿死）**：早稿「**固定 self/questioner cause 先**」会**饿死**老 designer——若同 home 第一批下发 self/q、其 consumed 后**又有新的同 home self/q staged**，下一次「全部 staged」固定再选 self/q → 老 designer 永远延后。**修：auto-split 按 aging 选 cause——每个 cause 类取其条目里最老的 `staged_at`（缺省回落 `created_at`），选「最老 staged 的 cause 类」先下发**；只有**同龄并列**时才按 `CAUSE_PRIORITY`（self/questioner〔§0 阻塞-产出型〕在前、designer 后）破平。这样一条被延后的 designer 一旦比新涌入的 self/q 老就必被先释放，无限延后不再可能；新鲜混批（self/q 与 designer 同时 staged）仍 self/q 先（破平保持 §0 意图）。落点：`taskQuestionDispatch.ts` auto-split 循环按 `causeAge(cause)=min(stagedAt??createdAt)` 升序、`CAUSE_PRIORITY` 破平。
- **与 fail-fast 拒类的边界**：auto-split **仅**用于「同 home 混 cause **串行化**」这一**合法待序**类；**precondition 违例类仍 fail-fast 整批 reject、绝不部分下发**——readiness gate（unsealed，§5.2.11）/ per-origin round multi-target（`:269-279`）/ per-home multi-borrow（`:299-307`）/ designer not-ready（`:329-331`）。**检查序**：先跑全部 precondition 拒类（任一违例 → 整批 reject、nothing stamped）→ 全通过后才进 same-home cross-cause 的 auto-split 分批。
- **测**：(1) 一个 cross round（questioner+designer 同 origin、异 home）整轮 sealed → 一个 batch dispatch 成功（不被 per-origin 误拒）；(2) 一个 round 的 designer 问题 reassign 到两 handler → 仍按 designer single-target 拒；(3) self/q home==designer home 跨轮 → 触 §5.2.12 串行化；(4) **R2-3 auto-split**：同 home self/q+designer 都 staged、一次「批量下发（全部 staged）」→ route 下发 self/q 半（cause `clarify-answer` / `cross-clarify-questioner-rerun`）、designer 半留 staged + response 含延后分组（**不** reject、**无**全量死循环），第一批 rerun done+output 后再下发 → designer 半成功；(5) **R2-3 边界**：批中混一条 unsealed → 仍走 readiness gate 整批 reject（precondition 优先于 auto-split）；(6) **R3-2 aging 防饿死**：同 home 老 designer（staged 早）+ 新 self/q（staged 晚）一次「批量下发」→ 下发**老 designer**、新 self/q 留 staged（aging 胜过 self/q-first 默认），反复涌入 self/q 不能无限延后老 designer。

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

现状看板「待下发(staged)」列每卡有勾选 checkbox（`tq-select-${id}`）+ 批量下发栏下发**所选**（`entryIds: selected`，`TaskQuestionList.tsx` §18 批量下发块）。**改为**：① staged 卡**去 checkbox**（删 `tq-select-*` + 局部 selection state）；② 「批量下发」收集**全部 staged 条目** id 下发——语义「进待下发=已确定，批量下发=全下」。后端 `POST /api/tasks/:id/questions/dispatch` **请求体不变**（仍接 `entryIds`，前端传全部 staged）。golden-lock：无 staged → 不渲染批量下发栏（保留现有）。回归：把 §18 的「勾选→下发所选」测试改为「批量下发→全部 staged 下发」。

**同 home 混 cause 不死锁（Codex 设计 gate 第二轮 R2-3 + 第三轮 R3-2）**：因本节删了 per-card checkbox（前端**无法**手选子集）、又「批量下发=全部 staged」，故当全部 staged 含**同 home self/q+designer**（混 cause）时，dispatch route **不得整批 reject**（否则前端反复全量提交→全量 reject 死循环），须按 §5.2.13 **auto-split**——下发同 home 单一 cause 类的安全批、其余留 staged 并回「延后分组」给前端展示。故 dispatch route 的 **response 须新增「已下发 / 延后（下一批）分组 + 原因」字段**（请求体仍 `entryIds`=全部 staged）；前端据此渲染「N 题待第一批续跑完成后可下发」、不进死循环；第一批 rerun done+output 后再次「批量下发」即下发剩余。**cause 选序按 aging（最老 `staged_at??created_at` 的 cause 先）防饿死（R3-2，§5.2.13）**——「批量下发=全部 staged」+ 固定 self/q-first 会让反复涌入的新 self/q 无限延后老 designer；aging 保证老的延后 cause 必被先释放。precondition 违例（unsealed 等）仍 fail-fast 整批 reject（§5.2.13 边界）。

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
6. **P5 self/questioner 逐题重跑（深度重构）**（最高风险）：分 **P5-0 / P5-A / P5-BC / P5-D**（§5.2.9，Codex 设计 gate F1 后 B+C 合并）——P5-0 硬拒 seal-without-path（可独立合）→ P5-A 锁网 → **P5-BC 核心（park+读侧+dispatch 放开+readiness gate+rerun-cause 契约+mixed-role grouping+注入+消费+借壳，一个 rollback 单元，单独 Codex gate）** → P5-D 快通道；四项 clean-path + 三契约（§5.2.11/12/13）+ **第二轮 R2 闭环（rollback playbook §5.2.9 / in-flight gate 扩域 §5.2.12 / route auto-split §5.2.13 / 黄金锁注入条件 §5.2.6）** + 五项满足表见 §5.2。
   > 强约束：先 P0/P5-0 hotfix 兜底、P5-A 锁网再动刀；P5（含 P5-BC）末位、可独立回退而不影响 P1–P4 的 designer 主线 + P5-0/A。**P5-BC 不可再拆回退**（park 与 dispatch release path 同单元，F1）。**回退指代码层；live self/q dispatch 状态须先 drain（或迁移）否则不可无数据回退**（R2-1，§5.2.9 rollback playbook）。
