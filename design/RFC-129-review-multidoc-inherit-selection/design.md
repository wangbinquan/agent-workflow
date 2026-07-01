# RFC-129 Design —— 多文档评审跨轮继承逐文档标记

> 读前置：`proposal.md`。本文件是技术设计（接口契约 / 数据流 / 耦合点 / 失败模式 / 测试策略）。
> 设计原则：**最大化复用 RFC-079 现有多文档运行时**；唯一新数据 = 每篇 1 个 `selection_stale` 标志位；
> 单文档路径**字节级零回归**；跨轮匹配 / 继承 / stale 判定全部抽成 `reviewMultiDoc.ts` 纯 oracle。

---

## 1. 数据模型

### 1.1 新列 `doc_versions.selection_stale`（migration 0069）

```sql
-- 0069_rfc129_review_selection_stale.sql
ALTER TABLE `doc_versions` ADD COLUMN `selection_stale` integer;
```

- **单条 statement**（纯 ADD COLUMN，无 table-rebuild、无需 `--> statement-breakpoint`）。
- **nullable、无 DB default**：单文档行、既有历史行、`unselected` 行全部保持 NULL。
- **语义**：`1` = 该多文档成员的 `selection` 是**从上一轮继承**而来，且**当前正文与「上次人工裁决时的正文」不一致**
  （= 内容变了、这条裁决可能过时、建议重看）。`0` / `NULL` = 未继承 / 内容未变 / 从未裁决 / 单文档。
- 值域是应用层约定（0/1），与 RFC-079 三列一样**不加 DB CHECK**。

drizzle（`schema.ts`，`docVersions` 表，紧随 `itemPath` :898 之后）：

```ts
// RFC-129: 1 when this multi-document member's `selection` was INHERITED from a
// prior review round AND its body differs from the body the human last judged
// (propagated across rounds until a human re-marks). NULL on single-doc rows,
// unselected rows, and freshly human-judged rows. Drives the "已变更" badge.
selectionStale: integer('selection_stale', { mode: 'boolean' }), // boolean | null（DB 层存 0/1/NULL）
```

> 用 `{ mode: 'boolean' }`（本仓 15+ 布尔列惯例，如 `readonly` / `syncOutputsOnIterate` / `enabled`）→ TS 类型
> `boolean | null`，写入接 boolean、读回即 boolean，全链无 `=== 1` 转换（Codex 设计 gate P2b）。**nullable**
> （不带 `.notNull().default`）以让单文档 / 历史行为 NULL。SQL migration 仍是裸 `integer`（§1.1 顶部）。

无新索引：跨轮查询按 `(taskId, reviewNodeId)`（既有 `idx_doc_versions_task` 覆盖 taskId 前缀）+ 内存过滤，
多文档一轮至多几十行、跨轮至多几百行，无需专用索引。

### 1.2 schema（`shared/schemas/review.ts`）

`DocVersionSchema`（:144）加一字段（镜像列，供 `rowToDocVersion`）：

```ts
/** RFC-129: inherited-selection staleness flag (see schema.ts). NULL on
 *  single-doc / unselected / freshly-judged rows. */
selectionStale: z.boolean().nullable().optional(),
```

`ReviewDocumentSummarySchema`（:338，驱动前端左栏）加一字段：

```ts
/** RFC-129: true when this document's `selection` was inherited from a prior
 *  round and its content changed since the human last judged it — the
 *  "已变更 / changed" badge. Absent / false on single-doc & first-round docs. */
stale: z.boolean().optional(),
```

---

## 2. 纯 oracle（`shared/reviewMultiDoc.ts`）—— 匹配 + 继承 + stale 判定

**全部跨轮语义抽成无 IO 纯函数**（首选可断言面，per CLAUDE.md「测试随每次改动」）。服务层只负责读上一轮行、
读正文、写列；决策逻辑全在 oracle，`reviewMultiDoc.inherit.test.ts` 穷举。

```ts
export type DocumentSelection = 'unselected' | 'accepted' | 'not_accepted'

/** 上一轮某篇的投影（服务层从 doc_versions + bodyPath 读出后喂进来）。 */
export interface PriorRoundMember {
  itemIndex: number
  itemPath: string | null
  selection: DocumentSelection
  selectionStale: boolean       // 上一轮该篇是否已 stale（未清除）
  body: string                  // 上一轮该篇归档正文（bodyPath 快照）
}

/** 本轮正在 mint 的某篇（正文在手：inline body 或 worktree 文件读出）。 */
export interface NewRoundItem {
  itemIndex: number
  itemPath: string | null
  body: string
}

export interface InheritedSelection {
  selection: DocumentSelection
  /** 是否给这篇打 selection_stale=1。 */
  stale: boolean
}

/** 从上一轮成员建查表：byPath 只收**唯一**路径（重复路径不进 byPath，退回 index 匹配）。 */
export function buildPriorSelectionLookup(prior: readonly PriorRoundMember[]): {
  byPath: Map<string, PriorRoundMember>
  byIndex: Map<number, PriorRoundMember>
}

/**
 * 单篇继承决策。匹配优先级（proposal AC-2）：
 *   1. item 有 path 且该 path 在上一轮**唯一**存在 → 命中该篇（路径优先，改序 / 增删稳健）。
 *   2. 否则退回同 item_index。
 *   3. 再否则 → 不继承（新文档，unselected / 非 stale）。
 * stale 判定：命中且被继承 selection ∈ {accepted, not_accepted} 时，
 *   stale = (本轮正文 !== 上一轮该篇正文) || 上一轮该篇 selectionStale。
 * 继承 unselected（或无命中）→ stale = false。
 */
export function inheritSelection(
  item: NewRoundItem,
  lookup: ReturnType<typeof buildPriorSelectionLookup>,
): InheritedSelection {
  const m =
    (item.itemPath != null && item.itemPath !== '' ? lookup.byPath.get(item.itemPath) : undefined) ??
    lookup.byIndex.get(item.itemIndex)
  if (m === undefined || m.selection === 'unselected') {
    return { selection: 'unselected', stale: false }
  }
  const changed = item.body !== m.body
  return { selection: m.selection, stale: changed || m.selectionStale }
}
```

**为什么路径优先能修「改序错标」**：上一轮 `[a.md(采纳), b.md(不采纳), c.md(采纳)]`，iterate 后上游丢掉 a、
输出 `[b.md, c.md]`。按 index：新 idx0=b.md 会误继承 a 的「采纳」。按 path：b.md→不采纳、c.md→采纳，**全对**。
内联模式无 path → 只能按 index（`splitMarkdownDocs` 保序，同 index = 同篇的常规假设，与 RFC-079 versionIndex
配对同源）。

**为什么用 `body !== body` 而非哈希列**：mint 时本轮正文已在手（inline body / worktree 文件读出），上一轮正文
从其 `bodyPath` 快照读出——两者都是「评审员当轮看到的正文」，逐字比对即「跨轮内容是否变化」。不引哈希列、
不做规范化（trim 差异也算变化，宁可多提示一次重看）。

**为什么 stale 要 `|| m.selectionStale` 传播**：某篇 R1 采纳（正文 C1）→ R2 内容变 C2、继承采纳 + stale（评审员
没重看）→ R3 内容仍是 C2（未再变）。若只比 R2↔R3 正文会判「未变、非 stale」，但相对评审员真正裁决的 C1 其实
早就变了。传播上一轮 stale 位 → R3 仍 stale，直到评审员重标（§3.2 清 0）才认为「已按当前内容裁决」。

---

## 3. 后端注入点（`services/review.ts`）

### 3.1 mint 循环注入继承（`dispatchReviewNode`，:600-660）

唯一注入点。iterate / reject / refresh / US-2 **四条重开路径都汇到这里**（见 §5 数据流），改一处全覆盖。

**改动**：进入多文档 mint 分支（:609 `else` 首次归档）前，**先加载上一轮成员并建 lookup**；把 :642 的
硬编码 `selection: 'unselected'` 换成 `inheritSelection(...)` 的结果，并把 `selectionStale` 透传给
`createDocVersion`。

```ts
// —— 新增：加载「紧邻上一轮」多文档成员（本 review 节点、同 workflow iteration、item_index 非空）。
//        跨 node_run（覆盖 US-2 新 run）；锚定到 max(reviewIteration) 那一整轮再匹配（见下 loadPriorRoundMembers）。
//        注意：不按 reviewNodeRunId 排除——iterate/reject/refresh 的上一轮就在这个复用 run 上（Codex P1）。
const priorMembers = await loadPriorRoundMembers(db, appHome, {
  taskId, reviewNodeId: node.id, iteration,
})
const lookup = buildPriorSelectionLookup(priorMembers)

for (let i = 0; i < itemCount; i++) {
  // …（沿用现有 body / itemPath 读取，:612-628 不动）…
  const inh = inheritSelection(
    { itemIndex: i, itemPath: itemPath ?? null, body },
    lookup,
  )
  const dv = await createDocVersion({
    db, appHome, taskId, reviewNodeId: node.id, reviewNodeRunId,
    sourceNodeId, sourcePortName, reviewIteration, body,
    ...(itemPath !== undefined ? { sourceFilePath: itemPath, itemPath } : {}),
    itemIndex: i,
    selection: inh.selection,        // 原 'unselected' → 继承值
    selectionStale: inh.stale,       // 新增
  })
  docs.push(dv)
}
```

`loadPriorRoundMembers`（新私有 helper，`review.ts`）—— **返回「紧邻上一轮」那一整轮的成员**
（Codex 设计 gate P1 + P2a 修）：

```ts
// 1. 取本 review 节点、同 workflow iteration 内、所有多文档成员行（item_index 非空），跨 node_run
//    （join node_runs 过滤 iteration）。**不按 reviewNodeRunId 排除**——iterate/reject/refresh 的上一轮
//    就在这个复用 run 上（decision = iterated/rejected/superseded），排除它 → prior 空 → 主路径不继承（P1）。
// 2. R* = 这些行里的 max(reviewIteration)。当前轮的行此刻尚未 mint（mint 循环仅在无 pending doc_version 时
//    进入，:603），故现存行必全部属于更早的轮 → 其 max 即「紧邻上一轮」的 reviewIteration。
// 3. 上一轮成员 = reviewIteration == R* 的行；同一 R* 若有多代（refresh 同轮 supersede 后再生），
//    每个匹配键（item_path 唯一优先、否则 item_index）取最新一行（id / createdAt DESC）。读其 bodyPath 正文。
async function loadPriorRoundMembers(db, appHome, args): Promise<PriorRoundMember[]>
```

- **scope = 同 workflow iteration**：`doc_versions` 无 `iteration` 列 → join `node_runs`（`reviewNodeRunId →
  node_runs.iteration`）过滤 `iteration = 当前 iteration`。保证 loop 每趟独立（AC-10）。
- **跨 node_run、不排除当前 run（Codex P1）**：iterate / reject / refresh **复用同一 review `node_run`——上一轮
  成员就在这个 run 上**（`decision` = iterated/rejected/superseded），**绝不能按 `reviewNodeRunId` 排除**（否则
  主路径 prior 恒空、`selection` 全被重置 unselected、AC-1/AC-7 失败）；US-2 重开 mint 新 run（上一轮成员在旧
  run）。用 `docVersions.reviewNodeId`（表已有该列）+ iteration 过滤同时覆盖两种。
- **锚定「紧邻上一轮」整组，而非「每键 max versionIndex」（Codex P2a）**：`reviewIteration` 是轮键——
  iterate/reject mint 时 run 已 bump 到 N、上一轮行是 N-1；refresh/US-2 不 bump、上一轮行与当前 mint 同为 N（当前
  行此刻未生成）→ **现存 max(reviewIteration) 恒 = 上一轮**。先锁这一轮的整组、再在组内做 path/index 匹配：
  某文档若不在上一轮（例：a.md 在 R1 有、R2 无、R3 又出现）→ **不复活更早轮的选择、按新文档 unselected**。
  （弃用「每键 max versionIndex」：`versionIndex` 按 item_index 递增、item 增删/改序时会串不同文档，且跨 US-2
  新 run 会重置、不可跨轮比较。）
- **`selectionStale` 读取/归一**（Codex 确认 gate P2）：列 `{ mode: 'boolean' }` → `row.selectionStale` 为
  `boolean | null`（legacy / 单文档 / unselected / 刚人工裁决行为 NULL）。构造 `PriorRoundMember.selectionStale`
  （oracle 输入、`boolean`）用 **`row.selectionStale ?? false`**（NULL = 未 stale）；`DocVersionSchema` 公开字段
  保持 nullable（`?? null`）。
- 读正文失败（bodyPath 缺失）→ 该篇 body 记空串（比对必判「变化」、偏保守多提示，不 wedge）。

### 3.2 人工重标清 stale（`setDocumentSelection`，:1839）

评审员 `PATCH …/selection` = 「对当前正文做出裁决」→ 清 stale：

```ts
await args.db
  .update(docVersions)
  .set({ selection: args.selection, selectionStale: false })   // 新增 selectionStale:false
  .where(eq(docVersions.id, args.docVersionId))
```

（`selectionStale: false` 写 0；配合 §2 传播链，人工重标是唯一的「stale 清除」出口。）

### 3.3 `createDocVersion` 增参（:693 `CreateDocVersionArgs`）

```ts
/** RFC-129: 多文档继承 stale 标志（默认 undefined → 列 NULL，单文档路径不传）。 */
selectionStale?: boolean
```

insert values 增 `selectionStale: args.selectionStale ?? null`（`boolean | null`；drizzle `mode:'boolean'` 落库
为 0/1/NULL；未传 → NULL，单文档零回归）。

### 3.4 `rowToDocVersion` / 读回

`rowToDocVersion` 映射 `selectionStale: row.selectionStale ?? null`（列 `{ mode: 'boolean' }` 已是
`boolean | null`，无需数值转换；供 `DocVersionSchema`）。

---

## 4. 读路径 + 前端

### 4.1 `getReviewDetail` 填 `stale`（`review.ts:977-998`）

`documents.push({...})` 增：

```ts
stale: m.selectionStale === true,
```

（单文档分支 / `selectionStale` NULL / false → `false`。）

### 4.2 前端 `MultiDocReviewView.tsx` 左栏「已变更」徽标

左栏每行现有 `selectionChip`（accepted/not_accepted/pending StatusChip）+ 评论数。**新增**：当 `d.stale` 时，
在 chip 旁加一枚 `warn` 色 `StatusChip`「已变更」（复用既有 `<StatusChip>` 公共组件，不自写 chrome）：

```tsx
{d.stale && (
  <StatusChip kind="warn" size="sm" data-testid="multidoc-stale-badge">
    {t('reviews.multiDoc.changed')}
  </StatusChip>
)}
```

- `ReviewDocumentSummary` 类型经 shared 自动带 `stale`。
- 徽标纯提示：不改 approve 门控（仍 `allDecided`）、不改逐篇按钮可用性。
- 可选（同一 PR，低成本）：右侧 per-doc 动作条在 `current.stale` 时加一行 muted 提示
  `t('reviews.multiDoc.changedHint')`（「内容较你上次裁决时有变化，建议重看」）。
- i18n（`zh-CN.ts` + `en.ts`）：`reviews.multiDoc.changed`（zh「已变更」/ en「Changed」）、
  `reviews.multiDoc.changedHint`。

### 4.3 WS / 失效

**无新 WS 事件**。新一轮 mint 由 dispatch 触发，前端经既有 `useTaskSync` + `refetchInterval:8000` 重取 detail，
继承后的 `selection` + `stale` 随 payload 到达。人工重标仍走既有 `review.selection_changed`（清 stale 后 detail
失效重取）。

---

## 5. 数据流：四条「重开新一轮」路径都过 §3.1 注入点

| 触发 | 现状路径 | 上一轮成员在哪 | 继承是否生效 |
| --- | --- | --- | --- |
| **iterate** | 决策 :1811 bump `reviewIteration` + 复用 review run → pending；上游重跑 → dispatch :557 `reuse.status==='pending'` 分支 → mint 循环 | 同 `reviewNodeRunId`（decision='iterated'） | ✅ |
| **reject** | 同 iterate，但回退 `pre_snapshot` + 上游整批重生 | 同 `reviewNodeRunId`（decision='rejected'） | ✅（内容多变 → 多打 stale） |
| **refresh**（awaiting 时上游更新，US-2 §7） | dispatch :504-547 retire 旧 pending→superseded → mint 循环 | 同 `reviewNodeRunId`（decision='superseded'） | ✅ |
| **US-2 重评**（决策后上游又变） | dispatch :571-585 mint **新** awaiting run → mint 循环 | **旧** `reviewNodeRunId`（终态 decided） | ✅（§3.1 跨 node_run 查 by `reviewNodeId`+iteration） |

四条都收敛到 `dispatchReviewNode` 的 mint 循环（§3.1）——**一处注入、全路径一致**。这正是把继承放在 mint 而非
放在各决策分支的原因。

---

## 6. 耦合点与失败模式

| 关注点 | 处理 |
| --- | --- |
| 单文档零回归 | `item_index IS NULL` 不进多文档 mint 分支，`selection_stale` 恒 NULL；decision / approve / 输出端口逐字不变（golden lock §7）|
| approve 门控 | 不变——仍 `allDocumentsDecided`（`reviewMultiDoc.ts:165`）；`stale` 不参与门控（AC-8）|
| 上游改序 / 增删文档 | 路径优先匹配吸收（§2）；新路径退回 index、内容多半变 → stale 提示兜底 |
| 内联 `list<markdown>` 无 path | oracle 自然退回 index（`item.itemPath == null` → 只查 byIndex）|
| 重复 path（退化输入） | `buildPriorSelectionLookup` 只把**唯一** path 收进 byPath；重复 path 退回 index |
| loop wrapper 多趟 | `loadPriorRoundMembers` 按 `node_runs.iteration` 过滤 → 不跨趟继承（AC-10）|
| 跨轮身份 = 紧邻上一轮（Codex P1/P2a）| `loadPriorRoundMembers` **不按 reviewNodeRunId 排除**（同 run 上一轮要能取到）+ 用 `max(reviewIteration)` 锁「紧邻上一轮」整组再匹配（弃「每键 max versionIndex」——会串文档 / 跨 US-2 run 重置）→ 更早轮的选择不复活 |
| bodyPath 读失败 | 视作空串正文 → 比对判「变化」→ stale（偏保守），不 wedge 整轮 |
| stale 跨轮不清除 | §2 `|| m.selectionStale` 传播；唯一清 0 出口 = 人工重标（§3.2）|
| 乐观锁 | 继承 / stale 全在 mint 侧，不碰 `reviewIteration`；逐篇 selection PATCH 仍不 bump（RFC-079 语义不变）|
| RFC-099 prompt 隔离 | 未新增任何进 agent prompt 的字段；`selection_stale` 纯 UI/调度侧，不入 `accepted` / `approval_meta` 端口 |

---

## 7. 测试策略（改动即带测试）

**纯 oracle（首选可断言面，`packages/shared/tests/reviewMultiDoc.inherit.test.ts`）**：

- 路径优先命中：上一轮 `a.md=accepted`，本轮同 path → 继承 accepted。
- 改序稳健：上一轮 `[a,b,c]`、本轮 `[c,a]` → 各按 path 正确继承（不按 index）。
- index 退回：内联模式（path 全 null）按 index 继承。
- 新文档：本轮 path 不在上一轮、index 也无匹配 → unselected / 非 stale。
- 内容变化：命中 + 正文变 → stale=true；正文逐字同 → stale=false。
- stale 传播：上一轮 `selectionStale=true` 且本轮正文未变 → 仍 stale=true。
- 继承 unselected：上一轮该篇 unselected → 本轮 unselected、非 stale。
- 重复 path：上一轮两篇同 path → 都不进 byPath → 退回 index。
- `buildPriorSelectionLookup`：唯一 path 收录、重复 path 排除、index 全收。

**后端（`packages/backend/tests/review-multidoc-inherit.test.ts`）**：

- iterate 重开（**Codex P1 回归锁**）：**复用同一 review run** 时新一轮各篇 `selection` == 上一轮匹配篇
  （含 unselected）——坐死「同 run 上一轮不被排除、prior 非空」；改过正文的篇 `selection_stale` = true（存 1）。
- reject 重开：同上（覆盖回退重生路径）。
- **紧邻上一轮而非更早轮（Codex P2a 回归锁）**：`a.md` R1 accepted、R2 缺席、R3 又出现 → R3 的 a.md **不继承
  R1**、按新文档 `unselected`（锚 `max(reviewIteration)` 整组、不用每键 max versionIndex）。
- US-2 新 run：跨 node_run 继承（by reviewNodeId + iteration）。
- 人工重标清 stale：`setDocumentSelection` 后该行 `selection_stale` = false（存 0）。
- **单文档 golden**：单文档 iterate/approve 后 `selection_stale` 恒 NULL、行为逐字不变。
- loop 隔离：不同 `node_runs.iteration` 不互相继承。
- detail：`getReviewDetail().documents[i].stale` 正确反映列（boolean）。

**前端（`packages/frontend/tests/review-multidoc-stale-badge.test.tsx`，vitest）**：

- `documents[i].stale=true` → 左栏该行渲染 `multidoc-stale-badge`；false → 无。
- 源码断言（兜底）：`MultiDocReviewView.tsx` 含 `multidoc-stale-badge` testid + 走 `<StatusChip>`（不自写 chrome）。

**回归锁**：`upgrade-rolling.test.ts` HEAD journal 计数 **68 → 69**（migration 0069；per memory
[reference_migration_bumps_journal_count_test]，同步 bump 标题 + 断言 + 注释 N）。

**门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿 + 单二进制 smoke + 前端 vitest。

---

## 8. Golden locks / 零回归清单

- 单文档 review：`selection_stale` 恒 NULL；`dispatchReviewNode` 单文档分支（:662-687）、`submitReviewDecision`
  单文档分支、`approved_doc` / `approval_meta` 输出**逐字不变**。
- 多文档 approve：采纳子集算法（`acceptedSubsetPaths` / `computeAcceptedSubset`）**不动**——继承只影响开局
  `selection`，approve 仍读当轮 `selection` 决定子集。
- 乐观锁 / `reviewIteration` bump 时点不变。
- 无新端口、无 prompt 字段变化 → RFC-099 隔离不受影响。

---

## 9. 决策记录（映射用户澄清）

| # | 决策 | 依据 |
| --- | --- | --- |
| **D1** | 跨轮匹配 = **item_path 唯一命中优先，退回 item_index**；内联无 path 走 index | 用户澄清 Q1「路径优先，退回位置」；RFC-079 定义 item_path 为稳定 id |
| **D2** | 内容变化 = **继承 + 打「已变更」标记**（advisory，不重置、不阻塞 approve） | 用户澄清 Q2「继承 + 标记『已变更』」 |
| **D3** | 覆盖 **iterate + reject**（并顺带 refresh / US-2，同一 mint 注入点） | 用户澄清 Q3「iterate 和 reject 都继承」 |
| **D4** | stale 判定用**正文逐字比对**（不引哈希列、不规范化）+ **传播上一轮 stale**、人工重标清 0 | D2 的正确实现（跨多轮防「粘滞过时」）；最小数据（1 列）|
| **D5** | 单一注入点 = `dispatchReviewNode` mint 循环（非各决策分支） | 四条重开路径都汇于此，一处改全覆盖（§5）|
| **D6** | 继承 scope = **同 workflow iteration**（join node_runs.iteration） | proposal 非目标「不跨 loop 趟」（AC-10）|
| **D7** | 全部跨轮语义抽 `reviewMultiDoc.ts` 纯 oracle | CLAUDE.md「首选可断言面」；RFC-079 已在此放同类纯 helper |
| **D8** | 单列 `selection_stale`，drizzle `integer(..., { mode: 'boolean' })` **nullable**（`boolean \| null`），不加索引、不加 CHECK；SQL 层裸 `integer`（存 0/1/NULL）| 本仓 15+ 布尔列惯例（Codex 设计 gate P2b 纠正原 plain int + 布尔写入不过类型）；数据量小 |
| **D9** | `loadPriorRoundMembers` = **紧邻上一轮整组**（`max(reviewIteration)` 锁轮 + 组内 path/index 匹配），**不排除同 run**、不用「每键 max versionIndex」| Codex 设计 gate P1（同 run 上一轮被排除 → 主路径不继承）+ P2a（每键 max 会从更早轮复活选择 / 跨 US-2 run versionIndex 重置）|
