# RFC-131 技术设计：任务级问题队列 + agent 产出后统一老化

> 配套 `proposal.md`。本文是权威技术设计，待 Codex 设计 gate + 用户批准。

## 0. 术语

- **origin**（产出源）：问题的原提问/产出节点。`task_questions.origin_node_run_id` 指向提问轮的 intermediary run；决定**产出归属 + 下游接线**（谁的输出端口、走谁的下游）。
- **target**（执行者）：实际承接、跑这个问题的 agent 节点。= `default_target_node_id ?? override_target_node_id`。**改派 = 改 `override_target_node_id`**。
- **队列**：任务级 `task_questions` 表，按 `target` 分组投影 = 「每个 target 节点的问题队列」。无新表。
- **老化（consume）**：一个 target 节点**正常输出走完（最新 top-level run `done` + 写了 output port）**后，它队列里所有已答（`sealed_at` 非空）问题「老化」——不再注入后续 rerun（产出已定型，下游用产物）。

## 1. 数据模型（复用现有，最小改动）

复用 `task_questions`（RFC-120/128 已有列）：

| 列 | 语义（RFC-131） |
|----|----------------|
| `origin_node_run_id` | origin（产出归属 + 下游） |
| `default_target_node_id` / `override_target_node_id` | target（执行者）；改派改 override |
| `sealed_at` | 已答（进入 target 队列的可注入集） |
| `dispatched_at` | 已下发（可被 mint rerun） |
| `role_kind` | self / questioner / designer / manual |
| `iteration` / `loop_iter` | 队列的 (target, iteration) 分组键 |

**老化不落新列（派生式，见 §2）**。`clarify_rounds` 的 `consumed_by_*_run_id` 保留供 non-deferred 旧路径 + 读侧兼容，新路径不依赖它。

> 备选（戳式）：新增 `clarify_rounds.consumed_by_target_run_id`，runner `done+output` 时标。放弃理由见 §2。

## 2. 消费判据统一（核心）——派生式老化

**新纯函数**（取代 `isQueueEntryRenderableForRun` window + `isDispatchedEntryConsumed` mode + `consumed_by_*` 戳）：

```ts
/** 一个 target 节点在某 iteration 是否「已产出、可老化其队列」。
 *  = 该 (target, iteration) 有一个 top-level run 处于 done 且捕获了 ≥1 <workflow-output>。 */
function isTargetNodeConsumed(
  targetNodeId: string,
  iteration: number,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  return runs.some(
    (r) =>
      r.nodeId === targetNodeId &&
      r.iteration === iteration &&
      r.parentNodeRunId === null &&
      r.status === 'done' &&
      outputRunIds.has(r.id),
  )
}
```

**三态规则（本 RFC 的关键正确性）**：

| target 最新 top-level run | 老化？ | 后果 |
|---------------------------|-------|------|
| `done` + output（正常产出） | ✅ 老化 | 队列已答问题定型、不再注入 |
| `done` **无** output（问了下一轮反问） | ❌ 不老化 | 答案留队列、下一次 rerun **继续注入**（修 round 1 丢失 + 天然避免死锁） |
| `failed` / `canceled` / `interrupted` | ❌ 不老化 | revivable（retry/resume 重跑）、不放行、不误消费 |
| `pending` / `running` / `awaiting_*` | ❌ 不老化 | 在飞 |

**为什么派生（而非戳）**：
- **单一事实源**：老化状态从 run 状态直接派生，不需要 runner 显式标一列、也不会因崩溃漏标而不一致（RFC-098 崩溃 replay 天然一致）。
- **零 migration**：不加列，升级窗口的在飞任务直接按现有 run 状态派生老化，历史问答不丢。
- **幂等**：读多少次都一样，无写副作用。

**review 打回重做**（用户拍板「消费掉」）：target 第一次 `done+output`（产出）即老化；review reject → 重做是新 run，但队列问题已老化 → **不重注入**；重做靠 RFC-119 prior-output 块带上次产物。这与派生自洽（老化只看「有没有出现过 done+output」，出现过就永久老化）。

## 3. 注入统一

**新 `buildClarifyQueueContext`**（收编 `buildClarifyNodeQueueContext` + `buildPromptContext` 的 per-question 半）：

- 取 target 节点队列里 **所有 `sealed` 且 target 未老化**（`!isTargetNodeConsumed`）的问题；
- **跨轮累积**、按 `clarify_rounds.iteration` 顺序渲染；
- 历史轮（非本次 dispatch）**read-only**（全量问答、无 sibling scope、无 directive）；当前轮（本次 dispatch 的 partial 子集）保留 RFC-128 P5-BC 的 sibling scope 块；
- **零 attribution**（RFC-099，源自 `clarify_rounds`）。

**golden-lock**：non-deferred / 单轮全量下发 → 与旧 `buildPromptContext` **逐字不变**（历史轮为空时退化为单轮渲染）。

## 4. 改派后的下游接线（RFC-127 收编）——设计决策 D3

**保留 RFC-127 借壳的产出语义**，只把消费账本简化：

- **run.node_id = origin**（产出归属 + 下游拓扑不变）；
- **agent = target 的 agent**（借壳执行者的脑子 body/model/runtime；`buildBorrowedAgent` 保留）；
- **下游 = origin 节点的输出端口**（改派只改「谁干活」，不改「工作流拓扑/谁的下游」）。

即「改派 = 改 target（执行者）」，但 **origin 决定下游**——designer 问题改派给 X 处理，产出仍走原 designer 的下游，不断链。

| role | origin | target（default） | 可改派？ |
|------|--------|-------------------|---------|
| self | 提问 agent 节点 | = origin | 否（自问自答） |
| questioner | questioner 节点 | = origin | 否 |
| designer | designer 节点 | = origin（可 override） | ✅ 改 override |
| manual | 手动问题 origin | 指定 target | ✅ |

**简化点**：RFC-127 的三账本（immediate / designer / deferred-self-questioner）借壳冲突判定，收敛为「同 (target, iteration) 一条在飞 rerun」的串行化（§7 in-flight）+ 派生老化。`resolveBorrowForNode` 仍用于把 target 的 agent 解析出来给 scheduler spawn（借壳 spawn 路径不变）。

## 5. non-deferred 双路径（保留）

- non-deferred（RFC-125 旧 quick-channel）：`submitClarifyAnswers` 立即 mint continuation + `buildPromptContext` 整轮注入 + `consumed_by_*` 戳消费——**字节级不变**（RFC-125 golden-lock）。
- deferred（新模型）：任务级队列 + 派生老化 + `buildClarifyQueueContext`。
- scheduler XOR 二选一（现状机制保留）：deferred + 有 dispatched 问题 → 新路径；否则 → 旧整轮路径。

## 6. 迁移策略

**派生方案 → 零 schema migration**：
- 不加列。升级后，新代码按现有 `task_questions`（origin/target/sealed/dispatched）+ run 状态派生老化。
- 升级窗口在飞任务：历史 round 的 target 若已 `done+output` → 派生为已老化（与旧 window 消费结果一致）；未产出 → 未老化、继续注入（比旧 window 更宽松、不丢历史轮，正是修复目标）。
- 无回填、无 dual-write（派生无持久态）。
- 回退安全：代码回退即回到旧 window/戳逻辑，DB 无残留。

## 7. 防护保留（不因简化放松）

1. **readiness gate**（`dispatchTaskQuestions`）：问题 `sealed_at` 非空才能下发（不变）。
2. **in-flight 串行化**：同 (target, iteration) 同时只一条在飞 rerun（防 double-mint）。按 target 派生：target 有 pending/running top-level rerun → 拦新 dispatch。取代 `assertNoInFlightDispatch` + `assertNoOpenImmediateLedger` 的 mode 判定，统一为「target 有未产出在飞 run」。
3. **park**：未下发的 `sealed` 问题 → 钉住 origin 提问节点（frontier 不越过）；`partitionUndispatchedParkTargets` 改按 target 派生老化（target 未产出 = 在飞、不 park；已产出 + 有未下发 sealed = park 等下发）。
4. **question-write 锁**（`getTaskQuestionWriteSem`）：seal / dispatch / 老化读一致性保留。

## 8. 失败模式

| 场景 | 现状风险 | RFC-131 处理 |
|------|---------|-------------|
| 同 target 上 self + designer 两 cause | double-mint | in-flight 串行（一条在飞）+ auto-split 分批 |
| `done`-无-output（问下轮）死锁 | 前序 1fb1646 修 | **天然避免**：done-无-output 不老化、下轮继续注入 + 可下发 |
| 改派后旧 target 队列残留 | 幽灵注入 | 改派改 override → 问题只进新 target 队列（按 target 投影，旧 target 不再取到） |
| review 重做重复注入 | 双来源冲突 | 已老化不重注 + prior-output（用户拍板消费掉） |
| park deadlock（sealed 未下发 + origin 死） | 永久 park | readiness gate + dispatcher 序列化 + 终态 CAS |

## 9. 测试策略（必写）

**纯函数**（首选可断言面）：
- `isTargetNodeConsumed`：无 run / pending / done-无-output / done+output / failed 各 case → 老化判定。
- `buildClarifyQueueContext`：多轮全历史注入 ✓ / done+output 老化后不注入 ✓ / done-无-output 不老化仍注入 ✓ / 历史 read-only 无 scope ✓ / 当前轮 sibling scope ✓ / 零 attribution ✓ / golden-lock non-deferred 逐字 ✓。

**集成**：
- 多轮 self-clarify e2e：round 1 + round 2 → 产出 prompt 含两轮（复现并锁死 `01KWDKBS` 那类 bug）。
- 改派：改 target → 问题进目标队列、下游归 origin。
- review reject → 重做不重注 + prior-output。
- 防护：readiness / in-flight 串行 / park。
- 迁移/派生：升级窗口在飞任务不丢历史轮。

**回归锁**：`rfc128-p5-bc`（golden-lock/partial/double-injection）、`rfc127-*-borrow`（借壳 spawn）、`clarify-rerun-ledger-deadlock`（前序死锁）——迁移到新判据后仍绿或按新语义更新。

## 10. 与前序改动的收敛

| 前序 | 处理 |
|------|------|
| 死锁 fix（`isDispatchedEntryConsumed` in-flight/revivable mode，`openImmediateRounds` mode，commit `1fb1646`） | 被派生老化取代（done+output 唯一老化、done-无-output 不老化）；mode 分裂收敛为单一 `isTargetNodeConsumed`。旧函数在 non-deferred 旧路径保留或删。 |
| history 补丁（`9b1c30e` `buildClarifyNodeQueueContext` 补历史轮） | 被 `buildClarifyQueueContext` 统一取代（更彻底：覆盖纯重跑、不依赖「有新 dispatch」）。 |
| RFC-127 借壳三账本 | 收编为「target 队列 + in-flight 串行」；`buildBorrowedAgent` / spawn 路径保留（§4 D3）。 |

## 11. 接口契约

```ts
// 老化判据（纯、派生）
isTargetNodeConsumed(targetNodeId, iteration, runs, outputRunIds): boolean

// 队列注入（取代 buildClarifyNodeQueueContext + buildPromptContext per-question 半）
buildClarifyQueueContext(args: {
  db; definition; taskId; consumerKind; consumerNodeId; dispatchedRunId; targetIteration;
  sessionMode?; applyLatestDirective?; directiveOverride?; directiveOverrideAt?;
}): Promise<ClarifyPromptContext | undefined>

// in-flight 串行 / park 改按 target 派生（dispatchTaskQuestions / partitionUndispatchedParkTargets）
```

## 12. 关键 file:line 索引

```
task_questions / clarify_rounds            packages/backend/src/db/schema.ts
消费判据（改/弃）                            clarifyRounds.ts:844 isQueueEntryRenderableForRun → 弃
                                            clarifyRerunLedger.ts isDispatchedEntryConsumed → 收敛
注入（改）                                   clarifyRounds.ts:302/612 selectAnsweredRoundsForConsumer/buildClarifyNodeQueueContext
in-flight / readiness（改按 target）         taskQuestionDispatch.ts:510/820 assertNoInFlightDispatch
park（改按 target）                          taskQuestions.ts partitionUndispatchedParkTargets
老化触发（派生，读时算；无 runner 写点）      —（派生，无需 runner.ts 标）
借壳 spawn（保留）                            taskQuestionDispatch.ts resolveBorrowForNode + buildBorrowedAgent
```
