# RFC-150 · 前端 Segmented/TabBar 公共原语 + W0 收口补做（design）

> 现场清单以 2026-07-08 调研全景为准（11+2 segmented / 12+5 tabs / 16 ConfirmButton
> 调用点 / 测试锁矩阵——原文录于调研输出，此处只列接线决策）。

## 1. `<Segmented>`（components/Segmented.tsx）

```ts
export interface SegmentedOption<V extends string> {
  value: V
  label: ReactNode
  disabled?: boolean
  title?: string
  /** kbd 快捷键提示（clarify.detail Q/W 场景）——渲染为
   *  <kbd class="kbd-shortcut segmented__shortcut">。 */
  shortcut?: string
  /** data-* 透传（ClarifyDirectiveToggle 的 data-directive 等）。 */
  data?: Record<string, string>
}
interface SegmentedProps<V extends string> {
  value: V
  onChange: (v: V) => void
  options: ReadonlyArray<SegmentedOption<V>>
  ariaLabel: string
  className?: string // 追加命名空间（memory-form__scope-segmented 等）
  testidPrefix?: string // ChipsInput 规程：`${prefix}` 容器 / `${prefix}-${value}` 项
  rootTestid?: string // 设计门修订：容器显式 testid（优先于 prefix 推导）
  disabled?: boolean
  /** canvas 场景（ClarifyDirectiveToggle）。契约（设计门修订，先锁后迁）：
   *  同时 stop mouseDown 与 click 冒泡；点击已 active 值不触发 onChange。 */
  stopPointerPropagation?: boolean
}
// SegmentedOption 增 testid?/shortcutTestid?——clarify.detail 的
// `clarify-scope-${id}-${mode}` 与 `...-kbd` 是独立于 prefix 推导的模式。
```

- DOM 固化：容器 `.segmented` role=radiogroup aria-label；项 button role=radio
  aria-checked + `.segmented__option(--active)`——与现存 10 处正确形态字节级同构，
  真行为锁（clarify-directive-toggle / language-switch 形态）天然兼容。
- AclPanel 迁移即修 a11y 漂移（group→radiogroup、补 aria-checked）。

## 2. `<TabBar>`（components/TabBar.tsx）

```ts
export interface TabDef<K extends string> {
  key: K
  label: ReactNode
  badge?: ReactNode // tasks.detail 问题数徽标（.tabs__tab-badge）
  testid?: string
}
interface TabBarProps<K extends string> {
  tabs: ReadonlyArray<TabDef<K>>
  active: K
  onSelect: (k: K) => void
  variant?: 'default' | 'inline' | 'inspector' | 'segment' // → .tabs--<variant>
  ariaLabel?: string
  className?: string
}
```

- DOM：`.tabs [tabs--<variant>]` role=tablist；项 `.tabs__tab(--active)` role=tab
  aria-selected。迁移即为 NodeDetailDrawer/NodeInspector/settings/skills.new/
  clarify.detail 免费补齐 a11y。
- NodeInspector 条件 preview tab = tabs 数组条件构造（`node-inspector.test.tsx`
  的 `.tabs--inspector .tabs__tab` 计数锁继续绿——类名不变）。

## 3. 迁移批次（与测试锁改写配对）

- **PR-1**：两原语 + 单测（radio/tab role 行为格、badge、shortcut、testidPrefix、
  variant class）+ W0 补做（15 处裸 span → StatusChip；describeStatus 键族并入
  `tasks.status.*`——home.taskRow.status\* 8 键删除、task-status-i18n 锁扩展）+
  ConfirmButton variant 化（16 调用点、`danger` prop 删除）。
- **PR-2 纯机械批**：Segmented 8（StructuralDiffView×2/CallChainView/
  StructuralGraph/tasks.detail engineMode/CrossClarifyEdit/ClarifyEdit/
  MemoryFormFields）+ TabBar 7（settings/skills.new/reviews/clarify/memory/
  AgentImportDialog/MemoryAllList 含 tabs--pills 修正）。
- **PR-3 中风险批**：TabBar 4（NodeInspector/NodeDetailDrawer/RepoSourceRow/
  tasks.detail 主 tab+badge）+ Segmented 3（AclPanel a11y 修正/
  ClarifyDirectiveToggle stopPropagation/clarify.detail shortcut+disabled+title）。
  受影响锁：tabs-retrofit-grep 改「渲染 <TabBar variant>」断言、
  rfc128-question-tab-badge 改 badge prop 锚、repo-source-tabs 双锁随迁。
- **遗留清单**（非目标，design 留档）：roving 文件树 tab ×2、InboxDrawer、
  auth-tabs、diff-mode-segmented、LanguageSwitch、**clarify.detail 分片切换器**
  （设计门 high 补录：TanStack Link 导航 tab——路由语义与 button tab 不同形态，
  TabBar v1 不做 as/link 透传；grep 守卫排除表显式列名，TabBar 验收计数修正
  为 11/13）。

## 4. 决策记录

- **D1** 原语复用既有 `.segmented`/`.tabs` CSS class（不内联样式）——
  tabs-modifier-styles CSS 锁零改动，视觉零变化。
- **D2** vertical roving tablist 不做进 TabBar v1（文件树场景是另一形态；
  structure-view 真行为锁保护现状）。
- **D3** describeStatus 收键族方向：并入 `tasks.status.*`（chip 与行文案同源；
  home.taskRow.status\* 删除；zh/en 双语种同步）。
- **D4** ConfirmButton `variant?: 'danger'|'default'`（缺省 default）——不引入
  primary/ghost（现无调用需求，YAGNI）；`size` 保留现状。

## 5. 测试策略

原语单测（role/aria/badge/shortcut/disabled/testid 格）；迁移批以「真行为锁零
改动 + grep 锁改组件断言」为交付判据；W0 补做扩展 status-chip-grep 棘轮
（裸 span 零再现）与 task-status-i18n（单键族）；ConfirmButton 调用点
grep 锁（danger prop 零再现）。前端全量 + 视觉自查（CLAUDE.md 规程：新原语
页面与核心页 side-by-side）。

## 6. 任务分解 → plan.md（3 commit）
