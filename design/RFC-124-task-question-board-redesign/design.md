# RFC-124 — 技术设计

## 0. 设计决策汇总

| # | 决策 | 取舍 |
|---|------|------|
| D1 | 布局=**方案 A 精修横向看板**（阶段=泳道列，列加底色/边框，列宽≈296px） | 用户拍板；接受横向滚动 |
| D2 | 抽**公共 `components/Card.tsx`** + `.card*` 样式（header/body/footer 槽 + interactive/highlighted），**本 RFC 仅看板接入** | 复用优先；血缘半径限看板 |
| D3 | 卡内动作按钮**统一 `btn--sm`**，`ConfirmButton` 传 `size="sm"` | 修按钮尺寸混用 + 全尺寸 bug |
| D4 | 顶部三段控件合并为**单行工具栏**（左过滤 chip / 右动作区） | 修控件错位 |
| D5 | **保留** `.task-questions__answer` / `.task-questions__meta` 类名 + 卡内 DOM 顺序（标题→答案→meta） | 守 RFC-120 回归锁 |
| D6 | **不新增 i18n key**、不改后端/API/数据 | 纯前端视觉，零行为回归 |

## 1. 新增公共原语 `components/Card.tsx`

设计系统盘点确认整仓**无公共 Card**；最接近的优质参考是 `.clarify-question`（styles.css:7301）。按仓库《Frontend UI consistency》「新组件初版就要考虑被复用」，原语初版即做成通用三槽卡片。

```tsx
// packages/frontend/src/components/Card.tsx
import type { ReactElement, ReactNode } from 'react'

export interface CardProps {
  /** 可选头部槽（如选择 checkbox / 角标），渲染在 body 之上。空则不渲染该 div。 */
  header?: ReactNode
  /** 主体内容（标题 / 答案 / meta…）。 */
  children: ReactNode
  /** 可选底部动作槽，带上分隔线。空则不渲染该 div。 */
  footer?: ReactNode
  /** hover 反馈（accent 边框 + 轻阴影）。默认 false。 */
  interactive?: boolean
  /** accent 着色背景+边框（如选中态）。默认 false。 */
  highlighted?: boolean
  /** 追加到标准 .card 链后的额外类名。 */
  className?: string
  'data-testid'?: string
}

export function Card(props: CardProps): ReactElement {
  const classes = ['card']
  if (props.interactive === true) classes.push('card--interactive')
  if (props.highlighted === true) classes.push('card--highlighted')
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  const hasHeader = props.header != null && props.header !== false
  const hasFooter = props.footer != null && props.footer !== false
  return (
    <div className={classes.join(' ')} data-testid={props['data-testid']}>
      {hasHeader && <div className="card__header">{props.header}</div>}
      <div className="card__body">{props.children}</div>
      {hasFooter && <div className="card__footer">{props.footer}</div>}
    </div>
  )
}
```

**契约要点（Codex 关注）**：
- `data-testid` 落在 `.card` 根 div → 看板传 `tq-card-{id}` 时 testid 不丢。
- 顺序固定 header→body→footer；看板把「标题→答案→meta」全部放进 `children`(body)，**答案/meta 顺序锁在 body 内**天然满足。
- **槽位 `undefined` / `null` / `false` 都按"未提供"不渲染**（用 `!= null && !== false`，`!= null` 同时覆盖 null/undefined）→ 常见写法 `header={cond && node}`（cond 假时为 `false`）也安全，不会留空 `.card__header`/`.card__footer` 多余 gap；调用方无需被迫写 `cond ? x : undefined`（**Codex P3 fold**）。

## 2. 新增 `.card*` 样式（token 化，对齐 `.clarify-question`）

```css
.card {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-4);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.card--interactive:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  box-shadow: var(--shadow-sm);
}
.card--highlighted {
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.card__header { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.card__title  { font-size: var(--font-md); font-weight: 600; color: var(--text); line-height: 1.45; }
.card__body   { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.card__footer { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
```

## 3. 升级 `.task-questions*` 看板样式（方案 A）

重写 `.task-questions*` 看板样式——位于 `styles.css` 的**两段**：11304–11363（board/col/meta/answer/actions）+ 11375–11409（wrap/toolbar/filter/dispatch/select）。**中间 11365–11372 的 `.clarify-handler` 块原样保留、勿删**（它属 RFC-120 D12 反问页、不在本 RFC 范围；故不能笼统"替换 11304–11410"——会误删它，**Codex P2 fold**）。`.task-questions__card` 旧扁平卡 CSS 删除（由 `.card` 接管）。要点：泳道列、单行工具栏、过滤 pill、流向 meta、答案引用块。

```css
/* 外层 + 单行工具栏（合并原 toolbar/filter/dispatch-bar 三段） */
.task-questions-wrap { display: flex; flex-direction: column; gap: var(--space-4); }
.task-questions__toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-3); flex-wrap: wrap;
}
.task-questions__filter { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.task-questions__actions { display: flex; gap: var(--space-2); align-items: center; }

/* 过滤 chip：仍是 <button>（role=button 锁），样式做成 pill 与右侧动作按钮在视觉上分型 */
.task-questions__filter-chip {
  border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  border-radius: var(--radius-pill); padding: 3px 12px; font-size: var(--font-sm);
  line-height: 1.3; cursor: pointer; white-space: nowrap;
}
.task-questions__filter-chip:hover { border-color: var(--border-strong); color: var(--text); }
.task-questions__filter-chip--active {
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
  border-color: var(--accent); color: var(--accent); font-weight: 600;
}

/* 泳道看板 */
.task-questions { display: flex; gap: var(--space-3); overflow-x: auto; padding-bottom: var(--space-2); align-items: flex-start; }
.task-questions__col {
  flex: 0 0 296px; width: 296px; display: flex; flex-direction: column; gap: var(--space-3);
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: var(--space-3);
}
.task-questions__col-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.task-questions__count { font-size: var(--font-sm); color: var(--muted); }
/* 泳道内卡片用 --panel，与列底 --bg 形成"卡片浮起"层次（明暗皆成立）。
   :not(.card--highlighted) 让 staged 勾选选中态的 accent 着色背景不被本规则覆盖（Codex P2 fold）。 */
.task-questions__col .card:not(.card--highlighted) { background: var(--panel); }

/* 流向 meta：来源 → 处理（替换原 dl grid） */
.task-questions__meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); font-size: var(--font-sm); margin: 0; }
.task-questions__meta-pair { display: inline-flex; align-items: center; gap: var(--space-1); white-space: nowrap; }
.task-questions__meta-k { color: var(--muted); }
.task-questions__meta-v { color: var(--text); font-weight: 500; }
.task-questions__meta-flow { color: var(--muted); }

/* 答案引用块（紧贴问题、排在 meta 前——RFC-120 布局锁） */
.task-questions__answer {
  font-size: var(--font-sm); color: var(--text); background: var(--bg);
  border-left: 2px solid color-mix(in srgb, var(--accent) 50%, var(--border));
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: var(--space-2) var(--space-3); line-height: 1.5;
}

/* 选择 checkbox（staged 卡头部） */
.task-questions__select { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--font-sm); color: var(--muted); cursor: pointer; }
.task-questions__select > input[type='checkbox'] { margin: 0; cursor: pointer; accent-color: var(--accent); }
```

> 注：`.task-questions__col .card { background: var(--panel) }` 依赖列底 `var(--bg)`。`--bg`(浅 #f8f9fb / 暗 #15181d) 比 `--panel`(浅 #fff / 暗 #1c2028) 更"沉"，卡片自然浮起；已在明暗 repro 双验。

## 4. `TaskQuestionList.tsx` render 重写（保留全部锁）

只改 render 结构与 className，**不动任何 hooks / mutation / 派生逻辑 / 条件**。映射：

- 顶部：原 `toolbar` + `filter` + `dispatch-bar` 三块 → 一个 `.task-questions__toolbar`：
  - 左 `.task-questions__filter`（**保留 `data-testid="tq-node-filter"`**）内为过滤 `<button className="task-questions__filter-chip[ --active]">`（**保留 `tq-node-filter-{nodeId}`、文本 `{node} ({n})`**）。
  - 右 `.task-questions__actions`：批量下发 `<button className="btn btn--sm btn--primary" data-testid="tq-batch-dispatch">`（外层 wrapper 保留 `data-testid="tq-batch-dispatch-bar"`，仅 stagedShown>0 渲染）+ 新增问题 `<button className="btn btn--sm" data-testid="tq-add-question">`（deferred）。
- 每列：`.task-questions__col`（保留 `data-phase`）→ `.task-questions__col-head`（StatusChip + `.task-questions__count`）+ 卡片们。
- 每卡：`<Card data-testid={`tq-card-${e.id}`} interactive highlighted={phase==='staged' && selected.has(e.id)} header={…} footer={…}>`：
  - `header`（仅 staged）：`<label className="task-questions__select"><input type="checkbox" data-testid={`tq-select-${e.id}`} aria-label=… /> …</label>`
  - body（children，**顺序锁**）：
    1. `<div className="card__title">{questionTitle}</div>`
    2. `{answerSummary && <div className="task-questions__answer">{answerSummary}</div>}`（**类名锁 + 在 meta 前**）
    3. `<div className="task-questions__meta">` 来源 pair → flow「→」→ 处理 pair（designer 非终态时处理 pair 内嵌 `<Select ariaLabel={reassign}>`，否则 `<span className="task-questions__meta-v">`）（**类名锁**）
  - `footer`（动作，**全 `btn--sm`**）：回答/查看反问 `<Link className="btn btn--sm[ btn--primary|btn--ghost]" data-testid={`tq-answer-${e.id}`}>`（originNodeRunId!=null）、复制 `<button className="btn btn--sm btn--ghost" data-testid={`tq-copy-${e.id}`}>`（deferred && pending）、确认 `<ConfirmButton size="sm" .../>`（awaiting_confirm）、加入/移出待下发 `<button className="btn btn--sm" data-testid={`tq-stage-${e.id}`}>`（pending|staged）。

> 关键：footer 槽内全是 `<button>`/`<a class="btn">`，`within(card).getAllByRole('button')` 仍 >0；checkbox 在 header 槽，staged 卡有、其它无——`queryByRole('checkbox')` 锁满足。

## 5. `ConfirmButton` 复用

`ConfirmButton` 已支持 `size?: 'sm'`（`ConfirmButton.tsx:13,50`）；看板确认按钮补传 `size="sm"` 即从全尺寸降到 `btn--sm`。组件本身不改。

## 6. 与现有模块的耦合点

| 模块 | 影响 | 处理 |
|------|------|------|
| `routes/tasks.detail.tsx` | 仅 `<TaskQuestionList>` 调用，props 签名不变 | 不动 |
| `components/clarify/ClarifyQuestionHandler.tsx` | `import type { TaskQuestionEntry }` from TaskQuestionList | **类型导出保持**，不动 |
| `components/tasks/QuestionAuthorForm.tsx` | 由「+新增问题」打开的 Dialog（已用 Dialog+Form 原语） | 不动 |
| `styles.css` 全局 | 新增 `.card*`；`.card` 命名空间已确认空闲（0 占用） | 无冲突 |
| `.clarify-question*` 等其它卡片 | 不迁移 | 留后续专项 |

## 7. 失败模式 / 边界

- **横向溢出**：6 列超出标签宽度 → `.task-questions` `overflow-x:auto` 横向滚动（用户知情取舍）。
- **空列**：某阶段 0 卡 → 仅渲染泳道列头（StatusChip + 计数 0），列体空。沿用现状（PHASE_ORDER 全渲染）。
- **超长标题**：`.card__title` 自动换行（`line-height:1.45`、无 `nowrap`）。
- **meta 内 Select**：designer 非终态渲染 `<Select>`，其 popover 为 portal，不撑破卡片；`.task-questions__meta-pair` `white-space:nowrap` 仅作用于 k/v 文本对，不影响 Select。
- **暗主题**：全部走 token；泳道 `--bg`/卡片 `--panel` 层次明暗双验。
- **大量卡片**：列纵向堆叠 + 页面纵向滚动；列头可选 `position:sticky; top:0`（实现期视效果决定，非必须）。

## 8. 测试策略

### 8.1 必须不改判定即绿的 golden-lock（回归防护）
现有测试逐字守住——证明"只动视觉"：

- `task-question-list.test.tsx`：
  - testid：`task-questions-board`（空列表时 null）、`tq-card-{id}`、`tq-answer-{id}`（link + `href=/clarify/{runId}`）、`tq-stage-{id}`、`tq-select-{id}`、`tq-batch-dispatch`、`tq-node-filter`、`tq-node-filter-{nodeId}`。
  - role：`within(card).getAllByRole('button').length>0`；staged 卡 `getByRole('checkbox')`、pending/closed/awaiting_confirm 卡 `queryByRole('checkbox')===null`；`within(tq-node-filter).getAllByRole('button')`。
  - **class 锁**：`card.querySelector('.task-questions__answer')`（含答案文本）、`.task-questions__meta` 存在。
  - **顺序锁**：`answer.compareDocumentPosition(meta) & DOCUMENT_POSITION_FOLLOWING`（答案在 meta 前）。
  - 计数文本：`tq-node-filter-nodeA` 文本含 `2`。
- `task-detail-tabs.test.ts` / `task-detail-page-tabs.test.ts`：标签切换、`task-questions` pane 不变。
- `clarify-question-handler.test.tsx` / `question-author-form.test.tsx` / `launch-deferred-dispatch.test.ts`：不受影响（结构/契约不变）。

### 8.2 新增测试（test-with-every-change）
- `card.test.tsx`（新）：`Card` 原语单测——
  - 默认只渲染 `.card` + `.card__body`（无 `.card__header`/`.card__footer`）；
  - 传 `header`/`footer` 渲染对应 div；
  - `interactive`→`.card--interactive`、`highlighted`→`.card--highlighted`、`className` 追加、`data-testid` 落根 div；
  - body 内子节点顺序保持。
- `task-question-list.test.tsx` 增补 source-lock：
  - 卡内**无全尺寸按钮**——`awaiting_confirm` 卡的确认按钮带 `btn--sm`（断言 `confirm 按钮.className` 含 `btn--sm`），即 `ConfirmButton size="sm"` 已传；
  - 过滤项仍为 `<button>`（已被 role 锁覆盖，显式再断言一次）。

### 8.3 视觉验证（[feedback_frontend_visual_verify_repro]）
最小 repro HTML（链真实 `styles.css`）+ `python3 -m http.server` + Chrome 截图，**明暗双主题**核对最终 CSS（落地后用真实组件产物再核一次，不只 mockup）。

### 8.4 门槛
`bun run typecheck && 前端 vitest && bun run format:check` 全绿 → push → 查 CI（[feedback_post_commit_ci_check]）。Codex 实现 gate 过一轮。

## 9. Golden-lock 清单（实现期对照表）

| 锁 | 来源 | 守法 |
|----|------|------|
| `task-questions-board` / `tq-card-*` / `tq-answer-*`(link+href) / `tq-stage-*` / `tq-copy-*` / `tq-select-*`(checkbox) / `tq-add-question` / `tq-batch-dispatch(-bar)` / `tq-node-filter(-*)` | 各测试 | testid 原样落到对应元素 |
| 过滤项 = `<button>` 且文本含计数 | list test 204 | `.task-questions__filter-chip` 是 `<button>`，文本 `{node} ({n})` |
| 卡内动作 = `<button>`/`<a class=btn>` | list test 173/177 | footer 槽内全按钮 |
| staged 卡有 checkbox、其它无 | list test 234/257 | checkbox 仅 staged header 槽 |
| `.task-questions__answer` / `.task-questions__meta` 类名 | list test 196/197 | 类名保留 |
| DOM 顺序 答案→meta | list test 201 | body 内 答案 在 meta 前 |
| `TaskQuestionEntry` 类型导出 | ClarifyQuestionHandler import | 导出不动 |
