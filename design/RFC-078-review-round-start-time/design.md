# RFC-078 技术设计：评审节点「本轮开始时间」展示修正

> 产品背景见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
>
> 本 RFC 为**展示/序列化层修正**，零调度行为改动。

## 1. 现状取数路径（已实证）

### 1.1 review 节点时间字段的真实语义

| 字段 | 写入点 | 含义 |
| --- | --- | --- |
| `node_runs.started_at` | `review.ts:543`（fresh mint）/ `review.ts:521`（pending 复用 `reuse.startedAt ?? now`）；派发 tick 盖章 | 评审槽位**首次打开**时刻，复用路径**永不重盖** |
| `node_runs.finished_at` | `review.ts:1301` `extra:{finishedAt: decidedAt}`（仅 approve；reject/iterate 回 pending 不盖） | 人类**提交 approve** 时刻 |
| `doc_versions.created_at` | `review.ts:638` `createDocVersion` INSERT 时 `= now`，随 `version_index` 原子自增 | **本轮评审内容产出/归档**时刻（每次 refresh / iterate 都新 mint 一版） |
| `doc_versions.decided_at` | 决定提交时 | 该版本被决定的时刻 |

关键代码事实（design 承重断言，实现期需复核）：

- **review 只针对 `done` 源派发**：`review.ts:381` `if (sourceRun===undefined || sourceRun.status!=='done') return failed`。
  ⇒ agent 永远在 review 内容挂上之前已完成；时间线上 agent 的 `canceled` 是 review 自己
  iterate 之后的 supersede 造成的（`review.ts:1405-1424`，`error_message=superseded-by-review-iterated`）。
- **awaiting-refresh 复用分支**（`review.ts:457-503`）：上游产出新 run 时，同一 review 行
  `consumed_upstream_runs_json` 重指、旧 pending doc_version 置 `superseded`，随后
  `createDocVersion`（`review.ts:564`）mint 新 pending（新 `created_at`），**`started_at` 不动**。
- **iterate/reject**（`review.ts:1474-1480`）：同一 review 行 bump `review_iteration`、status→pending，
  **`started_at` 不动**；重做完后再次进 awaiting-refresh 复用分支。
- **resume / daemon 重启重入**（`review.ts:550-562`）：已有 pending doc_version 则原样复用
  （`created_at` 不变），不新 mint。

### 1.2 序列化与展示落点

- 任务详情时间线：`getTaskNodeRuns`（`task.ts:1371-1439`）把 `node_runs` 行映射成
  `NodeRun`（`shared/schemas/task.ts:497-573`），**按 `asc(started_at), asc(id)` 排序**
  （`task.ts:1380`）；前端 `tasks.detail.tsx` `NodeRunsTable`（~615-624）渲染
  `new Date(r.startedAt).toLocaleTimeString()` + 时长 `(finishedAt-startedAt)/1000`；
  `NodeDetailDrawer` StatsTab（~382-404）同口径展示 started/finished/duration。
- review 详情/列表：`/api/reviews/*` → `ReviewSummary.createdAt`（**已**取自
  `doc_versions.created_at`，`review.ts:702-802`）；前端 `reviews.tsx` / `reviews.detail.tsx`
  用 `r.createdAt` / `v.createdAt`。**这条路径本就正确，不动。**

### 1.3 `started_at` 的非展示语义用途（⇒ 不可重盖）

- `scheduler.ts:790` `desc(started_at)` 选最新 parent run；`scheduler.ts:1358` `asc(started_at)`
  迭代；`task.ts:1380` 时间线排序。
- `stuckTaskDetector.ts` / `limits.ts` / `lifecycleInvariants.ts` 用 **`tasks.started_at`**
  做 elapsed/scope（与 review 行无直接关系，但同字段语义需保持）。
- freshness（RFC-074）是纯 id-order，不读 `started_at`；orphans 不读 `started_at`。

结论：**重盖 `node_runs.started_at` 被否决**（Option C）——它是行创建序锚点 + 调度 ORDER BY
依据，复用路径刻意保留它。本 RFC 只新增/派生展示锚点。

## 2. 推荐方案 A：序列化层派生 `reviewRoundStartedAt`（无 migration）

### 2.1 纯函数预言

新增纯函数（建议落 `services/review.ts` 或 `services/reviewRoundStart.ts`，便于单测）：

```ts
/**
 * 本轮评审内容产出时刻。仅对 review 行有意义；非 review 行返回 null。
 *  - 优先：当前 pending doc_version（最大 created_at）—— awaiting_review 正在看的那一版。
 *  - 次选：无 pending（已决定 / refresh 瞬时窗口）⇒ 最高 version_index 的非 superseded 版本的 created_at。
 *  - 兜底：该 review 行无任何 doc_version（孤儿/异常）⇒ run.startedAt。
 */
export function deriveReviewRoundStart(
  run: { id: string; startedAt: number | null },
  versionsForRun: ReadonlyArray<{ createdAt: number; versionIndex: number; decision: DocVersionDecision }>,
): number | null
```

判定（决定性、可穷举单测）：
1. `pendings = versionsForRun.filter(decision==='pending')`；非空 → `max(createdAt)`。
2. 否则 `nonSuperseded = versionsForRun.filter(decision!=='superseded')`；非空 → 取最高
   `versionIndex` 那条的 `createdAt`（即被决定/最终那一版）。
3. 否则（无任何可用版本）→ `run.startedAt`（可能仍为 null，前端再兜底）。

> 为什么按版本而非时间分支：refresh 事务在 supersede 旧 pending 与 mint 新 pending 之间存在
> 「零 pending」瞬时窗口（`createDocVersion` 在事务外，`review.ts:564`）；步骤 2 覆盖此窗口与
> 已决定态。daemon 重启若保留了上一轮 pending，则步骤 1 直接命中该 pending（正确——它就是当前
> 待审版本）。

### 2.2 数据流

- `getTaskNodeRuns`：现已只查 `node_runs`。新增——一次性批量拉本任务所有 `doc_versions`
  （`where task_id = ? `，按 `review_node_run_id` 分组），对每个 review 类 `node_run` 调
  `deriveReviewRoundStart`，把结果写入新字段。**单次额外查询**，O(版本数)，无 N+1。
- `NodeRun` schema 新增可选只读字段：
  ```ts
  /** RFC-078: review 节点本轮内容产出时刻（doc_version 派生）。非 review 行为 null/缺省。 */
  reviewRoundStartedAt: z.number().int().nullable().optional()
  /** RFC-078: 本轮被决定时刻（最高版本 decided_at），用于「人工等待时长」展示。 */
  reviewDecidedAt: z.number().int().nullable().optional()
  ```
  向后兼容（optional+nullable），旧响应/旧前端不受影响。

### 2.3 前端展示

- `NodeRunsTable`（`tasks.detail.tsx`）与 `NodeDetailDrawer` StatsTab：对 `node.kind==='review'`
  （或 `reviewRoundStartedAt != null`）的行：
  - 「开始时间」改渲染 `reviewRoundStartedAt ?? startedAt`。
  - 「时长」：若 `reviewDecidedAt != null` 显示「审阅等待 = decidedAt − reviewRoundStartedAt」，
    并加 i18n 标注（如 `时长(人工)`）；否则（awaiting）显示「等待中」或留空，不显示算力口径数字。
  - 复用既有时间格式化（`new Date(ts).toLocaleTimeString()`）与既有 class，不新写 chrome。
- **排序（US-3，可选）**：若纳入，`getTaskNodeRuns` 排序键对 review 行改用
  `reviewRoundStartedAt ?? startedAt`（仅排序用，不改 `started_at` 本身）。需评估对既有
  时间线快照测试的影响；若风险大，本 RFC 仅修展示、排序留后续。

## 3. 方案对比

| 方案 | 机制 | migration | 优点 | 缺点 / 风险 |
| --- | --- | --- | --- | --- |
| **A（推荐）** | 序列化层按 `doc_versions` 派生只读字段 | 无 | 复用唯一真源；`started_at` 零改动；批量单查 | `getTaskNodeRuns` 多一次 doc_versions 查询 + 派生逻辑 |
| **B** | `node_runs` 加 `round_anchored_at`，refresh/iterate/mint 处盖章 | 有（+backfill） | 读路径无 join；显式 | 多一个需保持同步的时间列，与 `doc_versions.created_at` 信息重复；写点多（457-503 / 1474-1480 / 543）易漏；backfill 复杂 |
| **C** | 重盖 `started_at` | 无 | 改动最小 | **否决**：撞 `scheduler.ts:790/1358` ORDER BY + 复用刻意保留 + resume 幂等 B18 跨切面回归 |
| **D（轻量）** | 纯前端：review 行改用 review summary `createdAt` | 无 | 零后端改动；复用现有 API | 任务页需额外拉 review summary（N 行 N 取或批量端点）；「人工等待时长」标注仍需前端拼；与 node-runs 数据模型割裂 |

推荐 **A**：单一真源、零 migration、`started_at` 零风险、读侧一次批量查询代价可忽略。

## 4. 失败模式

- **无 doc_version**（理论不应发生于已派发 review）：派生回退 `started_at`；前端再回退 `—`。AC-3。
- **refresh 零 pending 瞬时窗口**：派生步骤 2 用最高版本兜底；即便命中超时窗口也只是短暂显示
  上一锚点，不崩、不误导持久态。
- **daemon 重启孤儿 awaiting_review**：若 pending 仍在 → 步骤 1 命中（正确）；若 pending 丢失
  → 步骤 2/3 回退，时间线退化为 `started_at`（与现状一致，不更差）。
- **shard / fanout review**（若存在按 shard 的 review）：`doc_versions` 带 `source_port_name`；
  派生按 `review_node_run_id` 分组即可，shard_key 不影响单行派生。实现期需确认无按端口多 pending
  并存（同一 run 同一 port 同时只一 pending，`review.ts` 不变量）。
- **非 review 行**：`deriveReviewRoundStart` 返回 null，字段缺省，前端走原 `started_at` 路径，零影响。

## 5. 测试策略（CLAUDE.md「测试随改动落地」强制）

必写：

1. **纯函数单测** `deriveReviewRoundStart`（穷举生命周期）：
   - 单 pending（fresh mint）→ 返回该 pending.createdAt。
   - refresh 后（旧版 superseded + 新 pending）→ 返回新 pending.createdAt（晚于旧）。
   - approve 终态（无 pending，最高版 approved）→ 返回 approved 版 created_at。
   - iterate 后回 pending（旧版 iterated + 新 pending）→ 返回新 pending。
   - 多轮（superseded×N + iterated×M + 1 pending）→ 仍返回唯一 pending。
   - 零 pending 且全 superseded（瞬时窗口）→ 最高 version_index 版本 created_at。
   - 无任何版本 → 回退 `run.startedAt`（含 startedAt=null）。
2. **序列化集成测**：构造一行 review（started_at 远早于其 doc_version.created_at），断言
   `getTaskNodeRuns` 返回的该行 `reviewRoundStartedAt === doc_version.createdAt` 且
   `startedAt` 原值不变；非 review 行 `reviewRoundStartedAt` 缺省。
3. **回归样本测**（AC-4）：以 `01KT1HDYV6RA8EJGY5BSE20MH9` 形态构造（或 fixture）验证
   `rev_cbkatx` 锚点晚于其最终版本产出、不再早 ~25h。
4. **不回归断言**（AC-5）：review 详情/列表 summary `createdAt` 路径快照不变。
5. **前端文本/角色锚点兜底**：断言 review 行不直接绑定原始 `started_at`（例如断言渲染值等于
   `reviewRoundStartedAt`，或源码层「review 行的时间格式化输入不是裸 `r.startedAt`」）。

门槛：`bun run typecheck && bun run test && bun run format:check` 全绿；推 main 后按
`[feedback_post_commit_ci_check]` 查 CI（含 build smoke + Playwright e2e）。

## 6. 与现有模块耦合点

- 读：`task.ts getTaskNodeRuns`（+1 查询 +派生）、`shared/schemas/task.ts NodeRunSchema`（+2 可选字段）。
- 写：**无**（不写任何表；不动 `review.ts` 写路径——A 方案的全部魅力所在）。
- 前端：`tasks.detail.tsx`（NodeRunsTable）、`NodeDetailDrawer.tsx`（StatsTab）、i18n key。
- 不碰：`scheduler.ts`、`freshness.ts`、`dispatchFrontier.ts`、`review.ts` 决策/复用写路径、
  `/api/reviews/*`、`reviews*.tsx`。
