# RFC-173 任务分解

单 PR（前台，无 migration）。子任务按依赖排序；每个子任务落地即带对应测试
（Test-with-every-change）。commit 前缀：`feat(frontend): RFC-173 …`。
（设计门 R1〔0 P0/7 P1/3 P2〕+ R2〔0 P0/3 P1/4 P2〕已全折入 design.md，任务据收敛版本展开。）

## 任务

### RFC-173-T1 — `usePopoverPosition` 抽取（3→1，D1 定死）
- 新 `packages/frontend/src/hooks/usePopoverPosition.ts`：搬 `Select.tsx:89-113`（≈
  `UserPicker.tsx:54-82`）的定位 effect（window-scroll 坐标 + scroll(capture)/resize 重算 +
  open 清理）。**签名 nullable 泛型**（P1-2 R2）：`<T extends HTMLElement>(ref: RefObject<T|null>,
  open)`——匹配 Select/UserPicker 的 `useRef(null)`（React 19 类型 `RefObject<T|null>`）。
- `Select.tsx` + `UserPicker.tsx` **均**改用该 hook（删本地 `popPos` state + effect），行为等价——
  三处逐字拷贝→一份（**定死收编、非可退让**，P2-3 R2）。
- 测试：新 `use-popover-position.test.ts`（P2-1：mock `getBoundingClientRect` + 派发
  scroll/resize + 断言 open→pos、close→listener cleanup，作 dedup 守卫）；`select*.test`/
  UserPicker 测试全绿。
- 依赖：无。

### RFC-173-T2 — `MultiSelect` 公共原语（AC-2/4/5/8/9）
- 新 `components/MultiSelect.tsx`：契约见 design §1。**结构对齐 `UserPicker`**（`.chips-input__row`
  div 字段 + `.chip` 标签 + trailing `<input role="combobox">` + portaled `<ul role="listbox"
  aria-multiselectable>`）。要点：
  - 每个 `value` 保证在 listbox 有行（**按 value-set**：options 已覆盖者用其行、仅未覆盖者合成
    勾中行，不重复渲染同一 value）——已选恒可下拉取消（P1-1 + P2-1 R2）。
  - **active-row 不变式**（P1-1 R2）：打开/过滤/`options`·`value` 外部变化 → 落首个可交互行、
    结果变化 clamp、无行则 `null` 且移除 `aria-activedescendant`；custom 行参与同一键盘索引 ⇒
    "聚焦即 Enter""过滤即 Enter"恒有反应。
  - `ariaLabel` 必填（Field group→div，input 自带可及名，P1-3）。
  - 焦点/事件模型（P1-4 + P1-2 R2 勘误）：Space 只输入、Enter 作用于 active 行（候选 toggle /
    custom 提交）、Esc 回焦 input、外点不夺焦、**自写 IME-守 keydown**；`useChipsCommit` **只取
    `pending/setPendingValue/error/commit`**（它**不返回** `onRemoveLast`），**删末标签用自写
    `removeLast=()=>onChange(value.slice(0,-1))`，不接其 `handleKeyDown`/`handleBlur`**。
  - 泛型 `MultiSelectOption.value` / `value[]` 按 value-set 去重（P2-1 R2）。
  - 复用 `usePopoverPosition`（T1）+ `.select__*` 下拉基类（共享，非克隆）+ `.chip`。
- 样式：`.multi-select__field` / `__add-custom` + grouped `.select__listbox, .multi-select__listbox`
  等（design §10）。
- i18n：新 `multiSelect.addCustom` / `toggleOptionAria`（复用 common.searchEllipsis/noMatches/removeAria）。
- 测试：`tests/multi-select.test.tsx`（design §8 新增 10 组，含合成行标签=name、blur 不误提交、
  Space 只输入、**active-row「聚焦即 Enter」/「过滤即 Enter」/「零候选 custom Enter」/外部 value
  变化不悬空**、**value 唯一不重复渲染**、IME、外点不夺焦、a11y role）。
- 依赖：T1。

### RFC-173-T3 — `ResourcePicker` 改写 + wrapper + i18n 文案（AC-2/3/5）
- `ResourcePicker.tsx`：Select+ChipsInput → 单 `MultiSelect`；**移除 `nameOf`** + 泛型约束
  **`T extends {name:string}`**（value≡name，替代 unsafe cast，P1-2/D5/P2-1 R2）；候选 =
  **资格 ∪ 已选**（P1-1）；新增 `ariaLabel`（P1-3）+ 可选 `descriptionFn`；`filter` 改纯资格谓词
  （去 `existing`）；失败降级 + `labels.loadFailed` muted。
- 四 wrapper 调参：Plugins `filter=(p)=>p.enabled` + 版本进副行；AgentDepends
  `filter=(a)=>a.name!==selfName`；Skills/Mcps 无 filter；四者 `labelFn=name` + `descriptionFn` +
  **`ariaLabel`**；`*_QUERY_KEY`/`endpoint` 不动。
- **改写既有 i18n（P1-7 + D6）**：`fieldMcps`→"MCP 服务/MCP servers"、`fieldPlugins`→"插件/
  Plugins"；`*PickerEmpty` 去"all added"；`*PickerLoadFailed`"下方手动输入"→"可直接输入"；
  **删除** 4 个 `*PickerLabel` key + `ResourcePickerLabels.pick` 字段 + 四 wrapper `pick:` 传参
  （空态用既有 `fieldXxxPlaceholder`）。
- 测试：改写 `resource-picker.test.tsx`（并集 / 删 nameOf 用例 / 资格过滤 / 失败降级 / testid 落
  input）；新 `plugins-picker.test.tsx`（enabled 拆解 + 已选 disabled 可取消 + 版本副行）；更新
  `skills-picker.test.tsx` / `agent-depends-picker.test.tsx` 交互断言；**改
  `agent-form-mcp-picker.test.ts` 去 `mcpsPickerLabel` 断言**（D6 删该 key，`:71`）；
  `i18n-keys-symmetry` 跑绿。
- 依赖：T2。

### RFC-173-T4 — `Field` 图标槽 + 资源图标集（AC-6）
- `Form.tsx` `Field`：加可选 `icon?: ReactNode`（label 前，`.form-field__icon`）；向后兼容。
- 新 `components/icons/resourceIcons.tsx`：**6 个** inline SVG（能力/依赖 2 组图标 + 技能/MCP/
  插件/依赖代理 4 类型图标），line-icon。
- 样式：`.form-field__icon`。
- 测试：`Form` Field icon 渲染最小断言（传 icon→出现在 label 前；不传→无）。
- 依赖：无（可与 T2 并行）。

### RFC-173-T5 — AgentForm resources 两组重排（AC-1/3/7）
- `AgentForm.tsx` `resources`：扁平四 Field → "能力/依赖"两 `resource-group`（design §4）；四
  Field 挂图标 + **传 `group`**（P1-3）；自动检测 + 依赖树并入依赖组；`patch(...)` 调用点不变。
- 新 i18n `agentForm.group*`。
- 新 `.resource-group*` 样式。
- 测试：新 `agent-resources-groups.test.tsx`（两组标题 + 四类分属正确 section + **6 个 `data-icon`
  全存且唯一**，AC-1/6，P2-4 R2）；新 `agent-put-body.test.ts`（PUT body 保留 4 数组，AC-7，
  P1-6）；AC-3 源码锁改断言 `ResourcePicker` 只 render `MultiSelect`（不含 Select/ChipsInput）。
- 依赖：T3、T4。

### RFC-173-T6 — 视觉自查 + a11y e2e + 收尾
- e2e `a11y.spec.ts`：新增打开 Resources tab、预置 ≥1 已选标签、分别 axe 扫触发区 + portaled
  listbox（P1-6）。
- 本地起 dev / minimal repro，明暗双主题截图，与 `/agents`、`/settings` side-by-side 核对按钮
  高度/圆角/spacing/字号/颜色一致（[[feedback_frontend_visual_verify_repro]]）。
- `resourceRefCount` badge、round-trip 手验（AC-7）。
- 依赖：T5。

## PR 拆分建议

默认**单 PR**。若评审要求可拆：PR-A＝T1+T2+T4（hook/新原语/图标槽，独立可测、不改现有交互）；
PR-B＝T3+T5+T6（接线 AgentForm + i18n 改写 + 交互/e2e）。

## 验收清单（AC → 兑现 / 测试）

- **AC-1** 两组布局 → T5；`agent-resources-groups` 断言两组标题 + 四类分属 section。
- **AC-2** 标签多选 → T2/T3；`multi-select` + `resource-picker`（含并集已选可取消，P1-1）。
- **AC-3** 消两段式 → T5；源码锁 `ResourcePicker` 只 render `MultiSelect`（修正 P1-6）。
- **AC-4** 搜索 → T2；过滤用例。
- **AC-5** 自由输入兜底 / 值不丢 → T2/T3；custom-token + 失败降级 + 合成行标签=name（P1-2）。
- **AC-6** 图标 → T4/T5；Field icon 断言 + **6 图标全存唯一**断言 + 视觉自查。
- **AC-7** wire 不变 → T5；`agent-put-body` + `roundtrip` + `tab-badges` 绿。
- **AC-8** a11y → T2/T6；role/键盘/焦点/IME/active-row 用例 + Resources tab axe（P1-6）。
- **AC-9** 公共原语 → T1/T2；`MultiSelect` + `usePopoverPosition` + i18n + 样式 + 单测；wrapper
  薄壳、调用点不变（`agent-form-mcp-picker` 仅去 `mcpsPickerLabel` 断言，其余绿）。

## 门槛（P1-5 + P1-3 R2）

- commit 前**五门**（根 `bun run test`=后端、前端 vitest 独立，二者都要——CLAUDE.md:56 +
  [[reference_ci_test_scope]] + [[feedback_prepush_gate_includes_lint]]）：
  `bun run typecheck && bun run lint && bun run test && bun run --filter @agent-workflow/frontend test && bun run format:check`
  全绿。
- 推后立即查 CI（[[feedback_post_commit_ci_check]]）；关注 Playwright e2e（新 Resources axe）+
  `/agents` 视觉基线（如涉及需刷新）。
- 实现门再跑一次 Codex 评审（[[feedback_codex_review_after_changes]]）。
