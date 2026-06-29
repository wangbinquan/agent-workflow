# RFC-128 — 任务级集中回答 + 反问 per-question 独立答/下发

> 状态：Draft（待用户批准进入实现）
> 触发：2026-06-29 用户（接 RFC-127）：① 要一个**任务级集中回答界面**——回答「该任务当前所有待指派问题」、逐题确定答案；② **进入「待下发」必须先有答案**（前置 gate）；③ 用户给出架构指导「用独立问题队列、下发后再进 agent 执行队列」；④ 协调约束「问题列表只处理了一批反问的部分问题，再打开反问页时那些已处理的题要置灰、不重复下发」；⑤ 范围拍板「**部分回答（逐题独立答+下发）**」+「**self/questioner 也逐题重跑**」（明知 RFC-125 教训仍坚持，见 §6）。
> 关系：**依赖 RFC-127**（借壳执行：改派后下发用借壳顶替）。本 RFC 动 clarify「整轮 seal + 整轮续跑」核心，扩展/supersede RFC-023/056-059/120/123/125/126 的「整轮」假设（破坏面见 `design.md §8`）。
> 调研：4 路并行回源（借壳可行性×2 / 反问回答 UI 复用 / 整轮 seal→逐题改造）。证据 file:line 见 `design.md`。
> 编号：磁盘现有最高 RFC-127，本 RFC = 128；migration 从 **0067** 起（现存最新 0066）。

## 1. 背景

### 1.1 RFC-127 解决了「下发时怎么执行」，没解决「下发前怎么回答 / 入队列」

RFC-127 让全类型问题可改派 + 借壳顶替（换 agent 跑原节点位置）。但**回答**仍是现状：唯一入口 `/clarify` 反问页、**整轮一次性 seal**（一个 clarify_round 的全部问题一次提交、`answers_json` 整批 blob、`awaiting_human→answered` 原子翻转、再提交即锁死）。

### 1.2 现状是「两半分裂」的

调研发现（`design.md §0`）：

- **下发半已经 per-question**：`task_questions` 就是 per-(问题×角色) 行，`dispatched_at`/`staged_at`/`override_target_node_id` 都是逐题列；`dispatchTaskQuestions` 已支持「部分下发」——但**只对 cross designer 角色、整轮 answered 之后、deferred 任务**生效。
- **回答/seal 半仍整轮**：答案是整轮 blob，submit 一次性翻整轮 status，无 per-question seal、无 `partial` 态。任务看板路由**没有任何 answer 端点**（只有 manual/confirm/reassign/stage/dispatch）。逐题**草稿**已有（`draft_answers_json` + `PUT /draft`），但 submit 仍整轮。

### 1.3 用户的架构：独立问题队列 + 下发后进执行队列

用户把每个反问问题看作**独立队列项**（≈ `task_questions` 条目，已 per-question），「下发」= 把该题从问题队列推进到 agent 执行队列（mint rerun，RFC-127 借壳执行）。两个回答入口共享同一 per-question 状态，已下发题在反问页置灰、不重复下发。

## 2. 目标 / 非目标

### 2.1 目标（v1）

1. **任务级集中回答界面**：任务详情页新增一个回答面，**平铺该任务所有待指派问题**（跨多个反问轮、按轮分组），复用反问回答 UI（`QuestionForm` / scope 段控 / 改派下拉 / 逐题草稿 autosave）逐题填、确定每题答案。
2. **per-question 独立答 + seal + 下发**（全角色）：答案从「整轮一次 seal」改为「**逐题 merge 写入 + 逐题 seal 标记**」；一批反问可只答+下发其中几题、其余以后再答。
3. **两入口并存（延续 RFC-120 §11「两处理面」）**：
   - **反问页 `/clarify`（快通道，行为不变）**：答完直接执行（self/questioner 自我续跑、designer 按现状）。
   - **集中回答界面（控制通道）**：答完进「待指派」队列 → 选 agent（可换，走 RFC-127 借壳）→ 待下发 → 下发。
   - 区分靠**提交级 `defer` 意图**（集中界面=延迟入队列；反问页=立即）。
4. **反问页协调（防重复处理）**：两入口共读 `task_questions` 的 per-question 下发态（单一事实源）；已 seal/已下发的题在反问页**置灰只读、提交时排除**，绝不重复 seal/下发。
5. **待下发答案 gate**：`stageTaskQuestion` 加校验——问题必须已有答案（该题已 seal）才能进「待下发」。
6. **self/questioner 也逐题重跑**（用户坚持，**高风险**，见 §6）：把 RFC-120 §2.4 的条目级反馈/消费戳从 designer 扩到 self/questioner，逐题下发渐进式续跑。
7. **待下发即下发（简化批量下发交互，2026-06-29 追加）**：「待下发」列**去掉每卡勾选框**——进了待下发即「已确定要下发」；「批量下发」直接下发**全部**待下发项（不再逐个勾选）。

### 2.2 非目标

- **不改 RFC-127 借壳机制本身**（本 RFC 只管「下发前怎么回答/入队列」+ 触发借壳）。
- **不新增轮 `partial` DB 状态**：partial 是**派生态**（由逐题 seal/dispatch 标记派生），轮 `answered` 仍只在「全题 seal」时翻一次——避免破 RFC-126「轮要么 answered 要么不是」+ `failed→resume` 不变量。
- **不做逐题 directive**：directive 仍**节点级**（RFC-123 单一事实源），逐题重跑继承当前 directive。
- **不把答案搬离 `answers_json`**：内容仍以 `clarify_rounds.answers_json` 为 SoT（逐题 merge 写），只把逐题 seal/dispatch 态落 `task_questions`（落库方案见 `design.md §7` 推荐 C）——把改造爆炸面挡在 `task_questions` 人工覆盖层内。
- **不在单任务内混合两条投递路径**：全程走 deferred 单一投递（RFC-125 已设为默认）——RFC-125 6 findings 的根因就是混合路径，绝不重蹈。

## 3. 用户故事

1. **集中回答 + 部分处理**：任务跑出 3 批反问共 8 题。我打开任务详情的「回答」面，看到 8 题按批分组平铺。我逐题填答案（自动存草稿），先把其中 3 题「确定 + 选好 agent + 加入待下发」，其余 5 题留着。
2. **下发执行**：我把待下发的 3 题一键下发——每题进 agent 执行队列（designer 域题走借壳到我选的节点、self/questioner 题逐题渐进续跑）。
3. **反问页协调**：我后来打开其中某批反问的 `/clarify` 页，发现已经在「回答」面处理过的那几题**已置灰只读**、不能再次下发；只剩没处理的题可答。两边看到的是同一份 per-question 状态。
4. **待下发 gate**：我想把一个还没填答案的题加入待下发——被挡住，提示「请先确定该题答案」。
5. **快通道不变**：另一个简单的 self 反问，我图省事直接在 `/clarify` 答了就让它自己接着跑——和以前一样，不进队列。

## 4. 决策登记

- **D1（两入口）= 反问页快通道（不变）+ 集中界面控制通道（进队列）**，提交级 `defer` 意图区分。延续 RFC-120 §11。
- **D2（落库）= 逐题 merge + 逐题 seal 标记落 `task_questions`，answers_json 仍内容 SoT**（方案 C）；轮 `answered` 仅全题 seal 时翻一次，partial 纯派生（不新增 DB status）。
- **D3（self/questioner 逐题重跑）= 做，但带三坑缓解**（§6）：用户在知悉 RFC-125 教训后坚持；以「渐进式续跑 + 条目级消费戳 + 节点级 directive 继承」缓解，Codex 设计 gate 头号对抗审查。
- **D4（反问页协调）= 共读 `task_questions` per-question 态、已处理题置灰只读**；防重复下发靠既有 `dispatched_at IS NULL` CAS。
- **D5（待下发 gate）= `stageTaskQuestion` 加「该题已 seal」校验**。
- **D6（directive / 隔离 / 权限 / 迁移）**：directive 节点级（RFC-123 不破）；归属不入 prompt（RFC-099）；成员权限（RFC-120 D7）；存量 answered 轮 = 全题已 seal（migration 0067）。

## 5. 验收标准（每条先红后绿；门槛 typecheck+test+format:check 全绿 + CI + Codex 双 gate）

- **AC-1（逐题 seal）**：新 per-question seal 路径——seal 单题 merge 进 `answers_json` + 落 `task_questions` 逐题 seal 标记；轮 status 不翻（除非全题 seal）；同题不可重复 seal、兄弟题仍可答。
- **AC-2（reconcile 逐题门控）**：`reconcileDesiredEntries` 从整轮 `roundAnswered` 改逐题 `questionSealed[qid]`——每 seal 一题（scope=designer）即 reconcile 出该题 designer 条目；幂等。
- **AC-3（轮 answered 仅全 seal 翻）**：全题 seal 才 `awaiting_human→answered`；RFC-126 resume 不变量、questioner cascade 依赖整轮 answered 仍成立。
- **AC-4（集中回答界面）**：任务详情新回答面，平铺所有待指派问题（按轮分组）、复用 `QuestionForm`/scope/改派下拉/草稿；逐题填、逐题/批量确定答案；空/错/载入走公共组件；i18n。
- **AC-5（两入口 defer 意图）**：集中界面提交带 `defer=true`（进队列、不立即续跑）；反问页 `defer=false`（现状立即）；后端 submit 据此分流。
- **AC-6（反问页协调）**：`/clarify` 读 per-question 态，已 seal/已下发题置灰只读、提交排除；不重复 seal/下发。
- **AC-7（待下发 gate）**：`stageTaskQuestion` 拒未 seal 题（4xx）；前端隐藏未答题的 stage。
- **AC-8（designer 逐题下发）**：designer 域逐题独立下发借壳（复用 §18 + RFC-127），部分下发、`dispatched_at IS NULL` CAS 防重。
- **AC-9（self/questioner 逐题重跑 + 三坑缓解）**：逐题 rerun 注入「本题答案 + 兄弟题 pending 标注」、条目级消费戳只消费本题、directive 节点级继承；下游 freshness 取最终产出。回归锁三坑。
- **AC-10（迁移）**：存量 answered 轮映射为「全题已 seal」；不翻在飞任务的 `deferred_question_dispatch`。
- **AC-11（破坏面回归）**：RFC-023/056-059/070/120/123/125/126 既有测试全绿（破坏面清单见 `design.md §8`）。
- **AC-12（待下发即下发）**：staged 列无勾选框；「批量下发」下发**全部** staged 条目（非所选）；无 staged 不渲染下发栏（golden-lock 保留）。
- **AC-13（集中回答入口 + 单一提交）**：看板有待指派问题时显示「处理待指派问题」入口按钮（无则不显示）；集中回答页面平铺所有待指派问题、复用反问 UI（QuestionForm/scope/directive/改派）、**仅一个提交按钮**一次提交全部已填答案（按 originNodeRunId 分组、每轮 seal、defer=true）。

## 6. 高风险声明：self/questioner 逐题重跑（D3）

调研明确判定：self/questioner 是「阻塞-产出型」——**同一 agent 续同一上下文、整批答案一次注入、mint 一条续跑**。逐题重跑会撞三个坑，且**正是 RFC-125「逐条延迟」被 2 轮 Codex gate 共 6 findings 否决的同一区域**：

1. **半答案续跑**：只答一题就重跑，agent 拿「1 题答 + N 题未答」续跑 → 重复追问 / 基于不全信息产出。
   - **缓解**：逐题 rerun 注入「本题答案 + 明确标注兄弟题仍 pending/在队列、勿重复追问」；中间态靠 worktree 累积（契合平台「cross-iter state via worktree」）；下游靠 freshness 取最终产出。
2. **directive 冲突**：directive 是轮/节点级。
   - **缓解**：不做逐题 directive，保持节点级（RFC-123），逐题重跑继承当前 directive。
3. **provenance 破坏**：逐题 mint 多条 rerun，消费戳/lineage 乱。
   - **缓解**：把 RFC-120 §2.4 条目级反馈/消费戳从 designer 扩到 self/questioner，每条 rerun 只注入/消费它那一题。

**用户在知悉以上后坚持要做。** 故本 RFC：以上述缓解落地；把该项列为 **Codex 设计 gate 头号对抗审查点**；若 Codex 复现 RFC-125 级致命问题，带证据回退与用户重新权衡，不硬上。**落地分阶段**（`plan.md`）：designer 域逐题（低风险、复用 §18）先行；self/questioner 逐题重跑作为最后阶段、单独 gate。
