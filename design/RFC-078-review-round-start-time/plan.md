# RFC-078 任务分解：评审节点「本轮开始时间」展示修正

> 产品见 [proposal.md](./proposal.md)，技术见 [design.md](./design.md)。
>
> 默认单 RFC = 单 PR（纯展示/序列化，无 migration）。提交前 `bun run typecheck && bun run
> test && bun run format:check` 全绿，推 main 后按 `[feedback_post_commit_ci_check]` 查 CI。

## 依赖与前置

- **T0（决策门，阻塞实现）**：用户在 design §3 方案 A / B / D 间裁决，并决定是否纳入排序修正
  （US-3）。未裁决前不写任何实现代码。
- 下列子任务以**推荐方案 A + 暂不改排序**为基线编写；若 T0 改选 B/D 或纳入排序，相应调整
  T2/T4 并在此处标注。

## 子任务

- **RFC-078-T1｜纯函数 + 单测（红→绿可独立交付）**
  - 新增 `deriveReviewRoundStart(run, versionsForRun)`（落 `services/reviewRoundStart.ts` 或
    `review.ts`），实现 design §2.1 三步判定。
  - 写穷举单测（design §5.1 全部七类）。
  - 依赖：无。验收：单测绿；纯函数不触 DB。

- **RFC-078-T2｜序列化接入 `getTaskNodeRuns`**
  - `task.ts:1371-1439`：批量拉本任务 `doc_versions`（单查），按 `review_node_run_id` 分组，
    对 review 类 node_run 调 T1 派生，填 `reviewRoundStartedAt` / `reviewDecidedAt`。
  - `shared/schemas/task.ts` `NodeRunSchema` 加两个 optional+nullable 字段（design §2.2）。
  - **不改** `started_at` 取值与排序键（排序 US-3 不在本基线内）。
  - 依赖：T1。验收：序列化集成测（design §5.2）+ 回归样本测（design §5.3）绿；
    `started_at` 原值与非 review 行行为不变。

- **RFC-078-T3｜前端展示（NodeRunsTable + NodeDetailDrawer）**
  - review 行「开始时间」渲染 `reviewRoundStartedAt ?? startedAt`；「时长」改为人工等待口径
    （`reviewDecidedAt − reviewRoundStartedAt`，明确 i18n 标注）或 awaiting 留空。
  - 复用既有时间格式化 + 既有 class，不新写 chrome（遵 CLAUDE.md 前台统一原则）。
  - 加 i18n key（时长(人工)/等待中 等），中英齐。
  - 依赖：T2。验收：前端文本/角色锚点兜底断言（design §5.5）；与 `/agents` `/workflows`
    等核心页视觉对齐自查。

- **RFC-078-T4｜不回归守护**
  - 断言 review 详情/列表 summary `createdAt` 路径字节级不变（design §5.4 / AC-5）。
  - 断言 `/api/reviews/*` 与 `reviews*.tsx` 未被本 RFC 触及。
  - 依赖：T2/T3。验收：相关既有测试全绿。

- **RFC-078-T5｜（可选，按 T0）时间线排序修正（US-3）**
  - 仅当 T0 决定纳入：`getTaskNodeRuns` 排序键对 review 行用 `reviewRoundStartedAt ?? startedAt`
    （不改 `started_at` 本身）。评估既有时间线快照测试影响，必要时更新并在 commit 说明。
  - 依赖：T2。验收：排序集成测；既有快照测试有意更新且注明原因。

## PR 拆分建议

- 默认**单 PR**（T1→T2→T3→T4 一并），commit message 前缀
  `feat(review): RFC-078 评审节点本轮开始时间展示修正`。
- 若 T5（排序）纳入且改动既有快照面较大，可拆为第二 PR
  `feat(review): RFC-078-T5 时间线按本轮锚点排序`，分别立 PR 并在本文件标注。

## 验收清单（对应 proposal AC）

- [x] AC-1 awaiting_review 行展示锚点 = 当前 pending doc_version.created_at（T2/T3）
- [x] AC-2 approve 行锚点 = 被批准版 created_at；时长为人工等待口径并标注（T2/T3）
- [x] AC-3 无 pending / 无 doc_version 回退 started_at 不崩（T1/T2）
- [x] AC-4 回归样本 `01KT1HDYV6RA8EJGY5BSE20MH9` 形态：reuse-in-place 行锚点落在最终版本产出之后（review-round-start.test.ts）
- [x] AC-5 review 详情/列表/历史下拉时间显示不回归（既有 2238 前端测试全绿，未触 `/api/reviews/*`）
- [x] AC-6 纯函数单测（backend 11）+ 序列化集成（backend 3）+ 前端 helper（5）齐备
- [x] AC-7 无 schema migration（方案 A）
- [x] `bun run typecheck && bun run test && bun run format:check` + lint 全绿（backend 3018 / frontend 2238）；推后查 CI

> T0 裁决：**Option A + 纳入排序（US-3）**。T5 排序已实现并入主 commit（`compareNodeRunsForTimeline`，仅排序键改 review 行锚点、不动 `started_at`）。单 PR 交付。

## STATE.md 同步

- 落档时已在 STATE.md 顶部追加「进行中 RFC：RFC-078」行。
- 完工后：本 plan 各项打勾、`design/plan.md` RFC 索引状态 Draft→Done、STATE.md 已完成区加一行。
