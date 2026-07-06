# RFC-142 任务分解

单 RFC 单 PR；commit 前缀 `feat(review): RFC-142 评审历史信息全量回显`。
依赖：无（建立在 RFC-005/013/079/099/129 已落地代码上）。

## 子任务

### RFC-142-T1 后端轮端点 + G4 修复（shared + backend）

- `packages/shared/src/schemas/review.ts`：`ReviewRoundMemberSchema` /
  `ReviewRoundSummarySchema` + type export（design §3.1）。
- `packages/backend/src/services/review.ts`：
  - 抽取 `buildDocumentSummary`（现 `getReviewDetail` documents 循环体 `review.ts:1109-1131`），
    `getReviewDetail` 与轮成员构造共用——不 fork（[project_dedup_commonization_audit] 缝合原则）；
    已决策成员 commentCount 改走 `parseArchivedComments(commentsJson).length`（live 行已删，
    现 documents 构造对已决策轮数 live 表恒 0——顺带修正并锁测试）。
  - 纯函数 `groupDocVersionRounds` 导出（分组/排序/轮级派生，design D3/D4）。
  - `listReviewRounds(db, appHome, nodeRunId)`。
  - G4：多文档已决策轮取最高代（design D5）。
- `packages/backend/src/routes/reviews.ts`：`GET /api/reviews/:nodeRunId/rounds`
  （`ensureReviewVisible` 同门）。
- 测试（同 commit）：design §6.1-6.4（`rfc142-review-rounds.test.ts` + G4 先红后绿回归）。

### RFC-142-T2 决策信息块（frontend）

依赖 T1 仅类型（组件本身消费既有 DocVersion payload）。

- `components/review/ReviewDecisionInfo.tsx` 新公共组件（design D1/D2；复用
  AttributionChip / status-chip 既有样式，不新造 chrome）。
- `routes/reviews.detail.tsx`：当前视图 + 历史 `?version=` 视图接入，替换
  `review-detail__decider` 行（`reviews.detail.tsx:446-459`）。
- i18n：design §3.4 的 `reviews.decisionInfo.*` key（zh-CN 类型段 + 取值段、en-US）。
- 测试（同 commit）：design §6.5-6.6。

### RFC-142-T3 多文档分轮历史视图（frontend）

依赖 T1（rounds 端点）+ T2（决策信息块组件）。

- `routes/reviews.detail.tsx`：`validateSearch` 增 `round`；多文档分支透传
  `historicalRoundKey`（design D6）。
- `components/review/MultiDocReviewView.tsx`：rounds query + 历史轮只读模式（design D7：
  成员导航切该轮 members、全员走 `/versions/:vid` 懒加载、accept/not_accept 与轮决策按钮隐藏、
  只读横幅 + `<ReviewDecisionInfo>`、未知 roundKey 回落）。
- `routes/reviews.tsx`：`HistoryRows` 接 `isMultiDoc`，多文档渲染轮行（design D9 轮号 =
  1-based 序号）。
- `hooks/useTaskSync.ts`：review.\* 失效追加 rounds key（design D8）。
- i18n：`reviews.roundLabel` 等轮次 key。
- 测试（同 commit）：design §6.7-6.8。

### RFC-142-T4 收口

- `design/plan.md` RFC 索引状态 Draft → Done；`STATE.md` 顶部进行中行移除 + 已完成表加行。
- 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` +
  binary smoke（[feedback_prepush_gate_includes_lint]）；前端 vitest；推后查 GitHub Actions
  （[feedback_post_commit_ci_check]）。
- Codex 实现门 review，findings 修完再宣布完成。

## 验收清单

- [ ] proposal §验收标准 1-6 全过
- [ ] G4 回归先红后绿留档（测试文件头注明 RFC-142 + 混代场景）
- [ ] 已决策轮成员 commentCount 计冻结评论（T1 顺带修正）有正向断言
- [ ] 单文档 `?version=`、多文档当前轮、agent prompt 注入三条既有路径行为不变（回归跑绿）
- [ ] 新组件/新 key 无硬编码中文/英文散落（i18n 双语齐）
