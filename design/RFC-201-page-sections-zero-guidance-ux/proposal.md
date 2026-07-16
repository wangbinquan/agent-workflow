# RFC-201 — 全站页面分区、草稿安全与零指导细节 UX

> **状态**：In Progress（2026-07-16，用户明确回复「ok」批准实施；B1–B6 与正式测试已完成，B7 仅待原生 Ubuntu visual 与 exact-SHA CI）
>
> **触发**：用户要求在 RFC-199 的整体方向之后，逐页检查 Tab 是否合理、Tab 内布局与可用性是否友好，并把系统推进到“不用指导即可上手”；同时允许修正 RFC-199 与全局布局遗漏。
>
> **范围**：全站页面级分区导航、表单/模式 Tab、分区内草稿与保存边界、响应式可发现性、能力/权限过滤、关键空态与操作反馈；Workflow Editor 本身仍由 RFC-199 B4–B9 负责。

## 1. 先校正当前事实

RFC-199 不是“整体 UX 已全部落地”。当前仓库权威状态为：B0–B3 与 G1 已完成，B4 正在进行，B5–B9 尚未完成。真实 1280px 页面中，选中节点后的画布只剩约 250px；空画布仍没有第一步 CTA，连线仍以拖拽为主。因此：

- Workflow Editor 的空白态、Node Picker、非拖拽连线、自动布局、Validation 定位、Inspector 渐进披露、四档 workspace 与 header 动作层级，继续在 RFC-199 内完成；
- 本 RFC 不复制或接管这些任务，只修全站页面分区与表单保存契约；
- 本轮审计发现的 RFC-199 漏项——Validation 列表限高自滚动、Review/Edge 的 raw ID 选择、`Preview` 的业务命名——直接回填 RFC-199 设计与计划。

## 2. 现场证据

### 2.1 真实浏览器几何

使用隔离临时 daemon、真实 Chromium、英文/中文与 1280/390 视口走查，得到以下可重复现象：

1. **Settings** 有 9 个平级 Tab。390px 时 tablist 可视宽约 366px、内容宽约 808px，只露出前 4 项，界面没有“右侧还有内容”的可见提示。Runtime 卡片在 390px 出现名称、路径与操作按钮相互覆盖；Network 的单个输入在 1280px 下横跨近 1000px，难以扫描。
2. **Task detail** 有 9 个普通任务 Tab、动态任务最多 10 个。390px 中文页签内容宽约 685px，后半段产物/反馈入口完全在屏外；1280px 又挤成一条横跨整页的密集导航。
3. **Memory** 有 5 个平级 Tab。390px 内容宽约 493px，末项被裁；侧栏 badge 合并了候选与融合待办，普通 `/memory` 却总落到候选审批，Fusion 仍在第 5 项。
4. **Agent detail** 的 5 个表单分区本身合理，但 390px 下最后一项不可见；`Ports 1`、`Resources 2` 这类普通库存数量被渲染成 danger 红色。Resources 文案直接暴露 `dependsOn closure`、`cachedPath`、环境变量与 spawn 网络细节，不符合零指导语言。
5. **Workflow Editor** 在 1280px 同时显示 240px palette 与 480px inspector，实测 canvas 约 250px；该问题已由 RFC-199 T14 明确负责。

### 2.2 不是视觉问题，而是会丢工作或产生假成功的问题

| 等级 | 表面                       | 当前行为                                                                                                                                                         | 风险                                                                                     |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P1   | Settings                   | 只挂载 active Tab；每个 Tab 的 `useTabState` 是组件局部状态，切 Tab 即卸载；config refetch 又无条件重播种；LanguageSwitch 还会把可能过期的完整 config 展开后 PUT | 切 Tab、Back/Forward、旧 GET 晚到或并行语言切换会丢草稿/回滚 clean baseline/覆盖别的字段 |
| P1   | Agent Advanced             | `JsonField` 把非法 raw JSON 留在组件内部且不通知父层；页面 dirty/Save 只看最后一个合法对象                                                                       | 离页无守卫，Save 可能保存旧值却让用户以为保存了当前输入                                  |
| P1   | Skill Files                | 正文与文件树是两个独立 dirty/save 域；页头 Save/guard/History 只认识正文，文件树另有同名 Save                                                                    | 页头动作语义不真实，切资源可丢文件草稿                                                   |
| P1   | Workgroup panels           | group config 与 member editor 各自维护本地草稿和 Save，panel 切换只在 mutation pending 时受限                                                                    | 两个 Save 作用域互相误导，切 panel/关闭可丢草稿                                          |
| P2   | MCP Probe / Plugin Updates | Config 有 dirty 时，操作 Tab 仍基于服务端旧配置执行；保存校验失败只显示在隐藏 Config Tab                                                                         | 用户会误判“探测/更新了刚编辑的配置”，且不知道为何保存失败                                |
| P2   | Skill ZIP                  | 已选文件、review 决策与解析结果不在 route dirty guard 内                                                                                                         | 离开页面静默丢导入进度                                                                   |

### 2.3 结构与语义缺口

- 共享 `TabBar` 已有 roving tabindex、Arrow/Home/End、ARIA panel 关联与 active scroll；基础不是重写目标。
- 它只有 `overflow-x:auto` 与细滚动条，没有起止溢出状态、边缘提示或滚动控制。高基数页面因此“技术上能滚，产品上不可发现”。
- `TabDef.badge` 没有 tone；普通数量与真正错误都使用 danger。
- Memory 对非管理员仍显示 admin-only Distill Jobs；Compare 对话框还会把可管理 owner 错降成只读。
- Task 把状态、执行、产物、协作摊成 9/10 个同级 Tab，也会展示对当前 task 明确不适用的 worktree 类页签。
- Task Outputs 使用半套 `listbox` 语义：所有 option 都进入 Tab 序列，却没有 Arrow/Home/End。
- Clarify shard 实际是切换 sibling route，却借用 Tab 外观且没有 `aria-current`。
- Skill detail 的 Overview 只有路径/描述，正文另占 Content；层级多但信息少。
- 部分 Tablist 没有 accessible name；Node Inspector 的 `Preview` 实际只预览提示词。

关键源码证据：Settings active-only mount / local reseed 位于 `packages/frontend/src/routes/settings.tsx:135-199,1657-1678`；Agent raw-invalid 隔离位于 `packages/frontend/src/components/JsonField.tsx:19-67` 与 `AgentForm.tsx:386-405`；Skill 双保存域位于 `packages/frontend/src/routes/skills.detail.tsx:74-125,194-255` 与 `SkillFileTree.tsx:67-139,257-281`；共享 Tab overflow/badge 位于 `TabBar.tsx:43-203` 与 `styles.css:4213-4260`；Memory 默认/权限与 Task leaf 清单分别位于 `memory.tsx:33-80,132-172`、`task-detail-tabs.ts:35-111`。实施前仍需按 live source 重取行号与调用闭包，不能把本文行号当静态 oracle。

## 3. 目标

1. 用户在桌面、390px 手机、短横屏与 200% zoom 下，都能一眼知道“当前在哪、还有哪些分区、下一步做什么”，不依赖横向手势发现入口。
2. 任何 Tab/panel 切换都不静默丢草稿；任何 Save/已保存文案都精确覆盖用户当前看见并编辑的内容。
3. 页面级高基数导航按用户任务分组，不把 9–10 个异质入口摊成一排；已有 URL wire key 与程序化深链继续有效。
4. 表单分区、展示模式、页面章节与 sibling route 使用正确的不同原语，不把所有“切换”都画成 Tab。
5. 能力、权限与 task shape 决定入口是否出现；不让用户点进只会说“不适用/仅管理员”的死页。
6. 操作页明确说明使用的是“当前草稿”还是“已保存版本”，并提供能闭环的保存、重试与结果反馈。
7. 页面内部使用与内容类型匹配的语义宽度；保留 task/canvas/table 的工作区宽度，不用全局 `.page` max-width 粗暴收窄。
8. 保留 RFC-198 已正确的 Tab 键盘合同、URL resolver、`TabPanels` keep-mounted 和公共视觉 token。

## 4. 非目标

- 不在 RFC-201 实现 Workflow Editor 的 B4–B9，也不改 workflow/runtime/schema/ACL 语义。
- 不重做所有页面业务流；Review 评论、Clarify 同步、Account 信息架构等本轮发现但与 Tab 主链无直接关系的问题，只记录为后续输入，不借本 RFC 无限扩张。
- 不把每个长页面都改成 Tab。Account 等可连续阅读页面优先采用页内标题/锚点，而不是制造新的隐藏状态。
- 不新增 DB migration、resource route 或持久化字段。唯一 backend wire 增量是 MCP/Plugin 操作的 `operationConfigHash` / `expectedConfigHash`：GET/PUT 返回服务端语义 hash，Probe/Check/Upgrade 必须带 expected hash 并在不匹配时 409 fail closed。
- 不让隐藏 panel 中的重型 query/effect 全部常驻；草稿提升为页面级 registry，不等于把九个 Settings 子树全部 keep-mounted。
- 不用多行 wrap 解决高基数 Tab；多行 tab order 与空间位置会在响应式下变得难以预测。

## 5. 产品决策

### D1 — 先按语义选原语，再谈样式

全站切换面分成四类：

1. **页面章节 `PageSectionNav`**：改变 URL、可深链、离开后可恢复，适合 Settings、Memory、Task detail。它接受 group + leaf 模型，不再伪装成一条无限横向 Tab。
2. **表单/模式 `TabBar`**：同一对象内的局部分区或显示模式，local state，默认 keep-mounted；适合 Agent、Skill、MCP、Plugin、Auth、Node Inspector。
3. **同级路由 `PeerNav`**：目标是另一个 sibling resource/route 时使用 link/chip 与 `aria-current="page"`；Clarify shard 不再借 `.tabs__tab`。
4. **对象选择器**：文件、输出、结构 diff 等 master/detail 列表使用真正的 list/vertical tabs；要么实现完整键盘模型，要么回到普通按钮列表，不保留半套 ARIA。

`TabBar` 的 `ariaLabel` 或 `aria-labelledby` 变为必填；source ratchet 覆盖所有 callsite 与手写纵向 tablist。

### D2 — 页面级分区按任务分组，wire key 不变

#### Settings

- **执行环境**：Runtime、System agents、Limits
- **可靠性**：Recovery、GC
- **连接与访问**：Network、Authentication
- **界面**：Appearance、Rendering

仍接受 `?tab=runtime|systemAgents|...` 与旧 `#runtime` 规范化，默认 Runtime 不变。

#### Memory

- **待处理**：Candidate approval、Fusion approval
- **记忆库**：All、By scope
- **自动化**：Distill jobs（仅有权限时出现）

普通侧栏“Memory”进入稳定的记忆库默认页；待办 badge 改为独立、可访问的 sibling action，根据真实来源深链到 Candidate 或 Fusion，不再只导航到模糊 `/memory`，也不能在主导航 Link 内嵌第二个 Link。不可见 leaf 不渲染；直接访问无权限 key 时 replace 到最近的可用 leaf，并给一次非错误说明。

#### Task detail

- **概览**：Workflow status、Details、Orchestration（按 task shape）
- **执行**：Node runs
- **产物**：Outputs、Worktree files、Worktree diff、Structure（按能力出现）
- **协作**：Questions、Feedback、Chatroom（按 task kind/权限出现）

所有现有 `TaskDetailTab` query wire key、async resolver、外部跳转与默认优先级保持；展示层只增加 group。Questions/Fusion 等待办数量提升到 group/leaf 可见 badge，不再藏在屏外。

`PageSectionNav` 提供两种呈现但共用一份数据/ARIA/URL 模型：Settings/Memory 用 desktop rail；Task 把 inline group + active-group leaf 压进同一紧凑横排，不再用两排导航挤占正文高度。窄屏都收敛成共享 `Select` 的单一“当前分区”选择器，使用现有 `SelectOption.group` 呈现分组并让辅助技术读到 group + leaf，所有 leaf 一次可发现。

任务详情的异常、恢复、版本同步与不可恢复提示统一提供独立关闭按钮；关闭只隐藏当前 task 的当前信号签名，新告警/新版本/新恢复事件必须重新出现。多条提示进入有界可滚动 stack，不能无限压缩下方工作区；完全加载失败的 fatal error 因无可用正文，不提供关闭。

### D3 — 表单 Tab 保留少而稳，修正命名与状态

| 表面               | 决策                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent              | 保留 Basics / Prompt / Ports / Resources / Advanced 五分区；Resources 改用户语言“能力与协作”，技术细节折叠；普通计数使用 neutral badge，错误才 danger |
| Skill detail       | Overview + Content 合并为“编辑”，保留“文件”“版本”；managed path 收入技术信息                                                                          |
| Skill new          | “Managed”改“手动创建”，“ZIP import”改“导入 ZIP”；ZIP staged state 进入组合 dirty                                                                      |
| MCP                | 保留 Config / Probe；dirty 时 Probe 明示基于已保存版本并提供“保存并重新探测”                                                                          |
| Plugin             | 保留 Config / Updates；dirty 时 Check/Upgrade 明示旧版本并提供“保存并检查更新”                                                                        |
| Auth               | 保留 Password / OIDC / Token；OIDC discovery error 不再伪装成“系统没有 SSO”                                                                           |
| Node Inspector     | 保留 Edit / Preview 两项，不 URL 化；目标文案“编辑 / 提示词预览”与复杂 sections 由 RFC-199 实施，RFC-201 B2 只补最小 accessible name                  |
| Node detail        | 保留 Session / Events / Output / Stats；为事件/输出增加 neutral 数量或按确定能力隐藏                                                                  |
| Worktree/Structure | 保留纵向文件 Tab，补 accessible name，不改键盘合同                                                                                                    |

高基数页面已经迁出后，公共 `TabBar` 仍增加可复用的 start/end overflow 状态、边缘 fade 与可访问滚动按钮，保证 5 项 Agent 等在 390px 下也不会把最后一项悄悄藏掉。按钮只滚动，不改变 active；键盘左右仍按 tab 顺序切换。

### D4 — 草稿、校验与 Save 必须是同一真相

新增轻量页面级 `EditScopeRegistry` 合同；每个可编辑子面注册：

```ts
interface EditScopeState {
  id: string
  dirty: boolean
  busy: boolean
  valid: boolean
  stale: boolean
  firstInvalidTarget?: string
}
```

页面从 registry 派生总 dirty/busy/valid 与离页守卫；保存仍由页面 owner 依既有 API 组合，不让通用组件直接发请求。关键规则：

1. 切同一页面章节时保留草稿，不弹确认；离开 resource/route 时对组合 dirty 统一 guard。
2. raw-invalid 也是 dirty。`JsonField` 必须上报 raw value/parse state，不能只在合法时通知父层。
3. Settings 每个 leaf 的 baseline/draft/dirty 提升到 route registry。所有 config GET/PUT 通过同一 frontend causal receipt coordinator：本 tab 的 PUT 进入单写队列；旧 GET 若在后续 PUT settle 前已经发出，即使最后返回也不得回滚 exact PUT baseline；PUT 后强制发起更新 epoch 的 refetch。clean scope 只跟随可接收 receipt；dirty scope 冻结本地值并显示“服务器配置已变化”，由用户 reload 或保存覆盖，不静默重播种。所有 `/api/config` writer 只发最小 `ConfigPatch`，LanguageSwitch 严格只发 `{language}`。
4. Skill 正文与文件形成一个页面级组合状态；页头 Save 要么保存所有 dirty scope，要么把按钮写成精确作用域并在另一个 scope 显示唯一明确 Save。v1 选择“保存所有更改”；metadata 与逐文件操作必须串联前一响应的新 composite token，并按 path/op 结算。响应丢失等 ambiguous outcome 不得拿旧 token 盲重试：用 token-before → refetch tree/content → token-after 取得稳定 authoritative snapshot，前后 token 相同且远端已等于提交意图（含 delete 后确实不存在）才按 matching revision 收敛 clean；token 变化则重试核对或保留 outcome-unknown，远端不同则保留 dirty/stale。History 在 dirty/busy/outcome-unknown 时给出原因并要求先收敛、保存或放弃。
5. Workgroup config/member editor 使用同一组合 dirty/guard；因现有 PUT 是 config+members full-replace，Save All 必须捕获一个组合快照并只发一次 PUT，不能把两个 scope 串行覆盖。panel handoff 不丢本地值。
6. ZIP select/review 是 dirty；稳定的 result 状态 clean。文件替换、Back、侧栏导航都走同一 guard。
7. 提交成功只清除本次提交快照所包含的 scope；提交在途产生的新修改继续保持 dirty。
8. 校验失败若目标在隐藏 Tab，自动激活目标 Tab、聚焦首错并播报；不把错误留在看不见的 panel。

### D5 — 操作 Tab 必须披露执行版本与完整结果

MCP Probe、Plugin Check/Upgrade 以及任何“读取持久化配置再执行”的操作都遵守：

- clean：显示“基于已保存配置”，可直接执行；
- dirty：显示“当前改动尚未保存，本操作仍会使用已保存版本”，primary 为“保存并探测/检查”，secondary 才允许“仍使用已保存版本”；
- 保存失败：切回 Config、定位首错，不发后续操作请求；
- GET/PUT resource 回执携带由服务端 exact operation-basis projection 计算的 `operationConfigHash`；projection 覆盖完整可变资源 revision，Plugin 还包含 immutable install generation/cachedPath，不能只取 `spec` 或版本文案。操作 POST 必带 `expectedConfigHash`，服务端在同一次加载后比较，不匹配返回 409 且不执行；响应回显 `configHashUsed`，资源变更操作同时返回新 hash；
- 同一 resource id 的所有 mutation（含 ACL/owner transfer）与异步操作共享 daemon keyed coordinator，并在锁内按 stable id 重载与重新鉴权：Plugin 先安装到唯一 immutable generation，校验后才以单次 DB row update 发布新 cachedPath；失败/崩溃不触碰当前 live cache。MCP Probe 以 `{stable id, operationConfigHash}` 对完整 start→I/O→finalize 去重，为不同 operation 分配单调 generation 与因果 `startedAt`；完成后必须在锁内重取 hash 且仅最新 generation 可落库，stale/superseded 结果不得 upsert 成当前 last probe；
- frontend operation settle 同样 fail closed：只有本地 request id 仍 current，且 `configHashUsed` 与当前 query hash 满足 CAS，才允许更新 resource/result cache；否则丢弃旧 receipt、标记结果已过期并 refetch，不能让 200 响应乱序回滚较新的 PUT；
- loading、transport error、never-run、success-no-change、update-available、upgrade-success 各有独立稳定状态与 retry；
- mutation 回执只描述本次请求，不把旧缓存冒充新结果。

### D6 — 能力和权限先过滤，空态给下一步

- Task 的 Outputs/Files/Diff/Structure 由真实 capability 决定是否出现；异步能力未稳定前不规范化用户 URL，稳定后沿用 RFC-198 的 replace/push 合同。
- Memory 的 Distill Jobs、Candidate/Fusion 操作按真实权限过滤；owner 在列表与 Compare 内使用同一 `canManage` oracle。
- admin-only/不适用不是一个值得占据导航位置的“空页面”。直接深链才显示解释与返回可用分区动作。
- Approval Queue、Fusion、Probe、Updates 等 empty state 说明“为什么为空”和“下一步去哪里”，不只说“暂无内容”。

### D7 — 内容宽度按语义，不回退全宽工作区

- `.page` / `.content` 继续全宽；不修改 RFC-198 的全局 page-fill 合同。
- Settings 的字段型 panel 使用约 760–840px 的 reading/form measure，Runtime/列表 panel 可放宽到约 960px；字段帮助文案不横穿整屏。
- Task、canvas、table、diff 保持 workspace width；导航本身不能把工作区压窄。
- Runtime card 在窄屏改为 main/meta/actions 三段纵向布局，动作 wrap/grid，不发生覆盖；Delete 使用共享确认 Dialog。
- `ResourceSplitPage` 以当前实现的 `<=1080px` list-or-detail 为新合同，显式 supersede RFC-198 原来的 721–1080 stack 描述；补 1081/1080、901/900、短视口、Back/focus/dirty 几何门。

## 6. 全表面验收矩阵

| Surface                      | 状态/导航              | RFC-201 验收                                                     |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------- |
| Settings                     | URL page section       | 分组、草稿 registry、refetch 冲突、语义宽度、Runtime mobile      |
| Memory                       | URL page section       | 待处理/记忆库/自动化、权限过滤、badge 深链、owner action 一致    |
| Task plain/dynamic/workgroup | URL page section       | 四组、capability filter、旧 key/deep-link、workspace width       |
| Agent new/detail             | local form tabs        | keep-mounted、overflow affordance、neutral badge、raw JSON dirty |
| Skill detail                 | local form tabs        | Edit/Files/Versions、组合 save/guard/history                     |
| Skill new                    | local mode tabs        | 用户语言、ZIP dirty/guard                                        |
| MCP detail                   | local form/action tabs | saved-vs-draft、hidden validation handoff、完整 result state     |
| Plugin detail                | local form/action tabs | saved-vs-draft、hidden validation handoff、完整 result state     |
| Auth                         | local mode tabs        | late provider、discovery error、输入保留                         |
| Node Inspector               | local tabs             | Edit/Prompt preview、accessible name；复杂字段归 RFC-199         |
| Node detail drawer           | local tabs             | neutral counts/能力隐藏、accessible name                         |
| Agent import                 | local source tabs      | 保持 Upload/Paste 与 busy contract                               |
| Worktree/Structural diff     | vertical tabs          | 保持完整键盘合同，补 name                                        |
| Task Outputs                 | object selector        | 真 vertical tab/list 或普通按钮模型，零半套 listbox              |
| Clarify shard                | sibling route          | PeerNav + `aria-current`，不再伪装 Tab                           |
| Workgroup studio panels      | local editor panels    | 组合 dirty/save/guard，handoff 不丢值                            |

## 7. 成功场景

1. 在 Settings Limits 改值，切到 Network 再返回，值仍在；Back/Forward 也不丢。dirty 时配置 refetch 不覆盖输入，并给出可处理的 stale 状态；PUT(B) 成功后，先前发出的 GET(A) 晚到不会把 clean baseline 回滚，语言切换也不会携带过期全量 config 覆盖其他字段。
2. 在 Agent Advanced 输入非法 JSON，Save 不会保存旧对象或显示假成功；离页会拦截，错误可聚焦。
3. 编辑 Skill 正文与文件后，页头 Save 对两者的结果都真实；在保存前切资源会统一拦截。若服务端已写入但 200 丢失，页面先用 authoritative refetch 判断已应用/未应用并取得 fresh token，不会把成功操作当失败后重复 PUT/DELETE。
4. 在 390px 下，Settings/Memory/Task 的所有章节通过单一选择器一次可发现；Agent 最后一项有明显溢出提示且可用键盘/触摸到达。
5. Task 仍能用旧 `?tab=worktree-diff` 等深链；页面把它放在“产物”组，不适用的 leaf 不出现，异步 resolver 不抢用户选择。
6. MCP Config 修改后去 Probe，用户能明确选择“保存并探测”或“仍用已保存版本”；保存失败会回到错误字段，零误请求。双客户端无论在 operation 开始前插写、probe 已开始后换配置/转移 owner、同配置 A 慢/B 快，还是 backend 已返回 200 后前端先收到较新 PUT，都不能让旧结果覆盖当前资源：前者零执行/409，异步完成使用 stable-id+hash dedup 与 latest-generation finalize，前端再做 request/hash CAS。Save→Probe 即使落在同一毫秒，立即结果与刷新后的 freshness 也一致。
7. Plugin Upgrade 的 npm/git 安装失败、DB finalize 失败或进程中断，当前 DB 与 runner 正在使用的 cachedPath 都保持原样；成功安装发布带 source-identity manifest 的唯一 generation，即使版本文案相同 hash 也变化。Git 上游新 commit 即使 `package.json.version` 未变也能被 Check 识别；并发 Check 使用真正唯一临时目录，旧 generation/orphan 只由保守 GC 回收。
8. Memory 的主导航进入记忆库，独立待办 badge action 点击后直接到有待办的 Candidate/Fusion；两者都保留正确的移动端关闭/焦点合同。非管理员看不到 admin-only 死入口，owner 在 Compare 仍可完成动作。
9. 1280px Settings 字段不横跨整屏；390px Runtime 卡片无重叠；Task/canvas/diff 没被全局 max-width 或 rail 挤窄。
10. 宽屏 Task detail 的 group 与 active leaves 只占一个不高于 52px 的导航行；多条异常提示进入有界 stack，每条均可独立关闭。键盘关闭时焦点顺移到下一条，最后一条关闭后回到当前分区、页头或 AppShell 主内容；同一告警的计时 detail 刷新不会反弹，只有新 alert identity、严重度升级或新的恢复/版本信号才重新出现。
11. 所有 tablist 有可访问名称；Arrow/Home/End、focus restore、URL history、200% zoom 与 light/dark axe 均通过。
12. RFC-199 的 1280 inspector-open canvas 至少 520px，Validation 大列表自滚动且不压垮 canvas；这些门在 RFC-199 而不是本 RFC 重复实现。

## 8. 兼容与 supersede

- **窄幅 supersede RFC-198 D6**：Settings 实际有未保存草稿，不再属于“无 draft 的 page-level tabs”；Settings/Memory/Task 的展示与 ARIA 原语由横向 `TabBar/tabpanel` 改为 `PageSectionNav + aria-current`；Memory 缺省 leaf 从 `approval-queue` 改为 `all`。三页既有 URL leaf key、validator/resolver、functional search update、push/replace 与 Back/Forward 合同全部保留。
- **窄幅 supersede RFC-198 split breakpoint**：ResourceSplit `<=1080px` 使用 list-or-detail，不再使用 721–1080 list+detail stack；其余 shell 900/content 720 断点不变。
- **不 supersede RFC-199**：仅把审计漏项回填 B8/B9；所有 Workflow Editor 主体验仍按 RFC-199 既有批准范围实施。
- 现有 query key、route、resource CRUD、DB schema、ACL 与业务状态机不变；只新增 D5 的 exact-operation hash wire。

## 9. 风险与处置

| 风险                                            | 处置                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 把“页签重排”做成全站大改且难验证                | 按草稿安全 → 公共导航原语 → Settings/Memory/Task → 资源表单 → 细节门分批，每批独立可回滚              |
| 草稿 registry 让所有 panel 常驻并触发重复 query | 只提升 serializable draft/baseline/status；active panel 仍按需挂载，effects 由 owner 控制             |
| 分组导航破坏已有深链                            | leaf wire key 为唯一 URL 真相；group 仅展示元数据，旧 key 路由测试逐项锁定                            |
| Responsive rail 挤压 task 工作区                | Task 使用 inline variant；真实 bounding-box 门直接断言 panel 宽度，不只查 class                       |
| Save all 产生部分成功                           | 同一 API 的 scope 批量提交；跨 API 采用确定顺序与逐 scope receipt，任一失败不清未提交/新修改 dirty    |
| 共享 TabBar 改动波及 visual baseline            | 保持 DOM/keyboard 基线，overflow control 仅在真实溢出时出现；逐 callsite source ratchet + visual gate |

## 10. 批准边界

本文件、`design.md`、`plan.md`、RFC-199 漏项修订、`design/plan.md` 与 `STATE.md` 属方案阶段。用户明确批准 RFC-201 前，不修改 production code、测试或视觉基线。批准后按 `plan.md` 的 B1 → B7 顺序实施；RFC-199 继续按其 B4 → B9 顺序，由两个 RFC 的路径 owner/批次避免共享文件交叉覆盖。
