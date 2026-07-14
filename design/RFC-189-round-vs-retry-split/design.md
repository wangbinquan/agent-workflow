# RFC-189 · 技术设计

> **实施勘误（2026-07-15，以此节为准）**：
> 1. **fc 免疫**——fc 的 initial burst / 并发 message turn 在同一 tick 内并发
>    mint，「mint 时打序数」必然产生重复序数（max 口径会漏计）。fc 的轮预算
>    本质是「行计数」而非序数（每 run 消耗一行预算），保持计数制不变；
>    `wg_round` 仅 lw 行打戳，fc 行恒 NULL。原稿 §2 的 fc 回填分支删除。
> 2. **countRoundsUsed(lw) = 混合口径**——`max(wg_round | 非 canceled)` +
>    「NULL 戳 qualifying 行数」尾巴：引擎外 mint 的行（clarify-answer 续跑、
>    崩溃残留）在 mint→领养打戳之间无戳，每行恰是一个已启动的轮（与旧行计数
>    逐值相等）；领养时 `stampWgRound` 就地补戳（`WHERE wg_round IS NULL`
>    幂等）。原稿 §4 的「max ?? 0 + canceled 边角」并入此口径。
> 3. **前端 displayRetryForRun 保留**——回填的旧行 wg_round 非空但 retryIndex
>    仍是旧混合值，两个时代在行上不可分辨；谱系推导与 retryIndex 无关、对新旧
>    语义皆正确，保留为重试口径。wg_round 的前端价值是**轮标签**（抽屉新增
>    `statWgRound` 展示），非替换重试推导。原稿 §4「displayRetryForRun 退役」
>    撤回。
> 4. 回填窗口冻结的是 0095 时点的旧派生口径；lw member assignment 行以
>    `workgroup_assignments.round` 权威覆盖（msg 行保留窗口号）。

## 1. 方案选型：新列 `wg_round`，而非复用 `iteration`

两个候选：

- **(a) 新 nullable 列 `wg_round`**（选定）：仅工作组 host run 打戳；工作流
  行恒 NULL。
- (b) 复用 `iteration`（工作组恒 0，看似空闲）。

否决 (b) 的理由：`iteration` 深度参与共享机制——freshness/lineage 比较、
`priorDoneGenerationsForRun` 的 (nodeId, iteration, shardKey) 键（clarify
代际）、loop wrapper 计数、`abandonSupersededMergeStates` 的分片键。把
「轮」塞进去等于把本 RFC 要消除的「语义重载」原样搬家到另一列，且 clarify
代际会立刻被轮数污染（host clarify 的 iterationIndex 语义 RFC-172 刚修过）。
一列一义原则下，独立列是正解（宁多一列，不再重载）。

## 2. 数据与迁移

- migration NNNN（实现时取号）：
  `ALTER TABLE node_runs ADD COLUMN wg_round INTEGER;`
  `--> statement-breakpoint`（多语句备忘）
  backfill UPDATE：对 `workgroup_id IS NOT NULL` 任务的 host 行，按
  **今日派生口径**回填——同任务内按 id 升序扫描：
  - lw：`__wg_leader__` 行，`status≠canceled ∧ rerunCause∉{wg-gate,
    wg-protocol-retry}` 时轮号+1 并打戳；`wg-protocol-retry` 行继承当前轮号；
    `wg-gate` 行打当前轮号（不推进）。
  - fc：`__wg_member__` 行同法。
  - `__wg_clarify__` 行不打戳（NULL——它不是轮）。
  backfill 用 SQL 难表达扫描语义 ⇒ 走 **代码 backfill**（daemon 启动一次性
  迁移器 or migration 内 CTE）——设计门重点审此处：优先 CTE
  （window function `SUM(...) OVER (PARTITION BY task_id, node_id ORDER BY id)`
  可表达「非重试行累计数」），CTE 不可行再退回启动迁移器。
- `upgrade-rolling.test.ts` journal 计数锁 +1（备忘：单点 bump）。

## 3. 写路径（workgroupRunner）

三处 mint 统一为：

```ts
const round = currentRound(state) + 1        // 派单/领导轮：新轮
// 或 assignment.round（成员轮继承派单时的轮号——现状语义）
mintNodeRun(db, {
  ...,
  retryIndex: attempt,                       // G2：纯 attempt 序号
  overrides: { wgRound: round, ... },
})
```

- leader 轮：`wg_round = countRoundsUsed(state) + 1`（wrap-up 轮同样 +1——
  RFC-187 §3-7 的「counted grace」语义不变）。
- assignment/message 轮：`wg_round = assignment.round / currentRound(state)`
  （fc 模式下成员轮即轮，`+1`；沿用今日 `countRoundsUsed` 的 lw/fc 分叉）。
- 协议重试（attempt>0）：**同一 wg_round**、retry_index=attempt——
  `wg-protocol-retry` cause 保留（RFC-183 分类器/rfc098 gates 不动），但
  `countRoundsUsed` 不再依赖它。

## 4. 读路径

- `countRoundsUsed(state)`：`max(wg_round of hostRuns) ?? 0`——排除法退役。
  （轮号是 mint 时的事实，canceled 行也带号：max 语义下 canceled 不虚增轮，
  因为它的号 = 它启动时的轮，同轮必有非 canceled 的兄弟或它本身就是该轮。）
  设计门需对抗一个边角：**首轮 leader 被 cancel 后 resume**——今日派生口径
  canceled 不计数 → 重新数到 0 → leader 重驱为第 1 轮；max 口径下 canceled
  行携 wg_round=1 → resume 后直接从 2 起。两口径此处不同——采用
  `max(wg_round WHERE status≠canceled) ?? 0` 对齐今日行为（canceled 仍带号
  供显示，但不推进账本）。
- 前端：`runHistory`/抽屉的轮标签读 `wg_round`；「重试#M」读 retry_index
  （仅 >0 时显示）。`displayRetryForRun` 与其测试删除（或若工作流侧仍在用，
  收窄为 workflow-only 并改名，grep 定夺）。
- wire：`NodeRun` shared schema + 后端投影 + ws 帧加可选 `wgRound`。

## 5. 失败模式

- backfill 与今日派生口径不一致 ⇒ 轮数账本漂移（maxRounds 提前/滞后触发）。
  缓解：backfill 单测用「同一批合成行，老口径 countRoundsUsed vs 新列 max」
  互为 oracle 断言相等（含 gate/protocol-retry/canceled/clarify 混排）。
- 旧行 wg_round NULL（backfill 漏网/极老任务）：读路径 `max` 天然忽略 NULL；
  但「NULL 且非 canceled 的 host 行」说明 backfill 缺口 ⇒ 迁移测试锁全量
  非 NULL。
- 并发 mint 竞态：单驱动实例（runTask CAS）+ 轮号取自 turn 起点快照，与
  今日 retryIndex 计算的快照语义相同，不引入新竞态面。

## 6. 与在途工作的耦合

- **RFC-187 T4（已落）**：cause 枚举与 gates 不动；本 RFC 只让计数不再依赖
  该 cause。T4 的测试（rfc187-rounds-accounting）按 AC-4 改写断言口径。
- **RFC-188**：正交（mint 语义在站点层）。
- 并发 session 的 PR-3 余项若触 workgroupRunner mint 点，实现窗口错开
  （plan §依赖）。

## 7. 测试策略

1. migration：journal 计数 +1；backfill 互 oracle golden（§5）；
   多任务混排（lw+fc+dw、含 canceled/gate/protocol-retry/clarify 行）。
2. mint 单测：leader 三次协议滑 → 四行同 wg_round、retry_index 0..3。
3. `countRoundsUsed` 表测：新旧口径等值断言（拿既有 rfc187-rounds-accounting
   的场景直接换 oracle）。
4. 前端：`d1248df4` 两场景回归（第二轮不标重试、并行实例不互标）；
   轮标签/重试徽标渲染断言。
5. e2e：rfc187 maxrounds-wrapup 在新口径下不回归（wrap-up 轮 wg_round 递增）。
