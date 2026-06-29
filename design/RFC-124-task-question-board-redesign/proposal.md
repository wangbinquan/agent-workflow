# RFC-124 — 任务「问题」看板视觉重做（精修横向看板 + 公共 Card 原语）

状态：Draft（待用户批准进入实现）
触发：2026-06-29 用户报「任务的问题界面太丑了，按钮样式也不统一，卡片看着也丑」+ 两轮 AskUserQuestion 拍板（布局=方案 A 精修横向看板 / 卡片=抽公共 Card 原语、本 RFC 只用在看板）。

## 1. 背景

任务详情页「问题」标签页渲染 RFC-120 的 `TaskQuestionList` 看板（`packages/frontend/src/components/tasks/TaskQuestionList.tsx`，样式 `.task-questions*` 见 `styles.css` 11304–11410）。该看板是功能交付期堆出来的，视觉一直没有打磨，存在三处明确的「丑/不统一」：

1. **同一张卡片里按钮三种尺寸混用**——`task-questions__actions` 行内：「去回答/复制/查看反问」用 `btn--xs`（padding 2px 8px），「加入/移出待下发」用 `btn--sm`（4px 10px），而「确认」走 `ConfirmButton` 时**漏传 `size="sm"`**（`TaskQuestionList.tsx:398-401`），渲染成全尺寸 `.btn`（8px 14px）。一行里大中小三种按钮并排，是「按钮样式不统一」最直接来源。

2. **顶部三排控件错位**——`.task-questions__toolbar`（新增按钮，右对齐）、`.task-questions__filter`（筛选 `btn--xs` chip）、`.task-questions__dispatch-bar`（批量下发 `btn--sm`）是三个独立堆叠的 div，按钮尺寸 xs/sm 混用、对齐不一，像三段没拼好的工具条。

3. **卡片扁平拥挤**——`.task-questions__card` 仅 1px 边框、8px 圆角、8/10 内边距、无 hover、无层次、无阶段身份；与相邻「反问答题页」`.clarify-question` 卡片（16px 内边距、10px 圆角、focus 高亮、引用块）明显不在一个质感档位，看板像没做完。

> 现状截图（明/暗）与两套重做方案（A 精修看板 / B 纵向分组）的可点 repro 截图已在落档对话中比对；用户选定 **方案 A**。

根因不是单点 bug，而是**看板从未对齐设计系统、也没有可复用的卡片原语**——整仓没有公共 `Card` 组件（设计系统盘点确认），各功能各写一套卡片 CSS（`.clarify-question` 16/12、`.resource-list__item` 12/16、`.task-questions__card` 8/10、`.memory-row` token 化），看板恰好是最粗糙的一份。修它属于仓库《Frontend UI consistency》明令的「复用优先」范畴（违反复用按产品级 bug 处理）。

## 2. 目标

- **G1 统一按钮**：卡内所有动作按钮统一为单一尺寸（`btn--sm`），含修掉 `ConfirmButton` 漏 `size` 的全尺寸 bug；顶部工具栏控件尺寸/对齐统一。
- **G2 卡片升级**：卡片对齐 `.clarify-question` 同级质感（token 化内边距/圆角、hover 反馈、答案引用块、清晰的 来源→处理 流向 meta）。
- **G3 抽公共 Card 原语**：新增可复用 `components/Card.tsx`（`header`/`body`/`footer` 槽 + `interactive`/`highlighted` 修饰 + `.card*` token 化样式），**本 RFC 仅看板接入**；clarify/memory/resource 等现有卡片留**后续专项**迁移（写进 plan 的「非目标/后续」）。
- **G4 精修横向看板（方案 A）**：保留「阶段=列」的看板泳道观感，但列升级为带底色/边框的泳道、列宽加大、卡片换到 `.card` 原语、顶部工具栏合并成一行；明暗双主题对齐。
- **G5 零行为/契约回归**：所有 testid/role、`.task-questions__answer`/`.task-questions__meta` 类名锁、卡内 DOM 顺序锁（标题→答案→meta）逐字守住；现有 `task-question-list.test.tsx` 等不改判定继续全绿。

## 3. 非目标

- **不改任何后端 / API / DB / migration / 数据流**——纯前端视觉与组件结构。
- **不改看板的业务行为**——阶段列集合、过滤、暂存/批量下发/确认/改派/复制/新增、`awaiting_human` gate、deferred 门控等逻辑一字不动。
- **不切换布局范式**——保留横向看板（用户明确否决方案 B 纵向分组）；**接受横向滚动**：6 列在详情页标签宽度放不下时横向滚动，是用户知情选择的取舍。
- **不迁移其它页面的卡片到新 Card**——clarify/memory/resource 卡片本 RFC 不动，留后续专项（避免血缘半径外溢、避免动它们的密集测试）。
- **不动反问答题页 `/clarify`**（`ClarifyQuestionHandler` 仅复用 `TaskQuestionEntry` 类型，类型导出保持不变）。
- **不新增 i18n key**（复用现有 `taskQuestions.*` 文案；计数文本格式 `{node} ({n})` 保持，避免动断言）。

## 4. 用户故事

- 作为任务成员，我打开任务「问题」标签页，看到的看板按钮**尺寸一致**、卡片**有质感有层次**、来源→处理一眼可读，不再像半成品。
- 作为开发者，我之后要在别的页面做卡片时，能直接 `import { Card }`，而不是再 copy 一份卡片 CSS。
- 作为维护者，我重构看板视觉后跑 `task-question-list.test.tsx`，**不需要改任何断言就全绿**——证明只动了视觉、没动行为。

## 5. 验收标准

1. 看板顶部为**单行工具栏**：左侧节点过滤 chip（仍是 `<button>`、文本含计数），右侧动作区（批量下发 when staged>0 / 新增问题 when deferred），尺寸统一。
2. 每张卡片：`<Card>` 渲染，16px token 内边距、10px 圆角、hover 边框/阴影反馈；标题→（答案引用块）→meta（来源→处理流向）顺序；动作按钮**全部 `btn--sm`**、`确认` 为 `ConfirmButton size="sm"`。
3. 列为带底色/边框的泳道（列头 = StatusChip + 计数），列宽 ≈ 296px，明暗双主题对齐。
4. `Card.tsx` 为通用原语：`header`/`footer` 槽可空、`interactive`/`highlighted` 修饰、`data-testid`/`className` 透传；带单测。
5. **所有 golden-lock 守住**（见 design §测试策略）：`task-question-list.test.tsx` / `task-detail-*tabs` / `clarify-question-handler` / `question-author-form` / `launch-deferred-dispatch` 全部不改断言即绿。
6. 新增源码层 source-lock：卡内动作按钮不出现全尺寸 `.btn`（即 `ConfirmButton` 必带 `size="sm"`）；过滤项仍为 `<button>`。
7. 门槛全绿：`bun run typecheck && 前端 vitest && bun run format:check`；明暗主题最小 repro 视觉核对；CI 全绿（[feedback_post_commit_ci_check]）。
8. Codex 设计 gate（本 RFC 文档）+ 实现 gate（代码）各过一轮、findings fold（[feedback_codex_review_after_changes]）。
