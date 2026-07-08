# RFC-144 · merge_state 状态机化（design）

> 行号为 2026-07-08 调研快照（HEAD `7935e469`），实现时以 grep 实况为准。
> 范式蓝本：`shared/lifecycle.ts` + `services/lifecycle.ts` + `lifecycle-grep-guard.test.ts` +
> `scheduler-audit-s14-tasks-status-blind-write-inventory.test.ts`（RFC-053/097 四层防护）。
> 注意：审计报告所称「ESLint ratchet」实际不存在（`services/lifecycle.ts:18` 注释陈旧，RFC-053
> plan 计划过自定义 rule 但落地换成了 grep-guard 单测）——本 RFC 照抄的是**守卫单测**形态。

## 1. 值域与状态图

### 1.1 值域（7 值 + NULL）

```
NULL            非隔离 / passthrough / 旧行（golden-lock：永不改写；mint 恒生 NULL）
isolating       段①已建隔离树、agent 未跑完（persistIsoBase 时写入）
pending-merge   段②agent 成功、输出+node_tree 已 pin、delta 未落 canon
merged          终态·成功：delta 已三路合并落回 canonical
conflict-human  三路合并真冲突且合并 agent 解不了，泊人工（resolve-iso 保留）
merge-failed    终态·失败：merge-back 机制抛错（git 操作失败，区别于内容冲突）
abandoned       终态·废弃（本 RFC 新增）：行已被更新一代取代，其 delta 永不落 canon
```

不变量：**`abandoned` ⇔ 存在更新的取代行**（top-level 同 (task, node, iteration) 的更大 ULID
兄弟行，或父行已被取代的子行）。语义上它不覆盖「行自身失败/耗尽而 isolating 残留」的情形——
那类行是本节点的最终代，merge_state 停在 `isolating` 如实反映「隔离开始、从未完成」，不是僵尸
（不被 replay 捞、被 freshness 门排除），刻意不打 abandoned（见 §12 D8）。

`conflict-resolving`：schema 注释里的死值（RFC-130 设计有、实现从未写入），随本 RFC 从注释删除，
不进值域常量。

### 1.2 状态图

```
                begin-isolation            mark-pending-merge
      NULL ─────────────────▶ isolating ─────────────────▶ pending-merge
                                  │                          │  │  │
                                  │            mark-merged   │  │  │ mark-merge-failed
                                  │         ┌────────────────┘  │  └───────────▶ merge-failed ⊣
                                  │         ▼                   │ park-conflict-human
                                  │       merged ⊣              ▼
                                  │         ▲              conflict-human
                                  │         │ complete-human-resolution
                                  │         └───────────────────┘
                                  │
                                  └───── abandon ────┐
              pending-merge ───── abandon ───────────┼──▶ abandoned ⊣
              conflict-human ──── abandon ───────────┘
```

终态集 `TERMINAL_MERGE_STATES = ['merge-failed', 'abandoned']`（落地勘误 D13：merged 是
「代终点」非「行终点」——同行 wrapper 复活经 `reenter-isolation` 回到 isolating 开新一代；
merged 上其余事件全拒、且不入 abandon from 集）。
NULL 只有一条出边（begin-isolation）；passthrough 行因 `persistIsoBase` 的
`handle.passthrough` 早退（scheduler.ts:1631）永不离开 NULL——golden-lock 不变。
`begin-isolation` 含 `isolating→isolating` 自环（D13：fanout shard/agg 子行原地续跑时
persistIsoBase 重盖新 iso 基列）。

### 1.3 事件 ADT 与转移表（7 事件）

| 事件 kind | from | to | payload | 现有写点 |
|---|---|---|---|---|
| `begin-isolation` | NULL \| isolating | isolating | — | W1/W2（自环 = 同行子行续跑重盖章，D13） |
| `mark-pending-merge` | isolating | pending-merge | — | W3/W4 |
| `mark-merged` | pending-merge | merged | `via?: 'live' \| 'replay'`（纯审计） | W5, W8, W11, W14, W18 |
| `park-conflict-human` | pending-merge | conflict-human | `via?: 'live' \| 'replay'` | W6, W9, W12, W15, W17 |
| `mark-merge-failed` | isolating \| pending-merge | merge-failed | `reason?: string` | W10, W13, W16, W19 |
| `complete-human-resolution` | conflict-human | merged | — | W7 |
| `reenter-isolation` | merged \| conflict-human | isolating | — | 新增（D13：`createOrRebuildWrapperIso` 单点，wrapper 同行复活开新一代） |
| `abandon` | isolating \| pending-merge \| conflict-human | abandoned | `reason: string` | 新增（§6） |

live 与 resume-replay 是**同一条边**的两个入口语境（调研结论：E3≡E6、E4≡E7），用 `via`
payload 区分日志，不拆事件。payload 一律不参与状态计算（与 status 机一致）。

**落地勘误（isolating → merge-failed 边）**：merge-back 的 try 块覆盖两段——snapshot-pin
（`snapshotNodeIsoFinal` + `persistIsoNodeTree`，此段行还在 `isolating`）与三路合并
（`pending-merge` 后）。snapshot 阶段抛错时旧裸写会无条件盖 merge-failed 保证 fail-loud；
严格表若只收 pending-merge，done+isolating 行会落 frontier 的 blocked 桶把任务卡住。故
`mark-merge-failed` 的 from 集为 `{isolating, pending-merge}`（W10/13/16/19 的 catch 两相皆达）。

## 2. shared 层（`packages/shared/src/lifecycle.ts` 追加）

与既有两套状态机同文件、同形态（task 风格：`targetFor` total 函数 + `ok(froms)` 校验 +
`never` 穷举 + try/catch 派生 allowedFrom）：

```ts
export const MERGE_STATES = [
  'isolating', 'pending-merge', 'merged', 'conflict-human', 'merge-failed', 'abandoned',
] as const
export type MergeState = (typeof MERGE_STATES)[number]
/** 列可空：NULL = 非隔离/passthrough/旧行。状态机域显式含 null。 */
export type MergeStateOrNull = MergeState | null

export const TERMINAL_MERGE_STATES = ['merged', 'merge-failed', 'abandoned']
  as const satisfies readonly MergeState[]
export function isTerminalMergeState(s: MergeStateOrNull): boolean

/** deriveFrontier settled 门的单源：done 行的 delta 已在 canon（或从未隔离）。 */
export const SETTLED_MERGE_STATES = [null, 'merged'] as const
export function isMergeStateSettled(s: MergeStateOrNull): boolean

export type MergeStateTransitionEvent =
  | { kind: 'begin-isolation' }
  | { kind: 'mark-pending-merge' }
  | { kind: 'mark-merged'; via?: 'live' | 'replay' }
  | { kind: 'park-conflict-human'; via?: 'live' | 'replay' }
  | { kind: 'mark-merge-failed'; reason?: string }
  | { kind: 'complete-human-resolution' }
  | { kind: 'abandon'; reason: string }

export class IllegalMergeStateTransition extends Error {
  readonly code = 'illegal-merge-state-transition'
  constructor(readonly from: MergeStateOrNull, readonly eventKind: string)
}

export function targetForMergeEvent(ev: MergeStateTransitionEvent): MergeState
export function nextMergeState(cur: MergeStateOrNull, ev: MergeStateTransitionEvent): MergeState
  // switch(ev.kind) + ok(froms)（froms 里 NULL 用字面 null 表示）+ const _exhaustive: never = ev
export function allowedFromForMergeEvent(ev): readonly MergeStateOrNull[]
  // 遍历 [null, ...MERGE_STATES] try/catch 派生——与 allowedFromForTaskEvent 同构
```

与 status 机的两点差异（均已在范式内有先例的最小扩展）：

1. **域含 NULL**：`nextMergeState(null, {kind:'begin-isolation'})` 合法。派生遍历集是
   `[null, ...MERGE_STATES]`。
2. **终态拒绝**：与 `nextNodeRunStatus` 一致，函数开头对 `isTerminalMergeState(cur)` 统一拒
   （abandoned/merged/merge-failed 上任何事件都抛）。

不放 `schemas/task.ts`：merge_state 不是 wire 格式（零 API/前端暴露），是 DB 内部生命周期，
归属 `lifecycle.ts`（decision D3）。不建 zod schema。

## 3. backend CAS 层（`packages/backend/src/services/lifecycle.ts` 追加）

### 3.1 `transitionMergeState`（事件版单入口，无 explicit 逃生门）

```ts
export class ConcurrentMergeStateTransition extends ConflictError {
  // code='concurrent-merge-state-transition'，同族 ConcurrentNodeRunTransition（lifecycle.ts:70）
}

/** merge_state 伴随列白名单：仅 E1/E2 需要（iso 快照五列）。 */
export type MergeStateUpdateExtra = Partial<Pick<typeof nodeRuns.$inferInsert,
  'isoWorktreePath' | 'isoBaseSnapshot' | 'isoBaseSnapshotReposJson'
  | 'isoNodeTree' | 'isoNodeTreeReposJson'>>

export async function transitionMergeState(args: {
  db: DbClient
  nodeRunId: string
  event: MergeStateTransitionEvent
  extra?: MergeStateUpdateExtra
}): Promise<{ from: MergeStateOrNull; to: MergeState }>
```

实现与 `transitionNodeRunStatus`（lifecycle.ts:90-137）逐层同构：

1. SELECT `mergeState` by id（无行 → `NotFoundError`）；
2. `to = nextMergeState(from, event)`（非法 → `IllegalMergeStateTransition` **直抛不包壳**——
   与 `transitionNodeRunStatus` 放行 `IllegalNodeRunTransition` 完全同形；该列无 HTTP 写入口，
   异常只会到 runTask catch-all 失败任务）；
3. CAS UPDATE：
   ```ts
   // rfc144-allow-direct-merge-state-write -- single allowlisted writer
   .update(nodeRuns)
   .set({ mergeState: to, ...(args.extra ?? {}) })
   .where(and(
     eq(nodeRuns.id, args.nodeRunId),
     from === null ? isNull(nodeRuns.mergeState) : eq(nodeRuns.mergeState, from),
   ))
   .returning({ id: nodeRuns.id })
   ```
   `length === 0` → `ConcurrentMergeStateTransition`。**NULL-from 的 CAS 谓词必须用
   `isNull`**（`eq(col, null)` 在 SQL 里恒 false）——这是与 status CAS 唯一的机械差异，
   竞态测试要单独覆盖 NULL-from 格。

`tryTransitionMergeState(args): Promise<boolean>`：同 `trySetTaskStatus`（lifecycle.ts:302-317）
——吞 `ConflictError`/`NotFoundError` 为 false，其余重抛。供错误路径写点（W10/13/16/19，见 §5）
使用：这些写点在 catch 块内，直抛会掩盖原始 merge 错误。

### 3.2 `abandonSupersededMergeStates`（集合式守卫写，mint 不变量的执行体）

逐行 CAS 对 abandon 不必要：abandon 的合法 from 集 {isolating, pending-merge, conflict-human}
本身就是 UPDATE 的 WHERE 谓词——**集合式 UPDATE 的 WHERE 即 CAS**（只可能把合法 from 打到
abandoned，转移合法性由谓词保证，且幂等）。单条 SQL、mint 热路径零额外往返：

```ts
export function abandonSupersededMergeStates(args: {
  /** db 或事务客户端——同步执行（.run()），可进 bun:sqlite 同步事务回调（§4 原子性要求）。 */
  db: DbClient | DbTx
  taskId: string
  nodeId: string
  iteration: number
  /** 新一代行的 ULID；只废弃严格更旧（id <）的行。 */
  supersededByRunId: string
}): number  // 返回废弃行数（=0 是常态：首次派发无前代）
// 落地勘误：不带 reason 入参——废弃原因由取代行自身的 rerun_cause 列承载
// （'retry-node' / 'review-iterate' / …），helper 无 logger、重复入参只会漂移。
// from 集不硬编码：从 allowedFromForMergeEvent({kind:'abandon'}) 派生，转移表
// 增改 abandon 行时 WHERE 自动跟随。
```

```sql
-- rfc144-allow-direct-merge-state-write -- set-based abandon (WHERE 即转移守卫)
UPDATE node_runs SET merge_state = 'abandoned'
WHERE task_id = :taskId
  AND merge_state IN ('isolating', 'pending-merge', 'conflict-human')
  AND (
    -- (a) 同代 top-level 前代行
    (node_id = :nodeId AND iteration = :iteration
       AND parent_node_run_id IS NULL AND id < :supersededByRunId)
    OR
    -- (b) 前代行的子行（fanout shard / aggregator / merge-resolve 子行随父废弃）
    parent_node_run_id IN (
      SELECT id FROM node_runs
      WHERE task_id = :taskId AND node_id = :nodeId AND iteration = :iteration
        AND parent_node_run_id IS NULL AND id < :supersededByRunId
    )
  )
```

(b) 支闭合了 wrapper 被重跑时旧 shard 子行的遗留：shard 的 `conflict-human` 会立刻 fail 整个
任务（scheduler.ts:4458-4463），resume 时旧 wrapper（failed）被回滚重 mint —— 若不废弃其子行，
入口的 `replayConflictHumanResolutions` 会先把旧 shard 的人工决议物化进 canon、随后新 wrapper
又整组重跑，双重应用（§7 场景 C）。子行的取代性由父行取代性直接蕴含，无需 per-shardKey 判定
（per-shardKey 的 pending-merge 僵尸不可达：shard merge-back 在 dispatchFanoutShard 内同步
await，同一次 runTask 里 replay 已在任何 mint 之前跑完，见 §12 D9）。

ULID 序即 freshness 权威（`isFresherNodeRun` = 纯 `candidate.id > incumbent.id`，
freshness.ts:156-162），`id < :supersededByRunId` 与 sanctioned picker 同构，不引入新口径。

## 4. mint 收口点（abandon 不变量的挂载）

mint 是所有取代路径的汇聚点（调研 §1/§6）：retryNode（task.ts:1985）、review supersede
（review.ts:2097）、scheduler stale-redispatch/revival（scheduler.ts:2259 等 13 处）、clarify
答后重跑（clarify.ts:166 / crossClarify.ts:202)……全部经由两个入口落行：

1. **`mintNodeRun`**（nodeRunMint.ts:186-190）——异步工厂。改为在**单个同步
   `db.transaction`** 内执行 `abandonSupersededMergeStates(tx, …) + tx.insert(nodeRuns)` 两步
   （bun:sqlite 同步事务；对外 async 签名不变、调用点零改动）。**abandon 与 insert 必须原子**：
   若先 insert 后独立 UPDATE，daemon 在两语句间崩溃会留下「新行已在 + 旧行仍 pending-merge」
   ——本 RFC 要修的 stale replay 以另一形态存活（Codex 设计门 P1-1）；单事务下崩溃要么两者都
   没发生（回到修复前语义、下次取代重来）、要么都已提交。
2. **`taskQuestionDispatch.ts:759`** 的同步 `tx.insert(nodeRuns)`（RFC-120 原子 claim+mint，
   带 `rfc098-allow-direct-node-run-insert` 豁免标记）——在**同一既有 tx** 内以相同参数调
   abandon，天然原子。

据此 `abandonSupersededMergeStates` 做成**同步**函数（drizzle bun-sqlite `.run()`），第一参数
接受 db 或 tx 客户端——同步形态才能进 bun:sqlite 同步事务回调（回调内不可 await）。

**时序正确性**（为什么 mint 时废弃能关住 replay 竞态）：所有「取代 → 踢起 runTask」路径中，
mint 都发生在 runTask 之前——

- retryNode：mint（task.ts:1985-1994）→ `void runTask(...)`（task.ts:2003），同一 HTTP 调用内串行；
- review decision：supersede + mint（review.ts:2085-2116）→ 经 resume 通道踢 runTask；
- resume（无 retry）：不 mint、不 abandon——crash 窗口的 freshest 行本就是合法 replay 对象；
- runScope 内的 mint（stale-redispatch 等）：发生在本次入口 replay **之后**，但此刻该行若是
  pending-merge 早已在入口被 replay 成 merged（不在 abandon from 集），mint 时的 abandon 对
  未来入口生效。唯一在 runScope 内仍可能命中 abandon 集的是 clarify 答后重跑对 done+isolating
  行（D19 跳过 merge-back 的行）的取代——abandon 纯列写入，**不删 iso worktree**，答后内联
  续跑对保留 iso 的复用不受影响（§12 D7）。

mintNodeRun 内新增一次 UPDATE 的成本：每 mint 一次 +1 条索引良好的单表 UPDATE（常态匹配 0 行），
mint 频率低（人工/调度动作级），可忽略。

## 5. 19 处写点迁移表（scheduler.ts）

| W# | 行号 | 函数 / 场景 | 事件 | extra | CAS 输处置 |
|---|---|---|---|---|---|
| W1 | 1639 | `persistIsoBase` 单仓 | `begin-isolation` | isoWorktreePath, isoBaseSnapshot, isoBaseSnapshotReposJson(=null) | 抛（不可达；到 runTask catch-all 失败任务，fail-loud） |
| W2 | 1652 | `persistIsoBase` 多仓 | `begin-isolation` | isoWorktreePath, isoBaseSnapshot(=null), isoBaseSnapshotReposJson | 同上 |
| W3 | 1668 | `persistIsoNodeTree` 单仓 | `mark-pending-merge` | isoNodeTree, isoNodeTreeReposJson(=null) | 抛 |
| W4 | 1674 | `persistIsoNodeTree` 多仓 | `mark-pending-merge` | isoNodeTree(=null), isoNodeTreeReposJson | 抛 |
| W5 | 1751 | `replayPendingMerges` 干净 | `mark-merged` (via:'replay') | — | 抛 |
| W6 | 1754 | `replayPendingMerges` 冲突 | `park-conflict-human` (via:'replay') | — | 抛 |
| W7 | 1805 | `replayConflictHumanResolutions` 已解 | `complete-human-resolution` | — | 抛 |
| W8 | 3009 | `runOneNode` merge-back 干净 | `mark-merged` (via:'live') | — | 抛 |
| W9 | 3016 | `runOneNode` 冲突泊人 | `park-conflict-human` (via:'live') | — | 抛 |
| W10 | 3038 | `runOneNode` merge-back 抛错（catch 内） | `mark-merge-failed` | — | **try** + log.warn（直抛会掩盖原始 merge 错误） |
| W11 | 4448 | `dispatchFanoutShard` 干净 | `mark-merged` (via:'live') | — | 抛 |
| W12 | 4456 | shard 冲突 | `park-conflict-human` (via:'live') | — | 抛 |
| W13 | 4469 | shard merge-back 抛错（catch 内） | `mark-merge-failed` | — | try + log |
| W14 | 4807 | `dispatchFanoutAggregator` 干净 | `mark-merged` (via:'live') | — | 抛 |
| W15 | 4813 | aggregator 冲突 | `park-conflict-human` (via:'live') | — | 抛 |
| W16 | 4826 | aggregator merge-back 抛错（catch 内） | `mark-merge-failed` | — | try + log |
| W17 | 5027 | `mergeBackWrapperIso` 冲突泊人 | `park-conflict-human` (via:'live') | — | 抛（旁邻 :5029 的 status `park-human` 保持独立两步，见 §12 D10） |
| W18 | 5033 | wrapper 干净 | `mark-merged` (via:'live') | — | 抛 |
| W19 | 5040 | wrapper merge-back 抛错（catch 内） | `mark-merge-failed` | — | try + log |

「抛」路径的安全性：runTask 有 catch-all（scheduler.ts:482-487，任何 scope 异常 → `failTask`
fail-loud，防 wedge running），一个潜在的非法转移/并发覆盖会把任务显式打 failed 而不是静默
脏写——这正是状态机要的失败模式（同 RFC-143 §6「抛错落 failed」先例）。

W1/W2 由 `persistIsoBase` 收口（其 5 个调用点不变）；W3/W4 由 `persistIsoNodeTree` 收口（4 个
调用点不变，其 `mergeState: string` 参数删除——所有调用点都传字面 `'pending-merge'`，参数是
假旋钮，收敛为事件内定值）。

## 6. 读点改造

| 读点 | 现状 | 改造 |
|---|---|---|
| settled 门 scheduler.ts:1355 | `(r.mergeState ?? null) === null \|\| r.mergeState === 'merged'` 内联 | `isMergeStateSettled(r.mergeState)`（shared 单源） |
| done 分支 scheduler.ts:1562-1565 | `=== 'conflict-human'` / `else if === 'merge-failed'` / else blocked | 穷举 `switch` over `MergeStateOrNull`：conflict-human→awaitingHuman、merge-failed→failed、**abandoned→blocked（并入既有 stale-done 桶，语义：被取代的 done 行不参与任何冒泡）**、null/isolating/pending-merge/merged→blocked（现状保持）+ `never` 守卫 |
| replay SQL :1704 / :1776 | `eq(mergeState, 'pending-merge'/'conflict-human')` 裸字面量 | 引 shared 常量（值不变）。**不加 status 过滤**（§12 D6：wrapper 崩溃窗口行可为 interrupted+pending-merge，status 集合不收敛；僵尸排除由 abandoned 单机制承担） |
| fanout undo :4174 | `status==='done' && mergeState==='merged'` | 不变（abandoned/merged 分界天然正确：undo 只找已落 canon 的前代） |

## 7. stale replay bug 链条（回归测试的锚）

- **场景 A（retryNode）**：done+pending-merge 行（崩溃窗口）→ 任务 interrupted → retryNode
  （routes/tasks.ts:537-544 → task.ts:1781）：旧行不动、mint 新行（:1985）、回滚 canonical 到
  pre_snapshot（:1909）、`void runTask`（:2003）→ 入口 replayPendingMerges（scheduler.ts:472）
  捞旧行 → 旧 delta 物化。**修后**：mint 时旧行→abandoned，replay 零命中。
- **场景 B（review supersede）**：review reject/iterate 把旧行 `canceled`（review.ts:2085-2096，
  errorMessage 记 supersede marker）但 merge_state 不动 → canceled+pending-merge → 决议后
  resume → 同 A。**修后**：review 的 mint（:2097-2116）触发 abandon。
- **场景 C（fanout shard conflict resume）**：shard conflict-human → 任务 fail（scheduler.ts:
  4458-4463）→ resume 回滚 failed wrapper 并重 mint → 入口 replayConflictHumanResolutions
  （:476）先把旧 shard 的人工决议物化、新 wrapper 又整组重跑 → 双重应用。**修后**：wrapper
  重 mint 的 abandon (b) 支废弃旧子行。
- 回归测试先写 A（红）——断言 retryNode 后 canonical 不含旧 delta 且旧行 `abandoned`；B/C 以
  A 的骨架派生（C 至少覆盖「旧 shard 子行被 (b) 支废弃」的 DB 面断言）。

## 8. migration 0076（存量僵尸清洗）

```sql
-- 0076_rfc144_abandon_superseded_merge_state.sql
UPDATE node_runs SET merge_state = 'abandoned'
WHERE merge_state IN ('isolating', 'pending-merge', 'conflict-human')
  AND (
    -- (a) 被取代的 top-level 行：存在同代 top-level 更大 ULID 兄弟
    (node_runs.parent_node_run_id IS NULL
     AND EXISTS (SELECT 1 FROM node_runs s
                 WHERE s.task_id = node_runs.task_id AND s.node_id = node_runs.node_id
                   AND s.iteration = node_runs.iteration AND s.parent_node_run_id IS NULL
                   AND s.id > node_runs.id))
    -- (b) 被取代父行的子行（shard / aggregator / merge-resolve 子行随父废弃）
    OR node_runs.parent_node_run_id IN (
        SELECT r.id FROM node_runs r
        WHERE EXISTS (SELECT 1 FROM node_runs s
                      WHERE s.task_id = r.task_id AND s.node_id = r.node_id
                        AND s.iteration = r.iteration AND s.parent_node_run_id IS NULL
                        AND s.id > r.id))
  );
```

- 单语句，无需 `--> statement-breakpoint`；journal 75→76，`upgrade-rolling.test.ts`
  「HEAD journal has 75 entries」锁同步 bump（标题+断言+注释）。
- 语义：与 §3.2 运行时 abandon 完全同构（top-level 非 freshest + 其子行闭包）。合法崩溃窗口行
  （该节点 freshest、无更新兄弟）不匹配 (a)/(b) 任一支——不受影响。
- **(a) 支必须带 `parent_node_run_id IS NULL` 谓词**（Codex 设计门 P1-2）：否则子行会经 (a) 支
  的「存在更新 top-level 兄弟」误判——子行的取代性只能由父行取代闭包（(b) 支）表达，(a) 支只
  裁决 top-level 行。实现时用测试锁死三类行的判定：freshest 崩溃窗口行不动（含「wrapper 未被
  取代、其子行不动」）、被取代 top-level 行清洗、被取代父行的子行清洗。

## 9. 守卫与源码锁（第 3/4 层）

1. **新守卫测试** `packages/backend/tests/rfc144-merge-state-blind-write-inventory.test.ts`，
   机制照抄 s14（剥注释 → `.update(nodeRuns)` 匹配 → 括号配平截 `.set(...)` 实参 → 检
   `/\bmergeState\s*:/`）：
   - allowlist 精确计数：`{ 'services/lifecycle.ts': 2 }`（transitionMergeState 的 CAS 写 +
     abandonSupersededMergeStates 的集合写）；allowlist 外任何 `mergeState:` 写 → 红，报错文案
     指路 transitionMergeState；
   - 反空洞断言：allowlist 计数必须被真实占用（=2，防扫描器失效空绿）；
   - 豁免标记断言：两处写上方 5 行内必须有 `rfc144-allow-direct-merge-state-write`；
   - `taskQuestionDispatch.ts` 的同步 abandon（若内联 SQL 而非 helper）同标记、同 allowlist 登记。
   - **insert 面**：附一条源码锁——`buildMintNodeRunValues`（nodeRunMint.ts）不得出现
     `mergeState`（mint 恒生 NULL 是状态机的入口不变量）。
2. **schema 注释矫正**（db/schema.ts:770-773）：值域改为 7 值 + NULL 全列，注明
   「唯一合法写者 services/lifecycle.ts（RFC-144）；abandoned ⇔ 被取代」。
3. **命名收敛**：`mergeBackWrapperIso` 返回联合的 `{kind:'awaiting_human'}`
   （scheduler.ts:5002-5006）改名 `{kind:'conflict-human'}`，与 node 路径联合
   （scheduler.ts:3005-3006 已用 `conflict-human`）及列值统一；消费点（:3545/:5276 只匹配
   `merge-failed`，wrapper 调用处的 kind 分支）同步改。纯内部改名、单文件、零行为。

## 10. 失败模式

| 模式 | 处置 |
|---|---|
| 非法转移（逻辑 bug 暴露） | `IllegalMergeStateTransition` → ConflictError → runTask catch-all → 任务 fail-loud（现状是静默乱写；fail-loud 是改进目标本身） |
| CAS 输（并发覆盖被拦截） | 单任务单 scheduler 所有权（task CAS pending→running）下常态不可达；发生即说明出现了第二写者——主路径抛（暴露），catch 内错误路径 try+log（不掩盖原始错误） |
| abandon 与 live merge-back 竞速 | abandon 只在 mint 链上发生；mint 与该节点自身的 merge-back 在同一 scheduler 串行域内，不同节点的 merge-back 不触碰彼此行。集合式 abandon 的 WHERE from-集保证已 merged/failed 的行不可能被误废弃 |
| mint 与 abandon 之间崩溃 | 结构上不可达：两步在单个同步 `db.transaction` 内提交（§4，Codex 设计门 P1-1）——崩溃后要么新行与废弃都未发生（回到取代前语义），要么都已生效 |
| replay 撞 abandoned | 不可能命中（replay WHERE 按值捞，abandoned 不在捞取值内）——这正是修复本体 |
| migration 误清洗合法行 | EXISTS 谓词要求「存在更新兄弟」，freshest 崩溃窗口行天然不匹配；migration 测试三类行全锁 |
| abandon 误删 iso | 结构上不可能：abandon 是纯 UPDATE merge_state，不调 `discardNodeIso`（D19 kept-iso 依赖此约定，测试断言 abandon 后 iso 目录仍在） |

## 11. 与现有模块的耦合点

- **freshness.ts**：不新增依赖；abandon 判定与 `isFresherNodeRun` 同构（纯 ULID 序），若未来
  freshness 口径变化，abandon 的 `id <` 谓词需同步（在 freshness.ts:156 旁加交叉注释）。
- **dispatchFrontier.ts**：确认不读 merge_state（调研核实，审计报告此处有误），不动。
- **gc.ts**：只读 `tasks.status`（gc.ts:146），abandoned 无需 GC 变更；abandoned 行的 iso
  容器随任务终态由既有 `runIsoWorktreeGc` 回收（不做 eager 回收，见 §12 D8）。
- **orphans.ts / markWrapperTerminal / cancelTask**：全部不动（不挂 abandon——它们不产生取代行；
  遗留 isolating 是「最终代如实状态」，见 §1.1 不变量）。
- **RFC-130 测试群**（rfc130-node-isolation / crash-replay / merge-resolve / merge-agent-scheduler /
  merge-agent / shard-rerun-undo / wrapper-private-canonical / iso-gc / iso-worktree-primitives /
  internal-git-identity + scheduler.test.ts:672）：golden 回归网，全程必须绿。

## 12. 决策记录

- **D1 abandoned 第 7 值**（用户 2026-07-07 拍板，弃 freshness-过滤最小修与零行为变更两案）：
  被取代行显式打 abandoned；不变量 abandoned ⇔ 被取代。
- **D2 无 DB CHECK / 无 zod**：与 status 列同范式，应用层守卫；滚动升级零约束风险。
- **D3 状态机落 shared/lifecycle.ts**：三套状态机同源同形态；merge_state 常量不进
  schemas/task.ts（非 wire 格式）。
- **D4 live/replay 同边**：`via` payload 只进日志，不拆事件（转移图保持最小）。
- **D5 merge-failed 保持终态 sink 且不入 abandon from 集**：它已冒泡任务 failed、不是 replay
  值；重试走新行。原地重试合并是独立产品问题。
- **D6 弃 replay status 过滤**（设计过程反转）：wrapper 行在 pending-merge 时刻 status 仍
  `running`，崩溃后被孤儿收割成 `interrupted`——合法 replay 候选的 status 集不收敛
  （done/interrupted/awaiting_human 混杂），加过滤会漏合法行。僵尸排除由 abandoned 单机制承担，
  一个机制一个真相。
- **D7 abandon 纯列写入、不删 iso**：clarify D19 的 done+isolating 行被答后重跑取代时，保留的
  iso worktree 仍被新会话复用；eager 回收交给既有任务终态 GC。
- **D8 abandon = supersede-only**：行自身失败/耗尽（wrapper exhausted、agent failed、orphan
  interrupted 且再无后代）遗留的 isolating 不打 abandoned——那是最终代的如实历史，非僵尸、
  无 replay 面。挂钩所有终态路径（markWrapperTerminal / orphans / cancel）会重新散射写点，
  与收口目标背道而驰。
- **D9 shard 子行不做 per-shardKey abandon**：per-shardKey 的 pending-merge 僵尸不可达
  （shard merge-back 同步 await + 入口 replay 先于一切 mint）；子行取代性由父行取代闭包（(b) 支）
  表达。
- **D10 W17 的 merge_state 与 status `park-human` 保持两步独立写**：两个正交状态机各自 CAS，
  不合并成跨机原子事务——与 status 机现状（W17 旁 :5029）一致；崩溃窗口（merge_state 写成、
  park-human 未写）由既有 frontier done 分支兜底（done+conflict-human → awaitingHuman 桶）。
- **D11 `persistIsoNodeTree` 的 mergeState 参数删除**：4 调用点全传 `'pending-merge'` 字面量，
  假旋钮（flag-audit 判据 (a)），事件化后由 `mark-pending-merge` 内定。
- **D12 mint 与 abandon 单事务原子**（Codex 设计门 P1-1 产物）：`mintNodeRun` 内部改为同步
  `db.transaction` 包 abandon+insert 两步；`abandonSupersededMergeStates` 做成同步函数
  （接受 db 或 tx）以进入 bun:sqlite 同步事务回调。分两条独立语句会在语句间崩溃时留下
  「新行在 + 旧行仍可重放」——被修的 bug 换形态存活。
- **D13 同行复用的 resume 路径入表**（Codex 实现门 P2 产物）：仓内存在两类**同行多代**复用——
  ①fanout shard/aggregator 的 interrupted 子行被 reset 成 pending 原地重跑
  （`fanout-shard-resume`/`fanout-aggregator-resume`，setNodeRunStatus allowTerminal），此时行
  可能带着上一代的 `isolating`；②wrapper 行经 `findResumableWrapperRun` 同行复活续跑，若崩溃
  发生在 `mergeBackWrapperIso` 内部，入口 replay 已把它推成 `merged`（或 cancel-while-parked
  留下 `conflict-human`）。严格单 from 的机器会把这两类合法恢复打成
  `IllegalMergeStateTransition`。修法（建模而非绕过）：`begin-isolation` 增自环
  `isolating→isolating`（重盖新 iso 基列）；新增事件 `reenter-isolation`：
  `{merged, conflict-human} → isolating`（单点挂 `createOrRebuildWrapperIso`）；**merged 移出
  TERMINAL_MERGE_STATES**（它是「代终点」非「行终点」，出边唯一 = reenter-isolation；abandon
  from 集仍不含 merged——fanout undo 依赖 merged 历史、且 merged 行永不为僵尸）。
  **D13 第二半（PR-3 复核 P2）——merged 再入必须换新 iso 基**：merged 意味着上一代 delta 已在
  canonical，若沿用旧 `isoBaseSnapshot` rebuild，wrapper 结尾三路合并（base=旧基、ours=含旧代
  delta 的 canon、theirs=新代树）会把 canon 里的旧代文件当 `ours` 新增——新一代删除的内容复活。
  故 merged 再入：弃旧 iso（tolerant）→ 强制 create 路径从当前 canonical 重快照 →
  `persistIsoBase` 经 begin-isolation 自环重盖基列。`conflict-human` 再入保持 rebuild 旧基
  ——其 delta 从未进 canon（D27），旧基仍是正确合并基。行为测试：merged 再入后新 iso 内可见
  canon 现态文件 + 基列重盖；conflict-human 再入基列不动。
  **D13 第三半（PR-4 复核 P2）——git wrapper 的 progress baseline 同随新代重捕**：
  `runGitWrapperNode` 在调 `createOrRebuildWrapperIso` 之前就从 `wrapperProgressJson` 读
  baseline/preDirty；merged 再入换了新 wrapper-canonical 后，沿用旧代 baseline 会让结尾
  `gitChangedFiles(新 canon, 旧基线)` 把旧代已合并文件再次报进本代 `git_diff`。修法：
  `freshGeneration = existing.mergeState === 'merged'` 时跳过持久化 progress、在新
  wrapper-canonical 上按 fresh-mint 语义重捕 baseline+preDirty 并覆写 progress（后续同代
  resume 读到新基线）。S-4「resume 绝不重捕」规则仅限同代复活（旧 iso 及内部写入还在）——
  conflict-human/中途复活不受影响。e2e 锁：merged 再入代 inner 零写入 → `git_diff` 不含
  旧代文件（修复前红：gen1.txt 泄漏）。
  **D13 第四半（PR-5 复核 2 P2）——崩溃耐久 + 输出 upsert**：①reenter 的 CAS **原子清空**
  base 三列 + `wrapperProgressJson`（extra 白名单加一列）——崩溃于再入窗口只会留下
  「isolating + 基列空」的行，freshGeneration 检测加第二支
  `isolating ∧ isoBaseSnapshot/ReposJson 双空`（真·同代行必有 persistIsoBase 先盖的基列；
  passthrough 行 merge_state NULL 不命中），旧基线在任何崩溃序列下都不可能复漏；弃旧 iso
  移到 reenter **之前**（崩在其间只是重复 tolerant discard）。②wrapper 输出（loop 出口
  bindings / fanout 空捷径 / aggregator 出口 / `__done__` / git_diff 共 5 写点）从裸 insert
  收敛为 `upsertWrapperOutput`（onConflictDoUpdate on (node_run_id, port_name)）——真实崩溃
  现场旧代输出行已落库（输出先写、merge-back 后崩），再入代重写撞主键；e2e fixture 补预置
  旧 git_diff 行 + 断言内容被本代覆写为空。
  **D13 第五半（PR-6 复核 2 P2，终局）**：①顺序回正——reenter CAS（夺权）**先于**任何销毁性
  清理：并发复活者在 CAS 处输掉并抛出、绝无机会删掉赢家的新 iso；弃旧 iso 改为 create 路径上
  的**无列值容忍清理**（discardNodeIso 只需派生路径+refs，snapshot 值不参与删除——
  rebuildIsoHandle 空 map 即可），复活行到达 create 时统一预清理，任何崩溃残留目录都不再让
  `git worktree add` wedge 任务。②基线建立**恒为代起点语义**：progress 持久化严格先于
  runScope，且唯一置 NULL 的写者是 reenter CAS——「progress **SQL NULL** ⟺ 本代零内部工作」：
  此态捕 preDirty（loop 内嵌 git wrapper 的入场脏集必须被减掉，否则漏进 git_diff）并立即持久化
  （同代 resume 耐久）。**第六轮勘误**：「非 NULL 但解析失败」是代中损坏、内部产物可能已在
  worktree——此态若捕 preDirty 会把真实变更 hash 相等地**吞掉**（欠报断下游 fanout），保留
  RFC-144 前的空 pre-set 兜底（多报不吞、不覆写 progress）。两态由 SQL-NULL 判别子分流。
  崩溃矩阵测试：「reenter 清列后崩溃 + 旧目录残留」→ 容忍清理 + 重建不 wedge；源码顺序锁：
  CAS 先于 discard。

## 13. 测试策略（test-with-every-change 清单）

**shared（packages/shared/tests/rfc144-merge-state-transition-table.test.ts）**
1. LEGAL 网格穷举：7 事件合法 (from, to) 全绿（照 lifecycle-transition-table.test.ts:21 形态）；
2. 终态 × 全事件笛卡尔积全抛 `IllegalMergeStateTransition`（merged/merge-failed/abandoned）；
3. 非终态非法格全抛（含 NULL 上除 begin-isolation 外全拒）；
4. `allowedFromForMergeEvent` 与 `nextMergeState` property 自洽（照 rfc108 形态）；
5. `TERMINAL_MERGE_STATES` / `SETTLED_MERGE_STATES` / 谓词 ground-truth 断言。

**backend CAS（packages/backend/tests/rfc144-merge-state-cas.test.ts）**
6. happy path 各事件 + extra 白名单落库（E1/E2 iso 列与 mergeState 同条 UPDATE 原子）；
7. CAS 竞态：`dbWithCompetingWriter` Proxy（照 rfc097-task-status-cas.test.ts:84）在 SELECT 与
   UPDATE 间插竞争写者 → `ConcurrentMergeStateTransition`；**NULL-from 格单独覆盖**（isNull 谓词）；
8. try 变体 boolean 语义（Conflict/NotFound → false，其余重抛）；
9. `abandonSupersededMergeStates`：废弃 (a) 支 / (b) 支 / 幂等（二次调用 0 行）/ merged 行不可
   误废弃 / `id <` 边界（新行自身不废弃）/ **(a) 支不误伤「父行未被取代」的子行**（P1-2 对应格）
   / **mint 事务原子性**（tx 内注入故障 → abandon 与 insert 全回滚，P1-1 对应格）。

**行为回归（backend）**
10. **stale replay 场景 A 先红后绿**（rfc144-stale-replay-regression.test.ts，文件头注明锁
    §7 场景与本 RFC）：retryNode 后旧 pending-merge 行 abandoned、canonical 无旧 delta、
    replayPendingMerges 零命中；
11. 场景 B（review supersede → abandoned）；场景 C 至少 DB 面（旧 wrapper 子行被 (b) 支废弃）；
12. **merge-failed 行为补齐**（RFC-130 缺口）：merge-back 抛错 → 行 merge-failed → frontier
    failed 桶 → 任务 failed；
13. deriveFrontier abandoned 分桶：done+abandoned 的 stale 行落 blocked、不进 awaitingHuman/failed；
14. clarify D19 交互：done+isolating 行被答后重跑取代 → abandoned 且 iso 目录仍存在。

**migration**
15. 0076 三类行判定（freshest 崩溃窗口不动 / 被取代 top-level 清洗 / 被取代父行子行清洗）；
16. upgrade-rolling journal 75→76 bump。

**守卫**
17. §9 的 blind-write inventory（allowlist 精确计数 + 反空洞 + 豁免标记 + mint 无 mergeState 源码锁）。

**golden**
18. rfc130-* 全套 + scheduler.test.ts 既有 iso 用例保持全绿（不改断言——分桶与 replay 值语义未变）。
