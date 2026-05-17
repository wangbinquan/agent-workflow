# 前端 UX 一致性审计

**审计日期**：2026-05-17
**审计范围**：`packages/frontend/src/{routes,components,styles.css,i18n}` 全量；不含 e2e。
**目的**：在 RFC-032 导航重构进入实现前，先盘清各页面 UX 一致性缺口，让用户决定"扩 RFC-032 包含 UX 一致化"还是"先合并 RFC-032、UX 一致化另开 RFC-033"。
**作者**：Claude（在 agent-workflow 工作树执行 grep / 抽样 read 综合）。

---

## TL;DR

骨架已经相当一致，但**视觉细节**有 9 处明显缺口：4 套并存的"状态指示"系统、2 个被使用但**实际未定义** CSS 的按钮变体（`.btn--ghost` / `.btn--xs`，目前在 5 处静默退化）、4 套独立实现的 tab 视觉、表单 helper（`<Form>`）仅 35% 的路由采用、列表/表格采用率不均、对话框 / 浮层每次都重写、loading / empty 状态零组件化、详情页二级结构（pane / split-pane）没有标准件。建议把它们做成 RFC-033 独立处理（先 audit 已经产出，落地分 3 阶段、每阶段一个 PR），而 RFC-032 导航重构维持原 scope 不动。详见 §5「推荐路径」。

---

## 1. 已经具备的一致性（强项，**不要动**）

- **路由层 page header**：`.page__header` / `.page__actions` / `.page__section` 在所有业务路由（17/20）都有采用——除 `__root` / `auth` / `index` 三个非业务路由外，100% 覆盖。
- **基础按钮**：`<button>` 全部都带 `.btn` 类（grep 结果 0 个裸 button），没有"用 div 当按钮"的反模式。
- **二次确认**：`ConfirmButton` 在 10+ 路由广泛使用（plugins / agents / skills / tasks / mcps / workflows 等），删除 / 解绑场景已经统一。
- **错误条**：`ErrorBanner` 在 6 个列表路由（workflows / plugins / tasks / agents / skills / mcps）+ ImportZipPanel 使用，结构一致（红底 + icon + 重试按钮）。
- **CSS 变量主题化**：`--bg / --panel / --border / --text / --muted / --accent / --danger` 这套 token + `:root[data-theme='dark']` 暗色覆写一直执行得很彻底；几乎所有组件都用 `color-mix(in srgb, var(--accent) X%, transparent)` 这种基于 token 的色彩派生，没有散落的硬编码 hex。
- **i18n 全覆盖**：`zh-CN.ts` / `en-US.ts` 接 `Resources` 接口编译期类型检查，新 key 漏翻会编译失败，没有"双语漂移"问题。

---

## 2. 缺口分类（按修复成本从低到高排序）

### 2.1 [P0] 被使用但 CSS 未定义的按钮变体 — `.btn--ghost` / `.btn--xs`

`styles.css` 只定义 `.btn / .btn--armed / .btn--danger / .btn--primary / .btn--sm`。

但代码里这些类名被使用：

| 类 | 调用点 |
| --- | --- |
| `btn--ghost` | `routes/clarify.detail.tsx:388`、`routes/mcps.tsx:140`、`routes/mcps.tsx:247`、`components/launch/UploadPicker.tsx:92`、`components/mcps/McpInventoryPanel.tsx:100` |
| `btn--xs` | `components/launch/UploadPicker.tsx:92` |

**后果**：5 处按钮**静默退化**到 `.btn` 默认样式，作者期望的"幽灵 / 超小"视觉根本没出现，没人发现是因为代码 review / e2e 不会盯视觉细节。

**修法**：补 `.btn--ghost`（透明底 + accent 文字 + hover 浅底）与 `.btn--xs`（12px 字 + 4×6 padding）两个变体，或把 5 处调用改回已定义变体。建议**补 CSS**，因为 ghost / xs 在 design 表达里有用。

### 2.2 [P0] 4 套并行的"状态指示"系统

| 系统 | 形态 | 变体 | 用处 | 实现位置 |
| --- | --- | --- | --- | --- |
| `.status-chip` | 圆角胶囊 + 文字 | 5 色（amber / blue / gray / green / red） | task 状态、clarify 状态、review 状态 | `styles.css:561+` + `TaskStatusChip.tsx` |
| `.status-badge` | 同上但视觉略小 | 4 变体（danger / muted / success / warn） | inventory（agent / skill / plugin / mcp 表内行级状态） | `styles.css` + `components/inventory/StatusBadge.tsx` |
| `.mcp-probe-chip` | 圆角胶囊 + dot + 文字 | 4 态（unknown / probing / ok / error） | MCP 接口探测结果 | `styles.css` + `McpProbeStatusChip.tsx` |
| `.chip` | 通用胶囊（不一定是状态） | `--active` / `--external` / `--managed` / `--tight` | 标签 / 来源 / 属性 chip | `styles.css:561+` |

**后果**：用户看到的"状态"视觉语言**多达 4 种**，不同页面的同一概念（例如"成功"）可能是 `.status-chip--green` 或 `.status-badge--success` 或 `.mcp-probe-chip--ok`，配色权重和圆角都不完全对齐；扩展第 5 种状态时新作者会陷入"我该用哪个"。

**修法**：合并到一套 `.status-chip` 体系，把 `.status-badge` / `.mcp-probe-chip` 的语义映射进去（success → green，error → red 等）；keep `.chip` 作为非状态用途（filter chip / tag chip）独立存在。组件层把 `TaskStatusChip` / `McpProbeStatusChip` / `StatusBadge` 收敛成单一 `<StatusChip kind="success|warn|danger|info|muted" size="sm|md" />`。

### 2.3 [P1] 4 套独立 tab 实现

| CSS class space | 用处 |
| --- | --- |
| `.tabs / .tabs__tab / .tabs__tab--active` | 通用（agent 详情 / settings / skills 详情 / task 详情） |
| `.inspector__tabs` | 节点 inspector 抽屉（workflow editor 右抽屉） |
| `.agent-import__tabs` | agent.md 导入对话框 |
| `.repo-source-tabs` | launcher 选择仓库源（已有 / Git URL） |

`.tabs` 与 `.inspector__tabs` 视觉接近但 padding / border 不同；`.agent-import__tabs` / `.repo-source-tabs` 是另起炉灶。

**后果**：tab 看上去"长得一样但又不太一样"，新人改一处不知道是否需要同步另外 3 处。

**修法**：通用 `.tabs` 升级为支持 `--inline / --inspector / --segment` 三个 modifier，inspector / agent-import / repo-source 改用 modifier；新 tab 一律走 `.tabs`。

### 2.4 [P1] 表单 helper `<Form>` 仅 35% 覆盖

`components/Form.tsx` 导出 5 个标准件（`Field` / `TextInput` / `NumberInput` / `TextArea` / `Switch`），但只有 5 个路由采用：

| 已采用 | 未采用 |
| --- | --- |
| skills.new, skills.detail | agents.new, agents.detail |
| workflows.launch, workflows.edit | plugins.new, plugins.detail |
| settings | mcps.new, mcps.detail |
| + 6 个 components | reviews.detail, repos, clarify.detail, tasks.detail（含表单 fragment） |

**后果**：未采用的路由用 `<label>` + `<input>` + 手写 `.form-row` / `.form-grid` 直接拼，间距 / label 字号 / error 文案位置因人而异。

**修法**：把未采用的 7 个路由迁移到 `<Form>` 标准件（无需后端改动；纯 jsx + className 替换），每次迁移加快照测试锚住产物。

### 2.5 [P1] 列表 / 表格视觉两套并行

| 通用 | 局部自造 |
| --- | --- |
| `.data-table` + `.data-table__expand` / `__actions` / `__id` / `__link` / `__muted` / `__nowrap` / `__truncate`（mcps 列表使用） | `.repos-table` / `.repos-table__actions` / `.repos-table__url` |
| `.data-table__expanded-row`（mcps 行内展开） | `.agent-import__table`（导入对话框表格） |
| | `.reviews-row__*`（review 列表行视觉） |

**后果**：repos / agent-import / reviews 三处各自重新实现了"表格 / 列 / 操作列"的视觉，未来加新列表（例如 RFC-033 / RFC-034 提到的 batch import）又会再造一遍。

**修法**：所有列表统一走 `.data-table`，把 repos / agent-import / reviews 三处迁过去；reviews 行展开（历史版本）走 `.data-table__expanded-row` modifier。

### 2.6 [P2] 对话框 / Overlay 每次重写

`styles.css` 里两个独立的 overlay 实现：

- `.review-decision-dialog__overlay / __panel / __header / __close / __body / __actions / __label / __textarea / __error / __warn`（评审"通过 / 退回 / 迭代"对话框，~30 行 CSS）
- `.agent-import__overlay / __panel / __header / __close / __footer / __tab / __tabs / __preview / __upload / __warning / __warnings / __field / __value / __filename / __empty / __overwrite / __actions-row / __hint / __route / __textarea / __table`（agent.md 导入，~80 行 CSS）

**后果**：每加一个对话框/modal 就要重写 overlay + panel + close + 焦点管理；clarify 还有自己的提交 dialog（`.clarify-detail__submit-group`）虽然不是 modal 但又是另一种结构。

**修法**：抽 `<Dialog />` shared component（overlay + panel + header + close + footer + 焦点陷阱 + ESC 关闭 + portal 渲染）。把 ReviewDecisionDialog / AgentImportDialog 改用它。后续 RFC-032 inbox drawer / 其他新 modal 都复用。

### 2.7 [P2] Loading / Empty 状态零组件化

实际使用模式（grep 出 59 处 `isLoading && / isPending &&`）：

```tsx
{isLoading && <div className="muted">{t('common.loading')}</div>}
{!isLoading && data.length === 0 && <div className="muted">{t('common.empty')}</div>}
```

`.muted` 是一个**单一颜色** utility，没有 spinner / skeleton / icon / 居中对齐 / 高度撑起。各页面对"加载中"的视觉表现完全取决于上下文：有的是表格上方一行小字，有的是 panel 居中一行字。

**修法**：抽 `<EmptyState />`（中央 icon + 主标题 + 副标题 + optional action）+ `<LoadingState />`（中央 spinner + 文字 fallback）两个共享组件；列表 / 详情页统一调用。

### 2.8 [P2] 详情页 split-pane / 标签页骨架未抽象

- `task-detail` 用 `.task-detail__panes / __pane / __tab-bar` 这一套（RFC-021）。
- `review-detail` 用 `.review-detail__layout / __body / __sidebar-*`（RFC-009 sidebar 增强）。
- `clarify-detail` 用 `.clarify-detail__footer / __submit-group` 这种 ad-hoc 名字。
- `workflow-canvas` 用 `task-canvas-layout / --with-drawer`。
- `mcps.detail` / `plugins.detail` / `agents.detail` / `skills.detail` 是平铺单列。

**后果**：详情页"主区 + 侧栏"或"主区 + 抽屉"反复出现但没有公共骨架；以后做"agent 详情 + 关联工作流"想加侧栏要么照抄一种、要么再造。

**修法**：抽 `<DetailLayout main={…} aside={…} asideWidth=…>` 容器，task / review 切过去；agent / mcp / plugin 详情想加侧栏直接套用。

### 2.9 [P3] 路由内联 style 残留

仅 2 个文件有内联 style：

- `settings.tsx` 6 处（`marginTop` / `marginBottom` / `fontSize` 微调）
- `reviews.detail.tsx` 5 处（绝对定位 popover + 复杂动态 transform）

**后果**：低；但 settings 那 6 处暴露**间距 token 缺失**——没有 `--space-sm/md/lg`，作者只能写 `marginTop: 16`。

**修法**：补一组间距 token（`--space-0..6`）+ 给 `<p>` / `<section>` 加标准间距 utility（`.stack--sm/md/lg` 行间距）。settings 6 处可以一次迁完。

---

## 3. 设计 tokens 现状

| 类别 | 现状 | 缺口 |
| --- | --- | --- |
| 颜色 | ✅ `--bg --panel --border --text --muted --accent --danger`，dark 主题对称定义 | 缺 `--success --warn --info` 语义色（当前 success / warn 通过 `color-mix(green/orange, transparent)` 散落定义） |
| 间距 | ❌ 完全没有 | 建议引入 `--space-1..6`（4/8/12/16/24/32px） |
| 字号 | ❌ 没有 token，散落 `font-size: 11/12/13/14/16/18/22px` | 引入 `--font-xs/sm/md/lg/xl`（11/12/14/16/22） |
| 圆角 | ❌ 散落 4/6/8/10/999px | 引入 `--radius-sm/md/lg/pill` |
| 阴影 | ❌ 散落 box-shadow | 引入 `--shadow-sm/md/lg` |

---

## 4. 标准件清单建议

| 组件 / 类 | 现状 | 建议 |
| --- | --- | --- |
| `<StatusChip>` | 4 套并行 | 收敛 |
| `<Dialog>` | 2 套 ad-hoc | 抽出 |
| `<EmptyState>` / `<LoadingState>` | 无 | 新建 |
| `<DetailLayout>` | 无 | 新建 |
| `<Form.Field/Input/Switch/...>` | 35% 采用 | 补全采用 |
| `.tabs --modifier` | 4 套 | 收敛 |
| `.data-table` | 局部采用 | 推广 |
| `.btn--ghost/--xs` | 用而未定义 | 补 CSS |
| 间距 / 字号 / 圆角 token | 无 | 引入 |
| 语义色 success/warn/info | 半散落 | 提炼 |

---

## 5. 推荐路径

**强烈推荐**：把 UX 一致化作为**独立 RFC-033**处理，不要把 RFC-032 撑大。理由：

1. RFC-032 是**外壳改造**（侧栏分组 + 收件箱 + runtime 入口 + 设置 footer 化），不依赖标准件就能落地；如果阻塞在 UX 标准件上反而拖慢见效。
2. UX 一致化天然要拆 3 个 PR：(a) 设计 tokens + 补 ghost/xs + 收敛 status chip → (b) 收敛 tabs / table / form 采用面 → (c) Dialog / EmptyState / LoadingState / DetailLayout 抽出 + 落地点替换。每一阶段独立可回退。
3. RFC-032 落地后**反哺** RFC-033：例如 inbox drawer 实现时如果 Dialog 还没抽，先用 ad-hoc；Dialog 出来再 retrofit。这样不会卡。
4. 顺序倒过来（先 UX 后导航）会让用户更晚看到导航改进的收益，且 UX 一致化的范围易膨胀，没有外部 deadline 收口。

**RFC-033 建议结构**：

```
PR1：tokens + ghost/xs + status chip 收敛
  - 引入 --space / --font / --radius / --shadow / --success / --warn / --info
  - 补 .btn--ghost / .btn--xs
  - <StatusChip> 统一替换 .status-chip / .status-badge / .mcp-probe-chip
  - 测试：status-chip-render（5×size×variant 矩阵）+ 源代码层 grep 锁
PR2：tabs / table / form 推广
  - 通用 .tabs --modifier 扩展，agent-import / repo-source / inspector 切过去
  - .data-table 推广到 repos / agent-import / reviews
  - 7 个未采用 <Form> 的路由迁移
  - 测试：每个迁移点的快照测试 + 视觉回归（如果有 chromatic / playwright screenshot）
PR3：Dialog / EmptyState / LoadingState / DetailLayout 抽出
  - <Dialog> 抽出 + retrofit ReviewDecisionDialog / AgentImportDialog
  - <EmptyState> / <LoadingState> 抽出 + 推广（59 处 isLoading/isPending 调用点至少一半改造）
  - <DetailLayout> 抽出 + retrofit task-detail / review-detail
  - 测试：组件单测 + 源代码层 grep 锁旧 overlay 类不再被引用
```

**RFC-032 这边**：维持原 scope（外壳），可以等用户最后批准 layout-a 后直接进入实现，**不必等 RFC-033**。

---

## 6. 附录：审计方法

- 用 `grep -oE '^\.[a-z]'` 抽取 styles.css 全部顶级类，按前缀 group 看分类（501 个类，按业务/通用分布）。
- 用 `for f in routes/*.tsx; do grep -c 'pattern' "$f"` 统计每路由的采用率。
- 用 `grep -rohE 'className="btn[^"]*"' | sort | uniq -c | sort -rn` 看变体频次。
- 抽样 `reviews.detail.tsx` / `settings.tsx` 看内联 style 性质（是 ad-hoc 微调还是 dynamic 真需要）。
- 对照 `styles.css` 的 section 注释（`/* ---- X ---- */`）核对组件归属。
