# RFC-250 · 全局前端交互完整性与一致性收口

- 状态：Implementation Complete / Publication In Progress（自有范围与独立实现门已闭环；远端发布门执行中）
- 日期：2026-08-03
- 触发：用户要求审视整个系统前端，并按审计建议执行整改
- 相关 RFC：RFC-113/118（Agent 运行时选择）、RFC-169（未保存防丢）、RFC-198（全局 UI 基座）、RFC-199（工作流编辑器）、
  RFC-211（新手导览）、RFC-235（Intent Builder）、RFC-246（运行表面）、
  RFC-247（MCP 远程访问 / PAT）、RFC-249（仓库组目录树）
- 实现证据：[implementation-evidence-2026-08-03.md](./implementation-evidence-2026-08-03.md)

## 1. 背景

当前前端已经有统一的页面骨架、反馈组件、资源双栏、运行列表和响应式基座；问题不再是“整体换一套视觉”。
本轮源码审计与真实 390px / 桌面浏览器走查发现，剩余风险集中在四类跨页面合同：

1. **状态完整性**：高成本草稿只存在 React state；部分 mutation 失败没有可见反馈；一次性密钥在
   pending 或 reveal 阶段可被误关；Clarify 在最后一次写入被 cleanup 取消或远端写失败后仍可能显示
   “已保存”。
2. **交互基础**：共享 Dialog 默认把焦点送到右上角关闭按钮，反向 Tab 逃逸后又总回到第一个元素；
   Select、复选框、开关与变更文件导航在 disabled、空集合、键盘和触屏场景下合同不完整。
3. **复杂画布**：复杂 Workflow 首屏为追求“全部看见”缩到不可读，边上加号在 390px 下只有约 5px；
   Validate 的已批准页头入口发生回归。
4. **同义动作与跨 RFC 回归**：Scheduled 列表与详情的“立即运行”确认和可用性不同；审计另发现
   Intent、Onboarding 与 `/repos` 的问题，但它们已有 RFC-235/211/249 所有者，不能在本 RFC 复制实现。
5. **配置字段随异步基数消失**：Agent 的 Runtime 选择器曾在注册表只有一个 enabled runtime 时隐藏，
   使“继承全局默认”和“显式固定该 runtime”两个不同持久化状态无法查看或切换；加载/失败时字段也会
   跳变，用户因此误以为 Agent 已不能修改运行时。

这些问题会造成用户误以为数据已保存、误失一次性凭据、重复执行、在失败后无从恢复，或者在键盘与
移动端上无法完成同一条业务链。它们需要在共享原语和真实流程上收口，不能逐页加一层样式。

## 2. 目标

- **G1 数据不因普通离开而静默丢失**：高成本草稿有明确 dirty、持久化、恢复与离开合同。
- **G2 结果不被猜测**：pending、成功、失败、部分成功和 outcome unknown 使用真实回执驱动文案与动作。
- **G3 同一动作同一语义**：列表/详情、桌面/移动端、鼠标/键盘复用同一个 eligibility 与确认合同。
- **G4 共享原语可达**：Dialog、Select、Checkbox、Switch、文件导航和复杂画布满足方向焦点、禁用跳过、
  可读性与触控目标要求。
- **G5 已知回归有明确归属**：不把 Intent、Onboarding、`/repos` 发现塞进临时实现；逐项移交既有 RFC。
- **G6 增量修复而非重构系统**：复用 `Dialog`、`UnsavedChangesGuard`、`FeedbackStack`、`ErrorBanner`、
  `NoticeBanner`、`TableViewport`、`ConversationFlow` 和现有 route/query 合同。
- **G7 配置能力不随注册表基数消失**：Agent Runtime 字段稳定存在；加载、失败、单一 enabled runtime 与
  已固定 disabled runtime 都有可解释、可恢复的状态。

## 3. 非目标

- 不重做导航壳、色板、字体、卡片体系或 RFC-198 已建立的全局视觉语言。
- 不改变数据库、权限、任务生命周期、调度、PAT 安全模型或工作流定义 wire。
- 不修改 `intent.detail.tsx` 或实现 RFC-235 已拥有的 answer projector、action gate、mutation ledger、
  崩溃恢复、HMAC 指纹与 artifact 发布恢复链；本轮只记录阻断 finding。
- 不扩建 Onboarding 路线或改变 RFC-211 的权威三卡产品决策；数量、结果与 outcome 关联进入 RFC-211
  follow-up，不以 RFC-250 顺手增加第四条 Skill 路线。
- 不重写 Workflow Canvas 的图布局算法、节点数据模型或 React Flow 基座。
- 不由 RFC-250 重做仓库组编辑器或 `/repos` 页签；`?tab=` 回归作为 RFC-249 T31–T36 的关闭项。最终验收
  中用户明确报告 `/repos?tab=repos` 无法切换到 Memory 后，本轮按该所有权补了 canonicalizer 边界与关闭态
  editor 挂载的最小关闭增量；这不扩成 RFC-249 整体实现，也不允许其带着其它已知回归标 Done。
- 不做全站术语迁移；本轮新增/改动文案只遵循当前基线“代理 / 远端仓库 / 所有者”。
- 不引入新的全局状态库、toast 系统或第二套 Dialog / form 控件。

## 4. 范围所有权与依赖

| 审计面 | 既有所有者 | RFC-250 的动作 | 依赖 |
| --- | --- | --- | --- |
| PAT 创建与一次性 reveal | RFC-247 | 补 pending/reveal dismiss、焦点和窄屏权限矩阵合同 | 无 |
| 任务向导 / OIDC 长表单防丢 | RFC-169 原语 | 扩展共享 guard 的调用面；任务向导增加同标签页恢复 | `tasks.new.tsx` 等 RFC-249 释放所有权 |
| Clarify 草稿保存可信度 | RFC-099 | 区分本地落盘、远端同步、失败和最新 generation | 无 |
| Memory mutation 反馈 | 当前页面 | 修 archive/unarchive/delete pending/error/retry | 无 |
| Intent answers / actions | RFC-235 T5/T7 | 记录阻断 finding，不改 production | RFC-235 |
| Workflow Validate 与可读画布 | RFC-199 | 恢复已批准入口并补复杂图相机/语义缩放 | 无 |
| Onboarding | RFC-211 | 记录三卡/四线文案与 raw-click outcome finding | RFC-211 follow-up |
| Scheduled 立即运行 | RFC-159/246 | 抽单一 eligibility + confirmation projection | 无 |
| Agent Runtime 选择 | RFC-113/118 | 稳定显示 inherit / explicit pin；补注册表 loading/error 与单 runtime 回归 | 无 |
| `/repos` 页签与 RepoGroupEditor | RFC-249 | 将 URL tab/残余 dirty finding 加入 RFC-249；最终用户回归按该所有权补最小关闭增量 | RFC-249 T31–T36 |

RFC-250 实施不得把 RFC-249 的“完整编辑链、hosted visual、独立实现门”误记为本 RFC 完成，也不得用
RFC-250 的截图替换 RFC-249 尚未闭合的基准。

## 5. 产品决策

### D1 — 用“可证明的状态”驱动反馈

所有本轮 mutation 面至少区分：`idle`、`pending`、`success`、`error`。只有服务端或本地持久化层对
当前 generation 返回成功，才显示对应的“已保存/已完成”。失败保留用户输入和重试入口；pending
禁止重复触发同一个动作。

无法证明服务端是否已提交的状态只能显示“结果待确认”，不能自动重试、自动关闭或冒充失败。完整
outcome-unknown 恢复仍归 RFC-235；本 RFC 不用客户端文案掩盖缺失的后端收据。

### D2 — 一次性密钥只有显式“完成”能关闭

PAT 创建请求 pending 时，关闭按钮、Esc 与遮罩点击全部锁定；请求失败后原表单与错误保留。密钥
reveal 阶段同样禁用关闭按钮、Esc 与遮罩，唯一完成入口是 footer 的“完成”。复制成功/失败继续有
可读状态；关闭后清除内存中的 raw token。

只有明确 HTTP rejection 才回到可重试 editing；deadline、断网、client abort 等无法证明服务端未创建的
结果进入 `creation-outcome-unknown`，冻结再次创建，刷新 token inventory 并提示检查/撤销可能已创建但
无法恢复 raw secret 的条目。不得自动重试或把它写成“创建失败”。

这直接复用 `Dialog.dismissDisabled`，不新造 modal。用户不需要额外勾选“我已保存”，但不会再因
误触遮罩或 Esc 永久丢失仅显示一次的凭据。站内导航、浏览器 Back 与刷新另接未保存保护：普通 dismiss
不能离开；明确确认放弃后可以离开，`beforeunload` 使用浏览器原生确认。

### D3 — 高成本草稿采用“同标签页恢复 + 离开拦截”

`/tasks/new` 的可序列化草稿进入版本化 `sessionStorage`，按 actor、模式（new/relaunch/edit
scheduled/tour）与源对象 identity 隔离。刷新同一条流程后提供“恢复 / 放弃”选择；创建成功、明确
放弃、退出登录或 identity 不匹配时删除。上传文件本体不写入 storage，只保存文件名/大小/类型并在
恢复后明确要求重新选择。

带 userinfo/query credential 的手工 repo URL、明确标记为 secret 的输入和 client secret 不进入 storage；
只保留脱敏 metadata 并在恢复后要求重填。Task create/save pending 时冻结全部 material controls 与步骤
导航，不采用“提交快照在途仍允许继续编辑”的混合策略；失败后原样解冻。

移动导航抽屉不得在 capture phase 先卸载 Link：capture 只准备稳定焦点与 destination，Link 在自身 click
阶段把 transition 交给 router 后，bubble phase 才关闭抽屉。否则浏览器会退化为原生 document navigation，
绕过 `UnsavedChangesGuard`。桌面/390px 的 Stay、Discard 与 reload 恢复使用同一真实流程验收。

任务向导在 RFC-249 释放 `tasks.new.tsx` 所有权后实施；OIDC provider 长表单以及 RFC-249 完成后仍存在
的 RepoGroupEditor 残余草稿，都复用
`UnsavedChangesGuard`：有意义字段改变或写入在途时拦截站内导航和 `beforeunload`；成功保存后立即
解除。只切换步骤/折叠面板不算 dirty。

### D4 — Clarify “已保存”必须绑定最新 generation

Clarify 的 IndexedDB 本地写与 server draft 同步分开展示：

- 最新本地 generation 已落盘且 server 已确认：`已保存`；
- 本地已落盘、server 不可用：`已保存在本机，尚未同步` + 重试；
- 最新本地写仍在途：`正在保存`；
- IndexedDB 也失败：`草稿未保存` + 离开拦截。

server ack snapshot 只能在 PUT 成功后推进，失败不得提前覆盖 dirty 对照。组件 cleanup 不再仅清掉
最后一个 500ms timer；本地持久化对最新 generation 立即排队，server 发送仍可 debounce。同一 question
的 server PUT 必须串行并合并等待中的最新值，不能让旧请求迟到后覆盖新答案。

### D5 — Mutation 失败留在上下文中

- Memory archive/unarchive/delete：确认框在成功前保持打开，pending 锁定 dismiss，失败在框内或列表
  `FeedbackStack` 显示；只禁用同一目标动作，成功后再关闭和 invalidate。
- 页面不得只依赖开发者控制台、静默 `catch` 或 mutation object 中未渲染的 `error`。

### D6 — 聚合数据允许“部分可用”，但不允许“假空态”

首页待办预览分别保留 reviews 与 clarify 的加载/失败状态。一个源成功时可以立即展示已知结果，同时
用 warning 标明另一源不可用并只重试失败源；只有两个源都成功且合并结果为空，才显示“暂无待办”。
两源都失败显示 ErrorBanner，两源都未返回且无缓存显示 LoadingState。

### D7 — 同一业务动作共享 eligibility 和确认

Scheduled 列表与详情都调用同一个纯 `runNowEligibility(schedule)`，得到
`{ allowed, reasonKey }`。两处都使用同一种确认动作；repair/missing payload/missing schedule spec 均
禁止运行并显示同一原因。pending 防重复，失败不导航且保留重试；成功后的任务链接与 query 刷新一致。

### D8 — Dialog 焦点按阅读和方向流动

Dialog 默认初始焦点顺序为：显式 `initialFocusRef` → 标记的 body autofocus → body 第一可操作控件 →
panel；右上角关闭按钮不再成为普通表单的默认焦点。确认类 caller 必须显式把焦点送到安全动作，不由
Dialog 猜测哪个 footer button 安全。

focus trap 只在同一次 Tab key cycle 内记录方向：从第一项反向离开回到最后一项，从最后一项正向离开
回到第一项；完成一次 inside move/redirect、keyup、pointer 或 window blur 后立即清除，后续程序化逃逸
回到默认初始目标而不复用旧方向；嵌套 Dialog
与 portaled Select 继续遵守现有 topmost / `aria-controls` 合同。危险确认由 caller 显式把焦点放在
“取消/留在本页”，不默认落到 destructive primary。

### D9 — 基础控件的禁用、空集合和触屏合同一致

- Select 的键盘游标只落在 enabled option；过滤后无 enabled option 时不设置悬空
  `aria-activedescendant`，Enter/Space 不触发选择，并提供可读空态。
- Checkbox 与 Switch 保留桌面可见密度，但在 coarse pointer / ≤720px 下由 wrapper 提供至少
  44×44px 可点击目标；label 点击与 input 使用同一语义。
- disabled button/switch 不应用 hover 位移、强调色或阴影，cursor 与可访问状态一致。

### D10 — 变更文件导航不再伪装成混合 tablist

变更侧栏采用单选文件导航语义；分组折叠按钮和“已查看”复选框不再嵌在同一个 `tablist` 键盘域。
ArrowUp/Down/Home/End 只在文件项间移动，Space 在文件项上切换“已查看”，在分组按钮和复选框上执行
各自原生动作。选中、焦点、展开与查看状态互不隐式改写。

### D11 — 复杂 Workflow 首屏优先“读得清”，不是“全部塞进来”

打开画布时先计算 all-nodes fit zoom：达到可读阈值则完整 fit；低于阈值则以可读缩放聚焦入口节点、
最近选中节点或稳定首节点，并用 minimap + “查看全图”提供全局位置。用户主动查看全图时进入明确的
overview 状态；低于 action threshold 的边/节点内联按钮隐藏，屏幕空间工具栏仍提供 Add、定位选择、
放大与返回可读视图。

节点选择或键盘定位会回到可读焦点。边中点和 wrapper 添加入口在可操作状态下的屏幕命中区，桌面不小于
24×24px、coarse pointer 不小于 44×44px；不通过盲目提高 `minZoom` 把大图裁掉且不给导航。

### D12 — 恢复 Workflow 的显式 Validate 入口

工作流 PageHeader 恢复已由 RFC-199 批准的 secondary Validate，Launch 仍是唯一 primary。Validate
先等待 exact draft save，结果绑定 workflow revision/context hash，并把焦点/滚动送到 ValidationPanel。
Launch 仍执行 fresh validation，不复用旧绿色结果。

### D13 — 阻断消息必须使用公共反馈组件

AgentForm 和 Workgroup detail 等关键阻断不得使用没有基础样式/语义的裸 `.error-banner`。错误使用
`ErrorBanner`，可继续但需注意的状态使用 `NoticeBanner`；页面级多条反馈进入 `FeedbackStack`。语义、
`role`、retry 和 spacing 由公共组件负责。

### D14 — 跨 RFC finding 必须显式移交

- Intent 裸 JSON、归档动作和 mutation 反馈逐字归入 RFC-235 T5/T7；RFC-250 不修改 Intent production。
- Onboarding 三卡/四线文案、raw click 推进与完整 outcome 关联归入 RFC-211 follow-up。该 follow-up 必须
  用 step-scoped `{tourId, stepId, attemptId, kind, resourceId/taskId}` fulfilled receipt，而不是仅凭 route
  前缀或残留 DOM marker；是否 supersede 三卡形态需另获用户批准。
- `/repos?tab=` 与 RepoGroupEditor residual dirty 作为 RFC-249 关闭 finding，在 RFC-249 标 Done 前验证。
  最终验收中用户明确报告跨页回归后，允许在同一已批准工作流内按 RFC-249 所有权做最小关闭增量；不得
  借此接管 RFC-249 的完整编辑链或视觉基准。
- 全站术语治理另列 backlog；RFC-250 触及文案沿用当前基线“代理 / 远端仓库 / 所有者”，代码 identifier、
  协议 kind 与产品名不翻译。

这些移交只影响各自 RFC 的完成声明，不成为 RFC-250 production scope，也不让 RFC-250 的 Done 永久依赖
未获批准的其它设计。

### D15 — 响应式验收覆盖真实高风险内容

PAT 权限矩阵在 390px 不得靠不可见的横向裁切隐藏右侧权限；允许改为分组行/卡片或使用带明确滚动
提示的 `TableViewport`。画布、任务向导、Dialog、变更导航与操作列表都用 populated fixture，
同时覆盖长中文、长 Owner、错误消息和 disabled 状态，而不是只测空态。

### D16 — Agent Runtime 是稳定配置字段，不按候选数量隐藏

Runtime 字段始终显示。“继承全局默认”与“显式固定某个 runtime”是两个不同的持久化意图，即使当前只有
一个 enabled runtime，也必须允许双向切换。注册表初次加载时保留可见字段和当前值、禁用交互并显示
loading；初次加载失败时使用公共 `ErrorBanner` 提供 Retry，不能退回猜测性的 built-in 候选。

当前已固定但后来 disabled 的 runtime 继续显示，以免编辑其它字段时静默改写；用户仍可切回 inherit。
只有注册表成功返回后才允许选择新 pin。该决策不改变 backend runtime registry、默认解析或 Agent wire。

## 6. 分批交付

### B1 — 状态完整性与结果可信

PAT dismiss、Clarify generation、Memory mutation 反馈、首页部分失败、Scheduled 单一 run-now
合同；Task Wizard 在 RFC-249 释放相关路径后进入本批的后置子批。

### B2 — 共享交互与复杂画布

Dialog 焦点、Select、Checkbox/Switch、disabled hover、Changes 导航、Workflow 可读相机、Validate 入口、
公共 blocker banner、Agent Runtime 稳定选择与 PAT 移动矩阵。

### B3 — 跨表面集成验证与所有权移交

用真实浏览器与 hosted visual 复核 B1/B2 的组合流程，并确认 RFC-235/211/249 已接收各自 finding；不在
B3 增加 Intent、Tour、Repos 或全站术语 production change。

每批都先写与本批实现同批转绿的失败测试与视觉/几何 fixture，再改实现；不得提交跨批红测。

## 7. 验收标准

- **AC1**：PAT pending/reveal 的 Esc、遮罩和 × 均不能关闭；显式完成可关闭并清掉 raw token；无法证明
  POST 结果时显示 outcome unknown、禁止自动重试并引导检查/撤销 inventory。
- **AC2**：任务向导在有意义编辑后拦截站内离开/刷新；刷新可恢复兼容草稿；File、credentialed URL 与
  secret input 明确要求重选/重填，pending 期间 material controls 冻结；非幂等 create/save 的 unknown
  outcome 保留 frozen draft、进入 reconciliation 且不盲重试。
- **AC3**：任务创建成功、明确放弃、登出和 actor/source mismatch 会清掉对应恢复草稿。
- **AC4**：Clarify 不会在最新 local/server 写失败时显示无条件“已保存”，离开前最后一次编辑不被 timer
  cleanup 静默吞掉，同一 question 的旧 PUT 不会迟到覆盖新值。
- **AC5**：Memory mutation 失败可见、确认上下文保留、同一动作不可重复提交。
- **AC6**：首页只有两个 inbox 源都成功且为空时才显示真空态；单源失败显示 partial warning。
- **AC7**：Scheduled 列表/详情对每种 eligibility 给出相同确认、禁用与原因。
- **AC8**：Dialog 初始焦点不默认落到 ×；Tab 与 Shift+Tab 双向闭环；方向状态不污染后续程序化逃逸；
  嵌套 Dialog/portaled Select 不回归。
- **AC9**：Select 不选择 disabled option，无 enabled option 时没有悬空 active descendant。
- **AC10**：390px/coarse pointer 下 Checkbox/Switch 交互目标至少 44×44px，页面无横向 overflow。
- **AC11**：Changes 分组、文件选择和 viewed checkbox 各自键盘语义正确，无混合 tablist。
- **AC12**：14 节点复杂 Workflow 首屏文字可读；overview 有显式出口；可见添加动作达到屏幕命中阈值。
- **AC13**：PageHeader 有 Validate secondary、Launch 唯一 primary；两者都服从 exact-save/fresh-validate。
- **AC14**：关键阻断面不再使用裸 `.error-banner`，公共反馈组件的 role/spacing/retry 有 source ratchet。
- **AC15**：PAT 权限矩阵在 390px 的全部权限可发现、可操作且无无提示裁切。
- **AC16**：zh-CN/en-US 新增/变更 key 成对；触及文案遵循“代理 / 远端仓库 / 所有者”局部基线。
- **AC17**：Intent、Onboarding、`/repos` finding 分别有 RFC-235/211/249 的可追踪接收证据；本 RFC 不复制
  Intent/Onboarding production 合同，Repos 用户回归只按 RFC-249 所有权补最小关闭增量。
- **AC18**：Agent Runtime 字段在 loading/error/单一 enabled runtime/已固定 disabled runtime 下稳定可见；
  单一 runtime 仍可 `inherit → explicit pin → reload → inherit → reload`，失败可 Retry，期间不伪造候选。
- **AC19**：相关单测、workspace typecheck/lint/test/format、Chromium + WebKit 真实流程、本地 Darwin visual
  全绿；独立实现门无未处理 P0/P1。hosted Ubuntu exact-SHA visual 属于另获上库授权后的发布门，不阻塞
  未发布的 RFC implementation Done。

## 8. 批准边界

本文与 `design.md` / `plan.md` 已通过
[独立设计门](./design-gate-2026-08-03.md)，并于 2026-08-03 获用户明确批准，现可按 B1 → B2 → B3
修改 production code。该批准表示同意上述三批范围与跨 RFC 移交边界；不批准 RFC-211 follow-up、RFC-235 未完成任务或
RFC-249 新增 production change，也不自动授权提交、推送或发布。用户随后于 2026-08-03 明确要求
“完整实现之后提交上库”，因此 publication gate 已获授权，但只有 T46 的远端 ancestry、exact-SHA CI 与
hosted visual 全部成功后才可声明发布闭环。
