# RFC-056 patch 2026-05-26 — review row 必须把 clarifyIteration 跟到 approval 当时的上游水位

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (第 10 个 patch under RFC-056；接 RFC-064 unified counter)。
Scope: bug-fix patch。Per `CLAUDE.md` RFC workflow §6 exception，仍以 RFC-056 patch 形式归档（与
[`patch-2026-05-26-review-dispatch-respects-cci.md`](./patch-2026-05-26-review-dispatch-respects-cci.md)
落地的 freshness 守卫直接耦合，属同一守卫的右半边缺口）。

Pairs with:

- [`patch-2026-05-26-review-dispatch-respects-cci.md`](./patch-2026-05-26-review-dispatch-respects-cci.md)（守卫表达式 + dispatch 短路逻辑）
- RFC-064（unified `clarifyIteration` 计数器，已合并 cross/self 两路）

## 1. Symptom (live task `01KSH5ZAS6NVGMRJ9XG2BBQTZT`)

Workflow `01KS7C0K5ZRJ29AZD7J13C42C2`（"doc → review → doc → review"，含 self-clarify on
`agent_m7p3n1`）。用户报告：**一份文档审完确认（approved）之后，系统立刻又弹出一次相同节点的文档评审**。

DB 证据（`~/.agent-workflow/db.sqlite`，时间逆序裁剪）：

| node_run | node_id | retry | review_iter | clarify_iter | status | 关键事件 |
|----------|----------|-------|-------------|--------------|--------|---------|
| `01KSH5ZAXHJJ…` | agent_m7p3n1 | 0 | 0 | 0 | done | 初次产出 |
| clarify_400qzp ×2 | – | – | – | 0,1 | answered:continue / stop | 第 1 轮迭代 |
| `01KSH6JM52PV…` | agent_m7p3n1 | 0 | 0 | 1 | done | clarify 后重跑 |
| `01KSH6P8PE28…` | agent_m7p3n1 | 0 | 0 | 2 | **canceled** | "superseded-by-review-iterated" |
| `01KSH6WRQRSQ…` | **rev_5h9xpz #1** | 0 | 0→1 | **2** | done | v1 → user iterated（"100×100"）；同行内 v2 → user approved |
| agent_m7p3n1 × 4 | – | 0/1 | – | 2,3,4,5 | done | iterate 触发的 retry 链 + 自澄清 continue/continue/stop |
| `01KSH7BH22T5…` | agent_m7p3n1 | 0 | 0 | **5** | done | 最终一次源端 done |
| `01KSH7VWEV0E…` | **rev_5h9xpz #2** | 1 | 1 | **5** | awaiting_review | **这就是第二次评审** |

doc_versions 三行：

| dv | version | review_iter | decision | decided_at |
|----|---------|-------------|----------|------------|
| 01KSH6WRQS…3D | 1 | 0 | iterated | 1779768060449 |
| 01KSH7KQ53HD… | 2 | 1 | approved | 1779768881613 |
| 01KSH7VWEZ…MT | 1 | 1 | pending  | – |

**注意**：第一行 review_run（`01KSH6WRQR…`）创建时按 dispatch 拿到的 sourceRun 写入了
`clarify_iteration = 2`（review.ts:519，`clarifyIteration: sourceRun.clarifyIteration ?? 0`）。
随后用户 iterate → 同行被 `iterate-review` 转回 pending（review.ts:1451-1456，extra 只
写 `reviewIteration: nextIter`，**没有** bump clarifyIteration）。Scheduler 下一拍重 dispatch 时
upstream agent 还在 clarify 中、最终在 `clarify_iter=5` 才 done；接着创建 v2（review.ts:540+
fresh `createDocVersion` 路径）但仍未刷新 review 行的 `clarify_iteration`。用户 approve v2 →
`approve-review` transition（review.ts:1268-1273）把 status 推到 done、**extra 只含 finishedAt**。

approval 一落地，scheduler 下一拍跑 `dispatchReviewNode`：

```ts
// review.ts:478-481 + 327-333
const { reuse, latestDone } = pickFreshestReviewRun(reviewRuns)
if (isReviewClarifyAlignedWithUpstream(latestDone, sourceRun)) {
  return { kind: 'ok', summary: '', message: '' }
}
// =>
// latestDone.clarifyIteration = 2 (审到的水位不更新，仍是首次 dispatch 时刻的快照)
// sourceRun.clarifyIteration  = 5 (源 agent 自澄清后真正 done 的水位)
// 2 >= 5 → false → 未对齐 → 不短路 → mint 第二条 awaiting_review 行
```

第二个 review run（`01KSH7VWEV…`，retry_index=1, review_iter=1, clarify_iter=5）就此诞生，
内部又新建一条 pending doc_version 让用户再审一遍——但用户上一秒 approve 的就是基于
`clarify_iter=5` 的 v2，**实际上无东西可审**。

## 2. Root cause — `clarifyIteration` 只在"建行"时刻写入、approval 不重新对齐

`patch-2026-05-26-review-dispatch-respects-cci.md` 把 RFC-052 的"任一 done 行即短路"收紧为
"latestDone 的 cci ≥ sourceRun 的 cci 才短路"。在原始 cross-clarify 场景里 cascade
会主动 mint 一条 fresh pending review 行（更高 cci）→ latestDone 仍是旧 cci done →
短路被规避 → cascade 行被 dispatch。这条左半边在 RFC-064 把 cci 折入 `clarifyIteration`
后语义保留。

**但**右半边——**同一条 review 行经历 iterate → 源端自澄清 / 跨节点反问 → approve 的合法回路**——
留下了缺口：review 行的 `clarifyIteration` 字段是"上一次建/重入时刻的上游水位"，**不是
"approve 当时实际审过的上游水位"**。结果 RFC-064 把 self-clarify 也升到同一计数器之后，
任何一次"用户 iterate 之后源 agent 再次自澄清到更高 clarify_iter 才 done、然后用户
approve" 的现场都会复现 §1 的 false re-dispatch。

跟 `patch-2026-05-26-review-dispatch-respects-cci.md` 的关系是对偶：
- 那个 patch 修的是 cascade mint 出来的 pending 行**不该被短路掉**；
- 本 patch 修的是 reuse 一直在用的同一行**approve 之后该被认为对齐**。

两个 patch 合起来才构成完整的"freshness 守卫只在真正未审过的上游版本上拦截"语义。

## 3. 修复 — reuse / approve 都把 review 行的 `clarifyIteration` 升到当时 sourceRun 的水位

只动 `packages/backend/src/services/review.ts`，两处 + 一条单元 helper。

### 3.1 reuse 分支同步 bump（dispatch 重入）

把 `dispatchReviewNode` 的 reuse branch 改为同时把 `clarifyIteration` 升到当前 sourceRun
水位（pending → awaiting_review 的常规 re-park 与首次进入 awaiting_review 都走这里；
fresh-mint 分支已经写过一次，行为不变）。

```ts
// review.ts:485-500 当前形态：
if (reuse !== undefined) {
  reviewNodeRunId = reuse.id
  reviewIteration = reuse.reviewIteration
  if (reuse.status !== 'awaiting_review') {
    await transitionNodeRunStatus({
      db,
      nodeRunId: reviewNodeRunId,
      event: { kind: 'park-review' },
      extra: { startedAt: reuse.startedAt ?? Date.now() },
    })
  }
}

// 改为：
if (reuse !== undefined) {
  reviewNodeRunId = reuse.id
  reviewIteration = reuse.reviewIteration
  const upstreamClarifyIter = sourceRun.clarifyIteration ?? 0
  if (reuse.status !== 'awaiting_review') {
    await transitionNodeRunStatus({
      db,
      nodeRunId: reviewNodeRunId,
      event: { kind: 'park-review' },
      extra: {
        startedAt: reuse.startedAt ?? Date.now(),
        clarifyIteration: upstreamClarifyIter,
      },
    })
  } else if ((reuse.clarifyIteration ?? 0) < upstreamClarifyIter) {
    // 已经 awaiting_review 但上游又前进了一格——仍然要把 review 行的水位拉齐，
    // 否则后续 approve 走 §3.2 的 transitionNodeRunStatus 也是 'park-review' 不
    // 进入的状态，无法借 §3.2 兜底。setNodeRunStatus 在 awaiting_review →
    // awaiting_review 的"原地刷"路径下保持状态机合法（CAS 同状态写入仅更字段）。
    await setNodeRunStatus({
      db,
      nodeRunId: reviewNodeRunId,
      to: 'awaiting_review',
      allowedFrom: ['awaiting_review'],
      extra: { clarifyIteration: upstreamClarifyIter },
    })
  }
}
```

> **Q1（实施时机点）**：`setNodeRunStatus` 在 `nodeRuns` 上做 awaiting_review → awaiting_review
> 的"原地写"是否合法？— 答：`packages/backend/src/services/lifecycle.ts:128-170`
> `setNodeRunStatus` 只校验 `allowedFrom` 命中即 CAS UPDATE，不强求 from ≠ to；本 patch
> 把 awaiting_review 加入 `allowedFrom` 列表显式合法化此通路。RFC-053 invariant 仅禁
> `direct status assignment outside lifecycle.ts`，未禁原地刷。该写入只动一个 extra 字段，
> 不影响 broadcast / 状态机调用方语义。

### 3.2 approve 分支兜底（防 reuse 路径未走到）

在极少数 race 情形下（譬如 daemon restart 重入 + dispatch tick 没机会跑到 §3.1 就直接
approve 的中间窗口），仍要在 approve 时把 clarifyIteration 拉齐到 doc_version 实际消耗
的 sourceRun 水位。改 `approveDocVersion`（线 1268-1273）：

```ts
// review.ts:1268-1273 当前形态：
await transitionNodeRunStatus({
  db: args.db,
  nodeRunId: args.nodeRunId,
  event: { kind: 'approve-review' },
  extra: { finishedAt: decidedAt },
})

// 改为：
const sourceClarifyIter = await readSourceClarifyIterationForDocVersion(args.db, dv)
await transitionNodeRunStatus({
  db: args.db,
  nodeRunId: args.nodeRunId,
  event: { kind: 'approve-review' },
  extra: {
    finishedAt: decidedAt,
    clarifyIteration: sourceClarifyIter,
  },
})
```

新增 helper（导出供单测，与 `pickFreshestReviewRun` / `isReviewClarifyAlignedWithUpstream`
同档放在 review.ts 顶部）：

```ts
/**
 * RFC-056 patch-2026-05-26 (clarify-iter-tracking): 找到 doc_version 实际消耗的
 * sourceRun 当下的 `clarifyIteration`。优先用 dv.sourceNodeRunId（若 schema 已
 * 含该列；当前 schema 无），否则按 (taskId, sourceNodeId, iteration) 取
 * freshest top-level done 行（sortKey = clarifyIteration → retryIndex → ulid）。
 * 兜底 0 时返回 review 行已有值，避免回退；调用方负责合并到 extra。
 */
export async function readSourceClarifyIterationForDocVersion(
  db: DbClient,
  dv: DocVersion,
): Promise<number> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, dv.taskId),
        eq(nodeRuns.nodeId, dv.sourceNodeId),
        eq(nodeRuns.status, 'done'),
      ),
    )
  let freshest: (typeof rows)[number] | undefined
  for (const r of rows) {
    if (r.parentNodeRunId !== null) continue
    if (isFresherNodeRun(r, freshest)) freshest = r
  }
  return freshest?.clarifyIteration ?? 0
}
```

> **Q2（为何不直接读 review 行已有 clarifyIteration）**：能。但 §3.1 必须先在 reuse 路径
> 上修，§3.2 否则永远不可能兜到——逻辑环不闭合。两步必须同时落，否则任何 §3.1 没覆盖
> 的中间窗口（daemon restart / handler 顺序 race）会持续复现 §1。代价仅多 1 次 SELECT。

### 3.3 freshness 守卫表达式不变

`isReviewClarifyAlignedWithUpstream`（review.ts:327-333）逻辑保持，只是它读的
`latestDone.clarifyIteration` 现在被 §3.1 + §3.2 真正持续地刷新到上游水位，alignment
判定回到设计原意。

### 3.4 RFC-052 / canonical RFC-056 / RFC-064 不退化

- RFC-052 retry-placeholder 不会进入 §3.1：placeholder 不是被 `dispatchReviewNode` reuse
  分支选中的对象（placeholder 没有进入 `pickFreshestReviewRun` 的 reuse 候选——它没有
  fresher 排序键）；走原 fresh-mint 分支不变。
- 工作流完全无 clarify（clarifyIteration 全 0）：§3.1 sourceRun.clarifyIteration=0 = reuse.clarifyIteration=0，
  if 分支 `<` 不成立 → 不写；§3.2 helper 返回 0 = review 已有 0 → no-op；行为字节级守恒。
- RFC-056 cross-clarify 主场景（cascadeDownstreamFromDesigner mint 新 pending review 行）：
  §3.1 reuse 选中的就是 cascade-minted 行（status=pending），sourceRun.clarifyIteration = cascade
  bump 后的新水位、reuse.clarifyIteration = mint 时刻设置的同一新水位（[`patch-2026-05-25-fresher-noderun-includes-cci.md`](./patch-2026-05-25-fresher-noderun-includes-cci.md)
  已让 cascade mint 写入正确水位），两者相等、§3.1 if `<` 不成立、行为不变；
  approve 后 §3.2 helper 读到同样水位 → no-op。
- RFC-064 unified counter：`clarifyIteration` 现在涵盖 self + cross 两种触发源。本 patch
  完全建在该统一计数器上，无 cci 残留。grep `crossClarifyIteration` 在本 patch 改动的
  review.ts 区段 0 命中。

## 4. 实时任务恢复（task `01KSH5ZAS6NVGMRJ9XG2BBQTZT`）

任务目前停在第二个 review run `01KSH7VWEV0E…` 的 awaiting_review，doc_version
`01KSH7VWEZ69G42K6D5CXRCQMT` pending。该 doc_version 的 body 与上一次 approved 的
`01KSH7KQ53HDW8Y2BGNJA7J559` v2 内容一致（都是 clarify_iter=5 时的源 docpath），用户重新
approve 一次即可——不会再产生第三次 false re-dispatch（patch 落地后 §3.1 在那一拍 reuse
分支重入时就会把 clarify_iter 升到 5、§3.2 在 approve 把 5 保留下来 → 下一拍 alignment
判定为 true → 短路 → 完整继续走下游 `agent_b48d63` + `rev_cbkatx`）。

无需脚本介入。Diagnose 面板的 S5 rule（patch-2026-05-26-review-dispatch-respects-cci.md §5
预留的"cascaded review never dispatched"修复入口）不需要扩——该 rule 检测的是 pending 行
**未** dispatch，本 patch 触发的是 pending 行**多次** dispatch；属于同守卫两个相反失效模式，
本 patch 落地后直接消除右半边失效。

> **Q3（是否在 lifecycle alert 增加一条 S6 "review iter-bump tracking gap"）**：暂不。S5 已经
> 覆盖了"freshness 守卫错误地拦截了应进入的 dispatch"这条；S6 形态在本 patch + S5 共存后
> 不应该再出现。如果未来再次出现同型现场（用户报"approve 后又冒一次评审" / "pending review
> 行没人审"），先回看本 patch 是否回归，再考虑加诊断 rule。

## 5. 测试

新增 / 扩 backend 测试：

- `packages/backend/tests/review-clarify-iter-tracking.test.ts` —— 新增 unit + 集成混合
  文件，标题/注释明确写"locks in fix for 01KSH5ZAS6NVGMRJ9XG2BBQTZT-style false
  re-dispatch after approve"，至少 8 case：
  1. `readSourceClarifyIterationForDocVersion` happy：sourceRun done at cci=N → 返回 N。
  2. 同函数选择 freshest：同 sourceNodeId 多行 done（不同 retryIndex / clarifyIteration），
     返回 sortKey 最优解（用 `isFresherNodeRun`）。
  3. 同函数跳过 fan-out child（parentNodeRunId 非空）。
  4. `dispatchReviewNode` reuse 分支 pending→awaiting_review，sourceRun.clarifyIteration=5
     → review 行 `clarifyIteration` 被写到 5（已有值为 2 时被升级）。
  5. `dispatchReviewNode` reuse 分支 awaiting_review→awaiting_review 原地刷新：reuse 已
     awaiting_review 且 reuse.clarifyIteration=2，sourceRun.clarifyIteration=5 → 调用
     `setNodeRunStatus` 把字段升到 5（DB 行状态不变、字段被刷）。
  6. `approveDocVersion` 把 review 行 `clarifyIteration` 升到 helper 计算出的源水位
     （集成层验证：建 task + workflow + 走 dispatch → iterate → 模拟 source agent
     在更高 clarifyIteration 上重 done → reuse 不经过 dispatch（人为跳过 scheduler tick）
     → 直接 approve → 验证 row.clarifyIteration = 升级后水位）。
  7. 回归锁（场景级）：复现 task `01KSH5ZAS6NVGMRJ9XG2BBQTZT` 现场——initial → clarify → iterate
     → self-clarify continue/continue/stop → final source done at clarifyIteration=5 →
     approve v2 → assert：review run.status=done、run.clarifyIteration=5、**没有第二条
     awaiting_review 行被 mint**（query taskId+nodeId、count = 1，retryIndex=0）。这是
     最重要的一条；按 CLAUDE.md test-with-every-change 顶端注释链接本 patch md。
  8. 兜底冗余：even if §3.1 reuse 分支被绕过（直接构造一条 reuse=undefined 路径 →
     fresh-mint 写入 sourceRun.clarifyIteration），§3.2 仍把 approve 时刻的水位锁住——
     验证 fresh-mint + approve 的链路 row.clarifyIteration 与 sourceRun 对齐。

- Source-text grep guards（沿 RFC-056 patch 系列风格，放入新文件
  `packages/backend/tests/review-clarify-iter-tracking-source-locks.test.ts`）：
  1. `review.ts` 引用 `readSourceClarifyIterationForDocVersion` 至少 1 处（防 helper 被
     accidentally 删除）。
  2. `approve-review` transition 邻近 source（line range +-20 行）必须出现
     `clarifyIteration:`（防 §3.2 extra 字段回退）。
  3. reuse 分支 `park-review` 邻近 source 同上。
  4. `awaiting_review → awaiting_review` 原地刷 `setNodeRunStatus` 调用必须出现
     在 dispatchReviewNode 函数体里（grep `setNodeRunStatus` 在 review.ts 出现 ≥ 1 处）。
  5. `extra: { reviewIteration: nextIter }`（review.ts:1455 iterate/reject 分支）保持不动，
     不连带把 clarifyIteration 写进去——iterate/reject 路径**不**对齐 clarifyIteration，
     上游本就要重跑、对齐由后续 dispatch tick 进 §3.1 完成。

- 既有套件回归：`scheduler-fresher-noderun-cci.test.ts`（RFC-064 PR-A 整文件 rewrite 为 3
  层 sort key 后已就位）+ `review-iterate-sibling-cascade.test.ts` + `review-clarify-aligned-upstream.test.ts`（patch-2026-05-26-review-dispatch-respects-cci.md 落地时新增）3-trio 全绿。

`bun run typecheck && bun run test && bun run format:check` 三绿为 push 门槛；CI 全 15 jobs
绿后才认为完工（[feedback_post_commit_ci_check]）。

## 6. Out of scope

- iterate/reject 分支同步对齐 clarifyIteration：iterate/reject 之后上游必须重跑、状态由后续
  dispatch tick 推进；强行在 iterate 时刻刷 clarifyIteration 反而把"该重审一遍"的信号抹掉。
- doc_versions 加一列 `source_node_run_id`：能让 §3.2 helper 不必再做 SELECT，但属于
  migration scope，与本 patch 的"最小修复 + 不动 schema"风格不符；如果未来 helper 成为
  hotpath 再单独立 RFC 上 migration。
- frontend 改动：UI 仍正确显示"等待审查"——只要后端不 mint 第二条 awaiting_review，前端
  自然无第二轮弹窗。
- Multi-tab race / WS 冲突：既有 RFC-053 invariant + RFC-052 reuse pick 已覆盖，本 patch
  不扩。

## 7. Rollout

1. 落代码 + 测试 + 本 patch md + STATE.md 顶部追加一行进行中标记（合并后改 Done）。
2. CI 三绿后 push。
3. 对 `01KSH5ZAS6NVGMRJ9XG2BBQTZT`：用户在 UI 上直接 approve 第二条 awaiting_review 即可；
   patch 落地后不会再产生第三次 false re-dispatch。
4. 后续同型现场（task X "approve 后又冒一次评审"）：grep `review.ts` 是否包含 §3 的两处改动
   即可定位是否回归本 patch。
