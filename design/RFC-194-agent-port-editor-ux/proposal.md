# RFC-194 代理端口编辑器 UX 重构

状态：Done（2026-07-15）

## 背景

代理新建页与详情页共用 `components/AgentForm.tsx`。RFC-169 把原先的长表单收进五个页签，
但明确不改各字段自身的控件；“端口”页签仍直接拼接 `InputsEditor` 与 `OutputsEditor`。

2026-07-15 用户反馈：

> 代理的编辑页面，配置端口的那个页面很难用，你来优化下

本次在当前 dev 页面实测了空态和已有两个 `path<md>` 输出端口的密集态。问题不是单纯的
间距或配色，而是信息结构、操作模型和无障碍语义同时失效：

1. **名字像输入框，却不能编辑**：端口名实际是带输入框皮肤的只读 `<span>`；写错一个字只能
   删除后重建，输入端口会丢 `kind/required/description`，输出端口会丢 kind 与聚合映射。
2. **添加入口不可发现**：页面只给一个“输入名称后按 Enter”的文本框，没有显式添加按钮；
   blur 会自动提交，空输入时 Backspace 又会直接删除最后一个富配置端口。
3. **类型控件被挤成工具条**：一个 `KindSelect` 最多同时展开基础类型、扩展名、list 开关与高级
   按钮，再与端口名、必填、删除强塞进一行。两个文件端口已经很难扫读，窄栏更明显。
4. **输入/输出关系说不清**：输入端口只是给 leader / 编排 agent 阅读的能力声明，不进入实际
   spawn 绑定；输出端口则是运行时 `<workflow-output>` 信封契约。两段长 hint 把这个关键区别
   埋掉了。
5. **表单语义错误**：两个编辑器被默认 `<Field>`（即 `<label>`）整体包住，内部又含按钮、
   下拉、checkbox 与嵌套 label。点击标题或说明可能代理到第一个内部控件，新增输入也没有独立
   accessible name。
6. **已批准的数据没有编辑面**：`AgentInputPort.description` 已在 RFC-166 schema 中存在，但 UI
   只透传、不展示；聚合 agent 的 `outputWrapperPortNames` 仍在“高级”页以原始 JSON 编辑，和
   它所属的输出端口分离。
7. **现有防溢出测试是假绿**：CSS 约束 `.inputs-editor__kind/.outputs-editor__kind`，但 DOM 没有
   挂这两个 class；测试只匹配死 CSS 文本，没有验证真实布局。

RFC-169 把“修改各表单字段本身的控件与校验”列为非目标；本次是完整交互重构，按仓库规则
独立立 RFC，而不是借 RFC-169 的陈旧 In Progress 标记直接改代码。

## 产品决定

### D1：输入 / 输出分成两个语义区

- **输入端口 · 能力说明**：强调“告诉编排者这个 agent 能消费什么”，不是实际连线白名单；
- **输出端口 · 运行契约**：强调 agent 必须在输出信封中按这些名字产出，重命名/删除可能令
  现有 workflow 边失效。

两个区都显示数量、显式“添加端口”按钮和 compact 空状态。

### D2：逐端口卡片 + 统一添加/编辑 Dialog

列表页只呈现可扫描摘要：名称、类型、list、必填、描述摘要、聚合映射。新增或编辑时打开共享
`Dialog`，把名称、类型及低频选项放进有足够宽度的表单；只有点“保存端口”才提交到 agent
草稿，取消/ESC 不改数据。

这样既解决横向拥挤，也避免把无效的半截名称写进 `CreateAgent`，不需要给 wire 增加 UI-only
临时字段。

### D3：端口可以安全重命名

- 输入端口重命名保留 `kind/required/description`；
- 输出端口重命名一次性迁移 `outputs`、`outputKinds` 与 `outputWrapperPortNames` 三份状态；
- 新增/改名时重名或非法名称就地报错；schema 允许但不符合现行 UI 规则的存量名称可原样保存，
  不会因本次换 UI 被迫改名；
- 存量重复名称会在卡片上标出并要求通过 rename/delete 修复；删除重复项之一时，仍被同名项使用的
  sidecar 不得被清掉；修复前页面级“创建/保存”也禁用，不能绕过 Dialog；
- 不自动改写引用该 agent 的 workflow。Dialog 明示影响，现有 validator 在启动时继续用
  `edge-source-port-missing` fail closed。

### D4：聚合输出映射回到输出端口旁边

当 `role === 'aggregator'` 时，输出端口 Dialog 增加“Wrapper 暴露名”；空值或与自身同名表示
默认透传。Advanced 页现有 `outputWrapperPortNames` 原始 JSON 编辑器退役，避免同一事实有两个
互相覆盖的编辑面。编辑器要求本草稿所有输出的最终 Wrapper 暴露名唯一，因此 UI 不会提交新的
同名覆盖；直接 API 与未打开编辑器的历史 agent 仍沿用现有 runtime 语义，不在本 RFC 暗改成系统级
不变量。存量 orphan sidecar 在 normal / aggregator 的 Ports 区都显示修复提示与显式清理动作；新增或
改名若撞到 orphan key，必须先显式清理，不能在隐藏状态下继承或删除。页面 header 与 Dialog 共用
同一纯校验，agent.md import、Advanced 保留键或 normal→aggregator 也不能绕过 UI 门禁。wire 字段
本身不变。

### D5：输入描述打通能力卡

输入端口 Dialog 暴露 `description`。它不仅保存到既有 schema，还进入共享
`capabilityCardModel`：完整前端能力卡显示描述，leader / 编排 agent 收到的 Markdown 能力卡按
确定性总预算裁剪后包含描述；工作组与动态编排池另有 roster 级硬上限，不会随 64 个成员线性
膨胀；compact 预览可隐藏描述。输入端口仍不进入 spawn 路径。

### D6：保留 KindSelect 的完整文法，降低理解成本

不另造类型系统。Dialog 继续复用 `KindSelect`，但：

- 基础类型 option 增加一句用途说明；
- 高级原始 kind 的无效态通过可选 `onValidityChange` 上报，禁用“保存端口”；
- 错误补 `aria-invalid` / `aria-describedby` / `role=alert`；
- list 与扩展名不再和端口名挤在同一行。

### D7：删除是显式、可恢复焦点的操作

移除空输入 Backspace 删除捷径。卡片使用既有 `ConfirmButton` 二击确认；删除输出端口同时清理
两份 sidecar；若仍有同名存量端口则保留共用 key。最后一个映射被删时向 PUT 草稿写入显式空
map，不能让 `undefined` 被 `JSON.stringify` 省略成“服务端保持旧值”。删除后焦点依次落到同位置
下一张卡、上一张卡或“添加端口”按钮。

### D8：wire 不变 + shared 投影，无 migration

`CreateAgent`、REST body、DB 列与 agent.md frontmatter 形状不变。改动集中在 frontend 组件、
shared 能力卡投影与测试；backend 只让两个既有 prompt 调用点传入 roster description 预算，不新增
endpoint/持久化逻辑，不迁移数据。

### D9：agent.md 端口字段进入真正的表单路径

当前 import parser 把 `inputs/outputs/outputKinds/role/outputWrapperPortNames` 都误当成
`frontmatterExtra`；其中后三个又是 backend 的保留键，提交后会被提升成真实运行配置，造成“预览时
页面校验通过、保存后状态突变”的旁路。本 RFC 让这些既有 wire 字段按各自 schema 进入
`Partial<CreateAgent>`、导入预览和 overwrite 提示；坏 shape 仍按既有策略保留在 extra 并告警。
页面级校验同时拒绝 `frontmatterExtra` 中的端口保留键，要求用户在对应表单面修复，防止 Advanced
JSON 再制造同一旁路。不是新增 agent.md 字段，只是补齐已有字段的导入路由。

## 目标

1. 用户不读说明也能发现添加、编辑、重命名和删除入口。
2. 多端口在桌面与 390px 窄屏下均能快速扫读，无横向溢出。
3. 所有端口子控件拥有唯一、带端口上下文的 accessible name。
4. 端口重命名/删除不制造 `outputKinds` 或 `outputWrapperPortNames` orphan key，也不因存量重复名称
   误删仍在使用的映射。
5. 输入描述真正到达能力卡消费者，而不只是存进无人读取的 JSON。
6. 复用 `Dialog`、`Card`、`FormSection`、`Field`、`TextInput`、`TextArea`、`Switch`、
   `Select`、`ConfirmButton`、`EmptyState` 等公共原语。

## 非目标

- 不改变输入端口的运行时语义；它仍是能力声明，agent 的实际入参仍由 workflow 边和 prompt
  token 决定。
- 不为 output 增加新的 description 字段，不改 agent schema / DB / agent.md wire。
- 不自动扫描或批量改写引用该 agent 的所有 workflow；跨资源级联更新需要独立设计。
- 不增加拖拽排序；本轮保持数组顺序，新增项追加到末尾。
- 不重做 AgentForm 其余四个页签，也不改 canvas 节点端口 UI。
- 不移除 KindSelect 高级文法，不收窄现有合法 kind。
- 不在 backend API / scheduler 建立 wrapper 暴露名唯一的新系统不变量；本 RFC 保证新建/编辑 UI
  不提交冲突，并让打开页面的 legacy 冲突进入显式修复态。直接 API 加固需另案设计兼容与错误码。

## 用户故事

- 作为 agent 作者，我看到“输入端口 · 能力说明”和“输出端口 · 运行契约”，能立刻理解两者
  的作用不同。
- 我点“添加输出端口”，在 Dialog 内填名称、数据类型与是否返回多个值，保存后得到一张清晰
  的端口卡。
- 我把 `software_desgin` 改成 `software_design`，原有 `path<md>` 类型与聚合映射都保留，不必
  删除重建。
- 我给输入 `requirement` 写“用户的原始需求文本”，能力卡和编排者 prompt 都能读到这句说明。
- 我误按 Backspace 时不会静默删除最后一个端口；真正删除需要在目标卡上二击确认。
- 我用键盘完成添加、编辑、类型选择、保存与删除后，焦点仍落在可预测的位置。

## 验收标准

- **AC-1 语义分区**：Ports tab 渲染输入/输出两个带关系说明与数量的区域；外层不再用默认
  `<Field>` label 包裹多控件编辑器。
- **AC-2 卡片摘要**：每个端口一张公共 `Card`，至少显示名称与 canonical kind；输入显示必填
  和描述摘要，聚合输出显示 wrapper 暴露名。
- **AC-3 显式添加**：每区均有命名明确的“添加输入/输出端口”按钮；空态复用 compact
  `EmptyState`；不再靠 placeholder 作为唯一入口。
- **AC-4 Dialog 编辑**：新增/编辑复用共享 `Dialog`；名称初始聚焦；取消不改父草稿；保存只在
   名称满足新增/改名规则、最终身份唯一且 kind 合法时可用；存量非标准名称 unchanged
  pass-through；页面 header 用同一状态校验，import/Advanced 保留键/角色切换不能旁路；关闭后焦点
  回触发点/新卡；Kind Select 打开时第一次 ESC 只关 listbox，第二次才关 Dialog。
- **AC-5 安全重命名**：输入保留所有属性；输出原子迁移 `outputs + outputKinds +
  outputWrapperPortNames`，顺序与无关 key 不变；存量重复名按剩余引用数保留旧 key。
- **AC-6 安全删除**：二击确认；仅在最后一个同名输出被删时清 sidecar；最后映射通过显式空 map
  真正清到服务端，并以 service 回归证明返回 DTO/raw frontmatter 都为空且无关 extra 保留；删除后
  焦点交接可预测；空输入 Backspace 不再删除端口。
- **AC-7 输入描述闭环**：输入 description 可编辑、round-trip；完整前端能力卡展示；共享
  Markdown 能力卡按单卡 + roster 硬预算包含（64 成员仍有上界）；compact 模式可隐藏；spawn
  路径零改动。
- **AC-8 聚合映射就近编辑**：aggregator 输出 Dialog 可编辑 wrapper 暴露名；Advanced 页原始
  JSON 编辑器退役；最终暴露名冲突时禁保存；存量 orphan 映射有可见、二击确认的清理入口；
  normal agent 仍无映射编辑控件，但能看见 orphan 修复提示，存量字段不被静默清空；占用 orphan
  key 前必须显式处理；切 aggregator / import 冲突草稿时页面级保存同样禁用。
- **AC-9 KindSelect**：类型下拉包含用途说明；高级非法值阻止 Dialog 保存并有 live error；现有
  `string/markdown/signal/path<ext>/list<T>/高级文法` round-trip 全保留；历史 declared/orphan 非法
  output kind 也由页面级门禁拦住并给出修复入口，不再等 PUT 422。
- **AC-10 a11y**：无嵌套 label；所有按钮/输入/下拉名称唯一并含端口上下文；Dialog 焦点 trap、
  ESC、portal Select 沿用公共契约；错误与输入关联。
- **AC-11 响应式**：桌面卡片可扫读；`<=720px` 单列堆叠；390px Playwright 断言页面无水平
  overflow，添加/编辑/删除均在 viewport 内。
- **AC-12 wire 兼容**：agent 新建/保存/导入与 `agentToDraft` round-trip 形状不变；Ports badge
  仍等于 inputs+outputs；agent.md 的既有端口/role 字段进入一等预览与表单字段；legacy 非标准名/
  重复名/orphan/非法 kind fixture 可打开并可修复；空 sidecar 的 PUT 清除有序列化 + service 落盘
  回归；无 migration、无后端 route/持久化改动，仅改既有 prompt budget options。

## 与既有 RFC 的关系

- **RFC-166**：补齐其已设计但未交付的 input description 编辑与能力卡消费；不改变 inputs 的
  声明式语义。
- **RFC-169**：保留五页签、keep-mounted、Ports badge 与 split-page 草稿/未保存保护；只重做
  Ports 面板内部。
- **RFC-173**：沿用其经验——多控件组必须 `Field group`，新增 UI 应优先公共原语；本 RFC 不动
  Resources tab。
- **RFC-193**：只涉及运行后 path 端口产物归档；本 RFC 仅编辑 agent 声明，不改变归档协议。
