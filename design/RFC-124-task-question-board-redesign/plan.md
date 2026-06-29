# RFC-124 — 任务分解

单 PR 交付（纯前端视觉重做，无后端/migration）。commit 前缀：`feat(rfc): RFC-124 任务「问题」看板视觉重做`。

## 子任务

| ID | 任务 | 依赖 | 文件 |
|----|------|------|------|
| RFC-124-T1 | 新增公共原语 `Card.tsx`（header/body/footer 槽 + interactive/highlighted + data-testid/className 透传） | — | `packages/frontend/src/components/Card.tsx` |
| RFC-124-T2 | 新增 `.card*` 样式（token 化，对齐 `.clarify-question`） | — | `styles.css` |
| RFC-124-T3 | 替换 `.task-questions*` 看板样式（泳道列 + 单行工具栏 + 过滤 pill + 流向 meta + 答案引用块；删旧扁平卡 CSS） | T2 | `styles.css` (11304–11410 段) |
| RFC-124-T4 | 重写 `TaskQuestionList.tsx` render：接入 `<Card>`、合并工具栏、统一 `btn--sm`、`ConfirmButton size="sm"`、**保全 testid/role/类名/顺序锁** | T1,T3 | `TaskQuestionList.tsx` |
| RFC-124-T5 | `Card` 单测 `card.test.tsx` | T1 | `packages/frontend/tests/card.test.tsx` |
| RFC-124-T6 | `task-question-list.test.tsx` 增补 source-lock（确认按钮 `btn--sm` / 过滤 `<button>`）；跑全量看板相关测试确认不改判定即绿 | T4 | `packages/frontend/tests/task-question-list.test.tsx` |
| RFC-124-T7 | 明暗双主题最小 repro 视觉核对（真实组件产物截图，非 mockup） | T3,T4 | scratchpad repro |
| RFC-124-T8 | 索引/状态同步：`design/plan.md` RFC 索引 RFC-124 改 Done + `STATE.md` 收尾 | T1–T7 | `design/plan.md`, `STATE.md` |

## PR 拆分建议

单 PR。T1–T6 为代码主体（组件+样式+渲染+测试一并落，遵守 test-with-every-change），T7 为 push 前视觉验证，T8 为落档。

## 验收清单

- [ ] `Card.tsx` 通用三槽原语 + 单测绿。
- [ ] 卡内动作按钮全 `btn--sm`；`ConfirmButton` 带 `size="sm"`（全尺寸 bug 消除）。
- [ ] 顶部单行工具栏（左过滤 chip / 右动作区）。
- [ ] 泳道列 + 升级卡片，明暗双主题对齐（repro 双截图核对）。
- [ ] **golden-lock 全绿、不改判定**：`task-question-list` / `task-detail-*tabs` / `clarify-question-handler` / `question-author-form` / `launch-deferred-dispatch`（testid/role/`.task-questions__answer`/`.task-questions__meta` 类名/答案→meta 顺序）。
- [ ] 新增 source-lock：确认按钮 `btn--sm`、过滤项 `<button>`。
- [ ] `bun run typecheck && 前端 vitest && bun run format:check` 全绿。
- [ ] Codex 设计 gate（文档）+ 实现 gate（代码）各过一轮、findings fold。
- [ ] push 后 CI 全绿（lint+typecheck+test ×2 OS + 单二进制 smoke + Playwright e2e）。

## 非目标 / 后续

- **后续专项**：把 `.clarify-question` / `.memory-row` / `.resource-list__item` 等现有卡片迁移到公共 `Card` 原语（本 RFC 不动，避免血缘外溢 + 不碰它们的密集测试）。
- 看板布局保持横向（方案 A）；纵向分组（方案 B）已被用户否决，不做。
