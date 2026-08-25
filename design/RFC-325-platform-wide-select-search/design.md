# RFC-325 技术设计 —— 全平台下拉框搜索能力

## 0. 一句话

把「要不要搜索」从 **128 个调用点各自的记性**收进 **`Select` 这一个共享原语的默认值**（`options.length >= 8`），并把仓内散成四份的搜索匹配 / 归一化逻辑收敛到**一个纯函数模块**。

## 1. 落位与架构对齐（CLAUDE.md §RFC workflow 第 8 条）

本 RFC 是**纯前端共享组件层**改动：不新增 API、不动数据库、不触及任何后端 bounded context，因此 RFC-294（后台分层目标架构）的 bounded context / 分层落位**不适用（N/A）**。

对应到前端侧的等价原则（CLAUDE.md §Frontend UI consistency），本 RFC 是**正向**的：

- 不新增组件、不 fork 既有原语——只**最小扩展** `Select` 的默认值语义；
- 把重复第四遍的"归一化 + 匹配"抽成**单一事实源纯函数**，`Select` / `MultiSelect` / `user-permissions` / `runtime-parameters` 共用；
- 删掉调用点手写的阈值表达式（`CodeHostCallEdit.tsx:906`），把该判断上收原语。

**偏离项**：无（见 §7 的实现取舍 D1 —— 那是无障碍/输入法约束下的唯一正确形态，不是对既定架构的偏离）。

## 2. 新增：搜索匹配纯函数模块

新文件 `packages/frontend/src/lib/option-search.ts`。零依赖、零 React、可直接单测——符合 CLAUDE.md「首选可断言面：抽出纯函数」。

```ts
/**
 * 搜索文本归一化。搜索词与被搜文本必须走同一个函数，否则「全角能不能搜到半角」
 * 这类问题会随调用方各自实现而漂移。
 *   NFKC        —— 全角 ＡＢＣ ≡ 半角 abc、兼容汉字/罗马数字等价形
 *   locale 小写 —— 土耳其语 I/ı 这类 locale 相关折叠（本仓 zh-CN / en-US）
 *   空白折叠    —— 连续空格与换行归一为单空格，再 trim
 */
export function normalizeSearchText(value: string, locale?: string): string

/**
 * 逐字段匹配：任一字段（归一化后）包含归一化后的查询词即命中。
 * 空 / 全空白查询恒真。
 *
 * 刻意「逐字段」而非「拼成一个 haystack」：拼接会让 "alpha beta" 意外跨字段
 * 命中（label 结尾 + description 开头），用户看不出为什么这行会被搜出来。
 * runtime-parameters 的面包屑搜索是**故意**要跨字段的，它保留自己的拼接实现，
 * 只共用 normalizeSearchText。
 */
export function matchesSearchQuery(
  fields: ReadonlyArray<string | undefined | null>,
  query: string,
  locale?: string,
): boolean
```

## 3. `Select` 的改动（`components/Select.tsx`）

### 3.1 默认值：条件开启

```ts
/** 选项数达到该阈值时 Select 默认开启搜索。显式 searchable 优先于它。 */
export const SELECT_SEARCH_THRESHOLD = 8

// 组件内：
const searchable = props.searchable ?? props.options.length >= SELECT_SEARCH_THRESHOLD
```

- 判据用 **`props.options.length` 原始长度**，含占位行、含 `disabled` 行、含分组行。理由：可预测、与调用方看到的数组一致；若改用"可选项数"，`ModelSelect` 的空行 + `__custom__` 哨兵会让作者算不清什么时候会出搜索框。
- `searchable?: boolean` 的 **prop 签名与语义不变**，只是省略时的默认值从 `false` 变为条件式。传 `false` 仍强制关闭、传 `true` 仍强制开启（A2）。
- 组件内所有 `props.searchable !== true` / `=== true` 的判断（现 `Select.tsx:162 / 226 / 309 / 330 / 440`）统一改读这个局部 `searchable`。

### 3.2 匹配面扩到 4 个字段

```ts
const visible = useMemo(() => {
  if (!searchable) return props.options
  return props.options.filter((o) =>
    matchesSearchQuery([o.label, o.value, o.description, o.group], query, i18n.language),
  )
}, [props.options, searchable, query, i18n.language])
```

`i18n.language` 由 `useTranslation()` 取（组件已在用 `t`，改成 `const { t, i18n } = useTranslation()`）。

**顺带修掉一处既有重复**：`Select.tsx:450-465` 的搜索框 `onChange` 里手抄了一份**与 `visible` 逐字重复**的过滤逻辑（只为算出新的 `activeValue`）。改为复用同一个 `matchesSearchQuery`，消除"改了一处忘了另一处"的漂移面。

### 3.3 Esc 两段语义

`onListKey` 的 Escape 分支：

```ts
} else if (e.key === 'Escape') {
  // 仍然先 stopPropagation：Select 可能在 Dialog 内，第一次 Esc 只作用于本层
  // （RFC-194）。两段语义把「清词」插在「关闭」之前，不改变无词时的行为。
  e.stopPropagation()
  e.preventDefault()
  if (searchable && query !== '') {
    setQuery('')
    setActiveValue(props.options[firstEnabledIndex(props.options)]?.value ?? null)
    return
  }
  setOpen(false)
  triggerRef.current?.focus()
}
```

`onTriggerKey` 的 Escape 分支（打开瞬间焦点交接期）不变——那时必然无词。

### 3.4 不变的部分

打开时的焦点交接（`Select.tsx:220-232`，searchable → 聚焦搜索框，否则聚焦 listbox）、`aria-activedescendant`、↑↓/Home/End/Enter、Tab 关闭、IME 合成守卫（`onListKey` 首行 `isComposing` 早退）、三态空行（RFC-250）、分组表头、`renderOption` / `renderValue` / `renderUnknownValue`、portal 定位（`usePopoverPosition`）——**逐字不动**。

阈值以下的下拉，首字母 typeahead（`Select.tsx:328-360`）与空格选中（`:309`）分支照旧生效，因为它们的条件读的就是同一个 `searchable`。

## 4. `MultiSelect` 的对齐（`components/MultiSelect.tsx:116-125`）

只改匹配实现，**不套阈值**：

```ts
const searchable = props.searchable !== false // 默认值不变
const filtered = useMemo(() => {
  if (!searchable) return rows
  return rows.filter((r) =>
    matchesSearchQuery([r.label, r.value, r.description], query, i18n.language),
  )
}, [rows, query, searchable, i18n.language])
```

**为什么 MultiSelect 不套阈值**：它的搜索输入框**就是控件本体**（chips 行尾那个 `role=combobox` 的 `<input>`，用户随时在打字），不是额外顶出来的 chrome。套阈值只会让"3 项时不能打字筛选"，纯粹是倒退。`MultiSelectOption` 没有 `group` 字段，故匹配面为 3 项。

## 5. 存量归一化实现的收敛

| 位置                                               | 现状                                                                                                             | 改法                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `lib/user-permissions.ts:41-55`                    | 私有 `searchable()`：NFKC + locale 小写；haystack 以 `\n` 拼接（实际等价逐字段）                                 | 改用 `matchesSearchQuery([label, description, rawId], search, locale)`。**行为等价**：原实现不折叠 `\n`，跨字段本来就搜不到 |
| `components/runtime-parameters/catalog.ts:257-282` | 私有 `normalizedSearch()`：NFKC + 小写 + 去 `{{`/`}}` + 空白折叠；**故意拼成单 haystack** 以支持面包屑跨字段搜索 | 内部改调 `normalizeSearchText`，去花括号那一步保留在本地；**拼接语义保留不动**                                              |
| `components/UserPicker.tsx`                        | 服务端搜索，无本地匹配                                                                                           | 不动（非目标 N2）                                                                                                           |

## 6. 调用点改动

唯一一处：`components/canvas/inspector/CodeHostCallEdit.tsx:906` 的 `searchable={selectOptions.length > 8}` **删除**——它与新默认值逐字等价，留着就是把已上收的判断又写回调用点。其余 24 处显式 `searchable` **全部保留**：它们都是运行时动态列表（代理 / 工作流 / 端口 / 数字员工 / 事件规则），作者已判定该场景需要搜索，且实际条目数常常本来就 ≥ 8。

## 7. 实现取舍（逐条呈确认）

- **D1（无障碍 / 输入法）**：搜索开启时 DOM 焦点落在**搜索输入框**而非 `<ul role="listbox">`。这不是偏好而是硬约束——IME 只能向获得焦点的可编辑元素合成文本，焦点留在 `<ul>` 上中文用户根本打不出字。用户可感知的行为与"焦点在列表"完全一致：列表里有一行高亮、↑↓ 移动它、Enter 选它，`aria-activedescendant` 让屏幕阅读器播报的仍是当前选项。这也是 WAI-ARIA 1.2 combobox+listbox 的标准形态，且**与已上线 25 处 searchable 的行为逐字相同**。
- **D2（阈值取 8）**：既与仓内既有先例（`CodeHostCallEdit.tsx:906`）一致，又让已抽查的四个高相关锁测（选项数 3/4/5/6）零改动通过。取更小值会把一批"小枚举"卷进来并推翻它们的 typeahead 锁测；取更大值（如 12）会让"40 个代理"以下的常见列表继续没有搜索。
- **D3（不加 `searchThreshold` prop）**：只保留 `searchable` 一个二值逃生舱。加了每调用点旋钮，等于把"各凭作者记性"换个名字回来。
- **D4（阈值判据用原始 `options.length`）**：见 §3.1。
- **D5（`renderOption` 的已知边界）**：两处 `renderOption` 调用点（`node-session/SessionTab.tsx:218`、`routes/settings.tsx:2984`）的行内容由回调渲染，而搜索匹配的是 `SelectOption` 的 `label / value / description / group` 字段。故约定：**用 `renderOption` 时 `label` 必须仍是这一行的可搜文本**。二者今天都满足；若将来某行只有富文本没有 label，作者应把可搜文本放进 `description`。

## 8. 失败模式

| 场景                                             | 行为                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 选项数恰好在 8 上下抖动（异步列表加载中/加载后） | 搜索框随之出现/消失。已开着的下拉重渲染时 `query` 保留；若搜索框消失（列表缩短到 < 8）则 `visible` 回落为全量 `props.options`——因为 §3.2 的 `if (!searchable) return props.options` 先于 query 判断，**不会留下一个搜不到也清不掉的过滤态** |
| 列表全部条目都不匹配                             | 走既有 RFC-250 三态：`common.noMatches`（源非空 + 过滤后为空）                                                                                                                                                                              |
| 源列表本来就空                                   | `common.noAvailableOptions`（与"无匹配"是两个不同的行 role=presentation）                                                                                                                                                                   |
| 过滤后剩下的全是 `disabled`                      | `common.allOptionsUnavailable`，`aria-activedescendant` 为空，Enter/空格不触发 onChange                                                                                                                                                     |
| 归一化拿到非法/超长输入                          | `normalize('NFKC')` 对任意字符串安全；无正则回溯风险（只有 `\s+` 折叠）                                                                                                                                                                     |
| `i18n.language` 尚未初始化                       | `toLocaleLowerCase(undefined)` 退化为默认 locale，不抛错                                                                                                                                                                                    |

## 9. 测试策略（CLAUDE.md §Test-with-every-change）

**新增** `packages/frontend/tests/option-search.test.ts`（纯函数）：

- 归一化：全角 `ＡＢＣ` ↔ `abc`；大小写；连续空白折叠 + trim；中文原样保留。
- 匹配：空/全空白查询恒真；逐字段语义（`"alpha beta"` **不**跨 `label`/`description` 命中）；`undefined` / `null` 字段安全跳过。

**新增** `packages/frontend/tests/select-search-default.test.tsx`（Select 默认值契约，对应验收 A1–A6）：

- `T-A1a` 7 项 → 无 `sel-search`；`T-A1b` 8 项 → 有 `sel-search`；`T-A1c` `SELECT_SEARCH_THRESHOLD === 8`。
- `T-A2` 20 项 + `searchable={false}` → 无搜索框；3 项 + `searchable` → 有搜索框。
- `T-A3` 8 项列表里按 `description` 命中；按 `group` 命中。
- `T-A4` 全角查询命中半角标题；中文子串命中中文标题。
- `T-A5` 有词 Esc → 词清空、`listbox` 仍在、选项回到全量；无词 Esc → `listbox` 消失、焦点回 trigger；两种情况父级 `onKeyDown` 都收不到事件。
- `T-A6` 7 项列表上敲首字母跳转生效、空格选中生效（锁 G5 不被误伤）。

**新增（源码棘轮，A7）**：并入既有 `packages/frontend/tests/ux-source-ratchets.test.ts`（RFC-198，全前端源码棘轮的既有归属地）：

- 断言全仓不存在 `searchable={<任意>.length > <数字>}` 形态的调用点（禁止把阈值写回调用点）；
- 断言 `Select.tsx` 与 `MultiSelect.tsx` **都** import 了 `matchesSearchQuery`（钉死单一匹配实现）；
- 该棘轮属 `assertsAbsence`，按 RFC-317 规矩配**负 fixture**（构造一个含违规形态的假源串，断言 matcher 会咬中它）——否则"语料还在但 matcher 不咬了"与"合规"同形。
- 该文件已登记在 `architecture/guard-manifest.json`（`id: ux-source-ratchets`，`lines: 521`），新增断言后需同步其 `lines`。

**回归防护（既有锁测）**：`select-searchable.test.tsx` / `select-groups.test.tsx` / `kind-select.test.tsx` / `model-select.test.tsx` 的选项数分别为 3–4 / 5 / 4 / 6，全部低于阈值，预期零改动通过；`multi-select.test.tsx` 补一条全角/描述匹配用例。

**e2e**：不新增。已核查全部 11 处 e2e combobox 交互（`agent-port-editor` / `rfc310-zero-config-onboarding` / `rfc295-runtime-parameter-picker` / `visual-regression`）都是"点 trigger → 点 option"，不依赖焦点落点、不打字；`visual-regression.spec.ts` 无任何一张基线截的是**展开中的** Select listbox（`:1564` 那处选完即关），故视觉基线预期零变化。实现期以实跑为准。
