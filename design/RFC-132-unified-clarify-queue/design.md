# RFC-132 技术设计：统一平铺问题队列

> 配套 `proposal.md` / `plan.md`。核心：一个注入器 + 一套派生判据 + 一个平铺渲染块 + 一个节点反问状态，收编 4 条选路 + 2 套老化模型 + 轮次概念。

## 0. 术语

- **任务队列**：`task_questions` 全表（一个任务的所有反问问题）。
- **agent 队列**：`task_questions` 按 `effectiveTarget`（`override_target_node_id ?? default_target_node_id`）投影 + `dispatched_at IS NOT NULL` 的子集——即「已下发给该 agent」的问题。
- **下发（dispatch）**：`dispatched_at` 打戳 + 设置节点反问状态 + mint 承接 rerun。非 deferred 场景为「自动下发」。
- **老化（aged）**：一个问题不再注入。派生自 run 状态（见 §4）。
- **节点反问状态**：`task_node_clarify_directives` 表的 `continue`/`stop`，控制 agent 下一步（继续问 vs 出结果）。

## 1. 数据模型（保留 / 废弃）

**保留**：
- `task_questions`（任务/agent 队列的单一事实源）——`default_target_node_id` / `override_target_node_id` / `dispatched_at` / `trigger_run_id` / `sealed_at` / `answers_json` / `manual_body`。
- `task_node_clarify_directives`（节点反问状态，`setNodeClarifyDirective`）——唯一的 continue/stop。
- `clarify_rounds`（**降级为「答案存储」**：仍存问答内容 + answers，但**不再承载轮次语义**——`directive` / `round_generation` / 历史轮排序不再驱动注入）。

**废弃**（本 RFC 移除或停用）：
- `clarify_rounds.consumed_by_consumer_run_id` / `consumed_by_questioner_run_id`（RFC-070 消费戳）+ `markClarifyRoundsConsumedBy`——派生老化取代。
- `clarify_rounds.directive` 的**注入语义**（降级：只留作历史记录，不再挂 prompt trailer；continue/stop 归节点反问状态）。
- `tasks.deferred_question_dispatch` flag（所有任务走统一模型；迁移期见 §10）。
- `cross_clarify_sessions` 的注入职责（designer 走 `task_questions`，legacy 表保留供审计/回填，不再是注入源）。

**删列（用户 2026-07-01 拍板 forward-only）**：废弃列**本 RFC 删除**，不保留：
- `clarify_rounds.consumed_by_consumer_run_id` / `consumed_by_questioner_run_id`（RFC-070 戳）
- `clarify_rounds.directive`（per-round，归节点反问状态）
- `tasks.deferred_question_dispatch`（flag）
- （`clarify_rounds.round_generation` 若确认仅 clarify 轮次用则删；若 RFC-129 review 多文档代际复用则**保留**——T9 前 grep 确认归属）

drop-column migration（手写多语句需 `--> statement-breakpoint` 分隔 [reference_migration_statement_breakpoint]；新 migration bump `upgrade-rolling.test.ts` journal-count [reference_migration_bumps_journal_count_test]）。`cross_clarify_sessions` 注入职责移除但**表保留**（RFC-058 审计 / 其他 reader）。**forward-only**：删列不可回退（见 §9），排在最后 PR、删前全量确认无 reader。

## 2. 统一注入器 `buildClarifyQueueContext`（核心契约）

```ts
// 单入口，收编 buildClarifyNodeQueueContext + buildNodeQueueExternalFeedback +
// buildPromptContext + buildExternalFeedbackContext 的注入职责。
export async function buildClarifyQueueContext(args: {
  db: DbClient
  definition: WorkflowDefinition
  taskId: string
  consumerNodeId: string       // 运行中的 agent 节点
  dispatchedRunId: string      // 本次承接 rerun 的 node_run id
  iteration: number            // wrapper loopIter（保留——workflow loop，非 clarify 轮）
}): Promise<ClarifyQueueContext | undefined>

interface ClarifyQueueContext {
  block: string                // 单一平铺块（§5）
  sourceRunIds: string[]       // 参与老化判据的 run（审计）
}
```

**内部三步**（DRY 提取，见 plan T2/T3）：
1. **select**：取 `consumerNodeId` 的 agent 队列——`task_questions` where `effectiveTarget==consumerNodeId AND dispatched_at IS NOT NULL AND sealed_at IS NOT NULL`（manual 无 seal，见 §5.manual）。
2. **age-filter**：`!isTargetNodeConsumed(consumerNodeId, iteration, e.trigger_run_id, sameNodeRuns, outputRunIds)`（§4 单一判据）。
3. **bind + render**：绑 `trigger_run_id = dispatchedRunId`（承接标记）→ 平铺渲染（§5）。

**consumerKind 消失**：不再按 self/questioner/designer 分派 SELECT——统一按 `roleKind ∈ {self, questioner, designer, manual}` 一次查全（agent 队列 = 投影到该节点的所有 role 的已下发问题）。渲染平铺，不分 role 分组（§5）。

## 3. 选路收敛（scheduler）

现状 `scheduler.ts:2725-2822` 的 XOR（deferred ? 注入器1/2 : 注入器3/4）**整块删除**，替换为：

```ts
const clarifyContext = agentHasClarifyChannel(definition, node.id)
  ? await buildClarifyQueueContext({ db, definition, taskId, consumerNodeId: node.id,
      dispatchedRunId: nodeRunId, iteration: loopIter })
  : undefined
```

- 无 `deferredQuestionDispatch` 分流、无 `isQuestionerCrossClarifyRerun` 分派、无 designer 独立 `crossClarifyContext`（designer 问题进同一 block）。
- prior-output（RFC-119）后处理（`scheduler.ts:2836-2855`）**保留**——它正交于 clarify 注入，读 `freshestPriorRunWithOutput`（不受本 RFC 影响）。

## 4. 单一派生老化判据

沿用 RFC-131 `isTargetNodeConsumed`（`clarifyRerunLedger.ts`，已含 review-superseded canceled+output 修）——**成为唯一判据**：

- done+output（或 review-superseded canceled+output）且 `id >= trigger_run_id` → 老化。
- done-无-output / failed / 非-review canceled / pending / running → 不老化。
- trigger_run_id id 序防 round N+1 误老化（新问题承接 rerun id 更大）。

`consumed_by_*` 戳 + `markClarifyRoundsConsumedBy` 删除。所有 caller（non-deferred 曾用戳）改派生。

## 5. 平铺渲染（单一块）

一个块，无轮次分组：

```
## Clarify Q&A

- Q: {question title}
  Type: {kind} / Options: {...}
  Answer: {user's answer}
- Q: {...}
  Answer: {...}
（按 task_questions 的 dispatched_at / id 序平铺；所有问题对等）
```

- **无** `### Round N`、**无**历史轮 vs 当前轮、**无** sibling scope、**无** per-question directive trailer。
- **零 attribution**（RFC-099）——不渲染 who answered。
- **manual**（§15 手动问题，无 seal/无 answer）：渲染其 `manual_body`（并入同一块，作为一条对等条目）。
- **directive**：不在 block 里（归节点反问状态 §7）。
- 渲染 helper 收敛为一个 `renderFlatClarifyQueue(entries)`（取代 `buildClarifyPromptBlock` 轮次循环 + `buildExternalFeedbackBlock`）。

**designer 合并（②b）**：designer 问题不再 `## External Feedback` / 不再 `{{__external_feedback__}}` token；进 `## Clarify Q&A` 同块。**注**：这改变 designer agent 看到的 prompt 结构（有意变更，验收标准 #7②）——需确认 designer agent 的 prompt 模板不硬依赖 `## External Feedback` 字面（plan T5 审）。

## 6. 自动下发（quick-channel 收敛 —— 复用已有 `autoDispatchClarifyRound`）

**关键（research 更正，避免天真做法引 regression）**：**不在 `submitClarifyAnswers` 里加 dispatch 逻辑**——那会产生「条目 sealed+dispatched 但复用 home immediate continuation」的 hybrid 态，落入借壳账本 immediate/deferred 两不入 → `resolveBorrowForNode` 返 null → 借壳改派丢 agent + rerun stranded（已验证的 regression）。正确做法:复用**已存在并在 deferred 路径生产验证**的 `autoDispatchClarifyRound`（`clarifyAutoDispatch.ts:243`，RFC-128 P5-D：seal→`dispatchTaskQuestions`，mint 承接 rerun on target、**不** mint immediate continuation）。

现状:路由 `routes/clarify.ts:321` 按 `deferredQuestionDispatch===true` 分流——deferred 走 `autoDispatchClarifyRound`;non-deferred 落 `submitClarifyAnswers`/`submitCrossClarifyAnswers` 的 legacy immediate mint（`clarify.ts:504` / `crossClarify.ts:576`）。

统一后:**路由放宽——所有任务走 `autoDispatchClarifyRound`**;删 legacy immediate mint 成功路径。答完 = seal + 自动 dispatch（设 `dispatched_at` + 节点反问状态 + mint 承接 rerun on target），与显式 board 下发共用 `dispatchTaskQuestions`。UX 不变（答完自动继续、旧语义本就是「改反问状态 + 下发」），底层单一 deferred 路径。

**锁序契约（复用、勿重导）**:`clarifyAutoDispatch.ts` 文件头——seal-tx→dispatch-tx **串行两次 lock B、绝不嵌套**;self isolated worktree rollback 在 A≻B（A OUTER）下;sealed-undispatched 由 park 源（`partitionUndispatchedParkTargets`）钉住 home、frontier 不越（RFC-076 T0 等价保护）。deferred 路径已验证。

**designer immediate 缺口（plan 漏，本 RFC 裁决）**:`autoDispatchClarifyRound` 只 auto-dispatch **self/questioner**,designer 留 §18 手动 board。但 non-deferred designer 现走 `submitCrossClarifyAnswers`→`triggerDesignerRerun`（`crossClarify.ts:1119`）immediate mint（不打 `dispatched_at`）;统一注入器（`selectAgentQueue` 要 dispatched）后 non-deferred designer 注入会空。**裁决:designer 也切自动下发**（扩 `autoDispatchClarifyRound` 覆盖 designer,处理 multi-source readiness 在首个 sibling answer 触发的 `assertDesignerReady`）——与 self/questioner 一致走 dispatched 队列。

**借壳语义 borrow→move（§非目标勘误）**:借壳（RFC-127）现只活在 **immediate 账本**（dispatched 两账本已 RFC-131 T4 去借壳、borrow 恒 null）。删 immediate mint → immediate 账本 borrow 分支成死代码 → **self/questioner 改派从 borrow（home 跑 X 脑）变 move（X 跑自己 = T4 语义）**。这是**行为变更**(proposal §非目标原写「借壳行为保持」勘误为「统一为 T4 move 语义」)。immediate-ledger oracle（`openImmediateRounds` 等）**保留作迁移期 gate**（检测升级前遗留 continuation,§9）。`resolveBorrowForNode`/`buildBorrowedAgent` 回落 null 后成死代码,但 **RFC-132 不主动删**（留后续 RFC,保持窄边界）;`rfc127-self-questioner-borrow` 测试更新到 move 语义。

## 7. 节点反问状态（directive 收敛）

- `continue`/`stop` 唯一存于 `task_node_clarify_directives`（`setNodeClarifyDirective`）。
- **下发时设置**：dispatch 一批答案时带 directive（自动下发继承答题时的 directive；显式下发由 board 指定）。
- `clarify_rounds.directive` 不再驱动注入（降级历史记录）。per-round directive 概念消除。
- scheduler 读节点反问状态决定 `effectiveHasClarifyChannel`（继续问 vs 出结果）——现有机制（`scheduler.ts` persistent-stop）保留，数据源收敛为节点状态。

## 8. golden-lock 处理

现状字节锁（`rfc128-p5-bc:482` full-round == legacy byte-for-byte；`rfc070-aging-stamp-grep-guards` source-text）**会因平铺渲染 + 派生老化而变**——这是**有意行为变更**，不是回归：

- **删除** non-deferred 整轮 byte-for-byte 锁（`buildPromptContext` == legacy 那批）——整轮渲染被平铺取代。
- **删除** RFC-070 消费戳 source-text 锁（戳废弃）。
- **新增** 平铺渲染 golden 锁：`renderFlatClarifyQueue` 固定输入 → 固定平铺输出（snapshot / byte 锁），覆盖 self/questioner/designer/manual 混合。
- **保留 + 扩展** RFC-131 派生老化锁（`rfc131-target-consumed` + `scheduler-clarify-multiround-aging` + `rfc131-review-reject-aging`）——派生判据是唯一判据后更关键。

## 9. 迁移策略

派生老化零新列，但**行为变更 + 双路径合一**需迁移在飞任务：

- **consumed_by 戳 → 派生**：升级后不再读戳。历史已戳 round → 其 target run 若 done+output，派生判据同样判老化（等价）；未戳但 done+output → 也老化（派生更宽松、正确）。无回填。
- **non-deferred 在飞任务**：升级后走统一模型。两类在飞态需迁移垫片：① 已答未下发的 legacy round（无 `dispatched_at`）；② **升级前 mint 的 immediate continuation**（pending run、无 dispatched entry）。对 ①/②：immediate-ledger oracle（§6 保留）作迁移期安全网检测遗留 continuation；scheduler 恒走 deferred 注入器时,对无 dispatched 的在飞 round **迁移期一次性补 `dispatched_at`**（首选,走 `autoDispatchClarifyRound` 补下发）或短期 `buildPromptContext` fallback 容忍——不丢在飞 continuation。
- **borrow→move 回退边界**：§6 的 borrow→move 是行为变更——已 move 的 reassigned 问题产出挂 target 节点、下游接线随之变;**这层不可无缝回退**（非仅删列问题）。PR-B（行为变更）之后回退需考量已 move 的数据态;派生老化/注入本身仍可回退（无持久态）。
- **deferredQuestionDispatch flag**：先停读（视所有任务为统一模型）,列在最后 PR 删（下条）。
- **forward-only（用户拍板删列）**：废弃列本 RFC 删除、不保留。删列**不可回退**——故 drop-column migration 排在**最后一个 PR**（所有 reader 移除〔T4/T7/T8〕+ 在飞任务迁移完成后），删前全量确认无 reader（`rg` 列名空 + typecheck + 全量 test）。中间 PR 保持列存在（渐进停写），最后一 PR 一次性 drop。派生老化本身无持久态（不落库）——故删列**之前**的所有行为可回退；仅「drop-column migration」这一步单向，回退只能回到该 migration 之前的 commit。

## 10. 失败模式

| 场景 | 处理 |
|------|------|
| designer prompt 模板硬依赖 `## External Feedback` 字面 | plan T5 审 agent 模板 + inventory；若有依赖，先改模板再合并块 |
| non-deferred 在飞任务无 `dispatched_at` | 迁移垫片：selection 对 legacy round 容忍（补下发 or 视为已下发），plan T6 |
| 自动下发引入 double-mint | 复用 `dispatchTaskQuestions` 的 in-flight gate（RFC-131 §7）+ CAS |
| 平铺渲染丢失轮次信息导致 agent 混淆 | 平铺仍保留每问题完整问答；agent 不需轮次（对等）——US 已确认 |
| 老化在 review-reject 失效 | RFC-131 已修（review-superseded canceled+output），派生判据继承 |

## 11. 测试策略（必写）

**纯函数**：
- `renderFlatClarifyQueue`：self/questioner/designer/manual 混合 → 平铺 golden；无轮次/scope/attribution；顺序稳定。
- `isTargetNodeConsumed`：RFC-131 全 case 继承（唯一判据）。

**服务级**：
- `buildClarifyQueueContext`：单节点多问题平铺注入 / done+output 老化 / done-无-output 不老化 / round N+1 不误老化 / review-superseded 老化 / manual 注入 / designer+self 同块。

**集成（scheduler runTask e2e）**：
- 多轮 self-clarify 平铺注入（复现并保 `01KWDKBS` 修复）。
- 自动下发：非 deferred 答完自动继续（UX 等价旧 quick-channel）。
- review reject → 老化不重注 + prior-output（RFC-131 验收4）。
- 借壳改派（RFC-127 T4 去借壳）在统一注入下不破。

**回归/迁移**：
- 迁移垫片：在飞 non-deferred round 升级后正确注入、不丢答案。
- golden：平铺渲染 byte 锁；删除的整轮/戳锁不留悬空。

## 12. 关键 file:line 索引（现状）

- `clarifyRounds.ts:474`(buildPromptContext) / `:611`(buildClarifyNodeQueueContext) / `:302`(selectAnsweredRoundsForConsumer) / `:106`(markClarifyRoundsConsumedBy 废弃)
- `crossClarify.ts:1537`(buildExternalFeedbackContext) / `:1660`(buildNodeQueueExternalFeedback) / `:1876`(buildQuestionerCrossClarifyContext 死代码删)
- `clarifyRerunLedger.ts:isTargetNodeConsumed`(唯一判据)
- `scheduler.ts:2725-2822`(XOR 选路，收敛为单调用)
- `clarifySeal.ts:459-463`(round directive → 节点状态；自动下发接入点)
- `taskClarifyDirective.ts:95`(setNodeClarifyDirective，节点反问状态)
- `shared/clarify.ts:453`(buildExternalFeedbackBlock) / `:236`(buildClarifyPromptBlock)——收敛为 renderFlatClarifyQueue
- `tests/rfc128-p5-bc:482`(整轮 byte 锁，改) / `rfc070-aging-stamp-grep-guards`(戳锁，删)
