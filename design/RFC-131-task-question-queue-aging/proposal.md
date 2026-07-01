# RFC-131：任务级反问问题队列 + agent 产出后统一老化

> 状态：Draft（待用户批准 + Codex 设计 gate）
> 触发：2026-07-01 用户实测多轮反问最终产物丢失 round 1 决策，提出更根本的消费模型。

## 背景

RFC-128 P5 为支持「per-question 独立下发 + RFC-127 借壳」，用了一套复杂的消费/老化机制：

- **per-question window 消费**（`clarifyRounds.ts` `isQueueEntryRenderableForRun`）：条目是否注入，取决于「当前 rerun 是否落在该条目原始承接 rerun 的连锁 clarify-rerun 窗口内、且窗口内无 done+output」。窗口上界按 ULID 序的「下一个 clarify-rerun」。
- **逐条 `trigger_run_id` 绑定** + **整轮 `consumed_by_*_run_id` 戳**（dispatched 轮被排除）。
- **RFC-127 借壳三账本**（immediate / designer / deferred-self-questioner）借壳冲突判定。

**实测翻车（任务 `01KWDKBS`，deferred self-clarify）**：agent 问 round 1（5 题）→ 答 → agent 问 round 2（5 题）→ 答 → agent 产出 doc。最终 doc **只体现 round 2 的答案、丢了 round 1 的 5 个决策**（尤其「完整文档要 API / UI 线框图 / 伪代码」全缺）。DB 铁证：round 2 的 rerun prompt 里「## Clarify Q&A — Prior Rounds」只含「### Round 2」。

**根因**：window 消费把「agent done-**无**-output 问下一轮」当成了消费边界（窗口上界），round 1 在 round 2 的 rerun 时被误判「已消费」而不注入——即使 agent 从没「正常输出走完」（第一次 done+**output** 是产出 doc 那次）。

已打补丁（`9b1c30e` `buildClarifyNodeQueueContext` 补历史轮），但只覆盖「有新一轮 dispatch」、不覆盖「纯重跑（review-iterate）」，且没改消费时机的根本。

## 目标

用户提出的更根本、更简单的模型：

1. **任务级公共问题队列**：一个任务的所有反问问题（self / questioner / designer）在一个统一的池里；每个问题标一个**目标队列**（`target`，= 承接它的 agent 节点）。
2. **agent 产出后统一老化**：一个 agent（节点）**正常输出走完（`done` + 写了 output port）**后，**一次性老化它目标队列里所有已答（sealed）的问题**。即使之后被 review 打回重做，也算已老化（重做靠 RFC-119 prior-output 块带上次产物，**不**重新注入反问队列）。
3. **`done`-无-output 不老化**：agent 只是问了下一轮反问、没产出最终结果，不算「走完」——它答过的问题**留在队列**，下一次 rerun 继续注入。
4. **rerun 注入 = 目标 agent 队列里全部 answered 问题**（跨轮累积、按轮/问题顺序、当前轮 + 历史轮统一渲染、read-only 历史零 attribution）。
5. **改派 = 改问题的目标队列**：把某个问题的 `target` 指向工作流里别的 agent 节点，问题就进那个节点的队列——**取代 RFC-127 借壳的三账本 + 「run 归原节点 / agent 借用」机制**（下游接线方案见 `design.md`）。
6. **简化**：去掉 `isQueueEntryRenderableForRun` window 消费、逐条 `trigger_run_id` 消费判据、借壳三账本；消费统一为「目标 agent done+output」。

## 非目标

- **non-deferred quick-channel（旧的立即 mint continuation 路径）**：默认保留双路径（RFC-125 golden-lock，non-deferred 字节级不回归）；是否统一到新模型在 `design.md` 评估，但不作为必须。
- 不改 RFC-125 `deferred_question_dispatch` 的「创建即定、终生不翻转」特性。
- 不改 RFC-099 prompt-isolation（归属绝不进 agent prompt）。
- 不改 clarify 的问答 UI / 集中回答面（RFC-127/128 前台）——只改后端消费/注入/改派的实现。

## 用户故事

- **多轮 self-clarify**：agent 问 round 1 → 我答 → agent 问 round 2 → 我答 → agent 产出。**产出时 agent 能看到 round 1 + round 2 的全部答案**，最终产物体现两轮所有决策。
- **改派**：某个反问问题我想让工作流里别的 agent 处理 → 改它的目标队列 → 问题进目标 agent 的队列、由它处理。
- **review 打回**：agent 重做时看得到上次产物（prior-output），反问答案此时已老化、不再重复注入。

## 验收标准

1. 多轮反问：agent rerun 的 prompt 含**所有 answered 轮**（round 1 + round 2 + …）、按轮顺序、历史轮 read-only、零 attribution。
2. **老化时机**：目标 agent `done+output` → 老化其队列已答问题；`done`-无-output → **不**老化、下一次 rerun 仍注入。
3. **改派**：改问题 `target` → 问题进目标 agent 队列；目标 agent 产出后老化它。
4. **review 重做**：老化生效（不重注入反问队列）+ prior-output 带上次产物。
5. **防护保留**：readiness gate（问题 `sealed` 才能下发）/ in-flight 串行化（同一目标节点同时只一条在飞 rerun、防 double-mint）/ park（未下发问题钉住提问节点、不让 frontier 越过）。
6. **golden-lock**：non-deferred / 单轮全量下发场景，注入与旧路径逐字不变。
7. **迁移**：现有 `task_questions` / `clarify_rounds` 数据平滑过渡（升级窗口不丢历史任务的问答）。

## 核心设计问题（详见 `design.md`）

1. **改派后的下游接线**：RFC-127 借壳的语义是「产出归原节点、走原节点下游」（designer 的反问答案要喂原 designer 的下游）。「改派 = 目标队列」模型下，目标 agent 的产出归谁、走谁的下游？（`design.md` §改派与下游）
2. **消费判据统一**：以「目标 agent 最新 run `done+output`」替代 window + `trigger_run_id` + `consumed_by_*`——含 `done`-无-output 的规则化、review-rerun 的处理。
3. **non-deferred 双路径 vs 统一**。
4. **迁移策略**（现有逐条 `trigger_run_id` / window 语义 → 任务级队列）。

## 与既有 RFC 的关系

- **取代/收编** RFC-128 P5 的 window 消费 + 逐条消费；**收编** RFC-127 借壳三账本（改派改为目标队列）。
- 复用 RFC-128 P0-P4 的落库地基（`sealed_at` / `dispatched_at` / per-question seal / 集中回答面 / 看板）。
- 复用 RFC-119 prior-output（review 重做带上次产物）。
- 前序死锁修复（`openImmediateRounds` / `isDispatchedEntryConsumed` 的 in-flight/revivable mode，commit `1fb1646`）在本 RFC 落地后可**简化**（消费统一为 done+output、mode 分裂可收敛）。
