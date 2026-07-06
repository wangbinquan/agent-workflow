# RFC-142 评审历史信息全量回显（决策信息块 + 多文档轮次历史只读视图）

- 状态：Draft（2026-07-06 落档；同日用户三问拍板 scope）
- 触发：用户问「现在查看历史 review 的时候，会回显历史评审的信息吗」；确认现状缺口后拍板
  「都要回显——在评审页面，要能看到当时给这个版本文档的评审信息」。三问裁决：
  1. **只改 UI，agent 注入不动**（重跑 prompt 维持只带最新一轮，RFC-005 `buildReviewPromptContext` 现状）；
  2. 驳回原因在**详情视图**回显（历史只读视图 + 当前视图的已决策版本都显示）；
  3. 多文档评审（RFC-079）做**按轮次只读视图**。

## 背景

### 已回显的部分（本 RFC 不动）

- `/reviews` 列表页（RFC-005 T26 + RFC-013）：pending / all / approved / rejected / iterated 五个
  筛选 tab（`reviews.tsx:32`）；每行可展开列出全部 doc_versions（决策 chip + 时间 + Open 链接，
  `reviews.tsx:279-305`）。
- 单文档历史只读视图（RFC-013，`/reviews/$nodeRunId?version=<vid>`）：归档正文 + 决策时刻冻结的
  评论（`doc_versions.commentsJson`，决策后 live `review_comments` 行即删，归档 JSON 是唯一事实源
  ——`services/review.ts:1212-1250`）+ 只读横幅（vN + decision）+ 决策人 AttributionChip
  （RFC-099 D7，`reviews.detail.tsx:446-459`）。
- 当前视图的 diff 模式：左侧为上一轮已决策版本（RFC-005 PR-E / RFC-010）。

### 缺口（用户「都要回显」所指）

- **G1 驳回原因不显示**：`doc_versions.decision_reason` 入库（rejected = 用户填的退回原因；
  superseded = 系统 `'upstream-refreshed'`，`review.ts:531/1649-1656`）且 API 已返回
  （`rowToDocVersion` `review.ts:2538`、`DocVersionSchema` `shared/schemas/review.ts:159`），但
  前端**任何位置都没有渲染**。退回原因只进了 agent 重跑 prompt，评审页面上人看不到。
- **G2 多文档轮无历史入口**：路由分支在 `documents` 非空时一律渲染 MultiDocReviewView 并忽略
  `?version=`（`reviews.detail.tsx:55-65`）；`getReviewDetail` 只取 pending 成员、否则最高
  `reviewIteration` 的成员（`review.ts:1099-1138`）。更早轮次（更早 `round_generation` 代）的
  文档、当时的逐篇评论与 accepted/not_accepted 选择完全无法回看。
- **G3 多文档展开行的 v 序号误导**：`versionIndex` 按 `(reviewNodeRunId, sourcePortName,
  itemIndex)` 逐项独立递增（`review.ts:766-785`），列表展开对多文档轮显示 v1,v1,v1,v2,v2,…
  的平铺行，没有「轮」的概念，无法对应「哪一轮评审」。
- **G4（顺带修复）当前轮选择可混代**：`getReviewDetail` 选「已决策轮」只按最高 `reviewIteration`
  过滤（`review.ts:1100-1106`），不看 RFC-129 的 `round_generation`。upstream-refresh 会在同一
  `reviewIteration` 留下两代（superseded 旧代 + 新代），此时旧代 superseded 行会混进
  documents 列表（同 itemIndex 出现两行）。分轮逻辑落地后当前轮应取**最高代**。

## 目标

1. **决策信息块**：评审详情页（单文档当前视图 + 单文档历史只读视图 + 多文档轮视图）对已决策
   版本/轮次显示「决策信息」：决策结果、决策人（含角色快照）、决策时间、退回原因
   （rejected 显示用户填的原因；superseded 显示系统作废说明；iterated 不重复显示——其意见即
   页面已呈现的冻结评论）。
2. **多文档轮次历史只读视图**：历史按 `reviewIteration` + `round_generation` 分轮；
   `/reviews` 列表展开对多文档评审改为**轮行**（第 n 轮 + 轮决策 chip + 时间 + Open）；
   点开历史轮以只读 MultiDocReviewView 呈现该轮全部文档——各篇当时的正文、冻结评论、
   accepted/not_accepted 选择、轮决策 + 原因；决策/选择/评论写入全部禁用。
3. **G4 修复**：多文档当前视图「已决策轮」取最高代，refresh 留下的 superseded 旧代不再混入。

## 非目标

- **agent 重跑 prompt 注入不动**（用户拍板）：`buildReviewPromptContext` 仍只带最新一轮
  用户决策的驳回原因/评论；不做多轮历史注入。
- 不展示 `promptSnapshot`（生成该版的 prompt 快照，另行考虑）。
- 不做跨 node_run 的评审历史聚合——轮列表与 `/versions` 端点同样 scoped 单个 `nodeRunId`。
- 单文档 `?version=` 只读视图行为不变（仅叠加决策信息块）。
- 零 schema 变更 / 零 migration：`round_generation`（migration 0070）已在库，本 RFC 只是把它
  读出来做分组；不新增列。

## 用户故事

- **US-1**：评审员在 `/reviews` 打开一条已驳回的历史版本，除正文与冻结评论外，还能看到
  「谁在什么时间驳回、退回原因是什么」——不用去问当事人或翻 agent prompt。
- **US-2**：一个多文档评审经历了 3 轮 iterate。评审员展开列表行看到「第 1/2/3 轮」三行，
  点开第 1 轮，看到当时 5 篇文档、每篇的评论与接受/不接受选择、该轮的决策与意见——和当时
  评审时看到的一致（只读）。
- **US-3**：上游 refresh 把一轮 pending 作废重铸后，当前视图只显示新代文档；被作废的旧代
  在轮列表里以「已作废」轮出现，点开可回看，且能看到「上游产出已刷新，本版已被系统作废」。

## 验收标准

1. 单文档详情页：rejected 版本（当前或历史视图）显示退回原因全文；superseded 版本显示系统
   作废说明；iterated 版本显示决策人/时间但无原因行；pending 版本无决策信息块。
2. `/reviews` 列表展开：多文档评审渲染轮行（轮号、轮决策 chip、文档数、时间、Open）；单文档
   评审保持 v1..vN 行为不变。
3. 多文档历史轮只读视图：`?round=<key>` 呈现该轮全部文档（正文 + 冻结评论 + 选择状态 +
   决策信息块），无 approve/iterate/reject 按钮、无接受/不接受按钮、无评论写入口；未知
   roundKey 提示后回落当前轮（对齐 RFC-013 未知 version 的处理）。
4. 多文档当前视图在 refresh 场景不再混代（G4 回归测试先红后绿）。
5. ACL 与现有评审读端点同门：任务不可见者 403 `task-not-visible`；不存在的 nodeRunId 404。
6. `bun run typecheck && bun run test && bun run format:check` 全绿；前端 vitest 全绿。
