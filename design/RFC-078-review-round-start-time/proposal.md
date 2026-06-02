# RFC-078 评审节点「本轮开始时间」展示修正

> 产品视角。技术方案见 [design.md](./design.md)，任务分解见 [plan.md](./plan.md)。
>
> 状态：**Draft**（待 T0 方向裁决后进入实现）

## 背景

任务详情页的 node-runs 时间线对每个 `node_run` 统一展示「开始时间」与「时长」，
取值直接来自 `node_runs.started_at` / `finished_at`（`tasks.detail.tsx` 的 `NodeRunsTable`、
`NodeDetailDrawer` 的 StatsTab）。这套语义对 **agent 节点**是对的——它就是该次进程的
算力跨度。

但对 **review（评审）节点**，这两个字段的含义完全不同：

- `started_at` 是**评审槽位第一次被打开（进入 `awaiting_review`）那一刻**，由派发 tick 盖章
  （`review.ts:543`），且此后**永不重盖**。
- `finished_at` 是**人类提交 approve 决定的时刻**（`review.ts:1301`，reject/iterate 不盖
  `finished_at`，行回到 pending）。

中间发生的事让 `started_at` 与「这次评审到底在看哪一版、那一版什么时候产出」严重脱节：

1. **人类 iterate（打回重做）复用同一行 review**：iterate 只 bump `review_iteration`、把行改回
   pending（`review.ts:1474-1480`），并把当时**已经 `done` 的上游 agent run 就地 `canceled`**、
   mint 新 retry（`review.ts:1405-1424`，这正是时间线上那些 agent 行显示 `canceled` +
   `error_message=superseded-by-review-iterated` 的原因）。重做完后 review 走「awaiting-refresh
   复用」分支（`review.ts:457-503`），把 `consumed_upstream_runs_json` 重指到新 run，
   **但不重盖 `started_at`**。
2. **完成事件驱动派发**（RFC-076）：`runScope` 用 `Promise.race` 在任意在飞节点 settle 时
   重算 frontier（`scheduler.ts:633`），review 槽位的 `started_at` 盖在「谁唤醒了调度器」那一
   tick——可能是**兄弟节点**而非被评审的 agent。

后果（真实任务 `01KT1HDYV6RA8EJGY5BSE20MH9`）：

- `rev_cbkatx`：`started_at` 比它最终评审的 agent run（`agent_b48d63` 的最后一次 run）**早约
  25 小时**，因为它在多轮 iterate 间一直复用同一行；UI 显示「时长 25 小时」，实际是人类思考
  + 多次 agent 重跑之和，并非任何一次算力。
- `rev_5h9xpz`：某一行 `started_at` 紧跟在**兄弟节点 `agent_b48d63`** 完成 +179ms，而它评审的
  是 `agent_m7p3n1`（早约 7 分钟完成）。
- 因为 `getTaskNodeRuns` 还按 `started_at` 排序（`task.ts:1380`），被钉死的 review 行在时间线
  里还会**排到错误的早位置**。

注意：**调度本身没有 bug**，复用同一行 review 也是有意设计（维持一条稳定的评审线 /
doc_version 历史、approve 后不冒 spurious 重评）。问题纯粹在**展示层用错了时间锚点**。

## 目标

- 任务详情页对 review 节点展示的「开始时间」反映**本轮评审针对的内容何时产出**（即当前
  待审 doc_version 的产出时刻），而不是被钉死的槽位首开时刻。
- review 行的「时长/耗时」要么改为表达「等待人工决定的时长」并明确标注，要么不再以算力口径
  展示，避免「25 小时」这种误导。
- 时间线排序上，review 行不再因 `started_at` 被钉死而落到错误的早位置（次要目标，按 design
  权衡是否纳入）。
- 复用既有数据源（`doc_versions.created_at` 已是 `ReviewSummary.createdAt` 的真源），尽量
  **不加 migration**。

## 非目标（明确不做）

- **不改调度时序**：`Promise.race` 完成事件驱动派发、start-all-ready 全部保留。
- **不改 review 复用语义**：awaiting-refresh 就地复用、iterate 复用同一行、approve 幂等等
  全部保留。
- **不重盖 `node_runs.started_at`**：它被 `scheduler.ts:790/1358` 的 `ORDER BY` 与多处行序
  语义使用，复用路径也刻意保留它（`review.ts:521` 注释），重盖有跨切面回归风险（含 resume
  幂等 B18）。本 RFC 只**新增/派生**一个展示用锚点，绝不动 `started_at`。
- **不改 review 详情页 / review 列表页**：它们已经用 `doc_versions.created_at`，本就正确。

## 用户故事

- **US-1**：作为操作者，我在任务详情时间线看到 review 节点的「开始时间」时，它应当对应
  「我现在要评审的这一版内容是什么时候产出的」，而不是几小时前那个早已被打回的旧槽位时刻。
- **US-2**：作为操作者，我看到 review 行的耗时列时，要么看到「等待我决定了多久」（明确标注
  为人工等待），要么看不到一个会被误读成算力的「25 小时」。
- **US-3**：作为操作者，时间线按时间排序时，review 行应当出现在「它本轮内容产出之后」的合理
  位置，而不是因为槽位首开早而排到最前。
- **US-4**（不回归）：review 详情页、review 列表页、approve 后的历史版本下拉，时间显示与现状
  完全一致。

## 验收标准

- **AC-1**：对处于 `awaiting_review` 的 review 节点，任务详情时间线展示的「开始时间」= 当前
  pending `doc_version` 的 `created_at`；不再是被钉死的 `node_runs.started_at`。
- **AC-2**：对已 approve 的 review 节点，展示锚点 = 被批准那一版（最高 `version_index` 的
  非 superseded 版本）的 `created_at`；「时长」若展示，标注为人工评审等待时长（决定时刻 −
  本轮锚点），而非算力时长。
- **AC-3**：边界——daemon 重启后 awaiting_review 行恰好没有 pending doc_version（孤儿态）、
  或完全没有 doc_version 时，回退到 `node_runs.started_at`，绝不崩。
- **AC-4**：以真实任务 `01KT1HDYV6RA8EJGY5BSE20MH9` 为回归样本：`rev_cbkatx` 展示锚点落在其
  最终评审版本产出之后（不再早 ~25h）；`rev_5h9xpz` 的各行锚点对齐到其各自被评审 agent 版本
  产出之后。
- **AC-5**：review 详情页 / review 列表页 / 历史版本下拉的时间显示**字节级不变**（不回归）。
- **AC-6**：纯函数 `deriveReviewRoundStart`（或等价预言）有覆盖所有生命周期态的单测；序列化
  层有集成断言；前端有「review 行不再直接渲染原始 `started_at`」的文本/角色锚点兜底断言。
- **AC-7**：无 schema migration（若 T0 选 Option B 则例外，需在 design 标注并带 backfill）。

## 待裁决（T0 决策门）

进入实现前需用户在以下方向裁决（详见 design §方案对比）：

- **A（推荐）**：序列化层按 `doc_versions` 派生展示锚点，`NodeRun` 加可选只读字段，前端按
  review 行渲染。无 migration。
- **B**：`node_runs` 加 `round_anchored_at` 列，在复用/iterate/首 mint 处显式盖章。需 migration
  + backfill。
- **D（轻量）**：纯前端——review 行改用已有 review summary 的 `createdAt`，零后端改动。
- **范围**：是否同时修正时间线**排序**（次要目标 US-3），还是仅修正展示文案。
