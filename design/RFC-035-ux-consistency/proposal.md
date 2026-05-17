# RFC-035 — UX 一致性专项（Stub）

> **状态**：Draft（仅 stub，待 RFC-032 完工后展开 design.md / plan.md）。
>
> **背景与缺口清单**：见 [`design/ux-audit.md`](../ux-audit.md)（2026-05-17 全量审计，9 个缺口分类 + 强项保留清单）。该 audit 文档是本 RFC 的权威背景，不在本 stub 中复制。
>
> **创建动机**：RFC-032（导航重构 + 任务驱动首页）在改写 RFC 期间，用户问"是否同时统一所有界面 UX 风格"。诚实评估认为 RFC-032 应保持外壳 + 首页范围，UX 一致化独立处理才能避免 scope creep。本 RFC 即是那条独立路径。

## 背景

agent-workflow 在 31 个 RFC 累积后，前端 chrome 心智已经收敛（page__header / btn / ConfirmButton / ErrorBanner / 颜色 token），但**视觉细节**有 9 个已识别的不一致缺口。详见 `ux-audit.md`。

## 目标

**让全站 UX 视觉语言收敛到一套标准件**，使新页面的实现成本下降、新人改 UI 的"该用哪个"困惑消失。具体输出：

1. 引入 4 类设计 token：间距 / 字号 / 圆角 / 阴影（颜色 token 已经齐全，仅补语义色 success / warn / info）。
2. 补 `.btn--ghost` / `.btn--xs` 缺失 CSS（修复 P0 静默退化）。
3. 收敛 4 套并行"状态指示"系统到单一 `<StatusChip>` 组件。
4. 收敛 4 套 tab 实现到单一 `.tabs` + modifiers。
5. 推广 `<Form>` helper 到全部表单路由（当前 35% → 100%）。
6. 推广 `.data-table` 到 repos / agent-import / reviews 三处自造表格。
7. 抽出 `<Dialog>` shared component；2 处现有 ad-hoc overlay retrofit。
8. 抽出 `<EmptyState>` / `<LoadingState>` shared component；59 个 isLoading/isPending 调用点至少一半改造。
9. 抽出 `<DetailLayout>` 容器（主区 + 侧栏 / 抽屉 split-pane）；task-detail / review-detail retrofit。
10. 整理 11 处路由内联 `style={...}`，迁到间距 token / `.stack--{sm,md,lg}` 类。

## 非目标

- 不改变页面信息架构（仅视觉一致化，不重排 layout）。
- 不引入新的设计语言 / 主题（颜色 token 不变，dark 主题不变）。
- 不引入设计系统外的 npm 依赖（不引入 shadcn / Radix / Headless UI 等 —— 项目当前是手写 CSS，保持现状）。
- 不动后端 / shared / DB。
- 不破坏现有 RFC-005 / RFC-009 / RFC-021 / RFC-027 等页面已经形成的有意视觉差异（例如 review 详情的 sidebar count 视觉是产品有意为之，不收敛到通用 DetailLayout 时要保留视觉特征）。

## 用户故事

- **作为一个新接手的前端开发者**，我希望写一个新页面时打开 `components/` 就能找到现成的 `<StatusChip />` `<Dialog />` `<EmptyState />` `<DetailLayout />` 组件，而不是去 grep 看别的页面怎么做。
- **作为一个 RFC-032 落地后回头改首页的开发者**，我希望 task-row 的状态 chip 跟其他页面 `.status-chip` 视觉一致，不需要为同一概念维护多套 CSS。
- **作为一个 review user**，我希望平台所有"成功 / 失败 / 警告"的颜色与圆角语言完全一致，不会因为页面切换而产生认知摩擦。

## 验收标准（待 design.md 细化）

按 `ux-audit.md §5 推荐路径` 拆 3 个 PR：

### PR1（tokens + ghost/xs + StatusChip 收敛）

- 引入 `--space-1..6 / --font-xs..xl / --radius-sm..pill / --shadow-sm..lg / --success / --warn / --info` token 在 `styles.css` 顶部
- 补 `.btn--ghost` / `.btn--xs` CSS 定义
- 新 `<StatusChip kind="success|warn|danger|info|muted" size="sm|md" />` 组件 + 单测
- TaskStatusChip / McpProbeStatusChip / StatusBadge（inventory）三个组件 retrofit 内部走 StatusChip
- 测试：status chip render matrix（5 kinds × 2 sizes = 10）+ 源代码层 grep 锁旧 .status-badge / .mcp-probe-chip 类不再被业务代码引用

### PR2（tabs / table / form 推广）

- 通用 `.tabs` 加 `--inline / --inspector / --segment` 三个 modifier
- inspector / agent-import / repo-source 三处现有 tab 切到通用 .tabs --modifier
- `.data-table` 推广到 repos / agent-import / reviews 三处
- 7 个未采用 `<Form>` 的路由迁移：agents.new / agents.detail / plugins.new / plugins.detail / mcps.new / mcps.detail / reviews.detail / repos / clarify.detail / tasks.detail（含表单 fragment）
- 测试：每个迁移点的源代码层 grep 锁旧类不再被引用 + render 快照

### PR3（Dialog / EmptyState / LoadingState / DetailLayout 抽出）

- `<Dialog>` shared component（overlay + panel + header + close + footer + 焦点陷阱 + ESC 关闭 + portal）+ 单测
- ReviewDecisionDialog / AgentImportDialog retrofit 调用 `<Dialog>`
- `<EmptyState />` / `<LoadingState />` shared component + 单测
- 至少 30 处 isLoading/isPending 调用点改造（每 PR 写迁移列表）
- `<DetailLayout main aside asideWidth>` 抽出 + task-detail / review-detail retrofit
- 测试：组件单测 + 源代码层 grep 锁旧 overlay 类不再引用

## 与其他 RFC 的关系

- **依赖**：RFC-032 PR1（shell 改造）。理由：RFC-032 把 chrome 改造完成后，UX 一致化才能在稳定的外壳上做；否则两个 RFC 同时改 styles.css 会冲突。
- **不依赖**：RFC-029 / RFC-030 / RFC-031（runner / inventory / plugin 路径）。
- **后续 RFC**：本 RFC 完工后可以开 RFC-036+（如有需要）做更深入的设计语言演进，例如响应式 / 移动端 / 新主题。

## 待办（本 stub 不展开，留给 design.md / plan.md）

- design.md：标准件 API 定义、迁移点逐个清单、测试策略、与现有组件兼容性
- plan.md：T1..Tn 子任务、PR 拆分细节、验收清单逐项 checkbox

当 RFC-032 全部 3 PR 落地后再展开本 RFC 的 design.md / plan.md。
