# RFC-095 — 技术设计

行号基线：`97e627e`（2026-06-11）。

## 1. canceled 归类（方案 ①）：isDispatchable 增 canceled 分支 + supersede 标记守卫

dispatchFrontier.ts：

```ts
/** review.ts supersede 写入 errorMessage 的稳定前缀（review.ts:1729 注明是 grep 契约）。 */
export const REVIEW_SUPERSEDE_MARKER_PREFIX = 'superseded-by-review-'

export function isReviewSupersededRow(row: Pick<NodeRunRow, 'errorMessage'>): boolean {
  return row.errorMessage !== null && row.errorMessage.startsWith(REVIEW_SUPERSEDE_MARKER_PREFIX)
}
```

isDispatchable 的兜底段改为穷举 switch（见 §2），其中：

```ts
case 'canceled':
  // RFC-095 (audit S-22): a canceled row is a REVIVAL signal, same class as
  // interrupted — execution was externally cut short (task cancel keeps the
  // worktree; retryNode on a canceled task is a designed UI flow). EXCEPT a
  // review-supersede marker: submitReviewDecision flips the old author row to
  // canceled BEFORE minting the pending rerun (review.ts) — dispatching inside
  // that await window would run the agent without its review context. The
  // marker row stays parked; the rerun row (fresh ULID) carries the revival.
  return !isReviewSupersededRow(row)
```

review.ts 改为从 dispatchFrontier.ts import `REVIEW_SUPERSEDE_MARKER_PREFIX` 拼接标记
（单一事实源；dispatchFrontier 是纯模块、review.ts 引它无环——反向不引）。

爆炸半径核查（全部 nodeRuns 的 canceled 写入点；**对抗检视修订**——初版漏一类、错标一类）：

- review.ts:1740 supersede——被标记守卫排除 ✓
- runner.ts:954→:1164（abort → SIGTERM 退出 → 行翻 canceled，errorMessage='aborted by
  signal'，与 supersede 前缀不冲突）——正是要复活的目标 ✓（初版误写 task.ts:905；
  cancelTask 只翻 tasks 表行，不写 nodeRuns）
- **markWrapperTerminal（scheduler.ts:2232-2252）的四个调用点（loop :2353、fanout
  :2691/:2731、git :3337）把 top-level wrapper 行翻 canceled**——对 frontier 完全可见。
  连带决策：`findResumableWrapperRun`（:2210-2218）现把 canceled 与 done/failed 同列为
  不可复活 → 复活会**重启**（loop 从 iteration 0 重走、git 重新 captureHead 取错 baseline）
  而非**续跑**；与 interrupted 的续跑语义不一致。本 RFC 把 'canceled' 加入可复活集与两处
  wrapper-resume `allowedFrom`（:2322、:3308，已有 allowTerminal:true），与 interrupted
  对齐——取消后复活的 wrapper 按持久化 progress 续跑（git baseline 保持 pre-inner，正确
  语义）。配 wrapper 复活用例（§5-6）。
- fanout shard 子行（parentNodeRunId 非 null）对 frontier 不可见（:1092 过滤），shard
  复跑路径已容 canceled 子行（:2908-2915）✓
- 已取消任务无自动驱动（resumeTask 409、reapOrphanRuns 只翻 interrupted 不 resume、
  lifecycleRepair 纯操作员驱动）——canceled-dispatchable 只在 retryNode 显式复活后生效 ✓
- 二次取消（复活后再 cancel）在 abort 触发与 tick 头检查之间有**有界**竞态窗口（旧
  canceled 行被本 tick 误派发，但 runOneNode 入口 :1219 再查 signal + 子进程挂共享
  SIGTERM）——failed/interrupted 行今天就有同样窗口，非本 RFC 增量，注记不修。

## 2. 穷举分桶：Frontier.blocked + never 检查

### 2.1 isDispatchable（dispatchFrontier.ts）改穷举 switch

现有 if 链语义逐字保留，只改写为 `switch (row.status)` + `default: assertNever`，新增
canceled 分支（§1）。`skipped`：显式 case，返回 false 并注明「零铸造点；启用前必须先在
此决策语义」——switch 让未来新增状态编译失败。

### 2.2 deriveFrontier 分桶段（scheduler.ts:1182-1185）穷举化

```ts
// 不可派发且非完成节点的穷举归类。
// 【对抗检视修订（初版被推翻）】三个停泊桶必须【无条件】收纳——现行 :1182-1185 的入桶
// 不看上游就绪/在飞（derive-frontier.test.ts:208-230 锁定"上游未 done 的 failed 行仍入
// failed 桶"；quiescent 优先级 awaiting_* > failed 依赖无条件收纳——若提前 continue，
// 上游未就绪的 awaiting_review 行会从入桶变不入桶，quiescent 结局从 awaiting_review 变
// failed/stalled，违背"字节级等价"）。只有 blocked 诊断类分支才过「上游就绪 ∧ 不在飞」
// 闸——等上游/在飞不是卡点，不进诊断。
switch (latest?.status) {
  case 'awaiting_review':
    awaitingReview.push(n.id)
    break // 无条件（现行语义）
  case 'awaiting_human':
    awaitingHuman.push(n.id)
    break // 无条件（现行语义）
  case 'failed':
    failed.push(n.id)
    break // 无条件（现行语义）
  case 'exhausted':
    break // 已在 pass-1 入 exhausted 桶
  default: {
    if (!areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) break // 等上游，根因在上游
    if (inFlight.has(n.id)) break // 正在跑，正常推进
    switch (latest?.status) {
      case undefined:
        // clarify / cross-clarify 的图访问 no-op 不写行（:1273-1283），开放 session 时
        // pass-2 不 settle——正常停泊态而非去重病理，reason 据 openClarifyNodeIds 分叉。
        blocked.push({
          nodeId: n.id,
          status: 'absent',
          reason: openClarifyNodeIds.has(n.id) ? 'open-clarify-window' : 'in-invocation-dedup',
        })
        break
      case 'pending':
        blocked.push({
          nodeId: n.id,
          status,
          reason: openAskingNodeIds.has(n.id) ? 'open-clarify-window' : 'pending-anchor-consumed',
        })
        break
      case 'running':
        blocked.push({
          nodeId: n.id,
          status,
          reason: 'orphaned-running-row (restart daemon to reap, audit S-12)',
        })
        break
      case 'canceled':
        blocked.push({ nodeId: n.id, status, reason: 'review-superseded' })
        break // 方案① 下仅 supersede 标记行落到这里
      case 'skipped':
        blocked.push({ nodeId: n.id, status, reason: 'skipped-has-no-dispatch-semantics' })
        break
      case 'done':
        blocked.push({ nodeId: n.id, status, reason: 'stale-done-in-invocation-dedup' })
        break
      case 'interrupted':
        blocked.push({ nodeId: n.id, status, reason: 'interrupted-in-invocation-dedup' })
        break
      default:
        assertNever(latest.status) // awaiting_*/failed/exhausted 已被外层收走
    }
  }
}
```

> 备注：blocked 类只在「本调用已派发过又被去重挡住 / 锚点已耗 / 孤儿行 / supersede 窗口」
> 等病理或窗口态到达，quiescent 时刻即卡点。reason 字符串是诊断载荷不是 API 契约（测试
> 断言用前缀匹配）。穷举性由内外两层 switch + assertNever 共同保证——新增 NodeRunStatus
> 值时内层编译失败。

Frontier 接口增加：

```ts
blocked: Array<{ nodeId: string; status: string; reason: string }>
```

### 2.3 全集 property 测试（双保险）

- 编译期：switch + `assertNever`（util 内联或既有 helper）。
- 运行期：rfc095 测试从 shared 的 NODE_RUN_STATUS 全集（或 schema 枚举）逐值构造 latest
  行喂 deriveFrontier，断言「入且仅入一个显式集合」（completed / ready / awaitingReview /
  awaitingHuman / failed / exhausted / blocked），新增状态值未分类即红。

## 3. decideScopeOutcome 抽取（dispatchFrontier.ts，纯函数）

```ts
export interface ScopeOutcomeInput {
  awaitingHuman: readonly string[]
  awaitingReview: readonly string[]
  exhausted: readonly string[]
  blocked: ReadonlyArray<{ nodeId: string; status: string; reason: string }>
  failed: readonly string[]
  allSettled: boolean
}
export type ScopeOutcome =
  | { kind: 'ok' }
  | { kind: 'awaiting_human' | 'awaiting_review'; nodeId: string }
  | { kind: 'failed'; detail: { summary: string; message: string; nodeId?: string } }

export function decideScopeOutcome(
  f: ScopeOutcomeInput,
  firstFailureDetail?: { summary: string; message: string; nodeId?: string },
): ScopeOutcome
```

优先级与现行 :652-687 逐字等价：awaitingHuman > awaitingReview > firstFailureDetail >
exhausted（合成 wrapper-loop-exhausted detail）> allSettled→ok > stalled。唯一增量：
stalled 分支的 summary 变为

```
scheduler stalled — blocked nodes: nodeA(running: orphaned-running-row …), nodeB(canceled: review-superseded)[; failed parked: nodeC]
```

（message 仍为 `'no ready nodes in scope'` 保持机器面兼容；既有断言若匹配该 message 不受
影响——实现时 grep 确认无测试断言旧 summary 全文。）runScope 的 quiescent 块替换为：
取 outcome，`awaiting_*` 用 `detailFor(nodeId, parkedDetail)` 包装（detailFor 留在
scheduler.ts，因 parkedDetail 是 runScope 局部状态）。

## 4. 失败模式

| 风险                                                                    | 缓解                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canceled 可重派误伤 supersede 窗口                                      | §1 标记守卫 + 纯函数窗口用例 + rfc092-midrun-review-iterate 集成回归                                                                                                                  |
| canceled 可重派改变某些既有测试预期（如取消后任务保持 canceled 的断言） | canceled 行只在「任务被重新驱动」（retryNode→runTask）时才会被读到——已取消任务无调度循环；实现后全量套件扫红逐个核对，凡是「取消即终局」的既有断言不应受扰（无新调度循环就无派发）    |
| 穷举化引入行为差                                                        | 分桶语义除新增 blocked 外逐字保留；decideScopeOutcome 优先级表驱动单测 + 全量回归                                                                                                     |
| blocked reason 被当 API 依赖                                            | 注明诊断载荷非契约；测试只前缀匹配                                                                                                                                                    |
| review.ts ← dispatchFrontier 引入环                                     | dispatchFrontier 是纯模块（只依赖 shared/schema 类型 + freshness/wrapperProgress），review.ts 单向引入常量无环；typecheck + build:binary 兜底（不动 shared 包导出，无 binary 风险面） |

## 5. 测试策略

1. 翻转 `scheduler-audit-s12-status-bucket-universe.test.ts`：全集表按 §2.2 归类更新
   （running/skipped/pending-耗锚 → blocked + reason 前缀；canceled → ready；新增
   supersede 标记行 → blocked）。
2. 翻转 `scheduler-audit-s22-canceled-retry-stall.test.ts`：纯函数面 canceled sibling →
   ready；DB 面追加「retryNode 后任务跑到 done」集成断言（mock opencode）。
3. 新增 `rfc095-scope-outcome.test.ts`：
   - decideScopeOutcome 优先级矩阵（awaitingHuman/awaitingReview/firstFailure/exhausted/
     ok/stalled 共 ~8 组合）表驱动；
   - stalled summary 含 blocked 节点与 reason 前缀；
   - NodeRunStatus 全集运行期 property（§2.3）；
   - supersede 窗口：canceled+marker 行 → isDispatchable false / 入 blocked；canceled 无
     marker → dispatchable。
4. 翻转 `dispatch-frontier.test.ts:84-91`（对抗检视补列）：canceled 半边从「NOT
   dispatchable」翻为「无 supersede 标记 → dispatchable / 带标记 → NOT」；running 半边
   保持。
5. s22 DB 段翻转后的确定性（对抗检视补列）：方案① 下 retryNode 尾部的后台 runTask 会给
   canceled sibling 铸新行——原「sibling 行数恒 1」断言变竞态；翻转时改为确定性等待任务
   终态（mock opencode + 轮询任务 status 到 done）再断言行集。
6. 新增 wrapper canceled 复活用例：取消含 loop（或 git）wrapper 的任务 → retryNode 复活 →
   断言 wrapper 行被**续跑**而非重启（loop 从持久化 iteration 继续 / git baseline 不重取
   ——对应 findResumableWrapperRun + allowedFrom 的修改）。
7. 回归网：`rfc092-midrun-review-iterate.test.ts`、`derive-frontier*.test.ts`（:208-230
   在修正后控制流下保持绿）、review 全套（supersede 标记正则用例）、s01/s03 audit 锁定、
   `scheduler-boundary-canceled-fanout-status.test.ts`（取消后无新循环、行保持 canceled）、
   `dispatch-multi-row-consistency.test.ts`（C4 标记行）、全量套件。
