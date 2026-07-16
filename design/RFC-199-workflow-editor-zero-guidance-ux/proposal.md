# RFC-199 — 工作流编排器零指导 UX 与可靠草稿

> **状态**：In Progress（2026-07-16，用户明确回复「ok」批准实施）
>
> **触发**：用户要求调研并开始推进“直观、美观、不用指导可直接上手”的工作流编排体验。
>
> **范围**：Workflow Editor 的草稿保存、校验/启动交接、画布添加/连接/撤销/布局、空白态、检查器信息表达与编辑器专属响应式；保持工作流运行时语义与任务执行页不变。

## 1. 背景与现场证据

当前编辑器已经有一套能力很强的专家工作台：

- `WorkflowCanvas` 支持拖拽、复制粘贴、框选、wrapper、context menu，以及连线落点的 `NEW / REUSE` 实时预览；
- RFC-198 已补齐 palette 的点击/键盘添加，并提供 `<=720px` 的基础纵向降级；
- `NodeInspector`、validator、端口 kind、wrapper/fan-out 等领域模型已经比较完整；
- `@dagrejs/dagre` 已在前端依赖中，可复用作确定性自动布局，无需新增布局库。

问题不是“功能少”，而是第一次进入编辑器时，用户必须先猜交互、记住 ID、相信一个并不可靠的保存状态：

1. `workflows.edit.tsx` 的保存回执不绑定提交快照。PUT 在途时继续编辑，旧请求返回会无条件
   `setDirty(false)`；新改动仍在内存，却可能不再触发自动保存。
2. 查询刷新或 WebSocket invalidation 会把 `query.data` 直接写回 draft，没有 dirty/conflict 守卫；本地未保存内容可能被自身回声或他人修改覆盖。
3. 后端更新按 workflow id 无条件写入；没有 `expectedVersion` CAS。只读审计中的内存 SQLite 并发探针已复现：从 v1 同时写 A/B，两个 Promise 都返回 v2/B，最终也是 v2/B——两个提交复用版本号，A 调用方还拿到 B 的“成功回执”。
4. Launch / Validate 读取的是服务端已持久化版本。当前 Launch 会立即校验并离页，不等待最后一次自动保存；Validate 结果也不绑定本地 revision，编辑后旧“通过”仍可能看起来有效。
5. 新建 workflow 直接进入空画布。虽然 palette 已可点击添加，画布中央没有第一步，也没有模板、上下文 `+` 或可搜索命令入口；可发现性依赖用户主动扫描左栏。
6. 高效连线依然主要依赖小端口拖拽。拖拽保留价值很高，但触屏、触控板、键盘和不熟悉节点编辑器的用户缺少等价主路径。
7. `connectOnClick={false}` 是有意的：原生 click-connect 不能表达当前“选择 target input / 新建 input / REUSE”的命名端口语义。简单打开它会让错误更隐蔽。
8. 删除立即生效，编辑器没有 Undo / Redo；这让探索式编排变成高风险操作，也降低用户尝试按钮与自动布局的意愿。
9. 校验问题集中在页面下方，用户需在列表、画布、检查器间自己找对象；端口编辑仍暴露 upstream node id / port name 等回忆型输入。
10. RFC-198 的手机基线把 palette、canvas、inspector 纵向堆叠。它解决了页面溢出，但没有保住“画布是主工作区”；390px 下仍需要在三块区域间长距离滚动。

本 RFC 把“零指导”定义为：**不播放教程、不要求先读文档，用户仅凭可见界面即可从空白态完成添加、配置、连接、校验和启动；任何可能丢失工作的状态都必须可见、可恢复。**

### 1.1 外部标杆与取舍

本轮只采用可验证的官方产品资料做交互校准，不照搬品牌视觉：

- [Node-RED Quick-Add](https://nodered.org/docs/user-guide/editor/workspace/nodes) 把搜索、常用、最近使用与“在线上直接插入节点”放进同一添加入口，也用独立状态标记配置错误；对应本 RFC 的 Node Picker、edge insert 与 validation badge。
- [Zapier Canvas](https://help.zapier.com/hc/en-us/articles/19880280846221-Create-a-canvas-to-visualize-your-automated-system) 在现有步骤旁提供 contextual `+`，同时保留空白手工创建；[Clean up](https://help.zapier.com/hc/en-us/articles/30520451344397-Clean-up-your-canvas) 同时支持全图与所选步骤自动布局；对应本 RFC 的可见添加主路径与可撤销 layout transaction。
- [Make unified canvas navigation](https://help.make.com/unified-canvas-navigation) 会按 mouse/trackpad/touchscreen 适配导航并允许用户覆盖；本 RFC 吸收“输入设备不应成为能力门槛”，但核心添加/连接仍提供无拖拽 Dialog，不要求用户先配置手势。

共同结论不是“再加一套教程”，而是把动作放到对象附近、让搜索/最近项降低回忆成本、把布局和修错做成可逆的可见动作。RFC-199 进一步补上这些公开标杆未替本项目解决的强语义端口、wrapper/fan-out 与并发保存可信度。

## 2. 目标

1. 用户从新建空白 workflow 出发，不使用拖拽、不打开帮助，也能完成一条可启动流程。
2. 保存状态可信：显示的“已保存”必须对应当前本地 revision；编辑中、保存中、冲突、离线与失败不可混淆。
3. Validate、Export、Launch 均先完成同一份精确草稿的持久化；Launch 只消费刚刚确认的版本。
4. 保留现有专家拖拽与 `NEW / REUSE` 预览，同时提供键盘/触屏可用的显式“连接到…”路径。
5. 提供可见 Undo / Redo 与确定性自动布局，降低探索成本；wrapper、端口与图一致性不被绕过。
6. 将错误放到用户能修的位置：画布节点/边、检查器字段与问题列表互相导航，旧校验结果不会冒充当前结果。
7. 让编辑器在桌面、紧凑桌面与手机上始终以画布为主；palette 与 inspector 按需出现，不做三栏纵向长页。
8. 视觉方向保持克制、专业和清楚：节点显示业务标签与关键状态，原始 kind/id 退到技术详情，动作层级稳定。
9. 复用 RFC-198 的 `PageHeader`、`Dialog`、`Form`、`TabBar`、颜色/间距/focus token，不造第二套 UI 系统。
10. 用并发保存、双页面冲突、键盘/触屏、断点与真实浏览器 E2E 锁定“无需指导”而非只锁 DOM 文案。

## 3. 非目标

- 不修改 scheduler、runner、wrapper/fan-out 运行时语义或任务执行状态机。
- 不引入 AI 自动生成 workflow，也不把 prompt 输入框当作唯一创建入口。
- 不做 workflow definition 的自动三方图合并；冲突必须由用户显式选择保留方向或另存副本。
- 不移除现有拖拽添加、拖拽连线、右键菜单、框选、复制粘贴等专家路径。
- 不在本 RFC 加“运行单个节点”、运行数据预览或 task canvas 重设计。
- 不改变 workflow definition schemaVersion；starter 通过现有节点、边、端口和 wrapper 模型构造。
- 不把所有 inspector 字段塞进节点卡，也不把画布节点机械替换成公共 `Card`。
- 不 redesign Agent/MCP/Plugin/Skill 编辑器；只复用其公共 Form/Dialog 原语。
- 不承诺在任意图上得到“最漂亮”的全局最优布局；目标是确定性、可撤销、尊重 wrapper 边界与用户锁定位置。

## 4. 产品原则

### P1 — 信任先于炫技

只要存在丢改动或旧版本启动的可能，添加更多动效和入口都不会让产品真正“好用”。本 RFC 的第一批必须先完成版本 CAS、快照回执、单写队列和 `ensureSaved()`；后续交互全部建立在可信草稿上。

### P2 — 可见主路径，不依赖隐藏手势

核心任务不能只存在于 drag、right click、hover 或快捷键：

- 空白画布显示“添加第一步”与“从模板开始”；
- 顶部始终有“添加步骤”；
- 选中节点或边时显示 contextual `+`；
- 节点动作中有“连接到…”；
- Undo、Redo、自动布局有按钮，也有快捷键。

隐藏手势继续作为加速器，而不是能力门槛。

### P3 — 先认业务语言，再看技术细节

节点主标题使用 agent/resource 名称或用户命名；副信息只显示最关键的类型、输入/输出数量、配置状态。raw node kind、node id、upstream id 和原始 JSON 移到折叠的“技术详情”。需要 ID 的内部引用改成可搜索对象选择。

### P4 — 渐进披露，不一次展示所有能力

- 创建时只问完成当前步骤必需的信息；高级端口、wrapper、runtime 配置留在 inspector 对应分区。
- Node Picker 先展示“常用/推荐”，再搜索全部资源。
- Validation 先给可执行结论，再允许展开错误码、pointer 等诊断信息。
- Starter 只提供少量可信起点，不做模板市场。

### P5 — 用户始终知道“系统现在在做什么”

保存、校验和启动是三个不同阶段：

- 草稿状态：`有未保存更改 / 正在保存 / 正在核对 / 已保存 / 保存失败 / 与远端冲突 / 无法继续访问 / 远端已删除`；
- 传输状态：`在线 / 实时连接降级 / 离线`，离线只说明暂时无法确认服务端，不冒充“保存失败”或“已保存”；
- 校验状态：`待校验 / 正在校验 / 当前版本通过 / 当前版本有问题`；
- 启动状态：在保存与校验通过前禁用并说明原因，启动中防重复。

不使用一个绿色圆点同时表达三种含义。

## 5. 核心体验

### 5.1 空白态与 Starter

空白画布中央显示：

- primary：**添加第一步**，打开可搜索 `NodePicker`；
- secondary：**从模板开始**，打开 starter Dialog；
- 一行非教程式提示：“选择一个执行角色开始，之后可继续添加和连接。”

v1 starter 只有三项：

1. **标准开发闭环**：编码 → 并行审计 → 修复；
2. **只做审计**：输入 → 审计 → 输出；
3. **空白流程**：关闭 Dialog 回到 Node Picker。

模板不猜 agent。应用前通过角色映射页让用户选择现有 agent，并实时说明缺失端口/aggregator 等不兼容原因；不能构造合法 definition 时禁用“应用”。若标准闭环缺少 aggregator 候选，明确推荐“只做审计”而不是静默构造错误 wrapper。

### 5.2 添加节点

`NodePicker` 作为单一能力面，被以下入口复用：顶部“添加步骤”、空白态、节点/边 contextual `+`、wrapper 内“添加内部步骤”、现有 palette 点击/键盘入口。它支持：

- 搜索显示名、类型与能力摘要；
- 最近使用、推荐与全部资源分组；
- 键盘上下选择、Enter 确认、Escape 返回触发点；
- 根据入口预览结果：自由放置、接在选中节点后、插入选中边；
- 仅在语义兼容时启用“添加并连接”，否则解释缺哪个端口/类型。

palette 与拖拽继续存在；本 RFC 不回退 RFC-198 已完成的 click/keyboard add。

### 5.3 连接节点

保留现有端口拖拽和 `NEW / REUSE` drop hint。新增显式“连接到…” Dialog/模式：

1. 从当前节点动作或端口旁按钮进入；
2. 选择 source output；
3. 搜索兼容的目标节点；
4. 选择复用 target input 或创建命名 input；
5. 提交前显示 `A.output → B.input` 预览与 kind 兼容结论。

该路径必须完全可键盘操作，并适配触屏；不直接启用 xyflow 原生 click-connect。

### 5.4 安全探索

工具栏提供 Undo、Redo、自动布局：

- Cmd/Ctrl+Z 撤销，Shift+Cmd/Ctrl+Z / Ctrl+Y 重做；
- 新操作发生在 undo 之后时清空 redo；
- 删除节点、删边、添加/插入、连线、批量移动、wrapper 调整都可撤销；
- canvas、inspector 与名称/描述共享一条按时间排序的 history；拖动、连续输入和 Dialog submit 以明确 transaction 合并，旧 canvas history 不会跨过较新的 inspector edit；
- clean remote follow、加载远端或切换 workflow 时清 history；保存回执与自身 WebSocket 回声不清 history；
- 自动布局是一次可撤销 transaction，默认 left-to-right，保持 wrapper membership 与显式锁定尺寸/位置。

### 5.5 修错与启动

点击 Validation 问题会：

- 定位并选中对应节点/边；
- 必要时 fit view；
- 打开 inspector 对应 section，并把焦点放到可修字段；
- 无法定位的全局问题留在顶层，不伪造节点关联。

Validation summary 固定在 toolbar；正常高度下详情作为不参与 grid 排版的限高 overlay 自滚动，`<=720px` 或短视口改用互斥的 full-screen/sheet surface。错误数量增加时不得继续挤压画布。检查器仍只保留“编辑 / 提示词预览”两个顶层模式，Review/Loop 等复杂配置在“编辑”内部按基础、流程、高级、技术信息渐进披露，不继续增加同级 Tab。

每次 definition/name/description 编辑都令旧结果变成“上次校验，当前草稿待重新校验”。Launch 执行固定序列：

`短暂冻结本次 Launch 编辑 → ensureSaved(click revision) → validate(saved version/hash) → navigate launch`

任一步失败或版本变化都不离开编辑器，并在原处给出可恢复行动。

### 5.6 响应式与动作层级

- `>=1536px`：240px palette + 至少 520px canvas + 选中对象时 `clamp(360px, 27vw, 420px)` inspector；无选择时 canvas 扩展。
- `1180–1535px`：至少 520px canvas + 选中对象时 360–420px inspector；“添加步骤”打开左侧 Dialog sheet。1280px 不再被 240px palette 压成约 252px 窄画布。
- `721–1179px`：canvas 是唯一基底；palette 与 inspector 分别使用左/右 Dialog sheet，且同一时刻只挂载一个 modal surface。
- `<=720px`：canvas 保持稳定可用高度；Node Picker、Connection Dialog、Inspector 使用 full-screen Dialog sheet，不把三块纵向堆成长页。

顶部动作固定为：名称与保存状态 → Undo/Redo/Layout → Validate → primary Launch。Export、Rename、ACL、Delete 收入共享 Dialog action list；危险动作转入共享确认 Dialog，不在本 RFC 新造 Menu 原语。

本节仅窄幅 supersede RFC-198 对 workflow editor 的纵向堆叠策略；其 shell、token、Dialog、Form、PageHeader、TabBar 与全站断点仍为基础设施。

## 6. 成功指标与验收场景

### 6.1 必过任务

1. 新用户在 390px 与 1280px，从空白 workflow 出发，不拖拽、不打开帮助，能添加两个节点、配置、连接、修完校验问题并进入 Launch。
2. 保存请求在途时继续编辑，旧回执不会显示“已保存”；排队保存最终持久化最新 revision。
3. 两个页面同时编辑：后保存者收到明确冲突，本地内容不消失，可另存副本、加载远端或显式覆盖。
4. 点击 Launch 的瞬间仍有未保存编辑：服务端最终版本、校验版本与启动页面消费版本相同。
5. 键盘用户无需拖拽即可添加、连接、撤销、校验并定位问题；焦点可预测且 Escape 返回入口。
6. 自动布局后 wrapper membership、端口边、selection 与画布不变量保持；一次 Undo 恢复原坐标。
7. 390px 页面无 body 横向溢出，打开/关闭 picker/inspector 后焦点恢复，canvas 不因三栏堆叠被推到首屏之外。
8. 页面断线期间另一端提交：重连后 clean 草稿跟随，dirty 草稿进入冲突；旧绿色校验在 agent/skill/plugin inventory 变化后不能被 Launch 复用。
9. 保存期间 owner/ACL 变化或资源变得不可见：本地草稿不消失，也不把不可区分的 403/404 冒充“已删除”；用户仍可本地导出、在有权限时另存副本或返回列表。
10. 不拖拽创建空 git/loop/fan-out wrapper 后，可从容器内可见入口添加 child；membership、definition 绝对坐标 / renderer 相对投影和 Undo 正确。
11. 大量 Validation issue 时问题列表独立滚动、当前 issue 可定位聚焦；normal-height overlay 或 compact/short-height modal 关闭后的 summary-only 状态下，canvas 不低于对应断点的几何下限。compact/short-height modal 打开时改验 full-screen surface、最后 issue 与焦点交接，不要求背后 canvas 可见；Output/Review/Edge 的 node/port 引用均不要求手输 raw ID。

### 6.2 质量门

- 保存/冲突以纯状态机和 backend CAS 并发测试为主，不能只用组件 mock。
- 交互以 rendered component + Playwright 锁定；保留真实 drag connect `NEW / REUSE` 回归。
- canonical 视口：1536、1280×800、1180/1179、901/900、721/720、390；light/dark、200% zoom、reduced-motion。
- axe、完整键盘路径、触摸点击目标与无 drag-only 核心任务必须通过。
- visual fixture 使用确定性 workflow、固定资源名与关闭非必要动画，避免靠扩大截图阈值吞差异。

## 7. 风险与处置

| 风险                                            | 处置                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 保存重构同时改 name/definition 通道，范围过大   | 先抽 composite draft machine 与单写队列，再迁现有入口；每批都有旧行为反证测试                                |
| CAS 让 YAML import 等旧写入者失败               | 全仓枚举 UpdateWorkflow 调用点；每个 writer 显式传 expectedVersion，preview/apply 绑定同一版本               |
| 自动布局破坏 wrapper 内坐标                     | 顶层与每个 wrapper 分层递归布局，使用现有 coord projection/wrapper fit；fixture 锁边界                       |
| Undo 误覆盖 inspector 新改动                    | route 维护 composite history；所有本地编辑按 transaction 入同一时间线，远端替换边界才清 history              |
| 模板错误猜测领域语义                            | role mapping preflight + backend candidate/golden validator oracle；无合法候选时 fail closed，不自动降级     |
| 更多菜单降低动作可发现性                        | 高频动作保持可见；Export/ACL 等低频动作提供稳定菜单与快捷入口，真实可用性测试覆盖                            |
| 小端口仍不满足触屏                              | 扩大命中区且不改变视觉密度；显式 Connection Dialog 作为完整等价路径                                          |
| RFC-198 completion hunks 与 editor CSS 接缝冲突 | 以 `e48ba3e7` live foundation 为基线；RFC-199 只拥有 editor-scoped selector 与业务组件，不接管并行文档 hunks |

## 8. 依赖与批准门

- 依赖 RFC-198 最终实现基线 `e48ba3e7` 已落且状态已收口的公共 UI 原语与 click/keyboard palette；本 RFC 不改写其历史归属，实施前仍按 live source 复核接缝。
- backend CAS 与 frontend draft machine 必须先落地并通过并发门，后续 UI 批次才能开始。
- 本文件、`design.md`、`plan.md` 已于 2026-07-16 获用户明确回复「ok」批准；production 实施按 `plan.md` 的 G1 → G2 → G3 → G4 强顺序推进。
