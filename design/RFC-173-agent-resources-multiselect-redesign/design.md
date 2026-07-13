# RFC-173 技术设计

> 设计门（Codex 对抗评审）第 1 轮：0 P0 / 7 P1 / 3 P2，全部折入本文（见 §12 收敛记录）。

## 0. 改动全景

纯前台。自底向上四层：

1. **新 hook `hooks/usePopoverPosition.ts`** —— 抽出现有**三处逐字相同**的 portal 定位 effect
   （`Select.tsx:94-113`、`UserPicker.tsx:63-82`，加本 RFC 否则会成第三份）。
2. **新公共原语 `components/MultiSelect.tsx`** —— 标签多选 combobox。**结构对齐既有
   `UserPicker`**（`.chips-input__row` 字段 + `.chip` 标签 + trailing `<input role="combobox">`
   + portaled `<ul role="listbox">`），复用 `useChipsCommit`（删末标签/自由 token）+ `.select__*`
   下拉视觉，不 fork。
3. **`components/ResourcePicker.tsx` 改写** —— 「单选 `Select` 叠 `ChipsInput`」→ 单个
   `MultiSelect`。四 wrapper 保持薄壳、调用点不变；**filter 语义「排除已选」→「资格过滤」**、
   **移除 `nameOf` 泛化**（见 §3）。
4. **`AgentForm.tsx` `resources` 面板重排** —— 扁平四段 → "能力 / 依赖"两分组；`Field` 加
   `icon` 槽，四个资源 Field 传 `group`（div 而非 label，因内含按钮）。

配套：`.multi-select` / `.resource-group` 样式（**共享** `.select__*` 基类，非克隆）；i18n
（新 `multiSelect.*` + `agentForm.group*` **且改写**既有 `fieldMcps/fieldPlugins/*PickerEmpty/
*PickerLoadFailed` 文案）；测试见 §8。

## 1. `MultiSelect` 组件契约

`components/MultiSelect.tsx`：

```ts
export interface MultiSelectOption {
  value: string          // 提交进 value[] 的身份串（对 ResourcePicker 恒＝资源 name）
  label: string          // 下拉行主标题 + 触发区标签文本
  description?: string   // 下拉行 muted 副行（两行体）
  disabled?: boolean     // 未选时不可"加"（灰显）；已选时仍可"删"（见 §1.1）
}

export interface MultiSelectProps {
  value: string[]                         // 受控：已选身份串
  onChange: (next: string[]) => void
  /** 候选集：调用方传"资格 ∪ 已选"（见 §3.2）。未覆盖的 value 由本组件合成勾中行。 */
  options: ReadonlyArray<MultiSelectOption>
  /** 无障碍名——字段用 Field group（div，非 label），input 需自带可及名。必填。 */
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  searchable?: boolean                    // 默认 true
  /** 允许提交不在 options 的自由 token（前向引用 / 接口失败兜底）。默认 false。 */
  allowCustom?: boolean
  emptyLabel?: string                     // 下拉无候选行文案
  loadingLabel?: string                   // 下拉加载中行文案
  loading?: boolean
  'data-testid'?: string                  // 落在 input 上（getByRole('combobox') 命中它）
}
```

### 1.1 渲染 —— 对齐既有 `UserPicker`（关键复用决定）

**先例**：`components/UserPicker.tsx`（RFC-099）**已是**已发布的"标签 + 搜索输入 + portaled
下拉"多选组件（选中=`.chip`、字段=`.chips-input__row`、trailing
`<input role="combobox" aria-autocomplete="list">`、portaled `<ul role="listbox">`）。
`MultiSelect` **对齐它的结构**，差异只在数据源与行为语义。

- **字段区**（`<div class="multi-select__field chips-input__row">`，**非 `<button>`**）：
  - ⚠️ **不是 button**：标签的 `×` 是 `<button>`，button 套 button 非法。故字段是 div，
    **combobox role 落在内部 `<input>` 上**（同 UserPicker），天然规避嵌套按钮。
  - 复用 UserPicker 趟平的坑：整行 `onMouseDown` 命中非 `.chip__remove`、非 input →
    `preventDefault()` + 聚焦 input + 开下拉（否则焦点落 `<body>`、Dialog focus trap 弹走、
    字段读作"灰/死"——UserPicker 注释记录的真实事故）。
  - 每个已选 = `<span class="chip">` label `<button class="chip__remove" onClick=remove(v)>×`
    （复用 `.chip`/`.chip__remove`）；`×` 只删该标签、不冒泡开合。
  - 标签文本 = `options.find(o => o.value === v)?.label ?? v`。对 ResourcePicker `value`＝资源
    `name`（§3 移除 `nameOf` 后 value 恒是人类可读名），故回退 `?? v` 也永远是可读名——
    **P1-2 消解**：不会再出现"机器 id 当标签"。
  - `value` 空且 input 空 → input 显示 `placeholder`。
  - trailing `<input role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
    aria-label={ariaLabel}>`；`data-testid` 落此 input。
- **下拉**（`createPortal` 到 body 的 `<ul role="listbox" aria-multiselectable="true">`）：
  - **每个 `value` 都保证在 listbox 有一行**：**按 value-set**——`options` 已覆盖的 value 用其
    行（首行胜出），**仅**为 `options` 未覆盖的 value **合成勾中行**（label=v），故同一 value
    绝不渲染两行（P2-1 R2）——保证**所有已选项都能在下拉取消勾选**（P1-1 AC-2），不论它是否仍
    有资格 / 是否已被删除。
  - 行 = `role="option"` + `aria-selected={value.includes(v)}` + checkbox 视觉（复用
    `.select__option-check` + `.select__option-stack/title/sub`：title=label、sub=description）。
    点击 **toggle**（在→删 / 不在→加），**点后不关**（多选连点）。
  - `disabled` 语义：**未选 disabled 行不可加**（灰显、不响应）；**已选行永远可删**
    （即便 disabled）——保证失去资格的已选项可移除。ResourcePicker 不传 `disabled`
    （资格由 §3.2 的 options 并集处理），此语义仅为组件通用性备用。
  - input 打字 = **过滤本地 options**（label/description，大小写不敏感）；`loading`→单行
    `loadingLabel`；有词无匹配→`common.noMatches`；`allowCustom` 且无精确命中→"添加「{token}」"行。

**active-row 不变式（P1-1 R2，镜像 `Select.tsx:64/137/274` 的 activeIndex 处理）**：可交互行
＝候选行 + `allowCustom` 时的"添加「{token}」"行（**参与同一键盘索引**）。
- 打开 / 过滤词变化 / `options`/`value` 外部变化 → active 落**首个可交互行**（无则 `null`）；
- 结果集变化 → clamp active 到有效范围；`null` 时**移除 `aria-activedescendant`**；
- 故"聚焦后直接 Enter""过滤后直接 Enter"恒有确定行可 toggle（不会"Enter 无反应"）；
- 当过滤到零候选但 `allowCustom` + 词非空 → 唯一可交互行＝custom 行，active 落它，Enter 提交。

### 1.2 交互 / 键盘 / 焦点（AC-8）

combobox role 在 input 上 ⇒ **`Space` 只输入文本**（非 toggle）；toggle = `Enter`（有 active 行）
/ 点击。

| 操作 | 行为 |
|------|------|
| 聚焦 input / 点字段 / `↓` | 开下拉（同 UserPicker `onFocus`→open） |
| `↑`/`↓` | 移动 active 行（`aria-activedescendant`） |
| `Enter`（非合成） | 作用于 active 行（§1.1 恒有）：候选行→toggle；custom 行→提交 token。保持打开、清过滤词 |
| 点候选行 / 点 custom 行 | toggle / 提交（保持打开） |
| 点标签 `×` | 删该标签 |
| input 空时 `Backspace` | 删末标签 |
| input 输入 | 过滤本地 options |
| `Esc` | 关下拉 + **焦点回 input**（其余场景不动焦点） |
| **外点** | 关下拉、**不夺焦点**（保留用户刚点的新目标，同现状 `Select.tsx:120-131`） |
| IME 合成中 `Enter`/方向键/Space | 忽略/仅输入（`nativeEvent.isComposing` 守卫，照抄 `Select.tsx:171`） |

**焦点/事件模型（P1-4，务必自洽）**：
- 搜索 input 内 `Space` = 打字；`Enter` 作用于 §1.1 保证存在的 active 行，与打字不冲突。
- **`useChipsCommit` 的真实 API（`ChipsInput.tsx:24-32`）只返回
  `{ pending, error, setPendingValue, commit, handleKeyDown, handleBlur }`——`onRemoveLast` 是
  传入参数、非返回值**（P1-2 R2 勘误）。MultiSelect **只取 `pending`/`setPendingValue`/`error`/
  `commit`**（custom-token 的 trim→去重→validate→清空），把 `onCommit`＝加 custom；**不接
  `handleKeyDown`/`handleBlur`**（前者无 IME 守卫 + 吞逗号，后者 blur 自动提交会在"点 option
  致 input blur"时把搜索词误当 token）。
- **删末标签**：MultiSelect 自定义 `removeLast = () => onChange(value.slice(0,-1))`，在**自写
  keydown**（含 `isComposing` 守卫）的 Backspace-空输入分支调用；不依赖 useChipsCommit 触发。
- custom 提交只由显式 `Enter`（active 落 custom 行）/ 点 custom 行触发。逗号对资源名非法，
  不作 commit 键。

### 1.3 复用而非 fork（dedup 纪律）

- **弹层定位** → §2 `usePopoverPosition`（收编 Select + UserPicker + MultiSelect，3→1）。
- **custom-token 状态机** → `useChipsCommit` 的 `pending/setPendingValue/error/commit`（不接其
  keydown/blur）；删末标签用自写 `removeLast`（见 §1.2 勘误）。
- **下拉视觉** → 共享 `.select__listbox / __option / __option-check / __option-stack/title/sub /
  __search` 基类（§10，grouped selector 真复用，非克隆）。

## 2. `usePopoverPosition` hook（新）

```ts
// nullable 泛型 ref（P1-2 R2）：Select/UserPicker 均 useRef<…>(null) ⇒ React 19 下类型是
// RefObject<T | null>；签名必须容纳它，否则两调用方接线即 TS 报错。
export function usePopoverPosition<T extends HTMLElement>(
  triggerRef: RefObject<T | null>,
  open: boolean,
): { left: number; top: number; width: number } | null
```

内容＝把 `Select.tsx:89-113`（与 `UserPicker.tsx:54-82` 同形）搬出（window-scroll 坐标、
`scroll`(capture)/`resize` 监听、open 挂载/卸载清理）。`Select` + `UserPicker` 改为消费此 hook
（删本地 `popPos` state + effect），行为等价。**只抽定位**——各组件的键盘状态机（Select 的
Enter=选中+关 vs MultiSelect 的 Enter=toggle+留）**不共享**，无混淆风险。

**测试（P2-1：现有 Select 测试只覆盖搜索/分组、不验证 rect/scroll/cleanup）**：新
`use-popover-position.test.ts` mock `getBoundingClientRect` + 派发 `scroll`/`resize` +
断言 open→有 pos、close→卸载 listener（cleanup）。

## 3. `ResourcePicker` 改写

### 3.1 新契约 + 渲染

移除 `nameOf` 泛化（**P1-2**：四 wrapper 全用默认 `item.name`，无人用 `nameOf`；保留它会让
"value≠可读名"时标签显示机器 id）。value 身份恒＝`item.name`。新增 `ariaLabel`（**P1-3**：
Field 用 `group`→div，input 需自带可及名）+ 可选 `descriptionFn`。`filter` 改纯资格谓词。

```ts
// 泛型约束 name（P2-1 R2）：value 身份恒＝item.name，故约束 T 而非 unsafe cast。
export interface ResourcePickerProps<T extends { name: string }> {
  value: string[]
  onChange: (next: string[]) => void
  queryKey: readonly unknown[]
  endpoint: string
  /** 行主标题（短，进 tag + 下拉 title）。恒＝name 系。 */
  labelFn: (item: T) => string
  /** 下拉行副行（可选）。 */
  descriptionFn?: (item: T) => string | undefined
  /** 资格谓词（默认全通过）。已选项恒入候选（见下），不受此过滤。 */
  filter?: (item: T) => boolean
  ariaLabel: string
  placeholder?: string
  testid?: string
  labels: ResourcePickerLabels
}
```

```tsx
const eligible = props.filter ?? (() => true)
// P1-1：候选 = 资格 ∪ 已选（已选即便失去资格也留在下拉、可取消勾选）。
// P2-1 R2：value 唯一（四类资源名 DB unique：schema.ts agents/mcps/plugins/skills），且
// MultiSelect 内按 value-set 去重（options 首行胜出 + 合成行仅补 options 未覆盖者），故不会
// 同一 value 渲染两行；list.data 天然去重，此处直接 map 即可。
const options = (list.data ?? [])
  .filter((item) => eligible(item) || value.includes(item.name))
  .map((item) => ({
    value: item.name,
    label: props.labelFn(item),
    description: props.descriptionFn?.(item),
  }))
// value 中不在 list.data 的项（已删 / 查询失败）由 MultiSelect 合成勾中行兜底（§1.1）。

return (
  <div>
    <MultiSelect
      value={value} onChange={onChange} options={options}
      ariaLabel={props.ariaLabel} placeholder={props.placeholder}
      searchable allowCustom                     // 四类恒 true：保留自由输入兜底
      loading={list.isLoading} loadingLabel={labels.loading} emptyLabel={labels.empty}
      data-testid={props.testid}
    />
    {failed && <p className="muted …">{labels.loadFailed}</p>}   {/* 保留现状告知 */}
  </div>
)
```

### 3.2 filter 语义：「排除已选」→「资格过滤 + 并集」

旧 `filter` 把已选**排除出下拉**（它们另在胶囊区显示）。多选下拉里已选必须**留下并勾中**，
故候选 = `eligible(item) OR 已选`。wrapper 只保留"资格"子句：

- `PluginsPicker`：`filter={(p) => p.enabled}`（去 `!existing.has`；描述含 `resolvedVersion`）。
- `AgentDependsPicker`：`filter={(a) => a.name !== selfName}`（去 `!existing.has`）。
- `SkillsPicker` / `McpsPicker`：无 `filter`（默认全通过）。

**已选但失去资格**（如插件选后被 disable、agent 选后自身改同名）：因并集，它**仍在下拉、
勾中、可取消**（P1-1）；未选的无资格项则不可加。测试锁这两条（§8）。

### 3.3 wrapper 改动（薄壳）

四 wrapper：filter 去 existing 子句；`labelFn=name`、`descriptionFn=description`
（Plugins 额外拼 `resolvedVersion`）；**新增 `ariaLabel`**（＝各自 field label）。`queryKey` /
`endpoint` / `*_QUERY_KEY` 导出**不变**（`agent-form-mcp-picker.test.ts` 源码断言、
`DependencyAutodetectButton` 的 `*_QUERY_KEY` 复用仍成立）。

## 4. AgentForm `resources` 两组重排（AC-1）

`Field` 最小扩展（`Form.tsx`）：加可选 `icon?: ReactNode`（渲染于 label 前，`.form-field__icon`）。
**四个资源 Field 传 `group`**（**P1-3**：`Field` 默认 `<label>` 包裹会隐式绑定到第一个按钮；
含 chip×/option 按钮的控件组必须走 `group`→`<div>`，见 `Form.tsx:13-20`）。

```tsx
const resources = (
  <>
    <section className="resource-group" aria-labelledby="rg-cap">
      <header className="resource-group__header">
        <span className="resource-group__icon" aria-hidden>{CAP_ICON}</span>
        <span id="rg-cap" className="resource-group__title">{t('agentForm.groupCapabilities')}</span>
        <span className="resource-group__hint">{t('agentForm.groupCapabilitiesHint')}</span>
      </header>
      <Field group label={t('agentForm.fieldSkills')} hint={…} icon={SKILL_ICON}>
        <SkillsPicker … />
      </Field>
      <Field group label={t('agentForm.fieldMcps')} hint={…} icon={MCP_ICON}>
        <McpsPicker … />
      </Field>
      <Field group label={t('agentForm.fieldPlugins')} hint={…} icon={PLUGIN_ICON}>
        <PluginsPicker … />
      </Field>
    </section>
    <section className="resource-group" aria-labelledby="rg-dep">
      <header className="resource-group__header">
        <span className="resource-group__icon" aria-hidden>{DEP_ICON}</span>
        <span id="rg-dep" className="resource-group__title">{t('agentForm.groupDependencies')}</span>
        <span className="resource-group__hint">{t('agentForm.groupDependenciesHint')}</span>
      </header>
      <Field group label={t('agentForm.fieldDependsOn')} hint={…} icon={AGENT_ICON}>
        <AgentDependsPicker … />
      </Field>
      <DependencyAutodetectButton … />     {/* 用户选定：并入依赖组 */}
      <DependencyTreePreview … />
    </section>
  </>
)
```

图标：**6 个** inline SVG（能力组 + 依赖组 各 1 个组图标；技能 / MCP / 插件 / 依赖代理 4 个
类型图标），line-icon 惯例（`stroke="currentColor"`、16px viewBox），集中放
`components/icons/resourceIcons.tsx`。`patch('skills'|'mcp'|'plugins'|'dependsOn', …)` 调用点
一字不改（AC-7）。

## 5. 数据流 / wire（AC-7）

`value.skills/mcp/plugins/dependsOn` 全程 `string[]`，`MultiSelect.onChange` 回 `string[]`；
`patch(...)` 与 `onChange({...value, [k]: next})` 不变。`routes/agents.detail.tsx` 的
`agentToDraft`（`:33` 附近）与 PUT payload 构造（`:54-62`）**零改动** ⇒ round-trip 逐字节一致。
`resourceRefCount`（`AgentForm.tsx:68`）纯函数不动。**无 migration、无 schema。**

## 6. 失败模式

| 场景 | 处理 |
|------|------|
| 候选查询失败 | `options=[]`；`allowCustom` ⇒ 仍可自由输入；框下 muted 显示 `labels.loadFailed` |
| 候选查询在途 | `loading` → 下拉单行 `loadingLabel`；标签照显；可开下拉 |
| 已选值不在 options（删 / 前向引用 / 失去资格） | MultiSelect 合成勾中行（label=name）→ 下拉可取消 + 触发区可删；无崩溃（P1-1/P1-2） |
| 空候选 | 下拉单行 `emptyLabel`；`allowCustom` 仍可输入 |
| 点 option 致 input blur | **不**误提交 custom（未接 `handleBlur`，P1-4） |
| 超长列表 | 下拉 `max-height` + `overflow-y:auto`（共享 `.select__listbox`） |
| CJK IME 合成 | keydown 守 `isComposing`（P1-4） |
| 外点 / Esc | 外点不夺焦点；Esc 回 input（P1-4） |
| portal 被 `overflow:hidden` 裁剪 | `usePopoverPosition` + portal-to-body |
| 下拉打开时 `value` 外部变化 | 受控渲染，勾选态实时反映，无镜像 state |

## 7. 决策点（用户批准前确认）

- **D1 `usePopoverPosition` 收编三处（Select + UserPicker + MultiSelect，3→1）**：**定为全收**
  （P2-3 R2：新 hook 自测〔§2〕即补足守卫，"测试不足"不构成跳过 dedup 的理由；三处逐字拷贝
  不容留第二/三份）。仅在用户显式要求最小 blast radius 时才退为 Select+MultiSelect。
- **D2 自由输入（`allowCustom`）保留** vs. 纯列表。默认保留（现状 `ChipsInput` 即有，删＝回退；
  前向引用/接口失败兜底需要）。
- **D3 下拉行两行（name + description）** vs. 单行。默认两行。
- **D4 自动检测按钮并入"依赖"组**：用户澄清预览已选定，非待议。
- **D5 移除 `ResourcePicker.nameOf` 泛化 + 泛型约束 `T extends {name:string}`**（P1-2/P2-1）：
  **定为移除**（无生产调用方，value≡name 消除机器-id-标签隐患，约束替代 unsafe cast）。
- **D6 删除 4 个旧 `*PickerLabel` key + `ResourcePickerLabels.pick` 字段**（P2-2）：**定为删除**
  （多选无独立"pick"触发文案，空态用既有 `placeholder`）；连带 `agent-form-mcp-picker.test.ts`
  改写（去 `mcpsPickerLabel` 断言）——见 §8/§9。

## 8. 测试策略（Test-with-every-change；映射 P1-6 逐条补强）

### 新增
- `hooks/…/use-popover-position.test.ts`（P2-1）：mock rect + scroll/resize + cleanup。
- `tests/multi-select.test.tsx`：
  1. `value`→标签；空→placeholder；不在 options 的 value → 合成勾中行 + 标签显 name（非 id）。
  2. 开下拉列 options，`aria-selected` = `value.includes`。
  3. 点行 toggle：未选→`onChange([...v, x])`、已选→`onChange(去 x)`；**下拉不关**。
  4. 搜索过滤（label + description，大小写不敏感）。
  5. `allowCustom`：无匹配 Enter 提交；`allowCustom=false` 无"添加"行；**点 option 致 blur 不误提交**。
  6. 空 input Backspace 删末；点 `×` 删对应。
  7. a11y：`combobox`(input) + `listbox[aria-multiselectable]` + `option[aria-selected]`；方向键
     移动、Enter toggle、**Space 只输入**、Esc 回焦 input、外点关且不夺焦点。
  8. `loading`/`emptyLabel`/`disabled`；IME 合成中 Enter/Space 不 toggle/不提交。
  9. **active-row 不变式（P1-1 R2）**：聚焦后**直接 Enter**（不先按方向键）toggle 首行；过滤后
     直接 Enter toggle 首个匹配；过滤到零 + `allowCustom` 时 Enter 提交 custom；外部 `value`
     变化后 active 不悬空（`aria-activedescendant` 指向有效行或被移除）。
  10. **value 唯一（P2-1 R2）**：options 覆盖某已选 value 时**只渲染一行**（不与合成行重复）；
      `value` 含重复项时去重显示。
- `tests/agent-resources-groups.test.tsx`（AC-1/6，P1-6）：
  - 渲染层断言两组标题（`groupCapabilities`/`groupDependencies`）；**技能/MCP/插件在能力
    section、依赖代理 + 自动检测按钮 + 依赖树在依赖 section**（用 section 容器 + `within` 定位归属）。
  - **6 个图标全存在且互异**（P2-4 R2：2 组图标 + 4 类型图标，比对 `data-icon`——防两个组图标
    被复用/遗漏而测试仍绿）。
- `tests/plugins-picker.test.tsx`（P1-6 新）：锁 `enabled` 资格拆解（disabled 插件不在候选但已选
  时可取消）+ 版本描述进副行。
- `tests/agent-put-body.test.ts`（AC-7，P1-6）：断言最终 PUT body（`agents.detail.tsx` 构造）
  逐字段保留 skills/mcp/plugins/dependsOn（不止 `agentToDraft`）。

### 改写
- `resource-picker.test.tsx`：重锁新契约——候选 = 资格 ∪ 已选（已选留下拉勾中，**删除旧
  "排除已选"断言**）；资格 filter 仍作用未选行；toggle add/remove 经 `onChange`；查询失败→
  自由输入 + `loadFailed`；`testid`/`combobox` 落 input。**删除 `nameOf` 用例**（D5 移除该 prop），
  改为断言"value 即 name、标签始终可读"。
- `skills-picker.test.tsx` / `agent-depends-picker.test.tsx`：交互断言由"下拉选一个→胶囊区"改为
  "开下拉→勾选→标签 + 勾中态"；保留 self 排除、query-key 复用意图。
- e2e `a11y.spec.ts`（P1-6）：现仅访问 Basics/Advanced；**新增打开 Resources tab、预置 ≥1 已选
  标签、分别 axe 扫描触发区与打开的 portaled listbox**（覆盖嵌套按钮/多选 a11y）。
- `agent-form-mcp-picker.test.ts`（**P2-2 R2：从"保持绿"移来**）：其大部分断言（`import
  McpsPicker`、`patch('mcp', v)`、`MCPS_QUERY_KEY`、`endpoint="/api/mcps"`、`ResourcePicker` 含
  `useQuery`+`api.get(props.endpoint`）改写后仍成立；但它硬锁 `mcpsPickerLabel:`（`:71`）——D6
  删该 key ⇒ **必须去掉这一条断言**（其余保留）。

### 保持绿（不改）
- `agents-detail-mcp-plugins-roundtrip.test.ts`（纯 `agentToDraft`）。
- `agent-form-tab-badges.test.ts`（`resourceRefCount` 纯函数）。
- `agent-form-sections.test.tsx`（五页签外壳 + badge，不锁 resources 内部）。
- `agents-new-snapshot.test.tsx`：**它只测 `applyDefaults`、非布局快照**（P1-6 勘误）——本 RFC
  不影响它，无需"刷新"。
- `select.test.tsx` / `select-searchable.test.tsx` / UserPicker 测试（`usePopoverPosition` 抽取后
  仍全绿，D1 守卫）。

### AC-3 源码锁（修正，P1-6）
旧提法"断言 AgentForm 不叠 Select+ChipsInput"**无效**（AgentForm 本就只渲染 wrapper，旧组合在
`ResourcePicker` 内）。改为：**断言 `ResourcePicker.tsx` 只 import/render `MultiSelect`，不含
`Select` / `ChipsInput`**（`multi-select.test` 或 `resource-picker.test` 顶部源码断言）。

### i18n parity
`i18n-keys-symmetry.test.ts` **确实存在**（非"若有"）；新增/改写键必须 zh/en 对称，跑绿。

## 9. i18n（新增 + **改写既有**）

新增：
```
agentForm.groupCapabilities        能力 / Capabilities
agentForm.groupCapabilitiesHint    注入到该代理进程内、供其调用 / Injected into this agent's process
agentForm.groupDependencies        依赖 / Dependencies
agentForm.groupDependenciesHint    该代理可委派调用的其他代理 / Other agents it can delegate to
multiSelect.addCustom              添加「{{token}}」 / Add "{{token}}"
multiSelect.toggleOptionAria       切换 {{label}} / Toggle {{label}}
（搜索占位 / 无匹配 / 移除标签 复用 common.searchEllipsis / common.noMatches / common.removeAria）
```

**改写既有（P1-7，否则文案反驳新 IA）**：
- `fieldMcps`：`MCP dependencies`→`MCP servers` / `MCP 依赖`→`MCP 服务`；`fieldPlugins`：
  `Plugin dependencies`→`Plugins` / `插件依赖`→`插件`（它们现归"能力"组，不再叫"依赖"）。
- `skillsPickerEmpty` / `mcpsPickerEmpty` / `pluginsPickerEmpty` / `dependsPickerEmpty`：去掉
  "all added"语义（不再排除已选）→ 改为"（无可用 / 尚未注册）"。
- `*PickerLoadFailed`：措辞"在下方手动输入"→"可直接输入"（自由输入已并入同一控件）。
- `*PickerLabel`（旧下拉触发文案 `pick`）：**删除**（D6，P2-2）4 个 key
  （`skillsPickerLabel`/`mcpsPickerLabel`/`pluginsPickerLabel`/`dependsPickerLabel`）+
  `ResourcePickerLabels.pick` 字段 + 四 wrapper 的 `pick:` 传参；空态 placeholder 用既有
  `fieldXxxPlaceholder`。连带改 `agent-form-mcp-picker.test.ts`（去 `mcpsPickerLabel` 断言，§8）。

## 10. CSS（共享基类，非克隆——P2-3）

- 下拉复用：`.select__listbox, .multi-select__listbox { … }` 等 **grouped selector 真共享**
  （`__option` / `__option-check` / `__option-stack/title/sub` / `__search` 同法），只为
  MultiSelect 独有的 **trigger/token 布局**写 `.multi-select__field`（复用 `.chips-input__row`）
  / `.multi-select__add-custom`。避免"克隆"导致样式漂移。
- `.resource-group` / `__header` / `__title` / `__hint` / `__icon`；`.form-field__icon`。
- 明暗双主题：全走 `var(--*)` token，不写死色值（沿用 Select/chip 变量）。

## 11. 门槛（P1-5 修正）

前台单 PR、无 migration。commit 前**五门**（P1-3 R2：`bun run test` 是后端、前端 vitest 独立、
CLAUDE.md:56 明文要求根 `bun run test` 绿，二者都要）：
```
bun run typecheck &&
bun run lint &&
bun run test &&                                   # 后端/shared（bunfig root=backend）
bun run --filter @agent-workflow/frontend test && # 前端 vitest（CI ci.yml:97-98 同命令）
bun run format:check
```
（[[reference_ci_test_scope]]：bunfig root=backend，前端 vitest 不能替代根测试。）推后查 CI
（含 Playwright e2e——Resources tab 新 axe 用例 + `/agents` 视觉基线如涉及需刷新，
[[reference_visual_baseline_settings_default_tab]]）。

## 12. 设计门收敛记录

- **R1（0 P0 / 7 P1 / 3 P2）全折**：P1-1 候选并集（已选恒可在下拉取消）· P1-2 移除 `nameOf`
  （消机器-id 标签）· P1-3 div 字段 + input combobox + Field `group` + `ariaLabel`· P1-4
  Space/IME/blur/焦点自洽· P1-5 门槛加前端 vitest 命令· P1-6 测试补强· P1-7 改写既有 i18n·
  P2-1 hook 自测· P2-2 UserPicker 收编· P2-3 图标 6 个 / `.tsx` 路径 / 共享基类非克隆。
- **R2（NEEDS-ATTENTION，0 P0 / 3 P1 / 4 P2）全折**：P1-1 R2 active-row 不变式（打开/过滤/外部
  变化落首行、clamp、null 移 activedescendant、custom 行同索引 → "聚焦即 Enter"恒有反应）·
  P1-2 R2 **API 勘误**（`usePopoverPosition` 改 nullable 泛型签名；`useChipsCommit` **不返回**
  `onRemoveLast`，MultiSelect 只取 `pending/commit`、自写 `removeLast`）· P1-3 R2 门槛补回根
  `bun run test`（**五门**）· P2-1 R2 value 唯一（DB unique + value-set 去重 + 泛型约束
  `T extends {name:string}`）· P2-2 R2 `*PickerLabel` **定为删除**（D6）+ 连带改
  `agent-form-mcp-picker.test.ts`· P2-3 R2 UserPicker 收编**定死**（D1，非可退让；Esc 是新增
  增强非"与 UserPicker 一致"，后者无键盘态机）· P2-4 R2 图标测试锁**6 个** `data-icon` 全存唯一。
- **下一步**：实现门（编码后）再跑一轮 Codex 评审。
