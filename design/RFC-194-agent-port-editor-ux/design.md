# RFC-194 技术设计

## 0. 当前事实与改动边界

### 0.1 当前数据形状

```ts
type AgentInputPort = {
  name: string
  kind: string
  required?: boolean
  description?: string
}

type CreateAgent = {
  inputs?: AgentInputPort[]
  outputs: string[]
  outputKinds?: Record<string, string>
  outputWrapperPortNames?: Record<string, string>
  role?: 'normal' | 'aggregator'
  // ...其余字段
}
```

`outputKinds` 与 `outputWrapperPortNames` 都以 output name 为 key。当前删除只清前者，端口也不可
重命名；一旦增加 rename，如果不同时迁移三份状态，就会把聚合配置悄悄留在旧 key 下。

还有两条兼容事实不能被新 UI 掩盖：

- schema 比现行新增控件宽：input name 只约束 1..128，output name 是任意 string，wrapper 暴露名
  只要求非空；`outputs` 也没有 uniqueness refine，因此导入/历史数据可能含非标准名或重复名；
- PUT 是 sparse patch，`JSON.stringify` 会省略 `undefined`。用户明确删除最后一个 sidecar 映射时，
  不能把“显式清空”退化为“字段未发送”。

### 0.2 保持不变

- `AgentForm` 五 tab、`TabPanels` keep-mounted、Ports badge 计数；
- `agentToDraft` / `agentToPutBody` 与 REST body；
- DB/agent.md wire schema（import parser 会补齐既有端口字段到表单字段的路由，但不新增字段）；
- `KindSelect` 接受的 kind grammar；
- 输入端口不进入 `nodePorts` / runner spawn；
- workflow validator 对失效 output 边的 fail-closed 行为。

## 1. 组件结构

`AgentForm` 的 `ports` 面板改为：

```tsx
<div className="agent-ports">
  <InputsEditor
    inputs={value.inputs ?? []}
    onChange={(inputs) => onChange({ ...value, inputs })}
  />
  <OutputsEditor
    outputs={value.outputs ?? []}
    outputKinds={value.outputKinds}
    outputWrapperPortNames={value.outputWrapperPortNames}
    aggregator={value.role === 'aggregator'}
    onChange={(outputs, outputKinds, outputWrapperPortNames) =>
      onChange({ ...value, outputs, outputKinds, outputWrapperPortNames })
    }
  />
</div>
```

不再用两个默认 `<Field>` 包整组控件。`InputsEditor` / `OutputsEditor` 各自渲染：

1. `FormSection` 标题；
2. 语义说明 + 数量 + 显式 Add 按钮；
3. 空列表时 `EmptyState size="compact"`；
4. 非空时 `.agent-port-list`，每项复用 `Card`；
5. 本 section 的卡片级 issue 与 orphan repair UI；完整 draft 的 detailed validation summary 只由
   `AgentForm` 在 Ports panel 统一渲染，editor 不各自复制；
6. 单个受控 `AgentPortDialog`（add/edit 两模式，共享 chrome 与校验）。

`InputsEditor` / `OutputsEditor` 仍保留为独立公共组件，既有测试和未来嵌入点不用穿透
`AgentForm`。两者共享 feature-level 原语：

```text
components/agent-ports/
  AgentPortCard.tsx
  AgentPortDialog.tsx
  AgentPortValidationSummary.tsx
lib/agent-ports.ts
```

`AgentPortCard` 只负责摘要与动作槽；输入/输出差异由 props 表达，不 fork 两套 card chrome。

## 2. Dialog 状态机

### 2.1 模式

```ts
type PortDialogMode =
  | { kind: 'add'; direction: 'input' | 'output' }
  | { kind: 'edit'; direction: 'input' | 'output'; index: number }
```

Dialog 自持完整临时草稿；父 `CreateAgent` 只接收已验证的提交：

```ts
interface PortDialogDraft {
  name: string
  kind: string
  required: boolean
  description: string
  wrapperPortName: string
}
```

- add 初值：name/description/wrapperPortName 为空，kind=`string`，required=false；
- edit 初值从目标端口与 sidecar 解包；wrapper 映射缺省时显示空（语义＝同名）；
- `open` 的 identity 包含 direction + mode + index，切目标时完整重播种；
- 关闭/取消只清本地草稿；
- 保存调用对应纯 helper 后关闭；
- `TextInput` 新增可选 `inputRef?: Ref<HTMLInputElement>` 并透传给原生 input；`initialFocusRef` 指向
  name input。打开 Dialog 时把当前 Add/Edit DOM 节点快照进稳定的 `useRef` 再作为 `triggerRef`，不能
  直接把随列表 render 变化的 index-map lookup 当 ref，避免 focus effect 因 identity 漂移重跑。

使用共享 `Dialog size="md"`，`closeOnOverlayClick={false}` 防止误点背景丢草稿；ESC/×/取消按
明确“放弃本次端口编辑”处理。由于端口 Dialog 是显式事务，父 split dirty 只在保存端口后变
dirty，沿用 RFC-169 的 parent-draft 级合同，不新增 reporter registry。

### 2.2 校验

`lib/agent-ports.ts` 定义单一前端规则，并区分“新增/改名”与“原样透传存量身份”：

```ts
export const AGENT_PORT_NAME_RE = /^[a-z][a-z0-9_]*$/

validatePortName({ raw, direction, existingNames, editingIndex, originalName }) =>
  | { ok: true; value: string; legacyPassThrough: boolean }
  | { ok: false; reason: 'required' | 'format' | 'too-long' | 'duplicate' }
```

- add 或确实改名：trim 后为空 → required；必须小写字母开头，后续仅小写字母、数字、下划线；
- input add/rename 另锁 `maxLength=128`，与 `AgentInputPortSchema` 对齐；output 不凭 UI 新造 schema
  中不存在的长度上限；
- edit 且 raw 与 originalName 逐字相等：跳过 UI regex，允许 schema 可读的 legacy 名 unchanged
  pass-through；input 的 1..128 schema 边界仍不可绕过；
- 无论是否 legacy，除当前 index 外不可重名。已有重复名因此呈 repair 状态：可删除，或改成唯一名，
  但不能在保持歧义名称时提交 kind/required/description 变更；
- input description trim 后空串 compact 为 `undefined`；
- wrapper 暴露名为空或等于 output name → map 不存 key；它的 wire 规则不是 agent-name regex，
  非空 changed 值只 trim 后保存，legacy unchanged 值逐字保留；
- 当 `role === 'aggregator'` 时，对每个 output 计算
  `effectiveWrapperName = mapping[name] ?? name`，与除当前 index 外所有 effective name 比较；冲突时
  `wrapper-duplicate`，禁止保存。normal 的隐藏 map 不阻断普通编辑，切到 aggregator 时再由页面门禁
  要求修复；
- `KindSelect` 上报 invalid 时保存禁用；
- name / wrapper 错误由父 `Field error` 输出 `role=alert`。`Field` 最小增加可选
  `labelId/errorId`（group 且有
  labelId 时输出 `role=group + aria-labelledby`），`TextInput` 透传 `aria-invalid/aria-describedby`；
  默认调用方 DOM 不变，Dialog 用 `useId` 把输入、label 与错误逐项关联。

Dialog 不把非法半成品写进父草稿，但 import 与 role Select 可以直接形成 legacy/冲突草稿，不能
只守 Dialog。相同文件再导出：

```ts
validateAgentPortState(draft): {
  valid: boolean
  issues: Array<{
    severity: 'error' | 'warning'
    repairTarget: 'ports' | 'advanced'
    code:
      | 'input-name-schema'
      | 'input-name-duplicate'
      | 'output-name-duplicate'
      | 'output-kind-invalid'
      | 'wrapper-name-duplicate'
      | 'reserved-port-sidecar-key'
      | 'orphan-output-kind'
      | 'orphan-wrapper-name'
  }>
}
```

- input 的 schema 长度错误、input/output duplicate 始终是 error；
- 对 `outputKinds` 的每个 entry（含 orphan）调用共享 `AgentOutputKindSchema.safeParse`；未注册/非法
  kind 是 `output-kind-invalid` error。声明端口可打开 Dialog 改成合法类型，orphan 则走显式清理；
  不能让 rowToAgent 的宽松历史值在页面看似可保存、最终被 UpdateAgentSchema 422；
- effective wrapper duplicate 仅在 `role === 'aggregator'` 时是 error；normal 中保留的 wrapper map
  不阻断其它字段保存；
- `frontmatterExtra` 中出现 backend 保留键 `outputKinds/role/outputWrapperPortNames` 是
  `reserved-port-sidecar-key` error；先指向 Advanced 的 frontmatterExtra 删除保留键，再提示在 Ports /
  role 一等字段配置。它堵住手工 extra 与坏 shape import 在 POST 后才被 backend 提升的状态突变；
- orphan sidecar 只是 warning；unique legacy 非标准名不是 issue，继续 unchanged pass-through；
- `AgentForm` 用结果在 Ports section 显示详细 repair summary；`agents.new.tsx` 与
  `agents.detail.tsx` 直接调用同一纯函数禁用 Create/Save，并在 header actions 下方渲染同一
  `AgentPortValidationSummary` 的 compact 版本：普通端口问题指向 Ports，reserved-extra 问题指向
  Advanced 的 frontmatterExtra，不给错误页签指引，也不能只给一个无解释的 disabled button；不另造
  callback 状态。这样 import 与 normal→aggregator 也不能绕过，修复后
  提示消失、按钮同 render 立即恢复。header compact summary 是页面唯一 `role=alert` live region；
  keep-mounted Ports detailed summary 用普通命名 region（非 live），隐藏 panel 保持 `hidden`，避免同一
  issue 双重播报。

### 2.3 agent.md import 路由

当前 `parseAgentMarkdown` 的 `KNOWN_KEYS` 没有端口/role，合法字段会落进 `frontmatterExtra`；其中
`outputKinds/role/outputWrapperPortNames` 又会被 backend 当保留键提升，绕过页面校验。本 RFC 在
`packages/shared/src/agent-md.ts` 把以下**既有 wire 字段**路由成一等 `partial`：

- `inputs`：`z.array(AgentInputPortSchema)`，刻意不加 uniqueness refine，使 legacy duplicate 能进入
  repair state；单项 shape 非法则整字段按旧策略留在 extra 并 warning；
- `outputs`：string array，保留顺序与 duplicate，交给页面 repair；
- `outputKinds`：`AgentOutputKindsMapSchema`；非法 kind 不伪装成 typed partial，而是保留 raw extra +
  warning，随后由 `reserved-port-sidecar-key` 明确阻断提交；
- `role` / `outputWrapperPortNames`：各自复用共享 schema；坏 shape 同样进入 extra + warning。

`AgentImportDialog` 预览为 inputs/outputs/output kinds 标注“端口”，role 标注“高级”，并把这些字段
纳入 overwrite 提示；`mergeAgentImport` 继续按一等字段覆盖、extra 浅合并。parser 不再制造新的保留
键 extra；若当前草稿早已有保留键 extra，绝不静默删除，而由页面级 error 引导用户显式修复。

## 3. 纯数据 helper 与原子不变量

`lib/agent-ports.ts` 导出纯函数并独立单测：

```ts
addInputPort(inputs, draft): AgentInputPort[]
replaceInputPort(inputs, index, draft): AgentInputPort[]
removeInputPort(inputs, index): AgentInputPort[]

addOutputPort(state, draft, { role }): PortMutationResult
replaceOutputPort(state, index, draft, { role }): PortMutationResult
removeOutputPort(state, index): OutputPortState
removeOrphanOutputSidecars(state, refs: OrphanSidecarRef[]): OutputPortState

interface OutputPortState {
  outputs: string[]
  outputKinds?: AgentOutputKindsMap
  outputWrapperPortNames?: Record<string, string>
}

type PortMutationResult =
  | { ok: true; state: OutputPortState }
  | {
      ok: false
      reason:
        | 'index-out-of-range'
        | 'name-invalid'
        | 'name-duplicate'
        | 'kind-invalid'
        | 'orphan-key-conflict'
        | 'wrapper-duplicate'
    }

type OrphanSidecarRef = {
  source: 'outputKinds' | 'outputWrapperPortNames'
  key: string
}
```

Dialog 只在 `ok:true` 时写父草稿并关闭；`ok:false` 映射到对应字段/repair summary，Dialog 保持打开。
所有失败分支不得 mutate 输入数组/map，也不返回半更新 state；`index-out-of-range` 作为 stale UI 防御走
通用错误并要求重开目标卡。

### 3.1 序列化与显式清空规则

- 默认 `string` 不写入 `outputKinds`；
- 未触碰且原本 absent 的 sidecar 继续是 `undefined`；
- 用户操作删除了最后一个 mapping 时返回显式 `{}` tombstone，**不得 compact 成 `undefined`**。
  `agentToPutBody` + `JSON.stringify` 回归必须证明空对象真实出现在 PUT body：在 sparse update
  语义中 `{}` 才是“显式清空”，字段 absent/`undefined` 是“保留服务端旧值”；
- input `required=false` / 空 description 返回 `undefined`，保持既有序列化简洁；
- helper 不 mutate 输入数组或 map。

### 3.2 输出 rename

对 index 指向的 `oldName` → `newName`：

1. 仅替换 `outputs[index]`，顺序不变；
2. 计算 `oldNameStillDeclared = nextOutputs.includes(oldName)`；存量 duplicate 存在时保留旧 key，
   不存在时才删除；
3. 只要 new key 在任一 sidecar 中是 orphan，Dialog 报 `orphan-key-conflict` 并要求先从 repair alert
   显式处理；helper 也 fail closed。通过后，新 key 完全按 Dialog 最终 kind/wrapper 写入（默认值则
   删除新 key），旧 duplicate 仍使用改名前的旧 key 值；
4. 两份 map 的其他 key 原样保留；若删除最后 key，按 §3.1 返回 `{}` tombstone；
5. 校验层已拒绝 `newName` 与其他 output 冲突，并在 aggregator 下拒绝 effective-wrapper 冲突；helper
   接收显式 role 并用结果类型重复 fail closed，禁止调用方绕过或覆盖另一个已声明端口的 sidecar。

### 3.3 输出 delete

删除数组项后，仅当 `nextOutputs` 已不含该 name 时删除两份 sidecar 的同名 key；若仍有存量
duplicate，则映射继续由剩余项共享。最后 key 的清除使用 §3.1 `{}` tombstone。这个行为既修复
现状“删除 output 只清 `outputKinds`、不清 `outputWrapperPortNames`”的 orphan 漏洞，也不把修复
变成 legacy duplicate 的数据损坏。

### 3.4 存量 orphan 修复

`findOrphanOutputSidecars` 报告两份 map 中 `!outputs.includes(key)` 的项；两类 orphan 在 normal 与
aggregator 都列出 key/value/来源，normal 只没有“编辑有效 wrapper 映射”的控件，不隐藏修复事实。
`removeOrphanOutputSidecars(state, refs)` 只在用户对所列 `{source,key}` 二击确认后删除**该来源**的
entry，保留声明端口与 duplicate 共用的 key，并遵守 `{}` tombstone。同一 key 同时存在 kind 与
wrapper orphan 时显示两条来源明确的修复项，确认一条不得顺带删另一条。add/rename 占用任一 orphan
key 时一律拒绝并指向 repair alert；用户必须先显式清理或换名，不能因 normal 下 Dialog 没有 wrapper
字段而静默继承/删除历史映射。

## 4. 卡片摘要与聚合映射

每张 `AgentPortCard`：

- header：`<code>` 名称 + translated base kind chip + canonical kind code；
- input body：description（最多两行）或“未填写说明”；required chip；
- output body：若 aggregator 且映射不同，显示 `name → wrapperName`；否则显示默认同名提示；
- legacy 非标准名 / 重复名显示警告 chip；重复项的动作 accessible name 额外带 1-based 序号；
- footer：Edit（普通小按钮）+ `ConfirmButton size="sm" variant="danger"`。

Advanced 页中 aggregator 的 `fieldOutputWrapperPortNames` / `JsonField` 块删除；role Select 仍留在
Advanced。切换 normal → aggregator 不改 map；切回 normal 也不静默清 map，保持现有 round-trip。
有效声明端口的 wrapper 映射仅在 aggregator 卡片/Dialog 中显示；两类 orphan 在任何 role 都进入
可展开的 legacy repair alert（key/value + 分类型 `ConfirmButton`“清理未关联映射”），因此 normal
也能在占用同名 output 前知情修复。最终 wrapper 暴露名冲突同样在相关卡片与 Dialog 可见，编辑器
不会提交新冲突。此约束明确属于 Agent editor：backend Create/Update schema、直接 API 和 scheduler
last-write-wins 本轮不变，未打开编辑器的历史冲突不会被宣称已在系统层消除。

## 5. 输入 description → 能力卡闭环

### 5.1 shared model

`CapabilityInputPort` 增加：

```ts
description: string | null
```

`capabilityCardModel` trim 输入 description；前端完整卡直接消费，compact 卡通过 prop 隐藏描述。

### 5.2 prompt 预算

不能把每项最多 2048 字的 description 无界塞进 leader roster。给
`CapabilityCardOptions` 增加向后兼容字段：

```ts
inputDescriptionBudget?: number // 默认 600；0 = 不渲染 input descriptions
```

默认 600 只用于单卡/未指定调用方。新增 shared 纯 helper：

```ts
perCardInputDescriptionBudget(totalBudget, cardCount, perCardMax) =>
  cardCount <= 0 ? 0 : Math.min(perCardMax, Math.floor(totalBudget / cardCount))
```

两个生产 roster 显式覆盖，且只限制本 RFC 新增的 description 内容，不丢任何 agent card，也不改变
既有 bodyMd `promptBudget`：

- workgroup：按配置中的 agent member 数公平分配，总上限 2,400 字符、单卡最多 240；64 人时每卡
  最多 37 字符；
- dynamic-workflow orchestrator：按 pool 数公平分配，总上限 4,800 字符、单卡最多 600；64 人时
  每卡最多 75 字符。

缺失 agent 可能浪费其公平份额但绝不突破上限；顺序/身份/类型行全部保留。`workgroupRunner.ts` 与
`orchestratorAgent.ts` 只给现有 renderer 传 option，不改加载、ACL 或执行路径。

Markdown renderer 按 inputs 原顺序消费总预算，预算口径是本 RFC 新增的完整渲染片段
` — ${description}`（分隔符也计入，故 roster 总新增字符有硬上界）。只有 remaining 足以容纳
分隔符 + 至少 1 字符时才渲染；description 先 collapse whitespace，正文最多取
`min(160, remaining - separator.length)`。这里不用会额外追加一个字符的既有 `clipSummary`，而
新增 `clipInputDescription(text, budget)`：发生截断时先为 `…` 预留 1 字符，保证返回长度严格
`<= budget`（budget=1 只返回 `…`）。预算耗尽后的端口仍输出 `name/kind/required`，只省略
description。这样：

- 端口身份与类型永不因预算消失；
- 单卡 input 说明连同新增标点的总量有硬上界；
- rosterBudget 的既有整卡上界继续生效；
- `inputDescriptionBudget: 0` 可获得改造前逐字节格式，便于 compact/兼容调用方；
- `promptBudget` 与 `inputDescriptionBudget` 独立：只把前者设 0 仍会渲染 input description，调用方
  若要旧 compact Markdown 必须显式把两者都设 0。

Markdown 格式：

```text
- inputs: requirement (string, required) — 用户的原始需求；repo (path<*>) — 仓库根路径
```

### 5.3 前端能力卡

完整 `AgentCapabilityCard` 的 input 项改为小型 stack：名称/类型/必填在首行，描述在第二行；
`compact` 模式保持现有 chip 密度并隐藏描述。输出卡不变。

## 6. KindSelect 向后兼容扩展

`KindSelectProps` 新增全部可选字段：

```ts
className?: string
onValidityChange?: (valid: boolean) => void
contextLabel?: string
```

- wrapper 挂真实 class，替代当前从未命中的 `__kind` 死 selector；
- guided 模式与合法 advanced raw → `onValidityChange(true)`；非法 raw → false；unmount 不需要
  合成回调。callback 只传 validity，不让父层复制 parse 文案；
- advanced `TextInput` 增 `aria-invalid`、`aria-describedby`，错误有 id + `role=alert`；
- `OUTPUT_KIND_UI` 增加 `descriptionKey`（string/markdown/signal/path 四项必填），`KindSelect` 映射为
  `SelectOption.description`；catalog exhaustiveness 继续保证新 kind 不漏 UI 文案；
- 现有 NodeInspector 调用方不传新 props，交互/数据逐字节不变。

共享 `Select` 的 listbox Escape 分支补 `stopPropagation()`：listbox 打开时第一次 ESC 只收起 Select
并把焦点交回 combobox，不让同一个 keydown 继续到 Dialog 的 window listener；第二次 ESC 才关闭
Dialog。该行为是共享组合控件的层级合同，默认数据/DOM 不变，并以 Select-in-Dialog 回归锁定。

本 RFC 不折叠/删除 list 与 advanced；把它们移入独立 Dialog 已解决主要密度问题。若未来还要
改 KindSelect 本身的信息架构，应另立共享控件 RFC，避免只为 AgentForm fork。

## 7. a11y 与焦点合同

1. Ports 面板无“一个 label 包多按钮”；Dialog 中只有单输入 `Field` 用 label，多控件
   `KindSelect` 必须使用带 `role=group + aria-labelledby` 的 `Field group`。
2. Add：`添加输入端口` / `添加输出端口`；Edit/Delete/Confirm 包含方向、端口名与 1-based 序号，
   因而 legacy duplicate 也不会产生同名 action。
3. kind / ext / list / advanced input 的 accessible name 都包含端口名；同页多个 path 端口不再
   出现多个同名“文件扩展名”。为此 `KindSelect` 增加 `contextLabel?: string` 或由现有
   `ariaLabel` 派生各子控件名称（可选 prop，其他调用方不变）。
4. Dialog open → name；Cancel/ESC → 原 Add/Edit trigger。
5. Add 保存后 → 新卡 Edit；Edit 保存后 → 改名后卡 Edit。
6. Delete 后 → 同位置下一卡 Edit；无下一卡则上一卡；列表空则 Add。
7. `ConfirmButton` 的 `label` 与 `confirmLabel` 都传完整端口上下文；二击期间既有 4 秒复位不变。
8. 每个 `Field` 的 label/error 都有稳定 `useId`，对应输入用 `aria-labelledby` 或 label 包裹，并以
   `aria-describedby` 指向当前 error。name/wrapper error 只由父 `Field` 拥有，kind parse error 只由
   `KindSelect` 拥有；同一错误不得重复渲染/播报。
9. route compact summary 是唯一 live alert；Ports detailed summary 只作命名 region。即使 Ports panel
   keep-mounted，同一 validation issue 也只播报一次。

卡片组件维护 `Map<index, HTMLButtonElement>` refs，并用一次 pending-focus index 在 props 更新后的
effect 中交接；add 聚焦新末项，edit 聚焦原 index，delete 聚焦新数组的同 index / 上一 index / Add。
索引只在单 Dialog 事务内使用，不会被并发 reorder；rename 不依赖 name key 或 React key 的偶然复用。

## 8. CSS / 响应式

新增单一 feature namespace：

```text
.agent-ports
.agent-port-section*
.agent-port-list
.agent-port-card*
.agent-port-dialog*
```

- desktop：section 纵向；card 列表可用 `repeat(auto-fit,minmax(280px,1fr))`，卡内摘要不放表单；
- card 名称/canonical kind `min-width:0` + ellipsis/overflow-wrap；
- footer 复用 `.card__footer` + `.btn--sm`，不另造按钮 chrome；
- Dialog 字段纵向，KindSelect 可 wrap；
- `<=720px`：列表单列、header/actions 换行、footer 按钮保持 44px 触控高度；
- reduced motion 不新增动画；
- 删除 `.inputs-editor__kind/.outputs-editor__kind` 等死 selector，旧 overflow 文本测试退役。

## 9. i18n

修正现有错误：

- 中文 outputs placeholder 不再写“输入端口名”；旧 placeholder 随文本框退役；
- validation 文案改为“以小写字母开头，仅可包含小写字母、数字和下划线”；英文对等；
- 增加 section 关系说明、数量、empty、add/edit/delete、Dialog 字段、rename warning、wrapper 名、
  无 description、kind description 等 zh/en key；
- import preview 增 `routedTo.ports` / `routedTo.advanced`（inputs/outputs/outputKinds/
  outputWrapperPortNames → Ports，role → Advanced），并同步 `Resources` interface；
- 删除仅属于旧 token composer 的 placeholder key（确认无其他调用方后）。

所有新增 key 进入 `Resources` interface，跑 symmetry 测试。

## 10. 失败模式

| 场景 | 行为 |
|---|---|
| add/rename 名称为空、非法、重复 | Dialog 留在原地、就地错误、Save disabled |
| unique legacy 名称 unchanged | 带 warning 原样 round-trip；不强迫用户为本次 kind/description 编辑改名 |
| legacy duplicate | 卡片标 repair；unchanged edit 禁保存；rename/delete 可修，delete 保留仍共享的 sidecar |
| input name 超过 128 | 与 schema 同步阻止保存，不能先关 Dialog 再让 PUT 422 |
| import duplicate / normal→aggregator 后暴露名冲突 | Ports repair summary 出现，页面 Create/Save 禁用；修复后立即恢复 |
| import 合法端口字段 | 进入一等 Ports/role 字段与 overwrite 预览，不进入 extra |
| import 坏 shape / 手工 extra 含端口保留键 | 保留原值和 warning，但页面级 `reserved-port-sidecar-key` 禁提交，避免 POST 后状态突变 |
| advanced kind 非法 | 保留 raw 文本、错误 live announcement、Save disabled；父草稿仍未改 |
| legacy declared/orphan output kind 非法 | 页面级 error 禁 Create/Save；声明项进 Dialog 修，orphan 显式清理 |
| output rename 到现有 port | 校验拒绝；纯 helper 也 fail closed，不覆盖 sidecar |
| add/rename 撞到 orphan key | 禁止提交并指向 repair alert；不隐式继承或删除 kind/wrapper |
| output delete / rename | 两份 sidecar 同事务更新；最后 mapping 用 `{}` tombstone 真正清到 PUT |
| wrapper 暴露名为空/同名 | 删除 map key，运行时继续默认同名提升 |
| aggregator 下两个 effective wrapper name 相同 | Dialog/卡片报冲突并禁 UI 保存；normal 不阻断，直接 API/runtime 语义不在本 RFC 改动 |
| 存量 orphan sidecar | 任意 role 的 repair alert 列出；二击确认仅清 orphan；Advanced JSON 退役后仍可修复 |
| normal agent 带历史 wrapper map | 有效映射不展示也不清；orphan 显式展示；切 aggregator 后有效映射重新可见 |
| rename/delete 被已有 workflow 引用 | Dialog 静态警告；不自动改资源；启动 validator 继续 fail closed |
| input description 超长 | TextArea `maxLength=2048` + schema 双层；prompt 再受总预算裁剪 |
| Dialog 取消/ESC | 父草稿零改动，焦点回 trigger |
| 删除最后一项 | EmptyState 出现，焦点回 Add |
| 390px / 长端口名 / path+list | 单列 + wrap/ellipsis，无 horizontal overflow |

## 11. 测试策略

### 11.1 纯函数

新 `agent-ports.test.ts`：

- name trim / required / 格式 / 数字 / input 128 边界 / duplicate / edit-self / legacy unchanged；
- input add/replace/remove 保留 kind/required/description；
- output add 默认 string 不造 map；
- rename 同时迁移 kind + wrapper map，保留顺序/无关 key，不 mutate；
- duplicate rename/delete 按剩余同名项保留旧 sidecar；rename/effective-wrapper collision fail closed；
- delete 清两 map；最后 key → `{}` tombstone， untouched absent 仍 `undefined`；
- wrapper blank/same-name、最终暴露名唯一、legacy unchanged；
- orphan kind/wrapper 检测与任意 role 显式清理；同 key 双来源逐条确认互不误删；新增/rename 占用
  任一 orphan key 时 fail closed；
- `agentToPutBody` 后 `JSON.stringify` 仍含两份 `{}`，证明真正发出 clear。
- `validateAgentPortState`：input/output duplicate、input schema 长度、declared/orphan invalid kind、
  reserved extra、aggregator effective-name collision 是 error；normal wrapper collision 与 orphan 是
  非阻断 warning；unique legacy 名 pass。
- backend `agent-role-rfc060.test.ts`（或同层新 test）：seed `role=aggregator` + 两份非空 sidecar +
  无关 frontmatter，调用
  `updateAgent(..., { outputKinds: {}, outputWrapperPortNames: {} })`，断言 returned DTO 两图为空、raw
  `frontmatter_extra` 两保留键均为 `{}`，且 sibling role / 无关 key 原样保留，锁住 AC-6 的真实落盘
  后半程。

### 11.2 组件行为

- `InputsEditor.test.tsx`（新或从 AgentForm-inputs 拆）：空态、Add Dialog、初始 focus、提交、取消、
  描述/required/kind、rename、delete/focus；
- `OutputsEditor.test.tsx`：三 sidecar round-trip、aggregator wrapper field、normal 隐藏且 preserve、
  rename warning、duplicate repair、effective wrapper collision、orphan repair、delete confirm；
- `agent-port-dialog-a11y.test.tsx`：无 nested label、group name、重复端口 action 仍唯一、错误 id 关联、
  kind parse error 仅 KindSelect 一个 alert（父层不复制）、页面 validation 只一个 live alert、稳定 trigger
  snapshot、portal Select 第一次 ESC 仅关 listbox/第二次关 Dialog 与 focus；
- `kind-select.test.tsx`：description options、validity callback、advanced error aria；既有 grammar 全绿；
- `agent-form-sections.test.tsx`：五 tab / keep-mounted / badge 不变，旧 raw wrapper JSON 不再出现；
- shared `agent-md` + frontend import：五个既有端口/role 字段的一等 parse/preview/overwrite；duplicate
  inputs 必须由 `z.array(AgentInputPortSchema)` 进入 partial（不能误用带 uniqueness refine 的
  `AgentInputPortsSchema`），duplicate outputs 同样进入 repair，二者 import 后 Create disabled 且可修；
  坏 shape 保留 extra + warning；保留键 extra 页面禁提交；
- new/detail route：import duplicate 后 Create disabled + repair 原因可见；normal→aggregator collision 后
  Save disabled；normal 同数据可保存；legacy invalid kind/reserved extra 禁 Save；修复后同步恢复；unique
  legacy 名不误阻断；
- `AgentForm-inputs` / `AgentForm-outputs-kind` / roundtrip tests 适配新显式 Dialog，不降低数据断言；
- `outputs-editor-kinds-roundtrip` 移除“必须 useChipsCommit / Backspace 删除”旧实现锁，改成用户行为锁；
- `outputs-editor-overflow` 删除死 CSS 正则，改真实 DOM class + e2e。

### 11.3 shared 能力卡

- model 完整保留 description、trim 空值；
- Markdown budget=0 兼容旧格式；默认预算逐项/总量裁剪且端口名/type 不丢；budget=1/分隔符边界/
  截断返回长度严格不超过剩余预算；
- 公平分配 helper 的 0/1/64 卡边界；workgroup 64 members 新增 description 内容 ≤2,400，
  orchestrator 64 pool ≤4,800，且所有 card name/type 仍出现；
- full frontend card 显示 description，compact 隐藏；
- prompt-isolation 测试继续证明无 ACL/user 字段。

### 11.4 e2e / 视觉

- keyboard flow：Add → name → kind Select → Save → focus new card；Edit → ESC → trigger；Delete →
  confirm → focus handoff；
- a11y：Ports tab 与打开的 Dialog 分别 axe；
- 390px：至少 2 input + 2 path/list output，断言 `scrollWidth <= clientWidth`、所有操作在 viewport；
- light/dark/desktop/narrow 截图与 `/agents` 其他 tab 并排核对；刷新 agents visual baseline（若像素
  基线覆盖到 Ports 状态则更新对应 fixture）。

## 12. 文件清单（预计）

生产：

- `packages/frontend/src/components/AgentForm.tsx`
- `packages/frontend/src/components/InputsEditor.tsx`
- `packages/frontend/src/components/OutputsEditor.tsx`
- `packages/frontend/src/components/KindSelect.tsx`
- `packages/frontend/src/components/Form.tsx`（只加可选 aria 透传、inputRef 与 label/error id；默认 DOM 不变）
- `packages/frontend/src/components/Select.tsx`（Escape 只关闭当前 listbox）
- `packages/frontend/src/components/AgentImportDialog.tsx`（端口/role 一等预览）
- `packages/frontend/src/components/agent-ports/AgentPortCard.tsx`（新）
- `packages/frontend/src/components/agent-ports/AgentPortDialog.tsx`（新）
- `packages/frontend/src/components/agent-ports/AgentPortValidationSummary.tsx`（新，header compact +
  Ports detail 两种密度）
- `packages/frontend/src/components/agent/AgentCapabilityCard.tsx`
- `packages/frontend/src/lib/agent-ports.ts`（新）
- `packages/frontend/src/lib/agent-import-merge.ts`（更新既有字段合同/回归）
- `packages/frontend/src/routes/agents.new.tsx`（Create 复用 port-state validity）
- `packages/frontend/src/routes/agents.detail.tsx`（Save 复用 validity + `{}` PUT 锁）
- `packages/frontend/src/styles.css`
- `packages/frontend/src/i18n/zh-CN.ts`
- `packages/frontend/src/i18n/en-US.ts`
- `packages/shared/src/agentCapability.ts`
- `packages/shared/src/agent-md.ts`（既有端口/role 字段导入路由）
- `packages/shared/src/outputKinds/uiCatalog.ts`
- `packages/backend/src/services/workgroupRunner.ts`（只传 roster description budget）
- `packages/backend/src/services/orchestratorAgent.ts`（只传 roster description budget）

测试：按 §11，包含 backend service 的空 map 落盘回归；backend 不改 route/持久化/执行语义，只改
两个现有 prompt renderer 的 budget option。

## 13. 并发工作树处置

当前 `styles.css`、`zh-CN.ts`、`en-US.ts` 已有他人未提交改动。实施时：

- 先保存当前 diff 锚点，按邻近命名空间追加/最小改写；
- 绝不整文件覆盖或格式化无关区域；
- 测试与提交均用精确 pathspec；
- 若届时同一 i18n/样式区块发生真实同线冲突，停下让用户协调，而不是回退他人内容。
