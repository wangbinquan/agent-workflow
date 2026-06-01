# RFC-074 Design — Provenance-Based Node Freshness

> 状态：Draft（2026-05-27）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 核心概念

**Provenance（消费溯源）**：每个 node_run 记录它消费了上游每个节点的哪一个具体 node_run id。

```
node_runs.consumed_upstream_runs_json = { "<upstreamNodeId>": "<nodeRunId>", ... }
```

**freshness 不变式（Inv-Provenance）**：

> 一个 node_run `r` 是 **fresh** ⟺ `∀ [upId, consumedId] ∈ r.consumed`，`freshestDone(upId).id === consumedId`。
> 即：r 消费的每个上游 run，都仍是该上游节点当前最新的 done 行。

stale = 非 fresh = 至少一个上游产出了更新的 done 行。stale 的节点需要重跑。

与现状的本质差异：现状用 `clarifyIteration` 水位**推断**因果（且水位是可与内容 desync 的独立字段）；provenance **直接记录**因果（且记在唯一的内容读取点，无法 desync）。

## 2. 现状代码结构（要删 / 改的部分）

```
crossClarify.ts
  triggerDesignerRerun()
    ├─ mint designer pending（上游自身，保留）
    └─ cascadeDownstreamFromDesigner()           ← 删（Layer A）

scheduler.ts
  runScope()
    ├─ latestPerNode 用 isFresherNodeRun           ← Phase 2 改 id 排序
    ├─ applyClarifyFreshnessInvariant()           ← 删（Layer B），换读时 freshness
    ├─ resolveUpstreamInputs() 返回 {port→content} ← 改：同时返回 {upId→runId}
    └─ rescanScopeForNewPendingRows()             ← 改：接入 freshness 重算

review.ts
  dispatchReviewNode()
    ├─ isReviewClarifyAlignedWithUpstream()        ← 删
    ├─ pickFreshestReviewRun()                     ← 保留（选 reuse 行）
    └─ reuse + createDocVersion                    ← 改：stale 时 mint v(n+1) + supersede
```

## 3. 数据模型

### 3.1 consumed_upstream_runs_json

`node_runs` 加一列（沿用既有 `*_json` 列模式，如 `inventory_snapshot_json` / `pre_snapshot_repos_json`）：

```sql
ALTER TABLE node_runs ADD COLUMN consumed_upstream_runs_json text;  -- JSON: {upstreamNodeId: nodeRunId}
```

- 选 JSON 列而非独立表：与现有列风格一致、零新表、读写在单写者模型下原子。
- null = "无 provenance 记录"，由 freshness 判定为 fresh（向后兼容硬切，§7）。
- input 节点 / 无上游节点：consumed = `{}`（空 map），永远 fresh。

### 3.2 freshestDone 的定义（含 iteration 作用域）

`freshestDone(nodeId, scopeIteration)` = 在**当前 scope 的 iteration 作用域内**、该 nodeId 的 **status='done' 且 parentNodeRunId=null** 的行中，按 picker 选最新的一行：

- **Phase 1**：picker = `isFresherNodeRun`（仍 `(cci, retryIndex, id)`）
- **Phase 2**：picker = `(retryIndex, id)` 或纯 `id`（见 §6.1）

§4.2 论证两 phase 选出同一行，provenance 比较结果不漂移。

**iteration 作用域必须与现有 picker 对齐（loop-wrapper 关键）**：

- scheduler `latestPerNode`（`scheduler.ts:539`）按 `r.iteration === scopeIteration` 严格筛——freshness 重算用的 `freshestDonePerUpstream` 必须**同样**只看本 iteration 的 in-scope 上游行，否则 loop 内第 i 轮的节点会拿到第 j≠i 轮的上游代、误判 stale。
- 但 `resolveUpstreamInputs`（`scheduler.ts:3132`）读内容时用 `r.iteration <= scopeIteration`（允许读更低 iteration 的跨边界输入，如 git-wrapper diff / loop carry）。**这是两个不同的语义**：freshness 比的是"本 iteration 内上游有没有更新代"，内容读的是"含跨边界的可见上游输出"。
- **统一规则（D6 收紧）**：consumed 记录的是 `resolveUpstreamInputs` 实际选中的那一行（含跨 iteration 的）；freshness 判定时，`freshestDone(upId)` 在该上游行所属的 iteration 作用域内取最新 done。即"我消费的那行，在它自己的 iteration 作用域里是否仍最新"。跨边界（低 iteration）上游一旦该 iteration 已 settle 不再重跑，consumed 永远等于 freshestDone，天然 fresh——符合 loop 语义（上一轮的产物不会因本轮而失效）。
- 实现上 `freshestDonePerUpstream` 的 key 用 `(upstreamNodeId, 该 consumed 行的 iteration)`，不是裸 nodeId。B 组须含 loop-wrapper 内 + 跨边界输入的 freshness case。

## 4. freshness：读时计算，替代两层 cascade

### 4.1 纯函数 isNodeRunFresh

```ts
// 新增 scheduler.ts（或 freshness.ts）
export function isNodeRunFresh(
  run: typeof nodeRuns.$inferSelect,
  freshestDonePerUpstream: Map<string, typeof nodeRuns.$inferSelect>,
): boolean {
  const consumed = parseConsumedJson(run.consumedUpstreamRunsJson) // {} when null
  for (const [upId, consumedId] of Object.entries(consumed)) {
    const cur = freshestDonePerUpstream.get(upId)
    if (cur === undefined) continue          // 上游尚无 done 行：不据此判 stale（防御）
    if (cur.id !== consumedId) return false  // 上游有更新 done 行 → stale
  }
  return true
}
```

纯函数、易单测、无 DB 写。

### 4.2 scheduler completed 集合收紧

`runScope` 入口（替代 `scheduler.ts:546-583` 的 `completed` 构建 + Layer B 调用）：

```ts
// 1. latestPerNode（保留现有逻辑，Phase 2 picker 换 id）
// 2. freshestDonePerNode：每个 in-scope 上游的最新 done 行
// 3. completed = { nodeId : latest 行 done AND isNodeRunFresh(latest, freshestDonePerNode) }
for (const [nodeId, r] of latestPerNode) {
  if (r.status === 'done' && isNodeRunFresh(r, freshestDonePerNode)) {
    completed.add(nodeId); remaining.delete(nodeId)
  }
}
// 删除 applyClarifyFreshnessInvariant 调用
```

stale 的 done 节点**不进 completed** → 留在 remaining → 拓扑 ready 后被正常 dispatch（mint 新行时记新 consumed）。**没有任何 speculative mint**——这是 M2（死行）结构性消失的根因：行只在实际 dispatch 时 mint，且立即执行。

### 4.3 ⚠️ 关键：每-batch fixed-point 重算，替代的是 Layer A 预 mint（不只是 Layer B）

> 这是整个 RFC 最易写漏、漏了就 silent 错（下游基于 stale 上游跑完）的一处。务必看清职责归属。

**先厘清现状两层各自真正在干什么**（读代码后修正的认知）：

- `applyClarifyFreshnessInvariant`（Layer B）**只在 `runScope` 入口跑一次** fixed-point。
- 当 A→B→C 全 agent、A 刚因 clarify 重跑时：入口时 A 是 **pending**（clarify 答完 mint 的上游行），`freshestDone(A)` 仍是旧 A → B/C 的 consumed 仍 == 旧 freshestDone → **B/C 入口判定为 fresh，Layer B 入口什么都不做**。
- 那现状靠什么让 B/C 重跑？**靠 Layer A 的预 mint**——cascade 在 clarify 答完时就把 B/C 的 pending 行预先 mint 好了，入口 `latestPerNode` 直接看到 pending 行 → 进 remaining → 被调度。

**结论：删掉 Layer A 后，多跳 agent 链的 mid-loop 传播必须由"每个 batch 后 fixed-point 重算 freshness + demote stale-done 节点"接管。这个重算替代的是 Layer A 的职责，不是（只是）Layer B 的。**

时序（A→B→C 全 agent，A 因 clarify 重跑）：

```
入口:   A=pending(new), B/C=done&fresh(consumed=旧A/旧B)
batch1: 跑 A → A done(new)
  └─ 重算: B.consumed[A]=旧 ≠ freshestDone(A)=新 → B demote 回 remaining
batch2: 跑 B → B done(new)      ← runOneNode mint retry+1 新行,读 fresh A,记新 consumed (scheduler.ts:1171-1180)
  └─ 重算: C.consumed[B]=旧 ≠ freshestDone(B)=新 → C demote
batch3: 跑 C
```

**每 batch 后都要重算、loop 到稳定（每 pass 推进一层）。** 现有 `rescanScopeForNewPendingRows`（`scheduler.ts:832`）只"加 fresher pending 行"、**不 demote done 节点**——这正是必须新增的能力：

```ts
// 新逻辑（在 rescan 内或紧随其后，每 batch + 入口都跑）：
// 1. 从 DB 重读，重建 latestPerNode + freshestDonePerUpstream（含 iteration 作用域 §3.2）
// 2. 对当前 completed 的每个节点重算 isNodeRunFresh：
//    stale → 从 completed 移除、放回 remaining（不 mint，dispatch 时才 mint）
// 3. 返回"本轮是否有 demote/新增"，有则 while-loop continue 再跑一轮
// 终止性：DAG 无环 + 每节点重跑产出更新 done 行后即 fresh，单调收敛；safety cap = scope 节点数（沿用 Layer B maxPasses 思路）
```

US-4 的逐层传播由此实现：A done → 重算 demote R（review）→ dispatch R 即 `awaiting_review` 暂停 scope（R 不会 mid-loop 变 done）→ 用户 approve → 下个 runScope → 重算 demote B → 重跑 → O。**review/clarify 节点 dispatch 即暂停**，所以跨 review 的传播天然分散到多个 runScope；同一 runScope 内的 fixed-point 只推进纯 agent 链。**R 重评期间 B/O 仍 fresh**（B 消费的是 R 当前最新 done，R 还没产出新 done）——正确语义。

### 4.4 与 daemon restart resume 的关系

resume 重入 `runScope`，freshness 全部从 DB 的 consumed_json 真相重算，不依赖任何 transient cascade 跑过。crash-after-done 场景（AC-9）：节点 done 已 commit，consumed 已落库；resume 时该节点 fresh→completed，其下游按 freshness 正常推进。完全可恢复。

## 5. 记录点：consumed 写在唯一内容读取点

### 5.1 agent 节点：resolveUpstreamInputs

`resolveUpstreamInputs`（`scheduler.ts:3115`）已对每条入边选出具体 `run`（`run.id` 读 outputs）。改造：

```ts
// 返回值从 Record<string, string> 扩成：
//   { inputs: Record<string,string>, consumed: Record<string, string> }
// consumed[edge.source.nodeId] = run.id
```

dispatch 时把 consumed 落到新 node_run 的 `consumed_upstream_runs_json`。

**⚠️ picker 统一是一处行为变更（修潜伏 bug，须 baseline 锁）**：

- 现状 `resolveUpstreamInputs`（`scheduler.ts:3132-3136`）选行用 `(iteration desc, retryIndex desc)`，**无 cci、无 status 过滤**；而 freshness / `latestPerNode` 用 `isFresherNodeRun`（`(cci, retryIndex, id)`）。
- 潜伏 bug：上游同时有 `(cci=0, retry=5)` done（review-iterate 累积的 pre-clarify 行）和 `(cci=1, retry=0)` done（clarify-rerun 行）时，`resolveUpstreamInputs` 选 **retry=5 那个旧的**（读到 clarify 之前的过时内容），而 freshness 认为 cci=1 最新——**节点实际读的内容 ≠ freshness 认为的最新行**（§1.2 三-picker 漂移实锤）。
- 本 RFC 统一：`resolveUpstreamInputs` 改用与 §3.2 `freshestDone` 同一个 picker，且只选 done 行。这**修了上述 bug**，但属行为变更。
- **风险处置**：PR-A baseline 必须先锁住 `resolveUpstreamInputs` 现有选行结果（T-A 专项 case）；统一后逐一审计翻转的现有断言，确认每个变更都是"修正过时读取"而非"回归"。任何依赖旧 `(iteration,retryIndex)` 选行的测试要么改期望、要么暴露出它本就在锁 bug 行为。

### 5.2 review 节点：sourceRun

`dispatchReviewNode`（`review.ts:402-408`）已用 `isFresherNodeRun` 选出 `sourceRun`。把 `sourceRun.id` 记进 review row 的 `consumed = { [sourceNodeId]: sourceRun.id }`。

approve 时不需要任何 cci 同步——consumed 已指向实际评审的 sourceRun，approve 后 `isNodeRunFresh(reviewRow)` 自然 true（除非上游又出新 done，那走 US-2 再评）。**§1.3 bug 结构性消失**。

## 6. cci 退役（Phase 2）

### 6.1 isFresherNodeRun → id 排序

```ts
// 现状 (cci, retryIndex, id) → Phase 2:
export function isFresherNodeRun(candidate, incumbent): boolean {
  if (incumbent === undefined) return true
  if (candidate.retryIndex !== incumbent.retryIndex) return candidate.retryIndex > incumbent.retryIndex
  return candidate.id > incumbent.id
}
// 或纯 candidate.id > incumbent.id（ULID 创建序已含 retry 先后）——PR-A baseline 锁定后定夺
```

### 6.2 删 cci-bump max+1 跨参与者机械

`triggerDesignerRerun`（`crossClarify.ts:817-835`）/ `mintQuestionerRerun`（`crossClarify.ts:1161-1187`）/ clarify rerun（`clarify.ts:475`）里"`max(participant clarify, session iteration)+1`"全删——新行靠 id 自然最新，无需算 cci。这些 max+1 逻辑本身是多个 patch 的来源（"cci 必须 bump 过所有参与者"）。

### 6.3 lifecycleInvariants U1 迁 RFC-070 consumed-by 戳

`lifecycleInvariants.ts`：
- U1 dedup key（`:455`）含 `clarifyIteration` → 改 `(nodeId, reviewIteration, shardKey, id)` 或去 cci 维度。
- designer-run freshness 检查（`:536` `gt(nodeRuns.clarifyIteration, session.iteration)`）——**这正是 RFC-070 治过的跨尺度 cci 比较**。改读 RFC-070 的 `cross_clarify_sessions.consumed_by_*_run_id` 戳：「该 round 是否已被一个 done-with-outputs 的 designer run 消费过」直接由戳回答，不再 cci 比大小。

### 6.4 DROP 列 + 24 文件清理

- migration 12-step rebuild DROP `node_runs.clarify_iteration`。
- shared `NodeRunSchema`（`task.ts:411`）删 cci 字段；ws / clarify schema 注释清理。
- 后端 ~17 文件去 cci 读写（scheduler / crossClarify / clarify / clarifyRounds / review / runner / lifecycle / lifecycleInvariants / lifecycleRepair{S3,T2,U1,helpers,types} / sessionView / memoryInject / task / workflow.validator 注释）。
- 前端 5 文件「第 N 轮」改 row 序号派生（NodeDetailDrawer / SessionTab / node-history / injected-memories-card / rfc026-events）。

#### 6.4.1 ⚠️ 这些 cci 不是显示，是身份/分组/排序键——不能 grep-删

读代码后确认下列用法把 cci 当**逻辑键**，Phase 2 需"用 id 做代际身份"的深思替换，机械删会改错语义：

| 文件:行 | cci 当什么 | id 替换方案 |
|---|---|---|
| `memoryInject.ts:401-409` `loadInjectedSnapshotFromFirstAttempt` | 七元组身份键 `(task,node,iter,shard,reviewIter,**cci**,retry=0)` 找"本代 retry=0 首行"的注入快照 | cci 删后 `(...,retry=0)` 会匹配多个 clarify 代→取错。改为：从触发本次 followup 的当前行**沿同代向前**取最早 retry=0 行（按 id），或显式记 generation 锚点。**必须给出明确代际身份，不可裸删 cci 维度** |
| `lifecycleRepair/options-T2.ts:57-70` | 按 cci 分组 clarify 行、选最新代 | 改按 id 选 latest top-level clarify 行 |
| `lifecycleRepair/options-S3.ts:79` | dedup key `iteration|cci` | 改 `iteration|id` 或去 cci 维度 |
| `lifecycleRepair/options-U1.ts` / `lifecycleInvariants.ts:455` | dedup key 含 cci | 同 §6.3，去 cci 维度 / 迁 consumed-by 戳 |
| `sessionView.ts:196` | prompt 历史排序 `(cci, retryIndex, ...)` | 改 `(id)` 或 `(retryIndex, id)`，须产出与迁移前一致的顺序（C 组锁） |

→ T-C4 不能笼统写"17 文件去 cci"；上表每行是独立子任务，memoryInject 的代际身份替换尤其要单测。

### 6.5 UI「第 N 轮」派生

cci 删后，UI 显示的「第 N 轮 clarify」改由"该节点 top-level rerun 行按 id 升序的序号"派生（前端从 node-history 已有的行列表算 ordinal）。显示值需与迁移前一致（PR-C 测试锁）。

## 7. Review awaiting 期间的 refresh（mint v(n+1) + supersede）

awaiting 期间上游 done 出新 run（review row stale）时，`dispatchReviewNode` 走 refresh 路径：

```ts
// docVersions.decision enum 加 'superseded'（migration CHECK 约束改）
await db.transaction(async (tx) => {
  // 1. 旧 pending docVersion v(n) → decision='superseded',
  //    decisionReason='upstream-refreshed', decidedBy='system'
  // 2. 作废 v(n) 的 review_comments（锚定旧内容，已无意义）—— DELETE by doc_version_id
  // 3. createDocVersion v(n+1)，body 来自最新 sourceRun outputs
  // 4. review row.consumed = { [sourceNodeId]: 最新 sourceRun.id }
})
broadcastReviewCreated(...)  // 复用既有事件；前端切到 v(n+1)
```

前端（PR-B）：收到 broadcast 时若当前打开的是被 supersede 的 v(n)，自动切到 v(n+1) + banner「上游已更新，已切到 v(n+1)，你在旧版的批注已失效」。

**决策 D5**：review_comments 作废而非保留——批注锚定旧版内容，对新版无意义；保留只会产生悬空锚点。

## 8. Fan-out provenance（wrapper 边界）

**决策 D3**：fan-out wrapper 当原子节点。

- wrapper 整体的 node_run（wrapperRunId）记 `consumed = { 上游nodeId: 上游runId }`（wrapper 消费了它上游的哪些 run）。
- wrapper 内部分片子行 / aggregator **不记 provenance**（视为该 wrapper run 内部恒 fresh）。
- 上游变 → wrapper 整体 stale → 整个 wrapper 重跑（重分片 + 重跑子 run + 重 aggregate）。

代价：上游小改也整 wrapper 重跑，比分片级粗。收益：实现简单、与现有 wrapper run 生命周期一致、分片本就不直接对外触发下游。

## 9. Migration

### 9.1 PR-B：加列 + 硬切

```sql
ALTER TABLE node_runs ADD COLUMN consumed_upstream_runs_json text;  -- 历史行 NULL
```

**决策 D4**：不 backfill。null consumed → `isNodeRunFresh` 返回 true（fresh）。理由：

- in-flight task 升级后不会冒 spurious 评审（与本 RFC「修过度触发」方向一致——错也错在"不重评"而非"乱重评"）。
- 本仓开发期数据，历史 task reopen 罕见，可重新 launch。
- backfill 的复杂度（按 id<本行 的最新上游 done 推断）收益不抵风险。

**边界（AC-10 须写明）**：迁移时正卡 awaiting 的 legacy task 里，某个**本应 stale** 的节点会因 null=fresh 被当 fresh、不重跑。可接受——这是有意偏向"不乱重评"；用户可重新 launch 该 task 拿到正确传播。新 task（迁移后产生的行都带 consumed）不受影响。

### 9.2 PR-C：DROP cci 列

SQLite 12-step rebuild DROP `node_runs.clarify_iteration`；journal idx +1；drizzle schema 同步。docVersions.decision 加 'superseded'（若 PR-B 未含则此处补）。

## 10. 三相 PR 强序（决策 D7）

| PR | 内容 | 可独立发 |
|---|---|---|
| **PR-A** | baseline 锁定：`isFresherNodeRun` 行为、freshness 行为、review 再评合同、事故快照 ≥ 20 case。**零生产改动** | — |
| **PR-B** | provenance 列 + 记录点 + `isNodeRunFresh` + completed 收紧 + rescan 重算；删 Layer A/B + review cci-alignment；review refresh v(n+1)+supersede + 前端 banner。**cci 列暂留只做排序**。真正的 bug fix 在此落地 | ✓ 独立可发 |
| **PR-C** | cci 退役：`isFresherNodeRun` id 排序 + 删 bump 机械 + lifecycleInvariants U1 迁 consumed-by 戳 + DROP 列 + shared/前端 24 文件清理 + UI 派生 | ✓ 可缓 |

PR-A 全绿 + 用户验收 → PR-B；PR-B 上线稳定 → PR-C。出问题易定位（bug fix 与 cci 退役分离）。

## 11. 测试策略

### 11.1 PR-A baseline（≥ 20 case）

- A1-A6 `isFresherNodeRun` 现有排序行为逐 case 锁（clarify rerun / cross rerun / 单节点 retry / resume / process-retry / tie-break）——为 PR-C 切 id 排序做等价基线
- A7-A12 freshness 现有行为锁（Layer A cascade + Layer B demote 的可观察结果：上游 rerun → 下游最终重跑 / 多层传播 / 幂等）
- A13-A17 review iterate-reject-approve + 再评合同
- A18-A20 事故 task `01KSHVXCH6RQ5F5P64MZ4FZVN6` 快照回放

### 11.2 PR-B provenance（≥ 16 case）

- B1-B4 `isNodeRunFresh` 纯函数（空 consumed / 全 fresh / 一上游 stale / 上游无 done 行防御）
- B5-B7 consumed 记录：agent（resolveUpstreamInputs）/ review（sourceRun）/ 多上游
- B8-B10 completed 收紧 + **每-batch fixed-point 重算 + 多层纯-agent 链 mid-loop 逐层 demote**（§4.3 critical；A→B→C 全 agent、A 重跑 → 必须验证 B 在 batch1 后 demote、C 在 batch2 后 demote，且最终各读到 fresh 上游）
- B11-B13 事故修复：approve 后无 18ms spurious 行（AC-2）/ US-2 再评（AC-3）/ 无死行（AC-6）
- B14-B15 review refresh：mint v(n+1) + v(n) superseded + review_comments 作废（AC-4）
- B16 crash recovery（AC-9）+ null consumed = fresh（AC-10）
- **B17（验证为安全，须锁）clarify-only-no-output 上游**：questioner/agent 发 clarify-only（`runner.ts:996` status=done 但 0 output）→ 任务 awaiting_human 暂停 → 答完 `mintQuestionerRerun`/`triggerDesignerRerun` 产出带 output 的 rerun → 下游 dispatch 时 `freshestDone` 选**带 output 的 rerun 行**而非 clarify-only 行、不触发 review-source-port-missing
- **B18（验证为安全，须锁）review resume 幂等**：删 `isReviewClarifyAlignedWithUpstream` 后，fresh-done review 进 completed → 不 dispatch → 不重建 docVersion（completed-set freshness 替代旧短路）；awaiting_review row resume → dispatchReviewNode 幂等 re-broadcast

### 11.3 PR-C cci 退役（≥ 12 case）

- C1-C4 `isFresherNodeRun` id 排序与 PR-A baseline 字节等价
- C5-C6 lifecycleInvariants U1 迁 consumed-by 戳行为守恒
- C7-C8 UI「第 N 轮」row 序号派生显示与迁移前一致
- C9-C10 migration DROP 列 + shared schema 去 cci 不破坏序列化
- C11-C12 grep guard：`clarifyIteration`/`clarify_iteration` src+shared+frontend 0 命中；`cascadeDownstreamFromDesigner`/`applyClarifyFreshnessInvariant`/`isReviewClarifyAlignedWithUpstream` 0 命中；`isNodeRunFresh` + consumed 记录点命中

## 12. 实施期决策（D 编号，固化）

- **D1**：freshness = provenance 读时计算，删两层 cascade，无 speculative mint。
- **D2**：彻底退役 cci（Phase 1+2），分 3 PR；isFresherNodeRun 改 id 排序。
- **D3**：fan-out provenance 只在 wrapper 边界记，wrapper 当原子节点。
- **D4**：迁移硬切，null consumed = fresh，不 backfill。
- **D5**：review awaiting 上游变 → mint v(n+1) + supersede v(n) + 作废 v(n) review_comments + 前端 banner。
- **D6**：consumed 记录在唯一内容读取点（resolveUpstreamInputs / review sourceRun），picker 与 freshestDone 统一。
- **D7**：3 PR 强序，bug fix（PR-B）先于 cci 退役（PR-C）独立落地。
- **D8**：lifecycleInvariants U1 的 cci 跨尺度比较迁 RFC-070 consumed-by 戳（两 RFC 收敛）。
- **D9（深扫修订 2026-05-27）**：每-batch fixed-point freshness 重算替代的是 **Layer A 预 mint 的职责**（多跳 agent 链 mid-loop 传播），不只是 Layer B 入口 fixed-point。§4.3 为本 RFC 最高优先正确性点。
- **D10（深扫修订）**：`resolveUpstreamInputs` picker 统一是行为变更（修 `(iteration,retryIndex)` 选错旧行的潜伏 bug），PR-A baseline 锁现有选行 + 审计翻转测试（§5.1）。
- **D11（深扫修订）**：memoryInject + lifecycleRepair{T2,S3,U1} + sessionView 的 cci 是身份/分组/排序键非显示，Phase 2 用 id 做代际身份替换、逐项单测（§6.4.1），不可 grep-删。
