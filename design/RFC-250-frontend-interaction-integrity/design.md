# RFC-250 · 技术设计：前端交互完整性与一致性

- 状态：Implementation Complete / Publication In Progress（自有范围与独立实现门已闭环；远端发布门执行中）
- 配套：`proposal.md`、`plan.md`
- 约束：优先改共享原语与纯投影；除现有 endpoint 的正常调用外不改 backend/shared wire
- 实现证据：`implementation-evidence-2026-08-03.md`

## 1. 当前断点与权威源

| 断点 | 当前证据 | 本 RFC 的权威源 |
| --- | --- | --- |
| PAT 可误关 | `CreateTokenDialog.tsx` 的两个 phase 都把 `close` 直接交给 Dialog；pending 只禁 footer button | Dialog dismiss policy + create mutation phase |
| Task Wizard 全内存 | `tasks.new.tsx` 的 kind/space/content/step 均为 route-local `useState` | 版本化 session draft + authoritative seed baseline |
| Clarify 假“已保存” | debounce cleanup 只 clear timer；server ref 在 PUT 成功前前移；失败被 catch 吞掉 | local/server generation ack |
| Memory mutation 静默 | confirm 后立即 `setPending(null)`，mutation error 未渲染 | target-scoped mutation state |
| 首页假空态 | 只有两源同时失败才报错，任一源缺失时以 `[]` 合并 | 两个 query 各自状态的纯投影 |
| Scheduled 漂移 | list 用 `runNowBlocked + ConfirmButton`，detail 直接 primary button | shared eligibility + shared action component |
| Dialog 方向错误 | 初始 `querySelector(FOCUSABLE)` 命中 ×；逃逸统一回第一项 | initial focus resolver + Tab direction |
| Changes 混合语义 | `role=tablist` 祖先同时含 group button、file tab、checkbox | 分离 group controls 与 file navigation |
| Canvas 不可读 | `fitView` 可降到 `minZoom=.2`，边/节点内 action 随 viewport 缩放 | readable camera + explicit overview |
| Validate 入口回归 | route 存在 `handleValidate`/ValidationPanel，PageHeader 没有 Validate | RFC-199 exact validate contract |
| Agent Runtime 字段消失 | enabled registry 只有一项时 `AgentForm` 按候选数量隐藏 Select | 稳定字段 + registry truth + inherit/pin 意图 |
| 导览误推进 | `advanceOnClick` 在请求结果前推进；脚本只有三条路线 | 移交 RFC-211 follow-up |
| Intent 裸 JSON | answers turn 直接 stringify；多个 mutation error 未进入 JSX | 移交 RFC-235 T5/T7 |

本 RFC 不建立新的服务端“真实状态”。若现有响应无法判断 mutation 是否提交，前端只能显示未知并停手；
完整 ledger/replay 仍由 RFC-235 提供。

## 2. 共享实现原则

### 2.1 不建全局 mutation store

各页面继续使用 TanStack Query mutation。共享的是纯状态投影与反馈布局，不是把所有请求搬入 Context：

```ts
type OperationUiState =
  | { phase: 'idle' }
  | { phase: 'pending'; targetId: string; startedAt: number }
  | { phase: 'error'; targetId: string; error: unknown }
  | { phase: 'success'; targetId: string }
  | { phase: 'outcome-unknown'; targetId: string; messageKey: string }
```

页面可以直接从 mutation state 派生等价结构；只有同一组件需要管理多种 target/action 时才保存
`{kind,id}`。`FeedbackStack` 负责稳定占位，`ErrorBanner` 负责错误语义与 retry，`NoticeBanner` 负责
partial/local-only/overview 等非失败信息。

写请求失败统一复用现有 `classifyWriteOutcome(error, { idempotent })`：只有明确 4xx rejection 是
definitive；非幂等 POST 的 5xx、transport failure、deadline、abort 与 body-read timeout 都是 unknown，
不能自动重试。GET/refetch 失败不改变已经确认的 mutation outcome。

### 2.2 Source ratchet 优先禁止回归形态

新增 source-contract tests 锁定：

- 高风险 Dialog 调用必须传 dismiss policy；
- `AgentForm` / `workgroups.detail` 不存在裸 `className="error-banner"`；
- Workflow PageHeader 同时存在 Validate secondary 与唯一 Launch primary；
- `/tasks/new` 挂载 draft recovery + `UnsavedChangesGuard`。

source ratchet 只防结构性回退，不能替代行为、浏览器和视觉测试。

## 3. Dialog 与一次性凭据

### 3.1 保留现有 dismiss API

`Dialog` 已有 `dismissDisabled`、`closeOnOverlayClick`、`closeOnEsc`，本轮不再添加同义 enum。
`CreateTokenDialog` 的调用规则：

| phase | dismissDisabled | footer |
| --- | --- | --- |
| editing idle/error | `false` | Cancel + Create |
| request pending | `true` | disabled Cancel + pending Create |
| reveal | `true` | 唯一 enabled `Done`，直接调用显式完成 handler |
| creation outcome unknown | `true` | 检查 token 列表 / 显式结束，不提供 Create retry |

reveal 的 `Done` 不经 Dialog dismiss 路径；它先清除 component raw token，再关闭。reveal 期间以
`UnsavedChangesGuard` 阻断 route/Back 并启用原生 beforeunload；guard 的“放弃并离开”是有明确风险文案
的第二次确认，不等同于 Dialog 的普通 dismiss。creating 作为 busy 状态接入同一 guard，不能通过导航
制造“服务端可能已签发、前端已丢响应”的静默状态。

POST 前捕获当前可见 PAT id 集、request startedAt 与非敏感请求摘要。`classifyWriteOutcome` 为 definitive
才回 editing；unknown 时立即 refetch inventory，突出 startedAt 后新增且与非敏感摘要匹配的候选，提示
raw secret 已不可恢复并提供现有 revoke 路径。零个或多个候选都不能证明未创建，因此不自动重试；用户
只能继续检查/撤销后显式结束。inventory 对照只是恢复辅助，不伪装 exact idempotency。若需要“一键安全
重试”，必须另加 backend idempotency wire 并回 RFC 门。

POST 发出前另写一个不含 raw secret/credential 的 session reconciliation marker（startedAt、name、purpose、
scopes、expiry 摘要）；definitive rejection 或进入 reveal 后删除。busy guard 的强制离开、reload 或组件
崩溃保留 marker，下次进入 token 管理面必须先 refetch 并进入同一 unknown 检查提示，不能恢复成普通
Create。用户显式完成检查/撤销后才清 marker。

每个 attempt 使用独立 AbortController；force-leave 可停止客户端等待，但 abort 仍按 non-idempotent unknown
处理，marker 必须保留。组件卸载后的迟到 Promise 不再写 UI state，inventory reconciliation 是唯一恢复面。

`onCreated()` 若在 token 已经创建后失败，不能把 phase 退回可重试创建并生成第二个 token：保留 reveal，
另显示“列表刷新失败”，
允许独立 retry invalidate。create endpoint 成功是密钥事实，列表刷新只是后续观察。

create error 保留 `unknown` / `ApiError` 交给 body 内 `FeedbackStack + ErrorBanner`，不先降成 footer string，
以免丢掉 code、detail 与 retry 语义。

### 3.2 默认初始焦点

`Dialog` 内新增纯 `resolveInitialDialogFocus(panel, explicit)`，顺序为：

1. connected explicit ref；
2. caller 显式标记的 `[data-dialog-autofocus]`（body/footer 均可）；
3. `.dialog__body` 内第一个 enabled focusable；
4. panel。

`.dialog__close` 不参与隐式候选。caller 仍可显式指定 close，但默认不这么做。`ConfirmButton`、
`UnsavedChangesGuard` 等危险确认将安全动作 ref 作为 `initialFocusRef`。`ConfirmDialog` 自己明确三种默认：
danger 聚焦 Cancel，普通确认聚焦 Confirm，type-to-confirm 聚焦输入框；公共 Dialog 不读 `.btn--danger`
之类 CSS class 猜业务语义。

### 3.3 双向 focus trap

现有 topmost stack 与 `isFocusInsideDialog` 保留。新增 capture `keydown` 记录最近 Tab 方向：

```ts
type TabDirection = 'forward' | 'backward'
```

keydown 保存 `{direction, sourceElement}`。只有紧随其后的 escape `focusout` 源仍等于该 sourceElement，
才应用方向：forward 聚焦第一个候选，backward 聚焦最后一个候选；inside focus move、一次 redirect、
Tab keyup、非 Tab key、pointerdown 或 window blur 均清空 token。无因果匹配的程序化逃逸聚焦默认 initial
target，不能复用上一次 Shift+Tab。Select portal 属于 dialog owned node，不触发 redirect；嵌套 dialog
只由栈顶处理。

## 4. 草稿、持久化与离开

### 4.1 Task Wizard draft envelope

新增 `lib/task-wizard-draft.ts`，只含纯 schema、迁移、比较和 storage adapter：

```ts
interface TaskWizardDraftV1 {
  schemaVersion: 1
  actorId: string
  flow: 'new' | 'relaunch' | 'edit-scheduled' | 'tour'
  sourceId: string | null
  savedAt: number
  baselineFingerprint: string
  step: number
  values: {
    kind: WizardKind
    workflowId: string
    agentId: string
    workgroupId: string
    selectedWorkgroupVersion?: number
    space: SerializableWizardSpace
    taskName: string
    inputs: Record<
      string,
      { kind: 'value'; value: string } | { kind: 'reentry-required' }
    >
    uploadMetadata: Record<
      string,
      Array<{ name: string; size: number; type: string; lastModified: number }>
    >
    description: string
    goal: string
    allowClarify: boolean
    collaboratorIds: string[]
    gitUserName: string
    gitUserEmail: string
    workingBranch: string
    autoCommitPush: boolean
    maxDurationMin?: number
    maxTotalTokens?: number
  }
}
```

storage key 由 `actorId + flow + sourceId` 组成，并带固定产品前缀；不把用户名、URL 或 prompt 放进 key。
JSON parse 后先执行严格 schema/version/size 校验，再进入 UI。envelope 最长保留 24 小时、单份上限
512KiB；超限时不截断用户输入，而是显示“无法写入恢复草稿”并继续用 guard 保护当前内存。未知版本、
过期、超限、actor/source mismatch 直接丢弃并给一次性 warning，不猜迁移。

`SerializableWizardSpace` 是专用 allowlist，只含 cached repo/group id、branch/subdir/readonly 等非敏感选择
与 `repoUrlRedacted`。手工 URL 一旦含 userinfo、credential-like query/fragment 或无法证明无凭据，就不
保存原文，只保存 `{requiresRepoUrlReentry:true}`；明确标记 secret 的 workflow/agent input 同理只保存
reentry marker。未知敏感性按不持久化处理，绝不为恢复率把 credential 写进 sessionStorage。

### 4.2 Seed barrier 与恢复优先级

Task Wizard 已有 tour、deep link、relaunch、edit scheduled 与 workflow exact revision seed。恢复必须等对应
authoritative seed 完成后比较 `baselineFingerprint`：

1. flow/source 不同：不读取；
2. fingerprint 相同：询问恢复或放弃；
3. fingerprint 不同但 draft 可重新校验：显示“来源已变化”，允许恢复普通文本/选择，再要求重新确认
   workflow version、workgroup version、repo/ref 和 collaborators；
4. 权限消失、对象删除或 schema 不兼容：禁止恢复，清理 envelope 并显示原因。

URL/deep-link 的显式 identity 永远优先于 storage。恢复不会绕开既有 fresh query、ACL、revision fence 或
launch validator。

### 4.3 写入与 dirty

建立 initial seed snapshot 后，material values 与 snapshot 不等即 dirty；`step/maxVisited/advanced fold`
本身不构成 dirty，但可以和 envelope 一起保存以恢复位置。输入变更以短 debounce 写 sessionStorage；写失败
进入 visible local-draft error，guard 仍保持。File 只保存 metadata，恢复后每个非空 slot 标记
`requiresReselect=true`，提交继续使用现有 File presence validator。

route 中用同步 ref 驱动既有 `UnsavedChangesGuard`：

```ts
dirtyRef.current = materialDirty || persistenceFailed ? draftKey : null
busyRef.current = createTask.isPending || saveScheduled.isPending
```

`onDiscard` 同步清 storage + reset local draft。create/edit success 后先清 envelope，再导航。登出清理沿用
现有本地草稿清除入口并加入 task-wizard 前缀。

Task create/save pending 时冻结全部 material input、step navigation、restore/discard 与普通 dismiss；只显示
当前 submitted snapshot 的 pending。definitive failure 后解冻并保留原草稿。请求若无法证明 outcome，
保留 frozen snapshot 并进入已有任务 inventory/reconciliation 提示，不允许继续编辑后对同一 snapshot
盲重试。RFC-250 明确选择“pending 冻结”，不实现 submittedGeneration 后继续编辑的分叉策略。

### 4.4 Guard 的 save-and-proceed 扩展

Clarify 需要“先把最新值写入 IDB，再继续被拦导航”，因此给 `UnsavedChangesGuard` 增可选且向后兼容的
`onSaveAndProceed?: () => Promise<void>` 与对应 copy key。为 PAT/Clarify 等特殊风险增加可选 i18n key
override（title/body/stay/discard/save/failed），不接收 caller 拼装的裸 HTML。blocked dialog 在该 action pending 时锁 dismiss；
Promise fulfilled 且 caller 已同步清 dirty ref 后才 `resolver.proceed()`，reject 则留在原页并显示
`ErrorBanner`。既有调用方未传该 prop 时行为完全不变；`beforeunload` 仍只能显示原生提示。

移动抽屉导航必须先让 TanStack `Link` 在自身 click 阶段 `preventDefault()` 并把 transition 交给 router，之后
才能关闭抽屉。capture phase 只准备稳定焦点与 pending destination；同步在 capture 中卸载 link 会退化为
浏览器原生 document navigation，使 `useBlocker` 没有机会看到 transition。`ShellNavigation` 与移动 footer
因此采用 prepare(capture) / complete(bubble) 两阶段合同，并由 390px 真实恢复流程锁住。

### 4.5 OIDC 与 RepoGroupEditor

OIDC provider Dialog 不做长期 storage（含 client secret，不应持久落盘），只做内存 dirty + dismiss confirm：
字段改变后，Esc/遮罩/× 先进入共享未保存确认；test/save pending 时 dismiss locked。成功后关闭。

RepoGroupEditor residual dirty 只作为 RFC-249 T31–T36 finding；RFC-250 不接入、不引入 session storage，
也不改 tree/data wire。最终用户回归只在 route owner 处让关闭态 editor 不挂载，打开态仍完整复用原 guard。

## 5. Clarify generation ledger（前端本地）

这不是服务端 ledger。route 内维护单调 `editGeneration`、`localAckGeneration`、
`serverAckGenerationByQuestion`：

1. 每次 answer material change 递增 generation，并立即把 immutable snapshot 送入串行 local IDB writer；
2. writer 始终合并到最新 snapshot，成功只推进对应 generation；失败保留 snapshot 和 error；
3. server PUT 仍以 500ms debounce 合并，但 `serverDraftRef` 只在该 question PUT 成功后更新；
4. server 403/409 等 definitive disabled 时显示 local-only warning；可恢复网络错误保留 retry，不永久禁用；
5. 新远端 draft 只在本地未从最后 ack diverge 时采用，维持现有 per-question merge 语义。

每个 question 维护单飞 server queue：任一时刻最多一个 PUT in flight，新 generation 只替换 queued latest；
前一请求 settle 后若 ack snapshot 与 queued latest 不同，再发送下一次。客户端不能依赖 Abort 证明服务端
未提交，也不能并发 PUT 后用完成顺序推进 ref。跨成员继续沿用服务端 per-question LWW；本客户端只有在
自己的队列排空且 latest question snapshot fulfilled 时才显示 server synced。

展示纯函数：

```ts
projectClarifyDraftStatus({
  latest,
  localAck,
  latestQuestionGeneration,
  serverAckGenerationByQuestion,
  localError,
  serverPending,
  serverError,
  sealed,
})
```

`sealed` 优先；`latest > localAck` 时绝不显示 saved；任一 material question 的 server ack 小于 latest
question generation 时也不能显示 server synced。`flushLatest()` 在写入期间又出现新 generation 时继续
排队，直到调用时可见的最新 local generation 已 ack，不能只等最初 submitted snapshot。Save-and-leave
只等待本地 IDB，成功文案必须是“已保存在本机并离开”，不得暗示 server sync 已完成。站内导航若 local
writer 尚未确认或失败，通过共享 guard 阻断；beforeunload 只承诺原生提示，不能声称浏览器会等待异步
IDB。submit 成功后删除 local draft。

CentralizedAnswerDialog 使用相同 writer/projector，避免 detail 与弹层继续存在两套“已保存”定义。

## 6. Mutation 与聚合状态

### 6.1 Memory

用 `PendingConfirm` 扩展为 `{kind,id,phase,error}`，或保持 target state + mutation error，但必须满足：

- confirm 后不立刻设 null；
- `mutateAsync` 成功后 close；
- pending 时 `dismissDisabled`，两个 footer action disabled；
- error 在 Dialog body 的 `FeedbackStack` 展示，Retry 使用 frozen `{kind,id}`；
- unarchive 的 error 在列表上方显示，失败行仍在原位置；
- disable 精确到 target，不能因为一行 pending 锁死所有无关阅读/导航。

### 6.2 Intent finding 移交

`intent.detail.tsx` 的 answers 裸 JSON、archived action 和未渲染 mutation error 已由 RFC-235 T5.4/T5.5/T7
拥有。RFC-250 不新增 `IntentActionFeedback`、projector 或临时 `canMutate`；设计门把源码位置与负向场景
作为阻断 finding 移交 RFC-235。它们不进入本 RFC production diff 或完成 AC。

### 6.3 首页 partial feed

新增 `projectInboxPreviewState(reviewsQuery, clarifyQuery)`：

```ts
type InboxProjection =
  | { kind: 'loading' }
  | { kind: 'error'; errors: unknown[] }
  | { kind: 'empty' }
  | { kind: 'items'; items: InboxPreviewItem[]; failedSources: InboxSource[] }
```

缓存 items 可在 refetch error 时继续渲染并附 warning；`empty` 要求两源 `isSuccess`。retry 只触发
`failedSources`。`onCount` 仍返回已知 item 数，不伪造未知源数量。

### 6.4 Scheduled

把 `runNowBlocked` 替换为公共 `scheduleRunNowEligibility`（放在既有 `lib/schedule-view.ts` 或相邻纯模块）：

```ts
type RunNowEligibility =
  | { allowed: true }
  | { allowed: false; reason: 'migration-needed' | 'payload-missing' | 'spec-missing' }
```

list/detail 均将它传给同一 `ScheduledRunNowAction`，内部复用 `ConfirmButton`、pending、ErrorBanner 和成功
回调。两处保留各自布局，不复制 eligibility。

## 7. 基础控件

### 7.1 Select

键盘 active 状态从易漂移的数组 index 改为 `activeValue: V | null`，并新增纯 helpers
`enabledOptions` / `nextEnabledValue` / `firstEnabledValue`。open/Arrow/Home/End/typeahead 都调用 helper；过滤
或 options 动态变化时重新校正 active value。当前已选值若后来 disabled，trigger 仍诚实显示它，但打开后
导航从 enabled option 开始，不擅自改值。

没有 enabled option 时 active 为 `null`，combobox 移除 `aria-activedescendant`，Enter/Space no-op；只有
active 对应的 enabled DOM option 已挂载时才输出该 ARIA 引用。鼠标 hover disabled option 不改变 active。
空态文案区分“没有匹配项”“当前选项均不可用”和“源集合为空”，这些提示不伪装成 `role=option`。

### 7.2 Checkbox / Switch / disabled visuals

不放大 15px checkbox glyph 或 34×20 switch track；扩大其 label/control wrapper 的 hit area。CSS 使用
`@media (pointer: coarse), (max-width: 720px)` 设置 `min-inline-size/min-block-size:44px`，但 flex/grid 的
`min-width:0` 链必须保持，避免表格溢出。

所有 `.btn:hover` / switch hover 规则改成 `:not(:disabled)` 或 `[aria-disabled!='true']` 等价选择器；disabled
规则清除 transform、box-shadow 和 hover background。测试同时读 computed style 与 pointer hit rect。

### 7.3 Changes 文件导航

推荐 DOM：

```text
aside
  button(group header, aria-expanded)
  nav(aria-label=file selector)
    ul
      li(file row)
        button(aria-current=true when selected)
        input(type=checkbox, viewed)
```

不采用 `listbox`（option 内不能再嵌交互 checkbox），也不保留伪 tab/tabpanel。group disclosure 增稳定
`aria-controls`；file button 用 `aria-current`，detail 是有自身稳定 heading 的 section，不依赖可能因折叠卸载
的 selector id。Arrow/Home/End handler 只绑定 file button，按当前获得焦点的 file key 和可见 file 顺序
移动，不能截获 checkbox/group button 原生按键。折叠含焦点的组时把焦点送回 group header；Space 在 file
button 上保留“标为已查看”快捷键并声明 `aria-keyshortcuts="Space"`。

### 7.4 Agent Runtime 稳定选择

`AgentForm` 不再从 runtime 数量推导字段是否存在。Select 的值继续使用现有 wire：空字符串只作为 UI
sentinel，写回时投影为 `runtime: undefined`（继承）；具体 runtime name 写为 explicit pin。注册表成功后，
options 由 `inherit + enabled rows + 当前已固定 disabled row` 组成；不得用静态 built-in fallback 掩盖
registry loading/error。

初次 query 尚无 data 时字段保持挂载且 Select disabled：fetching 显示紧凑 `LoadingState`，error 显示
`FeedbackStack > ErrorBanner` 与 Retry。若 Agent 已有 pin，trigger 在加载/失败阶段仍显示该 name，但不可
选择新值；refetch 成功后恢复交互。这样避免异步加载造成布局跳变、空 trigger 或在保存其它字段时静默
改写 runtime。单一 enabled runtime 必须同时提供 inherit 和该 runtime，保留显式 pin 能力。

## 8. Workflow Canvas 相机与动作

本节只改变可编辑 Workflow editor 的相机与动作投影；camera mode 是纯 UI state，不进入 definition、history、
dirty/save。共享组件以明确 `cameraPolicy="readable-editor"`（或等价现有 prop）启用，并用 editable namespace
约束 zoom-band CSS；task detail、workgroup preview 等只读消费面保持现有 fit/尺寸，除非另有独立验收。

### 8.1 两种相机状态

```ts
type CanvasCameraMode = 'readable-focus' | 'overview'
type CanvasZoomBand = 'topology' | 'overview' | 'readable'

const TOPOLOGY_MAX_ZOOM = 0.55
const READABLE_MIN_ZOOM = 1.1
const OVERVIEW_MAX_ZOOM = 0.75
```

zoom band 只在跨阈值时更新 React state，不能在 `onMove` 每帧重建全图。`topology(<0.55)` 只保留轮廓、
边、选择/运行/校验标记；`overview(0.55..<1.10)` 显示标题/类型/状态；`readable(>=1.10)` 才显示完整
配置、端口文案与可操作入口。视觉隐藏不能用会改变节点几何的 `display:none`。

初次加载/稳定 owner identity（workflow id + authoritative load epoch）改变时计算 all-node fit zoom；不能以
每次编辑都会产生新引用的 definition object 作为 reset key。keep-mounted hidden tab 的 0×0/未完成测量阶段
只记录“待初始化”，直到容器有非零 rect、节点 measured 且现有 settle 条件满足后才执行一次 planner：

- `fitZoom >= READABLE_MIN_ZOOM`：fit all，mode=`readable-focus`；
- 否则：以最近选择、入口或稳定首节点在 1.10–1.25 聚焦，mode=`readable-focus`，minimap 显示全局范围；
- 用户点“查看全图”才以 `maxZoom=0.75` fit all 并进入 `overview`；选中 node、搜索结果、validation issue
  或“返回可读视图”聚焦该对象并退出 overview。大 wrapper 聚焦 header，不为塞下整个 wrapper 再缩回
  不可读；edge 聚焦中点并由 Inspector 表达两端。

不在每次 node size/WS/refetch 更新时抢夺用户手动 camera；一旦用户 pan/zoom，只在稳定 owner identity
变化或显式 fit/focus action 时再控制相机。

### 8.2 screen-space actions

canvas route 持有当前 zoom 并投影到 CSS custom property。只有 `logicalHitSize × zoom >= 24px` 时桌面才
渲染 edge midpoint / wrapper inline add；coarse pointer 的同一条件为 44px。否则它们退出 DOM/Tab 顺序，
screen-space toolbar 始终保留 Add/搜索/选择定位/放大。可见 action 可使用 inverse-scale 或 React Flow
non-scaling overlay，使实际 `getBoundingClientRect` 达标；视觉 glyph 可小于 hit rect，但 focus ring 必须
覆盖 hit rect。

overview 中节点/edge 仍可选择和读取摘要，不允许不可见的 5px control 获得 Tab 焦点。NodePicker 和
keyboard add 是同一动作的非画布入口。readable focus 的 14px title 有效屏幕字号至少 15.4px，11px
配置/端口至少 12.1px；聚焦对象在扣除 toolbar/minimap 后四边留至少 16px。相机动画遵守
`prefers-reduced-motion`。overview 的 selection/status/validation marker 屏幕尺寸至少 8px；390×844 编辑
画布可视高度继续 ≥560px，640×400 短视口继续 ≥240px，不回退 RFC-199 已批几何合同。

### 8.3 Validate 入口

PageHeader actions 顺序固定为：save state / secondary Validate / primary Launch / More。Validate 调用现有
`handleValidate`，不得另写 endpoint；完成后将 `validationBinding` 设为结果，并 focus/scroll
`ValidationPanel` heading。validation issue jump 复用现有 canvas focus path，进入 readable-focus。

## 9. 反馈与跨 RFC finding

### 9.1 Blocker banner

替换 caller JSX 而非补一个新的全局 `.error-banner` 样式：

- 无法继续/保存失败：`ErrorBanner`；
- 缺依赖、只读、需先配置但页面仍可探索：`NoticeBanner tone="warning"`；
- 多 channel 使用 `FeedbackStack variant="section"`。

i18n 文案描述用户下一步，不把 API error code 当标题；technical detail 可保留在组件既有 detail 面。

### 9.2 Intent / Onboarding 移交合同

Intent finding 归 RFC-235，见 §6.2。

Onboarding 的三卡/四线文案、raw click 推进与未完成路线归 RFC-211 follow-up。该 follow-up 若实施 outcome
推进，不能只监听 route 前缀或稳定 DOM marker；最小关联收据为：

```ts
interface TourOutcomeReceipt {
  tourId: TourId
  stepId: string
  attemptId: string
  kind: 'resource-created' | 'resource-saved' | 'validated' | 'task-created'
  resourceId?: string
  taskId?: string
}
```

attempt 必须由当前 step 的真实 action 发起，只有该 mutation/receipt fulfilled 才发布；迟到、重复、其它
resource、reload 后失去 active attempt 的回执不得推进。route/DOM 只负责把已证明的 outcome 定位展示。
RFC-250 不实现该接口，也不增加第四条 Skill 路线；是否 supersede RFC-211 权威三卡形态需单独批准。

## 10. `/repos` finding 移交与最终关闭增量

原设计不由 RFC-250 修改 `components/repos/RepoGroupEditor.tsx` 或 RFC-249 visual fixture。当前
route-local Tab 是 RFC-198 URL-state 合同的已知回归，必须进入 RFC-249 T31–T36：strict search 只认
`repos|groups`，无参数默认 repos，Back/Forward、刷新、deep link 与 query gating 有浏览器证明；非法值
replace 到默认且不污染 history。RepoGroupEditor residual dirty 也由 RFC-249 实现门定案。

最终验收中用户明确报告 `/repos?tab=repos` 无法切换到 Memory。实现按 RFC-249 所有权把 canonicalizer
限定在 committed `/repos` location，并让关闭态 editor 不挂载；没有修改 editor 内部、tree/data wire 或
visual fixture。RFC-249 未证明其余 finding 前仍不能标 Done，本次关闭增量不能替代其完整实现门。

## 11. 响应式与可访问性验收

几何从 DOM 实测，不以截图主观判断代替：

- widths：1280、1024、736、390；390 同时测 844 与 568 高度；
- browsers：Chromium + WebKit；keyboard 全链至少两者；
- `documentElement/main/owned viewport` 均 `scrollWidth <= clientWidth + 1`；允许横向数据 viewport 时必须
  有可聚焦容器、可读 label 和首屏滚动提示；
- coarse pointer control hit rect ≥44×44；canvas desktop inline action ≥24×24；
- dialog 初始/循环/restore focus 有 activeElement exact assertions；
- axe critical/serious = 0；视觉基准覆盖 light/dark 与 populated/error/pending 状态。

PAT 权限矩阵优先在窄屏改为 capability group cards；若保留横向表，必须复用 `TableViewport` 的显式语义，
不可仅加 `overflow-x:auto` 后让右列首屏无提示消失。

## 12. 测试矩阵

### 12.1 纯函数 / 单元

- task draft schema/key/fingerprint/restore compatibility/clear policy/file metadata；
- clarify generation projector、server failure/local-only、late ack 与 remote merge；
- inbox two-source truth table；scheduled eligibility；
- Select enabled-value navigation；Agent Runtime inherit/pin projection；Canvas camera mode/focal node planner；
- dialog focus target resolution与 forward/backward wrap。

### 12.2 组件 / 路由

- PAT editing/pending/reveal 的 Esc、overlay、×、Done、copy、onCreated failure，以及 POST 5xx/transport/
  body-read timeout/force-leave outcome unknown 与 inventory reconcile；
- Task Wizard new/relaunch/edit/tour seed barrier、dirty/discard/create success、File recovery、credentialed
  repo URL/secret input 不落盘、pending 全控件冻结，以及 create/save 5xx/transport/body-read timeout 的
  `classifyWriteOutcome`、unknown reconciliation 与零盲重试；
- Clarify rapid type→navigate/unmount、IDB fail、server fail/retry、同题 PUT 人工乱序、准确 local/server
  status copy 与 Save-and-leave 只承诺 local；
- Memory archive/unarchive/delete error/retry；
- Changes group/file/checkbox keyboard；Select all-disabled/filtered-empty；shared mobile controls；Dialog 内部
  正常 Tab 后程序化 focus 外逃不复用旧方向；
- Workflow Validate header/result focus、overview/readable focus、low-zoom Tab exclusion；
- Agent Runtime 单一候选、disabled pin、loading/error/retry；blocker feedback source ratchet；双语 key parity。

### 12.3 Playwright / visual

- Chromium + WebKit：任务草稿编辑→站内导航→留在/放弃、reload→恢复；Dialog Tab/Shift+Tab；
  Scheduled list/detail；Changes keyboard；390px Agent Runtime inherit→pin→reload→inherit→reload。
- complex workflow fixture ≥14 nodes：desktop/390 初始标签 screen px、camera mode、minimap、查看全图、node
  focus、edge/wrapper action rect；hidden 0×0 mount 后 reveal、用户 pan 后 definition refetch 不抢相机、
  0.55/0.75/1.10 阈值边界。
- 视觉：PAT matrix/reveal、Task Wizard dirty dialog、Clarify local-only/error、complex Workflow
  readable/overview、Changes sidebar、blocker ErrorBanner；Darwin baseline 与人工查看是 implementation
  Done 门。只有用户另行授权提交/推送时，才运行 hosted Ubuntu exact-SHA baseline 作为发布门。

## 13. 失败回退与兼容

- session draft 是客户端 best-effort；storage unavailable 时显示 warning，guard 仍保护内存草稿。
- 旧浏览器 storage 没有 draft 不改变当前 seed；未知 envelope 只清自身 namespaced key。
- Dialog 新焦点策略会影响全部 caller，因此先以公共组件测试和代表性 dialog E2E 锁回归；保留显式 ref
  escape hatch。
- Canvas 若 inverse-scale 在 WebKit 产生定位漂移，inline action 可在低 zoom 全部隐藏，依靠 screen-space
  toolbar/NodePicker 交付；不得退回 5px 可点击点。
- Intent/Onboarding/Repos 的 handoff 证据缺失时 RFC-250 不能 Done；它们的 production closure 不成为
  RFC-250 dependency。

## 14. 设计门要求

设计门必须独立核对：现有公共原语能否承载、不与 RFC-235/RFC-249 重叠、Task Wizard seed 是否会被
stale draft 绕过、Clarify ack 是否真实、PAT 是否会重复生成、Canvas 是否同时保留全局可探索性与局部
可读性、跨 RFC finding 是否有可追踪接收证据。所有 P0/P1 必须在请求用户批准前修订进本 RFC。
