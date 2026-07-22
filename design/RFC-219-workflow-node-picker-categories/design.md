# RFC-219 工作流节点选择器分类导航与类型显性化 — design

状态：In Progress（2026-07-22 用户批准；功能与本地定向验收完成，仓库总门和 Linux 权威视觉基线待收尾）。以 `proposal.md` 为产品合同。

## 1. 现有数据流

```text
Agent[] + PALETTE_DESCRIPTORS
          │
          ▼
buildPalette() -> PaletteSection[]（当前有 label/items，但 section key 未透出）
          │
          ▼
WorkflowNodePicker.buildEntries().flatMap()
          │                         └─ section 身份在这里丢失
          ▼
recommended / recent / all(flat entries)
```

修复只调整 `buildPalette → NodePicker view model → Catalog render`。`makeNode()`、`serialize()`、
`onPick`、canvas insertion 与 workflow draft mutation 不变。

## 2. 类型与单一事实源

### 2.1 section identity

扩展现有类型，不新增平行 kind 表：

```ts
export type PaletteSectionKey = 'agents' | 'wrappers' | 'io' | 'human'
export type NodePickerCategory = 'all' | PaletteSectionKey

export interface PaletteSection {
  key: PaletteSectionKey
  label: string
  items: PaletteSectionItem[]
}
```

把当前私有 `SECTION_ORDER` 导出为只读 `PALETTE_SECTIONS`，仍由
`PALETTE_DESCRIPTORS[kind].section` 决定每个 NodeKind 的归属。`buildPalette()` 只多透传 `key`；
现有调用方按 label/items 使用时兼容。

`PaletteSectionKey`、`PALETTE_SECTIONS` 与 `PALETTE_DESCRIPTORS satisfies Record<NodeKind, …>`
共同形成编译期闭包：新增 NodeKind 必须先声明 section；UI 不写 `kind === wrapper-*` 之类的第二份
分类判定。

### 2.2 picker entry

NodePicker view model 中每项保留：

```ts
interface NodePickerEntry {
  identity: string
  item: PaletteItem
  label: string
  description: string
  sectionKey: PaletteSectionKey
  sectionLabel: string
}
```

类型 chip 只读 `sectionKey`；`workflowNodePickerIdentity()` 与 localStorage 值不变。

## 3. 纯派生层

新增 `packages/frontend/src/lib/workflow-node-picker.ts`，把分组/过滤从 React 渲染中抽出：

```ts
export interface NodePickerCatalogModel {
  categoryCounts: Record<'all' | PaletteSectionKey, number>
  groups: Array<{
    key: 'recommended' | 'recent' | PaletteSectionKey
    label: string
    entries: NodePickerEntry[]
  }>
  visibleEntryCount: number
}

export function deriveNodePickerCatalog(input: {
  sections: PaletteSection[]
  activeCategory: NodePickerCategory
  query: string
  recentIdentities: readonly string[]
  labels: { recommended: string; recent: string }
}): NodePickerCatalogModel
```

派生顺序：

1. 按 `sections` 顺序构造带 section identity 的 canonical entries 与 identity map；
2. count 始终从未过滤的 canonical entries 计算，`all = 四类之和`；
3. query 使用现有 trim + lowercase 规则，haystack 仍是 label/description/kind/agentName；
4. activeCategory 非 `all` 时先限定 section，再匹配 query；
5. 仅 `all + 空 query` 生成 recommended/recent，随后追加四个 canonical group；
6. 其他状态只生成非空 canonical group；选中分类但无结果时 groups 为空，由组件渲染统一空状态；
7. `visibleEntryCount` 只统计当前 canonical 匹配数，不把 recommended/recent 的重复展示计入结果播报。

推荐策略保持现状：前三个 Agent + input/output/review，最多六项。最近项仍按 identity 顺序、丢弃
目录中已不存在的 identity、最多六项。

## 4. React 组件接线

`WorkflowNodePickerCatalog` 新增本地状态：

```ts
const [activeCategory, setActiveCategory] = useState<NodePickerCategory>('all')
```

`query` 与 `activeCategory` 都是单个 Catalog 实例的瞬时 UI 状态，不进 localStorage。关闭后重开默认
“全部”；Agent query 刷新沿用当前 query reset 行为，分类保持当前值，因为四个分类本身不会消失。

### 4.1 TabBar / TabPanels

- 搜索框下使用共享 `<TabBar variant="segment">`；五个 tab 的 badge 是稳定 count；
- `ariaLabel` 使用 `editor.nodePicker.categoriesLabel`；滚动按钮继续由 TabBar 管理；
- 用共享 `TabPanels`/`tabDomIds` 建五个 panel identity，但只有 active panel 挂载节点列表，避免
  50 Agent × 5 panel 的隐藏重复 DOM、重复 testid 与无意义 tab stop；
- active panel 内复用现有 `.workflow-node-picker__groups` 滚动容器和 row refs。

分类切换只更新 view model，不重置 query/recent，也不调用 `onPick`。`itemRefs.current.length` 按新
flattened 列表重置；搜索框 ArrowDown 只会聚焦 active panel 第一项。

### 4.2 group render

现有 `recommended/recent/all` 三组改为 view model groups。canonical group key 直接取
`PaletteSectionKey`，heading 取 `buildPalette()` 已翻译 label。推荐/最近组允许混合类型，但每行
带 chip；canonical section 同样保留 chip，确保搜索/复制 UI 结构时类型信息不丢。

### 4.3 row DOM

```tsx
<button
  className="workflow-node-picker__item editor-sidebar__item"
  data-category={entry.sectionKey}
>
  <span className="workflow-node-picker__item-copy">
    <span className="workflow-node-picker__item-heading">
      <span className="editor-sidebar__item-label">…</span>
      <span
        className="chip chip--tight workflow-node-picker__type-chip"
        data-category={entry.sectionKey}
      >
        Agent
      </span>
    </span>
    <span className="editor-sidebar__item-hint">…</span>…
  </span>
  drag grip
</button>
```

chip 文本进入按钮 accessible name，不设 `aria-hidden`。glyph 保留，形成图形 + 文字 + 分组三级
冗余识别。

## 5. 样式合同

复用 `.tabs--segment`、`.tabs__tab-badge`、`.chip.chip--tight` 与 `.editor-sidebar__item`，只在
`.workflow-node-picker` 命名空间做布局/色调扩展：

- picker 保持 `display:flex; flex-direction:column; min-height:0`；搜索框与分类条不进入结果滚动；
- category TabBar `max-width:100%`，由既有 overflow controls 负责 240px 情况；
- `.item-heading` 使用 `display:flex; min-width:0; gap`，名称允许收缩/省略，chip 与 drag grip
  `flex:none`；
- row `border-inline-start-width:3px`，四类色调与现有 canvas 家族同源；type chip 使用低饱和
  background/border，light/dark 都通过 token + `color-mix`；
- 任何分类都同时有文字 chip 与 section heading，颜色不作为唯一信息；
- 不改 `.canvas-node*`、`.editor-layout` 断点或 Dialog chrome。

## 6. i18n

`editor.nodePicker` 增加并在类型声明、en-US、zh-CN 同步：

```text
categoriesLabel
categoryAll
categoryAgent
categoryWrapper
categoryIo
categoryHuman
resultsCountInCategory
```

section heading 继续复用 `editor.paletteAgents/paletteWrappers/paletteIo/paletteHuman`。搜索、空状态、
推荐/最近和 dragHint 旧 key 不改。

## 7. 边界与失败模式

| 场景                             | 行为                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| agents = []                      | Agent count=0，仍可选中并看到统一空状态；其他分类不受影响            |
| recent identity 已删除           | 继续静默忽略，不产生空行                                             |
| active=human，query 只匹配 Agent | human panel 显示空状态，不自动跳分类                                 |
| 分类切换后结果数变化             | live region 播报 canonical visible count；不把重复推荐项计数         |
| disabledReason 命中              | 行仍可聚焦并解释原因，chip/分类不改变禁用语义                        |
| 240px 分类条溢出                 | TabBar 内部滚动 + 左右 affordance；picker/page 无横向溢出            |
| 新 NodeKind                      | `PALETTE_DESCRIPTORS` 编译门要求 section；picker 自动随 section 投影 |

不按搜索结果自动切换分类，也不持久化分类选择，避免“目录自己跳走”与跨 workflow 隐式状态。

## 8. 测试策略

### 8.1 pure / component

- `palette.test.ts`：四 section key/order、每个 kind 唯一归属、零 Agent 计数；
- 新 pure test：50 Agent 的 counts、all 空搜索 group order、wrapper/human 分类直达、query×category
  交集、空 group、recent stale identity、visible count 不重复；
- `workflow-node-picker.test.tsx`：五 tab + badge、TabBar 方向键、tab/panel 关联、分类切换保留 query、
  mixed group 每行文字 chip/data-category、搜索 ArrowDown 只进 active panel；
- 既有 disabled/onPick/recent/Escape 测试原样继续通过。

### 8.2 browser / visual / a11y

- Playwright 用 50+ Agent fixture：1179px 打开 palette，点 Wrapper/Human 后首屏立即可操作；390px
  分类条可滚且添加节点成功；1536px 常驻 rail 可搜索并拖拽；
- 直接断言 body 无横向 overflow、tab strip 自身 overflow、240px 行中名称/chip/grip bounding box
  不重叠；
- axe 覆盖 1179 Dialog 与 390 full-screen，检查 tablist/tab/tabpanel 与可访问名称；
- 更新既有 1179 palette visual baseline，并补一张大量 Agent + Human 分类的定向基线；light/dark
  至少各覆盖一类，不能只靠 DOM class；
- 不扩大无关页面 visual threshold。

## 9. 改动面

```text
packages/frontend/src/components/canvas/nodePalette.ts
packages/frontend/src/components/workflow-editor/WorkflowNodePicker.tsx
packages/frontend/src/lib/workflow-node-picker.ts                 (new)
packages/frontend/src/i18n/en-US.ts
packages/frontend/src/i18n/zh-CN.ts
packages/frontend/src/styles.css
packages/frontend/tests/palette.test.ts
packages/frontend/tests/workflow-node-picker.test.tsx
packages/frontend/tests/workflow-node-picker-model.test.ts        (new)
e2e/workflow-editor.spec.ts
e2e/visual-regression.spec.ts
e2e/visual-regression.spec.ts-snapshots/...                       (targeted)
```

无 backend/shared schema/migration/依赖变化。

## 10. 实现门

- production code 只能在用户批准本 RFC 后开始；
- 提交前跑 `bun run typecheck && bun run test && bun run format:check`，并跑相关 workflow-editor
  Playwright/visual/axe；
- 视觉走查对比 1536 rail、1179 side Dialog、390 full-screen，确认本 RFC 没改变画布节点或 editor
  三/两/一栏几何；
- 实现评审重点检查：section 单一事实源、hidden DOM 重复、键盘焦点、搜索计数、窄栏溢出和
  localStorage 兼容。
