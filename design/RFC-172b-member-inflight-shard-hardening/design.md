# RFC-172b 技术设计 — run-resolution 家族 shard 化

## 1. 根因（带源码坐标）

### 1.1 `resolveHandlerRun` 完全 shard 盲

`packages/shared/src/task-questions.ts:254`：

```
const sameNode = input.runs.filter(
  (r) => r.nodeId === input.effectiveTargetNodeId &&
         r.iteration === input.iteration &&
         r.loopIter === input.loopIter,          // ← 无 shard_key 过滤
)
// upperBound / lineage 都在 sameNode 上按 ULID id 序取窗口
const freshest = lineage.reduce((a, b) => (b.id > a.id ? b : a))
```

`sameNode` 把 `__wg_member__` 上**所有** shard 的 run 混在一起。member A 的 anchor（trigger=A 的续跑）解析时，一个 id 更大的 sibling done run（shard B）会成为 `freshest` → `hr.status==='done'` → 判「已消费」。`task-questions.ts` 全文零 shard 引用。

### 1.2 三个调用方（全部继承 shard 盲）

| 调用方                                     | 文件:行                     | 作用                                       |
| ------------------------------------------ | --------------------------- | ------------------------------------------ |
| `isDispatchedEntryConsumed`（anchor 分支） | `clarifyRerunLedger.ts:137` | in-flight 分发门 + mint 守卫的「消费」判据 |
| `resolveDispatchedEntryHandler`            | `taskQuestions.ts:236`      | 渲染：已下发条目的 handler run 状态        |
| `partitionUndispatchedParkTargets`         | `taskQuestions.ts:572`      | park 分区：哪些 target 还欠 run            |

### 1.3 同族守卫 `hasOpenDispatchedEntryOnHome`（self-rollback 门）也 shard 盲

`clarifyRerunLedger.ts:194`：`onHome = dispatchedEntries.filter(e => (e.override ?? e.default) === homeNodeId)` **node 键**，再 `isDispatchedEntryConsumed(e, ..., 'in-flight', mintCause)` **不传 shardKey**。被 `clarifyAutoDispatch.ts:137` 的 `selfHomeHasOpenLedger`（self-rollback preflight，:534 原子门）复用 → **member B 的 open ledger（shard B）会挡住 member A 的 self 回滚 + 重分发**（node-wide）。这才是 S4 的真守卫（见 §2.5）。

### 1.4 `isTargetNodeConsumed` 已 shard 安全（Codex 设计门澄清，非本 RFC 范围）

`isTargetNodeConsumed`（`clarifyRerunLedger.ts:249`）本身按 node 键、无 shard 过滤，但它**唯一的生产调用方** `clarifyQueue.ts:157` 传入的 `sameNode` 已在 SQL 层按 shard 过滤（R2-T3，`clarifyQueue.ts:146-147`：`shardKey===null ? isNull(nodeRuns.shardKey) : eq(nodeRuns.shardKey, shardKey)`）。sibling shard 的 run **到不了**该判据 → 老化路径 R2-T3 已闭合，**本 RFC 不碰 `isTargetNodeConsumed`**（碰它只扩核心 API + 回归面、零收益）。

### 1.5 分发门如何最终落到 shard 盲判据

`findOpenDispatchTarget`（`taskQuestionDispatch.ts:939`）→ 对每个在飞条目调 `isDispatchedEntryConsumed(e, ..., 'in-flight', mintCause)` → 其 anchor 分支（trigger 非 null）→ `resolveHandlerRun`（shard 盲）。所以「门按 target 单键」只是表象，真正的 shard 盲在 `resolveHandlerRun`。

`isDispatchedEntryConsumed` 的 **trigger-null 分支**（run-obligation 扫描）RFC-172 S1 已加了可选 `shardKey`（`clarifyRerunLedger.ts`，`r.shardKey === shardKey`）；但 **anchor 分支**（trigger 非 null，走 `resolveHandlerRun`）没有 shard 概念——这是缺口。

## 2. 设计：shardKey 贯穿家族（可选参数，golden-lock）

### 2.1 `resolveHandlerRun` 加可选 `shardKey`

```
export interface ResolveHandlerInput {
  effectiveTargetNodeId: string | null
  iteration: number
  loopIter: number
  triggerRunId: string | null
  runs: RunLineageView[]
  shardKey?: string | null   // ← 新增：undefined = shard 盲（golden-lock）
}
```

在 `sameNode` 过滤追加一条（**内存比较，无 SQL `eq(col,null)` 坑**，与 S1 同款）：

```
r.nodeId === input.effectiveTargetNodeId &&
r.iteration === input.iteration &&
r.loopIter === input.loopIter &&
(input.shardKey === undefined || r.shardKey === input.shardKey)   // ← 新增
```

`undefined` → 条件恒真 → `sameNode` 与今日逐字节一致（golden-lock）。传值时 lineage 窗口只含本 shard 的 run，sibling 不再掩盖/干扰。

> `RunLineageView` 需带 `shardKey`（若尚无）。检查 `toLineageViews`（clarifyRerunLedger）/ 各 lineageViews 构造点，把 `node_runs.shard_key` 映射进去；`shardKey` 在 view 上恒可得（node_runs 列）。

### 2.2 `isTargetNodeConsumed`：不改（§1.4 — 已由 R2-T3 SQL 过滤闭合）

### 2.3 `isDispatchedEntryConsumed` anchor 分支透传

anchor 分支调 `resolveHandlerRun({..., shardKey})`，把已有的 `shardKey` 参数（S1 加的）透传下去（当前只用在 trigger-null 分支）。

### 2.4 分发门传 shardKey

`findOpenDispatchTarget` 对每个在飞条目 `e`，解析 `e` 自己的 shard（`resolveEntryShardKeys` 或其 lineage run 的 shard_key），把它作为 shardKey 传给 `isDispatchedEntryConsumed`。**并且**引入「本批 mint 的 (target, shard) 集」跳过异 shard 在飞条目（member A shard-A 不挡 shard-B 批）：

- 异步预检 `assertNoInFlightDispatch`（`taskQuestionDispatch.ts:990`）：`resolveEntryShardKeys` 解析在飞条目 shard。
- **in-tx recheck**（`taskQuestionDispatch.ts:774`，同步 CAS）：需要**同步** shard 解析——写一个 `resolveEntryShardKeysSync(tx, entries)`（`.all()` 版），或把预解析的 shard map 传入并在 tx 内对新出现条目补解析。entry 的 shard 由其 clarify 轮 `asking_shard_key` 决定、**不可变**，只有 tx 与预检间新出现的条目需现解析。

`entryShardById`（现于 `taskQuestionDispatch.ts:626`）需**前移**到门（617）之前，以便构建「本批 (target,shard) 集」。前移是纯读、无序依赖、安全。S2a 的 source-lock（`toContain`）位置无关，保持不变。

### 2.5 S4 — self 回滚 open-ledger 门 shardKey 透传（Codex 设计门修正）

**真守卫是 `hasOpenDispatchedEntryOnHome`**（`clarifyRerunLedger.ts:194`），经 `selfHomeHasOpenLedger`（`clarifyAutoDispatch.ts:137`，self-rollback preflight 原子门 :534）。它 node 键 `onHome` + 对每条调 `isDispatchedEntryConsumed(e, ..., 'in-flight', mintCause)` **不传 shardKey** → member B 的 open ledger（shard B）会挡 member A 的 self 回滚 + 重分发。

改法：`hasOpenDispatchedEntryOnHome` 加可选 `shardKey`，`onHome` 追加 `shardOf(e) === shardKey`（+ 透传给 `isDispatchedEntryConsumed`）；`selfHomeHasOpenLedger` 传本 `selfRun` 的 `shard_key`（member=assignment id、leader/普通=null→undefined golden-lock）。`selfRun` 的 shard 从 `node_runs.shard_key` 直取。

> 更正：初稿把 S4 指向 `pickFreshestRun(scoped)`（self 回滚选 freshest run）——那条**已按 shard 过滤**、不是 blocker。真正 node-wide 挡 sibling 的是 `hasOpenDispatchedEntryOnHome`。故 S4 不动 `pickFreshestRun`、也不动 `scheduler-audit-s13` G7 锁。

## 3. 决策：宽（推荐）vs 窄

- **窄**：只 shard 化 `findOpenDispatchTarget` 的门逻辑（不碰 `resolveHandlerRun`）。**否决**——门的消费判据本身走 `resolveHandlerRun`，不碰它则门无法真正 shard 感知；且老化/渲染仍 shard 盲 → 读侧不一致（门放行了，老化却把 sibling 的产出当本 shard 的老化）。
- **宽（推荐）**：shard 化 `resolveHandlerRun` + `hasOpenDispatchedEntryOnHome` 家族 + 全调用方。一次可选参数，golden-lock 由 `undefined` 保。读侧一致。

## 4. 失败模式

| 场景                                                          | 期望                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| member A 在飞（shard A），dispatch member B（shard B）        | B 不被挡，铸 shard-B 续跑                                     |
| member A 在飞（shard A），dispatch member A 第二条（shard A） | 仍被串行挡（`task-question-node-dispatch-in-flight`），不双铸 |
| member B queued 条目 run-obligation 扫描                      | 只数 shard-B run，A 的在飞 run 不算 B 的义务                  |
| member A 老化（sinceRunId=A 续跑），sibling B done            | A 未产出前不老化（B 的 done 不老化 A 的答案）                 |
| in-tx recheck 与预检间新出现 sibling 在飞                     | tx 内 sync shard 解析，异 shard 不误挡                        |
| 普通节点 / leader / dynamic 全部路径                          | `shardKey===undefined`，逐字节等价今日（golden-lock）         |

## 5. 测试策略（design §测试策略，PR 必跑绿）

**纯函数预言（首选可断言面）**：

- `resolveHandlerRun`：同 (node,iter) 混两 shard run，`shardKey='A'` 只解析 A 的 lineage（sibling B 的 done 不成为 freshest）；`undefined` 复现今日（含 sibling 掩盖）= golden-lock。
- `isDispatchedEntryConsumed` anchor 分支：传 shardKey 后 sibling 在飞不判「消费」。
- `hasOpenDispatchedEntryOnHome`（S4）：`shardKey='A'` 时 member B（shard B）的 open ledger 不算 A 的 open ledger；`undefined` 复现今日 node-wide。

**集成（dispatchTaskQuestions 级）**：

- member A 在飞 + member B 分发 → B 铸 shard-B 续跑（**红→绿**：当前因 sibling 掩盖行为不确定，shard 化后确定性放行 B）。
- member A 在飞 + member A 第二条 → 仍 `task-question-node-dispatch-in-flight`（串行保留）。
- in-tx recheck 并发路径（sync shard 解析）。

**golden-lock 回归**：`rfc128-p5-bc` / `rfc131` / `rfc132` / `rfc133` / `rfc164` / `cross-clarify-*` / `clarify-auto-dispatch-*`（S4 门）全绿。

**源码锁**：`resolveHandlerRun` 的 `shardKey === undefined || r.shardKey` 追加行；`hasOpenDispatchedEntryOnHome` 的 `onHome` shard 追加；分发门 (target,shard) 跳过逻辑。

## 6. 风险

- `resolveHandlerRun` / `hasOpenDispatchedEntryOnHome` 是**读侧核心**，被渲染/消费/门/self-rollback 多处复用——改错会波及既有 golden-lock。缓解：可选参数 + `undefined` 默认 = 所有现有调用方零行为变化；逐调用方审计传 `undefined` vs 传 shard。
- in-tx sync shard 解析是新代码面（TOCTOU 边界）——须与异步预检判据完全一致（同一 `resolveEntryShardKeys` 语义的 sync 镜像），加 in-tx 并发测试锁。
- `RunLineageView` 加 `shardKey` 字段需审计所有构造点（漏一处则该路径 shard 恒 undefined/null → 静默 shard 盲）。
