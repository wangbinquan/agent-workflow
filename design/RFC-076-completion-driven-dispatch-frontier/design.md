# RFC-076 — 技术设计

> **三轮对抗性评审定稿（2026-06-02，3×~50-agent + 完整性批判 + 直接源码实证）。最终裁决：stage-slivers，不是整体推 trim-B。**
> - **PR-0（=T0，立即做，纯收益）**：带外 mint 撕裂态修复（§3.5）——这是唯一即使 trim-B 永不落地也该做的修复（撕裂窗今天 batch 模型下也存在）。
> - **PR-A（纯函数，低风险）**：`deriveFrontier`+`wrapperHasFreshInnerWork` 纯函数 + 单测，`runScope` 内部改调但仍走 batch（零行为变更）。**第一版即须含 HIGH-1 迭代窗 + HIGH-2 删 exhausted。**
> - **PR-B（race 切换）：暂缓（Deferred）**，go/no-go 待明确触发条件——**理由：用户真实 bug 已被 fix A（`scheduler.ts:606`，commit `1af4f47`，CI 绿）闭合,trim-B 不修在野 bug、纯概念债；三轮在 loop/fanout/exhausted/multi-repo 挖出的缺陷全在 PR-B 面（回归面宽且发散）。** 下方 §3/§4 的 race 设计是 PR-B 真做时的蓝本,**当前不实现**。
> 本文骨架（race + 删两对账 + 每-tick 派生）方向仍判为最优（否决 do-less/hybrid/novel），但**裁决是分期、PR-B 暂缓**。trim-B 的派发谓词修正（N1 failed/interrupted 可派发 / N2 wrapper carve-out / N3 dispatchedThisInvocation / G1 事务非原子→写顺序）见下；三轮报告 `tasks/{wepe4l768,wm68qm7xf,ww8oxsxg9}.output`。
> - **N1（critical，方向曾写反）**：`isDispatchable` **不得**排除 `failed`/`interrupted`——它们是 resume/retry/daemon-restart 的重派发信号（`resumeTask`/`retryNode`/`reapOrphanRuns` 靠「failed/interrupted latest + 无 pending → mint retry_index=max+1」）。仅排除 `done∧fresh`/leaf-`awaiting_*`/`exhausted`(loop-max 真终态)/`canceled`/`running`。
> - **N2（critical）**：wrapper-kind 的 `awaiting_*` 是 resume 再入锚，**必须可派发**（`wrapperHasFreshInnerWork` gated），与 leaf 区分。
> - **N3**：重新引入 `dispatchedThisInvocation`（本次 runScope 调用至多派发一次），恢复旧 `remaining.delete` 语义——纯 status 读分不清「本会话已派发的停泊 wrapper」vs「fresh resume」。
> - **G1（critical）**：Gap3 的「包 `db.transaction`」对含 yielding await 的 body **无效**（bun:sqlite 事务同步、首个 await 即 COMMIT）；须 hoist await 出事务 + 先插 rerun 后 flip。
> - **N4/N5/N6/G2-G7**：C4 锁形纠正（msg-gen 在 add 之后）、SIGKILL 升级提为一等、create-path 假完成、上线全量命中（N1 修复不可分两次发布）等。
> 完整两轮报告见 `tasks/wepe4l768.output`(round1 C1-C4/Gap1-8) + `tasks/wm68qm7xf.output`(round2 trim-B/N1-N8/G1-G7)。

## 1. 现状锚点（`packages/backend/src/services/scheduler.ts`）

- `runScope(state, args)` `:526` —— 单 scope 执行器。被顶层（`:343`）、wrapper-git/loop 递归（`:2132`、`:2999`）复用，故本 RFC 只改 `runScope` 一处即覆盖所有 scope 与嵌套。
- **seed**（`:540-578`）：读 `node_runs`，建 `latestPerNode`（每节点本 iteration 最新 top-level 行，比较器 `isFresherNodeRun`）、`freshestDonePerNode`（`buildFreshestDonePerNode`），把 `done ∧ isNodeRunFresh` 的节点放进 `completed`、从 `remaining` 删。
- **主循环**（`:594-725`）：
  - `ready = computeReadyNodes(remaining.values(), upstreamsOf, completed)`（`:606`，fix A 传递闭包）。
  - `ready` 空 → stall-guard（`:603-648`）：`rescanScopeForNewPendingRows` + `recomputeFreshnessAndDemote`，有进展则 `continue`，否则按 `anyAwaitingHuman` / `anyAwaitingReview` / `firstFailureDetail` 决定返回。
  - `await Promise.all(ready.map(runOneNode))`（`:657`）—— **batch barrier**。
  - 逐个结果：`ok → completed.add`（`:659`，并 RFC-075 commit&push 钩子）；`awaiting_review`/`awaiting_human` 置内存标志；`canceled` 立即短路返回；`failed` 记 `firstFailureDetail` 不短路。
  - 批后 `rescanScopeForNewPendingRows`（`:713`）+ `recomputeFreshnessAndDemote`（`:719`）对账。
- `recomputeFreshnessAndDemote` `:939` / `rescanScopeForNewPendingRows` `:989` —— 两个「重读 DB 调和内存集合」补丁（详见 proposal §1）。
- `computeReadyNodes` / `areTransitiveUpstreamsCompleted`（`services/freshness.ts`，fix A）—— 纯传递闭包就绪谓词，建立在 `completed` 集合上。**B 复用，不改**。

## 2. 新模型总览

把「seed 建快照 → 循环增量 mutate 快照 → barrier → 事后对账」压缩成**单一循环**：

```
每个 tick：
  1. 从 DB 重读本 scope+iteration 的 node_runs   ← 唯一真相
  2. 纯派生 frontier（completed / ready / awaiting / 终态）
  3. 启动所有「就绪且未在飞」的节点（writer 经既有写锁串行，readonly 并行）
  4. 若无在飞 → 据派生的终态返回 ScopeResult
     否则 await 任一在飞节点完成 → 回到 1
```

`completed` / `remaining` / `latestPerNode` 不再是**跨 tick 持有的可变状态**，而是**每 tick 从 DB 现算的局部值**。带外 mint、多跳 stale、resume —— 全部由「每 tick 重读」自然吸收，`rescan` / `recompute` / 双重 stall-guard 扫描随之删除。

## 3. 纯函数抽取：`deriveFrontier`（可断言面）

把派生逻辑抽成纯函数（放 `services/freshness.ts`，延续其纯模块契约；或新建 `services/dispatchFrontier.ts`）：

```ts
export interface Frontier {
  /** 已结算（不再可派发、不阻塞 allSettled）：done∧fresh 的真实行 ∪ settles-without-row 叶子（见下）。 */
  completed: Set<string>
  /** 可派发：传递上游全 completed ∧ isDispatchable(自身 latest 行) ∧ ∉ inFlight ∧ ∉ dispatchedThisInvocation。 */
  ready: string[]
  /** latest awaiting_review/awaiting_human 的 leaf + 未进 ready 的 wrapper（仅终态冒泡）。 */
  awaitingReview: string[]
  awaitingHuman: string[]
  /** latest failed 且未进 ready 者（已进 ready = 待 resume 重跑、非终态）。 */
  failed: string[]
  /** scope 内每个节点都已 completed（含 settles-without-row + latest=exhausted 真终态行）⇒ 可返回 done。 */
  allSettled: boolean
}
// 注（HIGH-2 修正）：**不设 `Frontier.exhausted`、deriveFrontier 不返回 `kind:'exhausted'`**——
// `ScopeResult.kind`（`scheduler.ts:388`）联合类型无 exhausted，runTask 无对应分支会穿透到 done，
// resume 时把 loop-max 任务误标完成。loop-max 继续由 wrapper 返回 `kind:'failed'`+`wrapper-loop-exhausted`
// （`:2204`）经 firstFailureDetail 冒泡（字节等价）；deriveFrontier 把 latest=`exhausted` 行视为
// 「非派发、非 pending、计入 allSettled 的终态」即可（同 done 处理）。

export function deriveFrontier(
  rows: NodeRunRow[],            // 全 task 的 node_runs（函数内过滤；wrapperHasFreshInnerWork 需跨 scope 看 inner 行）
  definition: WorkflowDefinition, // 取 node.kind + wrapper 的 inner descendant nodeIds（递归展开嵌套 wrapper）
  scopeNodes: WorkflowNode[],
  scopeIds: Set<string>,
  iteration: number,
  upstreamsOf: Map<string, string[]>,
  inFlight: ReadonlySet<string>,         // 已在飞、本 tick 不重复 start
  dispatchedThisInvocation: ReadonlySet<string>, // 本次 runScope 调用已派发（恢复旧 remaining.delete 语义，N3）
): Frontier
```

派生步骤：
1. `latestPerNode` ← rows 按 `iteration === iteration ∧ scopeIds ∧ parentNodeRunId === null`，`isFresherNodeRun` 取最新。
2. `freshestDonePerNode` ← `buildFreshestDonePerNode`。
3. **`completed`** ← 两类并集：
   (a) `latestPerNode[n].status==='done' ∧ isNodeRunFresh(...)`（与旧 seed `:573-574` 同口径）；
   (b) **settles-without-row（C1 修复）**：`n.kind ∈ {clarify, clarify-cross-agent}` 这类「graph-visit no-op、故意不写 node_run 行就返回 ok」的合成叶子（`scheduler.ts:1113`/`:1193`），归 `completed` 须**同时**满足：① `latestPerNode[n]` 缺失或非 live（无 awaiting_*/pending/running 行）；② 其传递上游已全 completed；③ **正向证据（N6 修复）**：该上游的 freshest-done 行**没有未答的 `clarify_session`/`clarify_round`**——否则与「runner 即将 createClarifySession 但行还没写」的无锁窗（`scheduler.ts:1936` 在 finally 释放 sem 之后才建会话）撞车，会把「正要停泊提问」误判为 completed → 丢 park。仅「上游 done + 无行」不足。
4. `remaining` ← `scopeIds \ completed`。
5. **`ready` ← `computeReadyNodes(remaining, upstreamsOf, completed).filter(∉inFlight).filter(∉dispatchedThisInvocation).filter(id => isDispatchable(latestPerNode[id], node.kind, ...))`**。两道关键修正：
   - **isDispatchable（trim-B 修正 C2/C3 — 注意 `failed`/`interrupted` 必须可派发，否则击穿 resume/retry/daemon-restart，见 N1/N2）**：
   ```ts
   function isDispatchable(row, kind, rows, definition) {
     if (row === undefined) return true                              // 从未跑过
     if (row.status === 'pending') return true                        // 带外 mint / 占位
     if (row.status === 'done' && !isNodeRunFresh(row, freshestDone)) return true // stale-done 重跑
     // RESUME/RETRY 契约：failed/interrupted latest 行 + 无 pending → 调度器 mint retry_index=max+1
     //（resumeTask task.ts:987-989、retryNode 注入 failed 占位 :1166-1171、daemon 重启 reapOrphanRuns→interrupted）。
     if (row.status === 'failed' || row.status === 'interrupted') return true
     // wrapper 的 awaiting_* 是 resume 再入锚（findResumableWrapperRun :2005-2013 对非终态返回行供 resume）：
     if ((row.status === 'awaiting_human' || row.status === 'awaiting_review') &&
         (kind === 'wrapper-loop' || kind === 'wrapper-git')) {
       return wrapperHasFreshInnerWork(row, rows, definition) // 仅当 inner 有「答后新 mint 的 pending」才再入；否则保持停泊
     }
     // exhausted（loop-max 真终态）/ canceled / running / done∧fresh / leaf-awaiting_* → 不可派发
     return false // done∧fresh / leaf 的 awaiting_* / exhausted(loop-max,真终态 :2201) / canceled / running
   }
   ```
   `exhausted` 仅由 loop-max 产生（`scheduler.ts:2201`），是真终态、不重派发；进程 retry 耗尽落 `failed`（可派发，由 runOneNode 的 `attempt ≤ retryIndex+maxRetries` 兜上限 `:1354`）。
   - **`wrapperHasFreshInnerWork` 必须带迭代窗（HIGH-1，否则 clarify-in-loop i≥1 resume 永久挂死）**：wrapper-loop 自身行写在 `parentIteration`（`:2120`），但 inner 后代 + clarify rerun 写在 loop 计数器 `i`（`:2132` / `clarify.ts:452`，可能为 2）。谓词**不能**用 `wrapperRow.iteration`(=0) 去扫 inner（扫不到 i=2 的 rerun → wrapper 不可派发 → 0-progress 兜底 → 已答任务静默 `scheduler stalled`）。须 `decodeWrapperProgress(wrapperRow.wrapperProgressJson).iteration`（`wrapperProgress.ts` 纯函数，runtime resume 在 `:2098` 用它解 startIter，malformed → fallback 0）作扫描窗；loop 类用 progress.iteration，git 类用 `wrapperRow.iteration`（git inner 与 wrapper 同迭代 `:2999`）。签名升级为 `wrapperHasFreshInnerWork(wrapperRow, rows, definition)` 且内部解 progress——**禁止默认 `wrapperRow.iteration`**。
   - **`dispatchedThisInvocation`（trim-B 恢复旧 `remaining.delete` :654 语义 — N3）**：旧模型防 in-pass busy-loop 靠「派发点把节点移出前沿、本次 runScope 调用内至多派发一次」，**不靠 status**；fresh runScope（resume）重新派生才能重派发。full-B 删了这个内存载体、改纯 status 读，于是**分不清「本会话已派发的停泊 wrapper（用户没答）」与「fresh resume（用户答了、inner 有新 work）」**——这正是 wrapper carve-out 的 `wrapperHasFreshInnerWork` 之外还须 `dispatchedThisInvocation` 的原因。`deriveFrontier` 因此从「纯 rows→frontier」变为「`(rows, dispatchedThisInvocation, inFlight)→frontier`」，仍纯、可断言面 +1 维。
6. `awaitingReview` / `awaitingHuman` ← 按 status 归类，但**仅收 leaf parked + 未进 `ready` 的 wrapper**（防一个 wrapper 同时进 ready 与 awaitingHuman）；`failed` 收 latest `failed` 且**未进 ready**者（已进 ready 的是待 resume 重跑、非终态）；**latest=`exhausted` 视为终态、计入 `allSettled`（同 done 处理），不单列、不返回 `kind:'exhausted'`（HIGH-2）**。
7. `allSettled` ← `remaining` 为空（每个 in-scope 节点都 `completed`，含 settles-without-row）。

**关键**：`stale-done`（latest `done ∧ !fresh`）+ `failed`/`interrupted` 经 `isDispatchable` 判可派发 → `ready` → runOneNode 重跑（见无 pending 即 mint `retry_index=max+1`，`:1336-1343`），与旧 seed+computeReadyNodes 字节等价；多跳 demote 每 tick 一次到位。

### 3.5 带外 mint 的撕裂态：事务 + 顺序 + hoist（Gap3/N3/G1 修复，前置约束）

`deriveFrontier` 每 tick 即读，比旧「barrier 后 rescan」更早暴露多行 mint 的**撕裂中间态**（典型：`submitClarifyAnswers` 把 clarify 行 `→done`(`clarify.ts:393`) 与给源 agent mint rerun `pending`(`:452`) 之间，夹着 `rollbackToSnapshot`(`:442`) 这个跑 git 子进程、**yield 事件循环数十~数百 ms** 的 await）。某 tick 读到「clarify done、rerun 未插」→ 误判 `allSettled=true` → **假完成丢 rerun**。

**根因纠正（G1，关键）**：DB 是单 `Database`+WAL（`db/client.ts:30`），drizzle bun-sqlite 的 `transaction()` 是**同步签名**、bun:sqlite 全同步——传 `async (tx)=>{...}` 时，事务括号只覆盖到 body 内**第一个真正 yield 的 await**，该 await 处会**先 COMMIT** 再继续。故「把含 `rollbackToSnapshot` 的 body 直接包 `db.transaction(async…)` **不会变原子**」（clarify→done 已落盘，rollback/insert 在事务外）。「单连接+WAL」是撕裂的**原因**（同 handle 读可见已提交写），不是安全保证。

**约束（实现前必做，plan T0）**——对每个「同一逻辑事件写 ≥2 行」的带外 mint：
1. **把所有 yielding 操作（`rollbackToSnapshot`、`getAgent`、非-DB select）hoist 出事务体**；事务体内只留**当 tick resolve 的同-handle DB 写**、零真 await。
2. **belt-and-suspenders 重排**：**先插 rerun `pending`、后 flip clarify→done**，使唯一可能的撕裂读是「clarify 仍 awaiting + rerun 已present」——`deriveFrontier` 判为「未 allSettled、rerun ready」的**安全态**。
3. 覆盖范围扩到 **create 路径（N6）**：`createClarifySession`(`clarify.ts:172/190/213`)、`createCrossClarifySession`(`crossClarify.ts:209/221/243`)，以及 `submitCrossClarifyAnswers`/`triggerDesignerRerun`（同 rollback-before-mint 病）；`review.ts:469` 的事务已安全（body 全 DB op、无外部 await，可作正面样板）。
4. mutation-guard 测试须在 tx body 内**保留一个真 yield（`Bun.sleep`）+ yield 期间 fire `deriveFrontier`**，断言绝不观察到 done-without-rerun——「拆成两 await 应变红」的旧 guard **覆盖不到 in-body-await 这一类**，会放过仍坏的实现。

## 4. `runScope` 新主体

```ts
// hoist-once（N8）：纯由静态 definition 派生、不依赖 node_runs，绝不每 tick 重建。
const scopeNodes = definition.nodes.filter((n) => scopeIds.has(n.id))
const upstreamsOf = buildScopeUpstreams(scopeNodes, definition.edges)
const scopeNodeById = new Map(scopeNodes.map((n) => [n.id, n]))

const inFlight = new Map<string, Promise<{ node: WorkflowNode; result: OneNodeResult }>>()
const dispatchedThisInvocation = new Set<string>() // N3：恢复旧 remaining.delete 语义，本次调用内至多派发一次
let firstFailureDetail: Detail | undefined

while (true) {
  // Cancel：不 await drain（Gap4/R7）。在飞节点已共享 opts.signal，runOneNode 经 runner SIGTERM；
  // 立即返回（对齐旧模型即时返回），不阻塞在吞 SIGTERM 的子进程上。后台子进程由 daemon graceful-shutdown 收尾。
  if (opts.signal?.aborted) return { kind: 'canceled', detail: { summary: 'task canceled', message: 'signal aborted' } }

  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const f = deriveFrontier(rows, definition, scopeNodes, scopeIds, iteration, upstreamsOf,
                           new Set(inFlight.keys()), dispatchedThisInvocation)

  // 启动所有新就绪节点（runOneNode 内部 writeSem 保证 writer 串行、readonly 并行）。
  // dispatchedThisInvocation.add 与 inFlight.set 在同步段一起做（早于任何 await），同 tick for 循环不重复 start。
  for (const id of f.ready) {
    const node = scopeNodeById.get(id)!
    dispatchedThisInvocation.add(id)
    inFlight.set(id, runOneNode(state, { node, iteration, log }).then((result) => ({ node, result })))
  }

  if (inFlight.size === 0) {
    // 无在飞、无新就绪 → 终态（优先级 canceled> awaiting_human> awaiting_review> failed> done> stalled）
    if (f.awaitingHuman.length) return { kind: 'awaiting_human', detail: detailFor(f.awaitingHuman[0]) }
    if (f.awaitingReview.length) return { kind: 'awaiting_review', detail: detailFor(f.awaitingReview[0]) }
    if (firstFailureDetail) return { kind: 'failed', detail: firstFailureDetail }
    if (f.failed.length) return { kind: 'failed', detail: detailFor(f.failed[0]) }
    // loop-max（latest=exhausted）不单独返回——它由 wrapper 的 failed 经 firstFailureDetail 冒泡（HIGH-2）。
    if (f.allSettled) return { kind: 'done' }
    // 0-progress 兜底（§8 R5）：ready 空 + inFlight 空 + 非 allSettled + 无 awaiting/failed = 真死锁。
    return { kind: 'failed', detail: { summary: 'scheduler stalled', message: 'no ready nodes in scope' } }
  }

  const { node, result } = await Promise.race(inFlight.values())
  inFlight.delete(node.id)
  if (result.kind === 'canceled') return { kind: 'canceled', detail: detailFrom(result, node) }
  if (result.kind === 'failed' && firstFailureDetail === undefined) firstFailureDetail = detailFrom(result, node)
  if (result.kind === 'ok' && state.task.autoCommitPush && state.topLevelIds.has(node.id)) {
    try { await maybeRunCommitPush(state, node, iteration, log) } catch (e) { log.warn(...) }
  }
  // awaiting_review / awaiting_human：不再置内存标志——下一 tick 从 DB 的 latest 行重新派生
}
```

要点：
- **完成事件驱动**：`Promise.race` 等任一在飞完成；其余继续跑。无 barrier，慢节点不挡已就绪分支（US-3）。每轮 loop 必有进展：start ≥1 / await 一个完成 / 返回终态。**防 in-pass busy-loop 靠 `dispatchedThisInvocation`（本次调用至多派发一次）+ runOneNode 即 mint pending（下一 tick latest 变 pending/running 自然不可派发）+ `attempt ≤ retryIndex+maxRetries` 上限（`:1354`）**，**不靠 status 排除**（failed/interrupted 在 trim-B 下可派发——是 resume 信号）。
- **awaiting 不再用内存标志**：`runOneNode` 把行落成 `awaiting_*` 后下一 tick 从 DB 重新派生归类。
- **canceled**：signal abort + 立即返回，**不 await drain**（Gap4/R7）。**前提（N5，提为一等任务非随手项）**：runner abort/timeout 须加 SIGTERM→（N 秒超时后）SIGKILL 升级——真 kill 点在 `runner.ts:762/773`（仅 SIGTERM）+ `:929` 无界 `await child.exited`；`safeKill` 已支持 SIGKILL(`:1502`) 但从不以 SIGKILL 调用（`cancelTask`/`gracefulShutdown`/`orphans` 均不 kill）。race 模型在飞子进程更多 → 泄漏面更大；吞-SIGTERM orphan 会在行已 canceled 后续写 worktree，污染后续 resume 的 `rollbackToSnapshot`（L1）。spawn 用 process-group 便于整树 kill。
- **RFC-075 commit&push 静默（C4 修法，N4/G7 纠正锁形）**：commitPushRunner 的真实顺序是 `git add -A`(`:170`) → `diff --cached`(`:173-180`) → **msg-gen opencode 子进程**(`:192`) → `commit`(`:213`) → push 循环(`:231`，失败夹 repair 子进程 `:310`)——**msg-gen 在 add 之后、commit 之前**（design 初版写反了），故「持 writeSem 包整段 git CLI」不可行（会把分钟级 LLM 锁进去）。**优选锁形**：writeSem 只包 **`add -A` + `diff --cached` 的快照瞬间**（`:170-180`），释放后跑 msg-gen；`commit`(`:213`，无 `-a`、只提交已冻结 index) / push / repair 不读工作树、无需 writer 互斥。需把 `writeSem` 经**回调** `acquireWrite: () => Promise<()=>void>` 注入 `runCommitPush`（保 commitPushRunner 对 Semaphore 类型零依赖；当前 `CommitPushParams`/`Deps` 无 semaphore 字段，`:57-87`）。回归测试须钉「B 在写时 A 的 `add -A` 被推迟」（注入假 writeSem + 可观测 runGit）。**备选 defer-flush**（inFlight 空时批量 flush）会把多节点改动揉进一个 commit、**破坏 RFC-075 per-node commit 归因**（`commitPushNodeId` 按 agentNodeId 生成）+ e2e——**非「更稳备选」，是行为变更，须 RFC-075 owner 同意**。

## 5. 退役清单

- 删 `rescanScopeForNewPendingRows`（`:989`）+ 其 2 处调用（`:613`、`:713`）。带外 pending mint 由每 tick DB 重读纳入。
- 删 `recomputeFreshnessAndDemote`（`:939`）+ 其 2 处调用（`:617`、`:719`）。多跳 demote 由每 tick `completed` 重导一次到位。
- 删 seed 块（`:540-578`）的独立性——融入首个 tick 的 `deriveFrontier`。
- 删循环内 `anyAwaitingReview` / `anyAwaitingHuman` / `awaitingReviewDetail` / `awaitingHumanDetail` 内存标志（`:588-591`）——改 DB 派生。
- `computeReadyNodes` / `areTransitiveUpstreamsCompleted`（fix A）**保留复用**。
- `buildScopeUpstreams` / `isFresherNodeRun` / `buildFreshestDonePerNode` / `isNodeRunFresh` **保留复用**。

## 6. 与既有 RFC 的耦合

- **RFC-074 / fix A**：B 是其自然终点——freshness 判据（`isNodeRunFresh`）+ 传递闭包就绪（`computeReadyNodes`）不变，只把承载它们的「快照 + 对账」骨架换成「DB 派生 + 事件驱动」。
- **RFC-023 / RFC-056 clarify·cross-clarify**：B 删除的 `rescanScopeForNewPendingRows` 正是 RFC-023 bug 13 的补丁——其职责（纳入带外 pending）被「每 tick 重读」结构性接管，需 I2-concurrent（真 `submitClarifyAnswers` + 在飞 sibling）证明仍即时纳入。**mint 须事务化（§3.5）**，否则每 tick 即读会暴露撕裂态假完成。答 clarify 后的续命路径（clarify 行 `→done` 自动归 settles-without-row/completed，源 agent rerun `pending` 进 ready）须由集成测试覆盖（Gap1）。
- **RFC-005 review**：awaiting_review 停泊 + refresh-supersede 不变；停泊节点经 `isDispatchable` 留在 remaining 仅供冒泡，不再每 tick 重入 `dispatchReviewNode`/重 `broadcastReviewCreated`（C2）。
- **RFC-075 commit&push**：触发点保 per-node `ok`，但 git 突变段持 `writeSem`（§4 C4）；若 top-level 节点经 stale-done 路径多次 `ok`，commit&push 触发可能多次——`git status` 空跳过已幂等掉无变更的二次触发；若需严格「每 top-level 一次」，按 nodeRunId（非 nodeId）去重（Gap6，plan T6 记录）。
- **output sink 节点**：跑完 mint 虚拟 `done` 行（`scheduler.ts:1063`、无 `consumedUpstreamRunsJson` → `isNodeRunFresh` 恒 true），走 `completed`(a)；其永不被 demote 是**既有行为**（旧 `recompute` 同样不 demote 空-consumed 行），B 保持不变。design §3 step 3(a) 已涵盖，无需特判。
- **lifecycleInvariants**：T3「task.done ⟹ 每 output 有 done node_run」依赖 output sink 的虚拟 done 行——B 的终态 `done` 仅在 `allSettled`（含 output ∈ completed）时返回，故仍满足；I-loop-guard 末态须断言 output 行存在（Gap8）。
- **wrapper-loop / wrapper-git（N2 resume 锚）**：wrapper park 时把**自己的 top-level 行**写 `awaiting_*`（`:2167-2171`），是父 scope 重派发它 → `findResumableWrapperRun`(`:2005-2013`) 复用该行 → 再入 inner scope 消费续命行的**唯一路径**。故 wrapper 的 `awaiting_*` **必须可派发**（`isDispatchable` 的 wrapper carve-out），但仅当 `wrapperHasFreshInnerWork`（inner descendant 有答后新 mint 的 pending）才再入、否则保持停泊防 wrapper 级 busy-loop。**leaf 的 awaiting_* 不可派发**（C2），二者必须区分。
- **fanout（N1+G3）**：fanout 不 park 在 `awaiting_*`（生命周期 pending→running→done|failed，`:2222`），故无 N2 死锁面。其 failed/interrupted **wrapper 自身行可重派发**（resume 重跑，trim-B），但 `dispatchFanoutShard`(`:2618`) 对每 shard **无条件 insert、无幂等** → 一次 fanout resume 会把已 done 的 shard 子行**再 mint 一份**。修复 = dispatchFanoutShard insert 前加 per-shard 幂等 SELECT（`nodeId∧iteration∧shardKey∧parentRunId∧status='done'` 命中则跳过），**非靠 status 排除**。I-fanout-fail 须断言「resume 后 shard 行数不翻倍」（G3）。子行（`parentNodeRunId !== null`）在 deriveFrontier step1 过滤跳过。

## 7. 测试策略（test-with-every-change 强制）

### 单元（纯函数 `deriveFrontier`，主断言面）
- **F1 settled-fresh**：链 in→A→R→C 全 done+fresh → `completed` 全含、`ready` 空、`allSettled`。
- **F2 带外 pending mint 即时纳入**：A 有新 `pending`（clarify rerun）→ A ∉ completed、A ∈ ready；**无需任何「rescan」步骤**（锁 RFC-023 bug 13 的结构性接管）。
- **F3 多跳 stale 一次到位**：A 推进出新 done，R/C 仍持旧 consumed → 一次 `deriveFrontier` 即让 R 落 remaining 且 ready、C 被传递闭包挡住（对比旧 `recompute` 一跳/批）。
- **F4 fix A incident 窗口**：completed={in,rev1}（designer 重跑中）→ ready=[designer]、questioner 不在 ready。
- **F-clarify-norow（锁 C1）**：clarify 叶子**无任何 node_run 行**、其传递上游已 done → `c ∈ completed`（settles-without-row）、`c ∉ ready`、`allSettled` 可达 true。
- **F-park-human（锁 C2）**：clarify 行 `awaiting_human`、上游 done → `awaitingHuman=[c]`、`c ∉ ready`。
- **F-park-review（锁 C2）**：review 行 `awaiting_review`、source done+fresh → `awaitingReview=[R]`、`R ∉ ready`。
- **F-crossclarify-park（锁 C2）**：questioner done+fresh、cross-clarify 行 `awaiting_human` → `awaitingHuman` 含之、`∉ ready`。
- **F-failed-retryable（锁 N1，与 C3 相反）**：latest `failed`/`interrupted`、上游 done、无 live pending → **∈ ready**（resume/retry 重派发信号）；**不**进 `failed[]` 终态。
- **F-exhausted（锁 N1 边界）**：latest `exhausted`（loop-max）→ `exhausted=[n]`、`n ∉ ready`（真终态）。
- **F-park-wrapper-loop / F-park-wrapper-git（锁 N2）**：wrapper 行 `awaiting_*` + inner descendant 有 `pending` → **∈ ready**；inner 无 fresh pending（首次停泊、用户未答）→ `awaitingHuman/Review` 含之、`∉ ready`。
- **F-dispatched-dedup（锁 N3）**：`dispatchedThisInvocation` 含某停泊 wrapper / failed 节点 → 本次不再出现在 `ready`；空集（fresh resume）→ 可重派发一次。
- **F-staledone（反向锁）**：latest `done ∧ !isNodeRunFresh` → **仍 ∈ ready**（确认 `isDispatchable` 没误伤 stale-done 重跑）。
- **F-inflight 去重**：ready 节点已在 inFlight → 不出现在 `ready`。
- **F-diamond / 边界 / 环**：复用 fix A 谓词覆盖，叠加 frontier 层。
> 注：第一轮的 `F-failed`（断言 failed∉ready）锁的是 **bug 行为**，已被 F-failed-retryable 取代——failed 必须可重派发。

### 集成（mock-opencode + 真 `runTask`，行为等价回归；每条带硬超时，hang 即 fail 而非挂死）
- **I-loop-guard（锁 C1/C2，最关键）**：① clarify 叶子 + agent 出 normal output → task 到 `done`、clarify 派发 ≤1 次；② agent 出 clarify → task 返回 `awaiting_human`、clarify 派发 ≤1 次、`broadcastReviewCreated`/cross-clarify `liveRows` SELECT 计数为小常数不随 tick 增长；③ review 停泊 → `awaiting_review`、`broadcastReviewCreated` 仅 1 次；④ cross-clarify 停泊 → `awaiting_human`、无 SELECT 风暴；⑤ clarify 叶子在 wrapper-loop body（iteration≥1，clarify 行写 iteration:0）→ 不 busy-loop。
- **I-clarify-resume（锁 Gap1）**：完整 `runTask → awaiting_human → submitClarifyAnswers → resumeTask → done`，断言 resume tick 把 clarify 行（已 `done`）归 completed、源 agent rerun（`pending`）进 ready、最终 task `done` + output 有 done 行。
- **I-resume-remint（锁 N1，最关键的 resume 回归）**：`runTask → 节点 fail → resumeTask`（或 `retryNode` 注入 failed 占位）→ 断言调度器 mint 一条 `retry_index=max+1` 的 pending 行并跑到 done、task 最终 done。**断言 `retry_index` 精确值序列**（G5：与旧 batch 模型字节等价，retryNode 注入 max+1 占位后 runOneNode 再 +1 的行为须一致）。变体：daemon 重启 interrupted resume。
- **I-clarify-resume-in-loop（锁 N2）**：clarify 在 wrapper-loop body 内 → `awaiting_human` → `submitClarifyAnswers` → resume → wrapper 行经 carve-out 重派发 → inner 消费续命 pending → task `done`。配 `scheduler-rfc040-wrapper-await.test.ts`（loop/git/nested）保持全绿为等价锚。
- **I2-concurrent（锁 G1/Gap3 + RFC-023 bug13）**：**前置子任务（G4，非 trivial）**——给 `mock-opencode.ts` 加 file-handshake barrier（TOUCH_ON_START 写哨兵 + WAIT_FOR_FILE 阻塞至测试删哨兵，含超时兜底 + afterEach 清理；现有 fixture 唯一时序控制是固定 `DELAY_MS`，无 barrier，且不可用 sleep 轮询=CLAUDE.md 禁 flaky）。`void runTask` + barrier 同步；sibling b 阻塞时对仍 running 的 task 调**真** `submitClarifyAnswers`，释放 b，断言 rerun 在 b 完成后派发到 done。**mutation-guard（G1）**：在 mint 事务体内**留一个真 yield（`Bun.sleep`）**、yield 期间 fire `deriveFrontier`，断言绝不见 done-without-rerun——「拆两 await」式 guard 覆盖不到 in-body-await。
- **I3 readonly 并行 / writer 串行**：两 readonly 同 tick 入飞；两 writer 经 writeSem 串行。
- **I-fanout-fail（锁 G3）**：fanout wrapper failed/interrupted resume → 断言 **shard 行数不翻倍**（per-shard 幂等 SELECT 生效）、不重复 spawn。
- **I-commit-quiescence（锁 C4/G7）**：两并行 top-level writer + `autoCommitPush`，注入可观测假 writeSem + 可注入 `runGit`，B 在写时断言 A 的 `git add -A` runGit 调用**被推迟到 B 释放后**（钉 add 瞬间，非仅「B 仍在写」）。
- **I4 loop / wrapper-git / fanout**：既有套件全绿（递归继承）。
- **I5 daemon 重启 resume**：重启 flip running/pending→interrupted（`orphans.ts`），resume 后从 DB 派生等价、interrupted 行经 `isDispatchable` 正确处理（不重 mint）。

### 源码层兜底守卫
- `rescanScopeForNewPendingRows` / `recomputeFreshnessAndDemote` 在 `scheduler.ts` grep **0 命中**（函数 + 调用全删）。
- `runScope` 含 `Promise.race(` 且**不含** `Promise.all(ready.map(`。
- `runScope`/调度路径调 `deriveFrontier(`，且 `deriveFrontier` 的 ready 计算 consult `isDispatchable`/latest-row status（防未来 refactor 静默丢 gate）。
- **更新（非新增）既有守卫**：`scheduler-transitive-dispatch-gate.test.ts:183` 断言字面量 `computeReadyNodes(remaining.values()`——调用搬进 `deriveFrontier` 后会误红，须改其锚。另 grep `packages/backend/tests/` 全量列出含 `rescanScopeForNewPendingRows`/`recomputeFreshnessAndDemote`/`Promise.all(ready` 的测试（如 `clarify-review-combination-scenarios`、`cross-clarify-downstream-cascade`），逐文件判定「文本守卫需更新」vs「真集成断言需保留语义」，不可笼统「grep 0 命中」误删。

### 全量回归
`bun test` backend 全量（排除既有环境失败：daemon/ws/cli/mcp）零新增失败；前端不受影响；Playwright e2e 全 4 shard ×2 OS 绿。

## 8. 失败模式与风险

- **R1 并发实现 bug（race / inFlight 管理）**：`Promise.race` + `inFlight` Map 的增删、cancel 的 signal 传播（R7）——以 I3/I5 集成测试 + 纯函数把派发决策与并发编排**分离**（`deriveFrontier` 纯、可穷举）来降风险。
- **R2 行为等价性**：这是核心风险。缓解：fix A incident、clarify/cross-clarify/review/loop/fanout 既有套件 + e2e 必须全绿；任何一条变红即视为行为回归、停下排查（不放宽测试）。
- **R3 每 tick DB 重读开销**：图 ≤ 数十节点、`select * from node_runs where task_id` 已被现有 rescan/recompute 每 batch 各做一次；B 频率更高但单次轻。先不优化（proposal Q4），design 记录；若 profiling 显示热点，可加「仅在有完成事件后重读」（本就如此）或行级增量。
- **R4 stall 误判**：`inFlight` 空 ∧ `ready` 空 ∧ 非 allSettled ∧ 无 awaiting/failed → 真死锁，返回 stalled（与现状同语义，但不再因「快照漏 pending」假死）。
- **R5 busy-loop / 0-progress tick（评审 C1/C2 根因，已修）**：合成叶子无行（C1）、leaf 停泊节点不 gate（C2）会每 tick 重派发死循环。修复 = §3 settles-without-row + `isDispatchable`。**防 in-pass 重派发的载体是 `dispatchedThisInvocation`（本调用至多一次）+ runOneNode 即 mint pending + maxRetries 上限，不靠 status**（trim-B 下 failed/interrupted 可派发）。I-loop-guard 以「派发计数 ≤ 常数 + 硬超时」守之。
- **R6 撕裂态假完成（Gap3/N3/G1，前置约束 §3.5）**：根因**不是** WAL，是 bun:sqlite `db.transaction()` **同步签名**——async body 在首个真 yield 的 await 处先 COMMIT，故含 `rollbackToSnapshot` 的 mint **直接包事务无效**。修复 = hoist yielding await 出事务体 + 先插 rerun 后 flip clarify→done + 扩到 create 路径。mutation-guard 须在 body 内留真 yield + yield 期间 fire deriveFrontier。
- **R7 cancel 行为变更 + SIGKILL 缺失（Gap4/N5，提为一等任务）**：race 模型 cancel 时有未 await 在飞子进程；选「signal abort + 立即返回」。但 runner **只 SIGTERM**（`:762/773`）+ 无界 `await child.exited`（`:929`）+ 无 SIGKILL 升级（`cancelTask`/`gracefulShutdown`/`orphans` 均不 kill）→ 吞-SIGTERM orphan 在行已 canceled 后续写 worktree。修复 = abort/timeout 后起超时定时器 `safeKill(SIGKILL)` + process-group spawn。
- **R8 commit&push 多次触发（Gap6，低）**：top-level 节点经 stale-done 重跑可多次 `ok` → 多次触发；`git status` 空跳过幂等无变更，严格则按 nodeRunId 去重（§6）。
- **R9 锁序不对称（N7，latent）**：C4 使 commit&push 成首个「持 writeSem 不持 globalSem」者。今天**不**死锁（writeSem 段纯 git CLI、不 spawn、不取 globalSem）但无结构守卫——未来「buildCommitAgent 变 non-readonly / commit 子进程走 globalSem / 图省事把 writeSem 包整个 runCommitPush」任一都能闭合死循环。修复 = 优选 N4 的「只锁 add+diff 快照」自然规避；若留则加源码守卫（断言 writeSem span 内无 `runNode(`/`globalSem.acquire(`、buildCommitAgent 保持 readonly）+ hard-timeout 测试。
