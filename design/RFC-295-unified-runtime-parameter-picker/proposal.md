# RFC-295 统一运行期参数选择器与作者面收口

## 1. 背景

工作流 Agent 节点的编辑面板会在 Prompt 下无条件平铺 30 个
`{{trigger.webhook.*}}` 变量按钮。这些事件上下文对没有使用 Webhook 的作者是长串干扰；
同时，把这一排按钮只从 Agent 删掉也不是完整解法，因为平台已经有多个运行期模板作者面，
并且变量写入交互已经分裂：

- Agent、CallWorkgroup、Review 各自平铺 Webhook chip，Review 还另平铺
  `{{__review_comments__}}`；
- CodeHostCall 同时存在“入边反向绑定到目标字段”、业务 Select 混入参数 token、
  集中式 Advanced variables 三套写入方式；
- Webhook 规则配置在 `workingBranch`、workflow text mapping、Agent description 与
  Workgroup goal 上重复铺 chip，workflow mapping 还会猜测“最近聚焦，否则第一个”插入目标；
- CodeHost 的枚举参数是合法模板面，却不能接受 Webhook token；Webhook 直达 Agent
  的 `inputs.*` 也是后端认可的模板面，但前端目前只原样保留 API 已写值，没有编辑 UI。

现有 chip 只显示原始 token，文字解释藏在 `title` 里；在触屏、键盘或不熟悉字段名时，
作者无法稳定获得“这是什么、什么时候有值、会插到哪里”的信息。

本 RFC 不将 Webhook 能力私有地折叠在 Agent 内，而是建立一套全产品可复用的运行期参数目录、
选择器与目标写入合同。两份 shared inventory 继续是“持久化字符串可能含模板”的权威真值；
前端只为当前 discriminator/action 下的 active authoring target 提供写入控件，两者通过稳定 sink family 而非动态
pointer 实例对账。

## 2. 术语与边界

- **运行期参数**：保存为 canonical template token，在任务启动/节点执行时渲染的值；
  例如 `{{trigger.webhook.comment_text}}`、`{{input_port}}`。
- **运行期模板作者面**：权威 inventory 明确允许渲染参考的字符串字段。
- **字面配置值**：保存后不进行 runtime-template 替换的字段，不得因为文本中可能出现
  `{{...}}` 就接入选择器。
- **全局参数**：与当前节点入边无关，由平台运行期上下文提供的参数。本 RFC 落地时包含
  `trigger -> webhook`，以及今天 renderer 已支持但只能手输的 `runtime -> task` 内置任务/仓库/迭代上下文；
  两类都按 surface 的真实 producer 白名单提供。
- **局部参数**：只对当前 surface 有意义的节点入边、Review context 等；它们与全局参数在
  同一选择器中出现，但不伪装成 `trigger` 类型。

## 3. 已批准的产品决策

### D1. 所有 runtime-template 作者面只用一套公共选择机制

- 每个可插入运行期参数的目标字段旁使用同一个 `RuntimeParameterPicker`，统一触发文案为
  “插入参数”。
- 页面不再常驻平铺 chip；未打开选择器时，非 Webhook 用户不看到 30 个事件字段。
- 多目标表单不再依赖“最近聚焦/默认第一个”的暗中猜测；选择器与具体字段相邻，
  并明示目标名。

### D2. 全部参数先分作用域，再强制按“类型 -> 来源 -> 功能分组 -> 字段”分类

根层先区分“当前节点/当前字段”与“全局参数”；根层之下即使当前只有单子分支，也保留稳定的
type/source/group/field 逻辑路径，由 D5 的 singleton compression 减少点击而不是拍平数据。示例：

```text
全局参数
└─ trigger（触发参数）
   └─ webhook（Webhook 事件）
      ├─ context（事件上下文）
      └─ api（API 定位与回写）

全局参数
└─ runtime（运行上下文）
   └─ task（当前任务）
      ├─ repository（仓库与工作区）
      ├─ identity（任务与节点标识）
      └─ iteration（迭代与分片）

当前节点
└─ input（输入参数）
   └─ upstream（上游连线）
      └─ ports（输入端口）
```

- 类型、来源、功能组与字段都使用稳定 id；展示名称与 id 分离并可本地化。
- 中央 provider registry 与 surface source-policy 分离：workflow authoring 请求当前已实现且对该
  surface 合法的 global sources，Webhook rule 则明确只请求 `trigger/webhook`。
- 未来 `scheduler` 作为 `trigger` 下的新 source 注册，不改公共组件与现有 workflow
  inspector；新 scheduler 配置面只需声明自己的 source-policy，不应让 Webhook rule 误看到 scheduler。
- `runtime/task` 不是新 runtime 能力：Agent prompt 已认可 `BUILTIN_VARS`，CallWorkgroup goal 已提供其中的
  task/repository/iteration 子集。本 RFC 只是把每个 surface 真正有 producer 的项纳入统一目录；review/clarify
  条件项会注明可用时机，不向无 producer 的 CodeHost/Webhook launch 面泄漏，也不提供 retired token。
- 本 RFC **不会提前显示** `trigger.scheduler.*`；当前 shared schema、template-ref parser 与任务上下文
  只认可 Webhook。未来必须先完成 scheduler runtime contract，再只注册新 source。

### D3. 每个参数项必须有可读名、canonical token 和可见文字解释

叶节行同时展示：

1. 本地化可读名，例如“评论正文”；
2. canonical token，例如 `{{trigger.webhook.comment_text}}`；
3. 常显解释，例如“本次事件的评论内容；仅评论类事件提供”。

解释不得只存在于 tooltip/`title`。来源层也要解释可用时机：Webhook 明示“仅由 Webhook 启动时提供”。
每个目标字段自身也保留/补齐可见 hint，说明渲染位置、格式和上限；例如 CodeHost JSON body 必须把 token 放在
合法 JSON 字符串值内，picker 不绕过保存校验。

### D4. 同一选择器合并全局与 surface-local 参数，但不扩大 runtime 语义

- Agent/CallWorkgroup/CodeHostCall 的当前入边，以及 Review 的 `__review_comments__`，收入同一按钮下的
  “当前节点/当前字段”分类。
- Agent/CallWorkgroup 的 runtime builtins 同样进入该按钮下的“全局参数 -> runtime -> task”，但按
  surface producer allowlist 投影；不把 `BUILTIN_VARS` 全表倒给所有 surface。
- 用户选择后始终写入完整 canonical token，不写展示名、alias 或被截断 token。

### D5. 参数选择是一次“插入动作”，不伪装成持久业务 Select

- 弹层提供分类浏览、breadcrumb 和搜索；搜索命中可读名、字段 id、token、解释、alias 与完整路径。
  单子分支可在交互上自动压缩，但 breadcrumb 仍展示完整 type/source/group 分类。
- 点击参数后执行写入、关闭弹层、清空搜索并通过 live region 宣告结果；不留下错误的
  selected/check 语义。
- 文本目标按当前光标/选区插入；CodeHost 业务枚举 Select 选择参数时整值替换，并在 UI 明示
  “将替换当前值”。

### D6. Workflow 编辑器不根据当前 Webhook rule 隐藏 Webhook source

工作流资源可以先保存，后绑定 Webhook rule，workflow inspector 也不拥有所有外部规则的完整当前绑定信息。
因此 Webhook source 在选择器中保持可发现，但默认不展开，并清楚说明只有 Webhook 启动时有值。

Webhook 规则编辑器已知道 `eventTypes`，继续按所选事件类型的可用字段交集过滤，不给出保存后必然
在 preflight 失败的字段。

### D7. Webhook 配置的全部合法 template 字段与 workflow inspector 复用同一组件

迁移以下字段：

- 公共 `workingBranch`；
- Workflow launch 的每个 text input mapping；
- Agent launch 的 `description` 或已声明的兼容 `inputs.*`；
- Workgroup launch 的 `goal`。

Agent 有声明 input ports 时，不能继续把 `inputs.*` 当作 API-only 暗值。前端必须先完成选中
Agent detail 解析，再使用 shared launch-form 判定：initial-loading/query-error/target-missing 不得被当成 zero-port；
只有 resolved detail 才能取得 target-specific payload 的编辑权。resolved 的 zero/ported shape、端口 blocker 与
存量 repair issue 是正交维度，不用互斥枚举掩盖“端口已漂移为不兼容且仍有旧值”的组合。

- text 类输入使用 TextArea 及公共选择器；`presentation: chips` 的 Webhook **模板**也统一使用
  multiline TextArea，明示一行一项/newline wire，不在参数插入时临时发明第三种 ChipsInput writer；
- upload/path/signal/非法端口无法由 Webhook JSON launch 提供 multipart/信号语义，显示精确阻断原因并禁止保存，
  不伪装成可用文本框。

`description` 与整个 `inputs` 从 common `payloadBase` 中拆出。每个 Agent id 有隔离的未提交 draft；
A -> B 不携带同名/异名值，切回 A 可恢复本对话内 A 的编辑。保存时 serializer 显式执行
zero-port=`description` 且删 `inputs`、ported=`inputs` 且删 `description` 的 XOR。端口改名/删除产生的存量
orphan 保持可见、阻断保存，只有用户显式移除/重置才删除；切换目标的存量替换也有明示确认。

Agent detail 查询失败或目标暂时不可见时，不把一条原本可编辑的规则整体锁死：界面常显“当前未验证 Agent 参数”
banner、目标/保留键摘要和 Retry；用户可只改规则名、事件类型等 common 字段，并通过明确的“仅保存通用设置，
Agent 参数原样保留”动作，以 preserve-opaque 模式原样提交 target id + 原始 `description`/`inputs`。此模式不能切 Agent、
不能改 target-specific 值；已经改过 target-specific draft 时动作禁用。初次加载期间禁保存；resolved 后的重新验证使用
`refreshing(previousResolved)`，保留字段、草稿、焦点、selection 与 IME，只暂时 fence Save/picker，避免刷新造成表单闪退。
若新定义会改变输入结构，则在普通输入、粘贴、IME 或未结束的 focus-session 中只提示“Agent 定义已变化”，等字段
blur/显式“应用最新定义”后再切换，不能在两次按键之间卸载控件；等待期间新 generation 的结果覆盖旧 pending，
同一 generation 的更新结果也以单调 pending identity 取代旧值；真正应用前比较完整 identity，不能让已经被替换的
旧 Apply 闭包把较旧结构落回去。后端若因真实定义漂移拒绝保存则原样显示错误。

这一变更只补齐已有 backend/shared 合同的前端作者面，不新建 Webhook launch/runtime 语义。

### D8. CodeHostCall 参数写入收口，不再保留第二套注入交互

- 每个合法 preset/custom template target 旁放统一 picker；query key 是结构化字面量，不接入。
- 删除 Advanced variables 集中 chip 区，删除业务 Select 中混入的入边 token option。
- 业务 Select 的可选列表只保留 action-registry 字面枚举，但已保存的模板值必须在关闭态独立显示为
  “当前由运行期参数提供：<token>”，可更换/清除，不能因为 token 不在 options 中看起来是空值。
- 现有入边映射区可保留“已引用到哪里”的只读状态与解除动作，但不再使用另一个目标 Select 写入 token。
- 文本、textarea、枚举 Select 都经过同一 target adapter，不再使用隐式 active-target 状态决定将参数写到何处。
- CodeHost 的 persisted inventory 可包含当前 action/provider 不会执行的旧 `params`/`request`。本 RFC 建立
  total action-aware active projection，让 frontend authoring、workflow/Intent authoring validation、launch preflight 与
  direct executor defense 对同一 active targets；preset 只取 registry params，custom 只取 request，invalid/unsupported
  先报 action 错。非 active 值不自动删除，inspector 显示可恢复的 repair/清理诊断，切回后再恢复为可编辑 target；
  migration/diff 与 Intent diff preview 仍保留 persisted 全量。

### D9. 键盘、输入法、光标和手机是公共合同，不是各调用面自行补丁

- 打开时快照 stable target id、value/revision 与有效历史光标/选区；提交前重读目标并条件写入。
  picker 打开期间发生 undo/redo、远端同步、row 删除/重排或 target unmount 时 fail closed，不用旧值覆盖新值。
- commit 后恢复光标，但只在焦点仍属于 picker/trigger/body/原目标时执行；用户已移到任何其它
  可聚焦控件时都不抢回。
- trigger 声明 `aria-haspopup=listbox`；弹层搜索框是带独立可读名、`controls` 与 active descendant 的 combobox，
  分类与 leaf 是同一 listbox 内的 action option。Enter/Space/Arrow/Home/End 可用；Tab/Shift+Tab 显式把焦点交给 trigger 前后的
  外层控件，不依赖 `document.body` portal 的 DOM tab 顺序。
- Escape 只关闭 picker 并返回触发器，不关闭外层 workflow/Webhook dialog；CJK IME 期间
  Enter 不提交，Escape 可取消 composition 但必须阻止事件继续关闭外层 Dialog。
- 行的 accessible name 为完整 breadcrumb + 可读名，token 与解释是可见文本并由
  `aria-describedby` 关联，避免一次重复朗读所有内容。标题节点不伪装成可选项。
- 每个含 input + picker button 的字段使用公共 Field action 布局，不把多个交互控件嵌入同一
  `<label>`；picker 按钮的可访问名是“向 <目标名> 插入参数”。
- 手机继续使用 portal 式非模态 popover，不在已有 inspector Dialog 里再嵌一个 modal Dialog；弹层支持上下
  flip、viewport clamp、`100dvh` 剩余高度、sticky search 与至少 44px 触控行。
- Workflow 作者面的成功插入进入既有 canvas history。Webhook Dialog 的全部 controlled draft 只由一个
  dialog-session history stack 管理；可见 Undo/Redo、快捷键和文本 `historyUndo/historyRedo` 走同一栈。
  同字段一次 focus-session 的连续输入/粘贴/IME 合为一项，picker 插入与 repair 各自保持 atomic boundary，
  不让浏览器原生 text history 与 Dialog history 同时争夺撤销；picker 搜索框等 ephemeral editor 不属于 rule draft，
  它们的 Undo 只改自己的临时搜索值，不得穿透去撤销外层规则。

## 4. 权威作者面矩阵

本 RFC 不使用前端文本搜索猜测范围。shared collector 给出持久化 template sink family；
action/discriminator-aware active projection 给出当前实际可编辑/会执行的 target。前端 adapter registry 与 stable sink
family 双向对账，不声称动态 pointer 实例与当前可见控件数量永远相等：

| 域                | 合法 target                                       | 本 RFC 的 UI                                                   |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| Workflow Agent    | `promptTemplate`                                  | textarea 旁一个 picker：当前入边 + task runtime + Webhook      |
| CallWorkgroup     | `goalTemplate`                                    | textarea 旁一个 picker：当前入边 + task runtime 子集 + Webhook |
| Review            | `commentInjectTemplate`                           | textarea 旁一个 picker：Review context + 全局 Webhook          |
| CodeHost preset   | `params.*`                                        | 每个参数 target 旁一个 picker；text 插入，select 整值替换      |
| CodeHost custom   | `request.path` / query **value** / `request.body` | 每个 target 旁一个 picker；query key 不接入                    |
| Webhook Workflow  | text `inputs.<key>.template`                      | 每个 text mapping 旁一个经 eventTypes 过滤的 picker            |
| Webhook common    | `workingBranch`                                   | 字段旁一个经 eventTypes 过滤的 picker                          |
| Webhook Agent     | `description` 或兼容 `inputs.*`                   | 按 Agent launch form 渲染目标，每个目标一个 picker             |
| Webhook Workgroup | `goal`                                            | 字段旁一个经 eventTypes 过滤的 picker                          |

Workflow collector 不包含 Script body、Clarify description、Review 普通 description、CodeHost query key；
Webhook collector 不包含 git/enum/files/upload 的 workflow input mapping。这些字段不得被“所有文本框都加按钮”误收编。

## 5. 能力影响清单

批准本 RFC 表示同时批准以下可见交互/能力变更：

| 编号 | 影响                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | 全部常驻 template-variable chip 排退场，替换为字段旁的统一“插入参数”按钮                                                                                                                                                                                                                     |
| C2   | CodeHost 的目标反向绑定与业务 Select 混入 token 写入能力退场；相同 token 由统一 picker 写入                                                                                                                                                                                                  |
| C3   | Webhook workflow mapping 不再“最近聚焦/否则第一个”猜目标，用户在具体字段旁显式插入                                                                                                                                                                                                           |
| C4   | Agent/CallWorkgroup 的当前入边从只展示 token 升级为可通过同一 picker 插入                                                                                                                                                                                                                    |
| C5   | CodeHost 枚举模板字段首次可选全局 Webhook 参数，以整值替换方式保存                                                                                                                                                                                                                           |
| C6   | Webhook Agent 已声明的兼容 `inputs.*` 从 API-only 保留值升级为可见可编辑的模板目标                                                                                                                                                                                                           |
| C7   | 不兼容 JSON Webhook launch 的 Agent upload/path/signal 端口在前端即显式阻断，不再等保存期 422；Agent 定义后续漂移也进入可修复阻断态                                                                                                                                                          |
| C8   | CodeHost 的 frontend authoring、Workflow/Intent authoring validation、launch preflight 与 direct executor defense 只处理当前 action/provider 的 active targets；非 active 存量值保留且可见修复，不再因隐藏 token 阻断当前不使用它的 action                                                   |
| C9   | Agent/CallWorkgroup 今天已可手输的 task/runtime builtins 进入同一分类选择器；只提供对应 renderer 真有 producer 的 surface 子集，不改变 token/runtime 语义                                                                                                                                    |
| C10  | Webhook Agent detail 暂时查询失败/不可见时，以显式 banner/摘要/Retry/“仅保存通用设置”保留 common-only、target payload byte-preserving 能力；后台刷新在普通输入/paste/IME/focus-session 中不卸载字段，结构变化延迟到 blur/显式应用；不把网络/权限读失败误判 zero-port，也不静默重写旧 payload |

不删除任何 canonical token、renderer、preflight 或 runtime context；旧工作流/Webhook 资源的 wire 格式不变。

## 6. 非目标

- 不实现 `trigger.scheduler.*`、定时触发上下文快照或它的 renderer/parser；只保证 picker/catalog 可注册新 source。
- 不改 Webhook field/event availability 真值、canonical token、task trigger context 或 RFC-292 对 **active target** 的
  fail-closed 语义；C8 只纠正 CodeHost 非 active 存量字段被隐藏却仍参与 validation/preflight 的投影偏差。
- 不给 Agent 资源编辑页的 Markdown body、Script body、Clarify prose、i18n 文案、Intent preview、
  starter generator、manual/scheduled literal input 或任意出现 `{{...}}` 的普通文本框加 picker。
- 不重写 workflow canvas、Webhook 权限模型、launch wire version 或 CodeHost action registry。
- 不向每个 surface 开放所有 prompt builtin；不提供 retired token，也不把 review/clarify 条件参数伪装成处处有值。

## 7. 验收标准

- [x] 全部合法 runtime-template 作者面使用同一 `RuntimeParameterPicker`，无生产调用面继续渲染
      `TemplateVarChips` / `WebhookTriggerVarChips` 或自制 token option。
- [x] 全部 catalog 在 scope 下完整表达 `type -> source -> functional group -> field`；添加测试用假
      `trigger/scheduler` provider 时组件与现有 workflow inspector 零修改，Webhook source-policy 仍不泄漏 scheduler。
- [x] `WEBHOOK_TEMPLATE_VARS`、event availability、catalog leaf、中英可读名/解释一一完整且无重复路径。
- [x] shared runtime-builtin descriptor 与 `BUILTIN_VARS`/CallWorkgroup 实际 producer 同源；Agent 与
      CallWorkgroup 只看到各自有 producer 的 runtime/task 子集，per-surface 文案准确描述 child/caller 与
      newline/bullet/comma 格式，CodeHost/Webhook launch 看不到这些项。
- [x] 参数行可见展示名称、canonical token、文字解释和完整 breadcrumb；解释不只在 tooltip。
- [x] Agent、CallWorkgroup、Review、CodeHost preset/custom、Webhook workingBranch/workflow/agent/workgroup
      具有正向、光标/选区、字段切换、禁用/空结果与保存回读测试。
- [x] Webhook 事件类型过滤、Webhook Agent text/chips-newline template、initial-loading/refreshing/error/missing、
      opaque banner/摘要/“仅保存通用设置”、XOR serializer、orphan repair、A -> B -> A draft 隔离、异步
      generation/updatedAt fence、远端 drift refetch、普通输入/paste/IME 时结构 reconcile 延迟，以及 gen2 pending ->
      gen3 before blur 与同 generation r2/A -> r3/B -> stale A Apply 的 latest-wins/full-identity CAS；dialog 单一
      history owner 与 focus-session Undo/Redo、ephemeral search Undo 隔离、不兼容端口阻断和 common payload key
      保留都有回归。
- [x] CodeHost 枚举 target 整值替换且存量 template 关闭态可见；JSON body 只在合法字符串位置
      插入；query key 无 picker；total active projection 与 validator、Intent confirm、launch/direct preflight 同源；
      custom/unsupported/invalid 与全 action×provider 完整；无隐式 target 错写。
- [x] 键盘、CJK IME Escape、nested Dialog、Field action label、ARIA/live region、target revision/stale fence、
      outside/unmount/pending transition、undo/redo 与手机 viewport 有专项测试。
- [x] 五张现有 Agent inspector 默认态视觉基线更新，并新增至少一张打开 picker 的桌面基线和一张
      Webhook 配置窄屏基线；不把 Agent 默认态冒充为全 surface 视觉覆盖。
- [x] shared stable sink family / active projection 与被实际 target builder 消费的前端 adapter registry 有双向棘轮；
      新增 sink 而未接 adapter，或 adapter 不再被实际字段消费时测试失败。
- [x] 定向 shared/frontend/E2E/visual 全绿，最终 `bun run gate:local` 全绿；本 RFC 的 Draft/Done
      状态与真实实施/验证边界一致。

## 8. 批准记录

用户于 2026-08-13 整体批准 D1-D9 与 C1-C10，并授权进入 T0-T8 实施。批准范围包括：

1. 一个公共选择机制取代所有平铺/私有参数写入交互；
2. 全部目录在 scope 下固定为 type/source/group/field；全局注册既有 trigger/webhook 与 surface-supported runtime/task，
   不提前造 scheduler runtime；
3. CodeHost 的第二/第三套写入入口退场，但 token 可写能力保持或扩充；
4. Webhook Agent 兼容 `inputs.*` 新增 UI，存量 orphan 需显式修复，不兼容端口显式阻断保存；
5. CodeHost 按 active action/provider 校验/preflight，隐藏非 active 值保留不自动删除。
6. Agent/CallWorkgroup 既有 runtime/task 内置参数从“只能手输”升级为同一 picker 内可分类发现，但不向
   没有 producer 的 surface 扩散。
7. Webhook Agent detail 失败时只通过明示“仅保存通用设置”执行 common-only preserve-opaque；刷新期间的结构变化
   等待 target field blur/显式应用，target-specific 编辑仍须 resolved detail。
8. Webhook Dialog 的 rule draft 只有一个 history owner；文本 focus-session 聚合，picker search 的 Undo 不得穿透。

实现、验证、commit/push 与发布边界继续分别记录。用户随后于 2026-08-13 明确要求“做完提交上库”，
因此授权在全部发布门满足后精确提交并推送本 RFC。
