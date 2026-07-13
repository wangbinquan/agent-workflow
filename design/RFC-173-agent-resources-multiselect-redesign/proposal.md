# RFC-173 代理配置「资源与依赖」界面重构（标签多选 + 能力/依赖分组）

状态：Draft

## 背景

Agent 配置页（`/agents/new`、`/agents/$name`）的 `AgentForm` 中，"资源与依赖"
（Resources & deps，RFC-169 T7 起是右栏第 4 个 tab）承载四类引用：技能（`skills`）、
MCP 服务（`mcp`）、插件（`plugins`）、依赖代理（`dependsOn`）。

现状实现（`components/AgentForm.tsx` 的 `resources` 面板 + `components/ResourcePicker.tsx`，
RFC-151 PR-2 已把四份重复收敛成一份共享实现）：四类各渲染一个**字节级相似**的
`ResourcePicker` —— 上面一个单选 `Select` 下拉「选一个加进来」，下面一个 `ChipsInput`
把已选项摊成一排可删除胶囊。四个控件无差别地竖排堆叠。

用户反馈（2026-07-13）：

> 代理配置页面的资源与依赖界面太丑了，技能、mcp、插件、agent都没明显区分关系，
> 并且现在的选项还是一个选择一个胶囊显示，界面太冗余了。

拆解三个痛点：

1. **视觉单调 / 丑**：四个同款控件裸堆，无图标、无分组、无强调色，是一片灰白线框。
2. **关系不清**：技能·MCP·插件是"注入到代理进程内、供其调用的能力"，而依赖代理是
   "该代理可委派调用的下游 agent"——两种语义不同的关系，却被渲染成完全一样的控件，
   用户无从区分。
3. **交互冗余**：「下拉框选 + 独立胶囊区展示」是两段式，一个"加一项"动作占用两块 UI；
   四类 × 两段 = 八块，纵向臃肿。

## 目标

用户已在设计澄清中拍板两个承重方向（2026-07-13）：

1. **交互＝标签多选框**：用 token multi-select 替代"下拉 + 独立胶囊区"。每类资源一个
   输入框，框内内联显示已选标签（可删），点右侧箭头展开**可搜索的勾选下拉**（行内
   checkbox + 名称 + 描述），勾选即加、取消勾选即删——把"选"与"显示"合并进同一控件，
   消除两段式冗余。
2. **结构＝分两组**，用组标题讲清两种关系：
   - **能力**（注入到该代理进程内、供其调用）：技能、MCP 服务、插件
   - **依赖**（该代理可委派调用的其他代理）：依赖代理 ＋ 依赖关系树预览 ＋ 自动检测
3. 给每类资源配**专属图标**，让四类一眼可辨。
4. 全程复用/最小扩展公共原语；新增的标签多选框本身作为**可复用公共组件**
   `MultiSelect` 落地（放 `components/MultiSelect.tsx`），供后续（工作流节点覆盖、任务
   启动表单等）复用，而非塞成 AgentForm 的私有助手。

## 非目标

- **不改后端 / 数据模型 / wire**：`CreateAgent` 仍是 `skills/mcp/plugins/dependsOn: string[]`；
  本 RFC 纯前台呈现层，保存 / 加载 payload 逐字节不变。
- **不改依赖树与自动检测的逻辑**：`DependencyTree` / `DependencyTreePreview` /
  `DependencyAutodetect*` 行为不动，仅把它们在 tab 内的**位置归属**并入"依赖"组。
- **不动 AgentForm 其余四个 tab**（Basics / Prompt / Ports / Advanced）。
- **不引入图标库依赖**：沿用仓内 inline SVG + `stroke="currentColor"` 惯例（如
  `ChoiceCards` 的 `icon` 槽）。
- **不废弃 `ChipsInput`**：其他自由字符串数组输入（如 outputs 场景）仍用它；
  `MultiSelect` 是并列的新原语，不是替换。
- 不改 canvas 内的节点检视器（`AgentSingleEdit` 等）——那是另一处 UI，超出本 RFC。

## 用户故事

- 作为 agent 作者，我打开"资源与依赖"tab，一眼看到"能力"与"依赖"两组分区，立刻明白
  技能/MCP/插件是给这个 agent 装的工具，依赖代理是它能叫的其他 agent。
- 作为 agent 作者，我在"技能"框里点箭头，弹出带搜索的清单，勾掉 3 个技能，框里立刻
  出现 3 个标签；点标签上的 `×`、或在下拉里再取消勾选，都能移除。
- 作为 agent 作者，某个资源列表接口临时挂了，我仍能在框里直接打字加一个名字（自由
  输入兜底），表单不至于卡死（保留现状 `ChipsInput` 兜底能力）。
- 作为 agent 作者，我引用了一个尚未创建的 agent 名（前向引用），或引用的技能后来被
  删了——多选框把这些值仍作为标签保留、不吞掉，保存时后端校验照旧提示。

## 验收标准

（AC 编号，供 `plan.md` 逐条兑现 + 测试锁定；映射见 `plan.md §验收清单`。）

- **AC-1 两组布局**：resources 面板渲染"能力""依赖"两个分组（各带标题 + 一句关系说明）；
  技能/MCP/插件在能力组，依赖代理 + 依赖树 + 自动检测在依赖组。
- **AC-2 标签多选框**：每类资源用 `MultiSelect` 渲染；已选项以标签内联显示在触发区；
  点箭头展开 listbox，行内 checkbox 反映选中态，勾选/取消更新 `value`。
- **AC-3 消除两段式**：resources 面板不再出现"单选 `Select` 叠一个独立 `ChipsInput`
  胶囊区"的组合（源码层文本断言 + 行为断言双锁）。
- **AC-4 搜索**：下拉带搜索框，按名称/描述过滤（复用 `Select` searchable 范式）。
- **AC-5 自由输入兜底**：列表接口失败时可自由打字提交标签；已选但不在列表中的值
  （已删资源 / 前向引用）仍渲染为可删标签、不丢失。
- **AC-6 图标区分**：四类各有专属 inline SVG 图标（挂在各自 `Field` 上）。
- **AC-7 wire 不变**：保存/加载 round-trip（`agentToDraft` + PUT payload）与改造前一致；
  `resourceRefCount` tab badge 计数不变。
- **AC-8 a11y**：`MultiSelect` 具备 `combobox` / `listbox` / `option` role +
  `aria-multiselectable` + 键盘（方向键移动、Enter/Space 切换、Esc 关闭、Backspace 删末
  标签、CJK IME 合成保护），role 断言进测试。
- **AC-9 公共原语**：`MultiSelect` 落 `components/MultiSelect.tsx`，有独立 i18n、
  `.multi-select` 命名空间样式、单测；四个 wrapper（Skills/Mcps/Plugins/AgentDepends
  Picker）保持薄配置壳，调用点 `patch('skills'|'mcp'|'plugins'|'dependsOn', ...)` 不变。

## 与既有约束的关系

- 遵循 CLAUDE.md「前台界面统一风格」：优先复用/最小扩展公共原语。`MultiSelect` 是共享库
  确实缺失的一类（现有 `Select` 单选、`ChipsInput` 自由字符串、`ChoiceCards` 单选卡片
  都不覆盖"从已知列表多选 + 标签展示"），按"新增公共组件"对待。
- 遵循「Test-with-every-change」：新组件正向/边界/错误路径全覆盖，改造点带回归锁。
