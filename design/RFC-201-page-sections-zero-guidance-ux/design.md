# RFC-201 — 详细设计

## 1. 约束与所有权

### 1.1 权威来源

- URL leaf key：TanStack Router validated search；group 不是新 wire，不进入 URL。
- 表单草稿：对应 route owner；公共组件只上报状态与事件，不自行持久化。
- 远端 baseline：现有 query 返回的 config/resource revision；没有 revision 的 Settings 以 query snapshot identity + field projection 比较。
- 权限/能力：现有 backend wire 与前端 selector；不得根据文案、空数据或 404 猜权限。
- 保存结果：mutation 本次提交快照的 receipt；不能仅因 query invalidation 或 mutation resolve 就清全部 dirty。

### 1.2 文件 owner 边界

RFC-201 预计主要触及：

- `packages/frontend/src/components/TabBar.tsx`
- 新的 `PageSectionNav` / `PeerNav` / edit-scope helper
- `packages/frontend/src/routes/settings.tsx`
- `packages/frontend/src/routes/memory.tsx`
- `packages/frontend/src/routes/tasks.detail.tsx` 与 task tab resolver/shape helper
- Agent/Skill/MCP/Plugin/Workgroup 对应 detail/new route 与局部组件
- route-scoped CSS、i18n 与 frontend tests/e2e

以下继续由 RFC-199 owner 修改：

- `workflows.edit.tsx`
- `WorkflowCanvas.tsx`
- `NodeInspector.tsx` 的 workflow editor 行为与复杂 edit sections
- Validation target、connection planner、layout/history 与 editor modal controller

RFC-201 B2 原子拥有所有 `TabBar` callsite 的最小 accessible-name 接线，包括 `NodeInspector.tsx`；只加 `ariaLabel/ariaLabelledBy`，不改其行为和文案。Node Inspector 的“提示词预览”改名、复杂 sections 与 editor 行为仍由 RFC-199 独占。若同文件并行，先协调精确 hunk。

## 2. 导航数据模型

### 2.1 `PageSectionNav`

```ts
export interface PageSectionLeaf<K extends string> {
  key: K
  /** Plain localized string: also feeds compact Select and accessible name. */
  label: string
  description?: string
  badge?: React.ReactNode
  badgeTone?: 'neutral' | 'attention' | 'danger'
  disabled?: boolean
  disabledReason?: string
}

export interface PageSectionGroup<K extends string> {
  key: string
  label: string
  badge?: React.ReactNode
  badgeTone?: 'neutral' | 'attention' | 'danger'
  items: readonly PageSectionLeaf<K>[]
}

interface PageSectionNavProps<K extends string> {
  groups: readonly PageSectionGroup<K>[]
  active: K
  /** Owner renders a real TanStack Link for desktop leaf/group-default destinations. */
  renderDestination: (
    key: K,
    state: { className: string; ariaCurrent?: 'page'; children: React.ReactNode },
  ) => React.ReactNode
  /** Compact Select cannot be a Link; owner performs the same functional search update. */
  onSelectCompact: (key: K) => void
  presentation: 'rail' | 'inline'
  inlineLayout?: 'stacked' | 'single-row'
  ariaLabel: string
  idPrefix: string
}
```

约束：

1. `groups.flatMap(items)` 中 key 唯一；active 必须属于 visible items。dev/test 中违反时 fail fast。
2. group 只用于信息架构与 badge 汇总，不成为额外 route state；点击 leaf 一次到目标，不要求先切 group 再猜第二层。
3. presentation 由 **PageSectionNav 自身 container inline-size** 决定，不直接绑 viewport/AppShell 断点：container `>=56rem` 才显示 rail/inline，保证 220px rail + 24px gap 后 panel 仍至少约 640px；更窄时使用 compact Select。通过 `ResizeObserver/useSyncExternalStore` 只挂载当前形态，不渲染 hidden duplicate。`rail` 显示 group heading + leaf links/buttons；`inlineLayout='single-row'` 时 group trigger 与 active-group leaves 同处一个可横向滚动的紧凑行，panel 仍占全宽。
4. compact 形态是一个有可见 label 的共享 `Select`；options 使用现有 `SelectOption.group`，当前 leaf 是 value。group 不能只画成 `aria-hidden` 标题：每个 option 的 accessible name/description 必须包含 group + leaf，或将共享 Select 的 group 语义补完整。
5. desktop leaf 与 inline group-default 使用 owner 提供的真实 TanStack `Link`，保留 href、复制地址、Cmd/Ctrl-click、新标签页与 router preloading；compact Select 调用 route owner 的 functional search update。两者都保留其他 search；用户动作 push，fallback/权限规范化 replace。
6. 只有与当前 URL **精确对应的 active leaf** 使用 `aria-current="page"`，不是 `role=tab`；Task 的 active group trigger 只用视觉/data-active 与可读 group label，不能形成第二个 `aria-current`。真正 panel 不强制使用 `tabpanel`，避免错误宣称同一 tab widget。
7. group/leaf badge 的 accessible text 与视觉数字同源；颜色不是唯一线索。

### 2.2 Task 的 inline 呈现

Task panel 不能被 180–220px rail 挤窄：

```text
[概览] [执行] [产物 3] [协作 2] | [输出] [文件] [差异] [结构]
----------------------------------
full-width task panel
```

- group trigger 选择该组时，进入“当前 task shape 下该组的默认 leaf”；若用户本 session 最近访问过该组的可用 leaf，纯页面内缓存可恢复它，但 URL 仍只有 leaf key。
- active leaf 决定 active group；Back/Forward 只读 URL，不让 recent cache 抢历史。
- active-group 的可视重复标题在单排中省略，但保留用于 leaf list accessible name 的 visually-hidden label。
- container 小于 56rem 时不显示横向双层控件，直接显示单一 grouped Select。

#### 2.2.1 Task 顶部横幅

- loaded-task 的 stale query、lifecycle alert、workflow sync、mutation error、resume unavailable、failed summary、worktree preserved、recovery/quarantine 与 room error 都有独立关闭按钮；fatal task/actor load error 不可关闭。
- 不让整个横幅响应点击，避免与 Retry/Diagnose/同步/展开等动作冲突。关闭按钮有本地化 accessible name、可见 focus ring，移动端命中区至少 44px。
- owner 按 condition signature 记录 session dismiss：query error 含最近成功 `dataUpdatedAt`，failed 含 `finishedAt`，lifecycle 含 task id、alert id/rule/severity/detectedAt 且刻意排除持续变化的 detail/`pendingForMs`，sync 含 task/version，recovery 含 task/event ids。相同信号保持隐藏；新的 alert identity、严重度升级或新版本/事件重新出现。
- `.task-detail__banner-stack` 有 `max-height` 与 `overflow-y:auto`，并清除旧 banner 外边距；即使同时出现多条，正文仍保留可用高度且每个关闭按钮可到达。

### 2.3 `TabBar` 增量合同

`TabBar` 保留现有 DOM、manual activation、roving tabindex、Left/Right/Home/End 与 panel ids。新增：

```ts
type TabBadgeTone = 'neutral' | 'attention' | 'danger'

interface TabDef<K extends string> {
  // existing fields
  badgeTone?: TabBadgeTone
}
```

- badge 默认 `neutral`；等待处理使用 `attention`；校验错误才 `danger`。
- `ariaLabel` 与 `ariaLabelledBy` 二选一必填，类型层用 discriminated union 保证。
- 用 `ResizeObserver` + scroll event 派生 `canScrollStart/canScrollEnd`；内容或容器 resize 后重新计算。
- 真溢出时显示 start/end fade 与 44px 可点击滚动按钮。按钮在 tablist 外，不参与 roving tab 序列；accessible name 为“向前/向后查看更多分区”。
- 点击滚动按钮按约 70% clientWidth 平滑滚动；`prefers-reduced-motion` 时 instant。按钮不改变 active/focus。
- active tab 继续 `scrollIntoView({block:'nearest', inline:'nearest'})`；不能把整个页面纵向滚动。
- 第一/最后端容差 1px，防 subpixel 让按钮闪烁。

### 2.4 `PeerNav`

Clarify shard 等 sibling route 使用小型 link list：

- 语义为 `<nav aria-label>` + `<Link aria-current="page">`；
- 外观可复用 spacing/radius token，但不使用 `.tabs__tab` class；
- Cmd/Ctrl-click、open-in-new-tab 与 router search 保留；
- source ratchet 禁止 route `Link` 借 tab class 伪装。

## 3. 草稿与保存状态模型

### 3.1 `EditScopeRegistry`

route owner 内建立 registry reducer，不建全局 store：

```ts
type EditScopeId = string

interface EditScopeSnapshot<T = unknown> {
  baseline: T
  draft: T
  revision: number
  dirty: boolean
  validity: 'valid' | 'invalid' | 'unknown'
  inFlight?: {
    requestId: string
    submittedRevision: number
  }
  /** Ignore config reads that were already issued before this accepted write settled. */
  ignoreReadsThroughEpoch?: number
  lastAcceptedReadEpoch?: number
  ambiguousSubmit?: {
    requestId: string
    submittedRevision: number
  }
  staleRemote?: T
  firstInvalidTarget?: string
}

type EditScopeEvent<T> =
  | { type: 'edit'; draft: T }
  | { type: 'begin-submit'; requestId: string; submittedRevision: number }
  | {
      type: 'submit-success'
      requestId: string
      submittedRevision: number
      persisted: T
      ignoreReadsThroughEpoch?: number
    }
  | {
      type: 'submit-error'
      requestId: string
      submittedRevision: number
      error: unknown
      outcome: 'definitive' | 'ambiguous'
    }
  | { type: 'remote-read'; remote: T; issuedEpoch: number }
  | { type: 'discard'; baseline?: T }
  | { type: 'validity'; validity: 'valid' | 'invalid'; firstInvalidTarget?: string }
```

核心 reducer 规则：

- `dirty = !semanticEqual(draft, baseline)`；raw editor 可用 `{raw, parsed, error}` 作为 T，不能只比较 parsed。
- `remote-read` 的 issuedEpoch 若 `<= ignoreReadsThroughEpoch` 或早于 lastAcceptedReadEpoch，直接忽略；网络完成顺序不能冒充因果顺序。
- clean 收到可接收 remote：baseline=draft=remote。
- dirty 收到语义等于当前 draft 的 authoritative remote：服务端已达到用户当前意图，baseline=draft=remote、清 stale；若来自 ambiguous-submit recovery，仍要求 requestId/submitted revision 与待确认记录匹配，不能让旧请求清 newer edit。
- dirty 收到等于 baseline 的可接收 remote（自身 query refresh）：忽略，不标 stale。
- dirty 收到不同 remote：保持 draft/baseline，记录 `staleRemote` 并显示 conflict advisory。
- 每个 scope single-flight；`begin-submit` 生成唯一 requestId，同 revision retry 也必须使用新 id。只有 requestId 与当前 `inFlight` 匹配的 success/error 才可 settle；旧请求晚到不得清 busy 或改 baseline。
- submit success 采用 exact mutation receipt，并记录 settle 时已经发出的最大 read epoch 为 ignore floor；只在 `current.revision === submittedRevision` 时把 draft 一并 clean，否则只把 baseline 更新为 persisted，重算当前 draft dirty。settle 后强制发起一个 epoch 更大的 refetch。
- definitive submit error 不改变 draft/baseline；settle 只清匹配 request。timeout/abort/connection lost 等 ambiguous error 记录 matching request/revision 与“结果未知”，禁止使用旧 OCC token 重试，先做 authoritative refetch/reconcile；fetch 失败继续 outcome-unknown。组合/逐文件 owner 还维护 operation-level request id、意图与顺序 receipt。
- unmount panel 不删除 scope；route/resource identity 变化才 reset registry。

registry 聚合：

```ts
const pageState = {
  dirty: scopes.some((s) => s.dirty),
  busy: scopes.some((s) => s.inFlight !== undefined),
  valid: scopes.filter((s) => s.dirty).every((s) => s.validity === 'valid'),
  stale: scopes.some((s) => s.staleRemote !== undefined),
}
```

`UnsavedChangesGuard` 读取组合 dirty/busy。现有 guard 会拦截所有 router navigation，连同一 pathname 的 `?tab=` 变化也会拦；因此新增窄幅 `shouldBlockNavigation(current,next)`/`allowSameResourceSectionChange` 合同。只允许“同一 resource identity、仅 RFC 登记的 section key 改变”的导航穿过；其他 search/path/resource 变化、Back 到外页、sidebar、关闭 split detail 仍阻断。不能全局放行 query-string 变化。页面内 section 切换保留草稿且不弹确认。

mutating busy（尤其 Skill file/ZIP commit）期间，内部导航 guard 只提供“等待操作完成”，不提供“放弃并离开”：AbortSignal 不能证明服务端没有完成写入。beforeunload 继续用浏览器原生提示；请求 settle 后再根据 success/result 或 error/dirty 提供离开。`validity='unknown'` 的 dirty scope 不可提交，必须先完成同步校验。

### 3.2 Settings

不能简单 keep-mounted 九个 Tab，因为它们含 query/effect。实现：

1. route 初始化 `SettingsDraftRegistry`；一个 leaf 可拥有多个 scope。普通配置 leaf 有字段投影与 semantic equality；System Agents 明确拆成 `systemAgentsConfig` 与独立 Agent-row `fusionAgent` 两个 scope/receipt，不能把 `fusionDraft` 混进 Config projection；Authentication 若只读/独立 mutation，不注册伪 scope。
2. 新增 frontend `ConfigReceiptCoordinator`，原子迁移所有 `GET/PUT /api/config` callsite。它为每次 GET 分配单调 issuedEpoch；同一 tab 的 PUT 进入单写队列并分配 writeEpoch，后一个 local writer 必须在前一 exact receipt settle 后才发出，避免网络响应乱序把 cache 与服务端最终顺序拆开。PUT settle 时捕获此前已 issued 的最大 read epoch，把 exact full response 发布为 matching write receipt、取消/忽略该 floor 之前的晚到 GET，再强制发起更新 epoch 的 refetch。TanStack query cache 仍可保存 Config，但 Settings reducer 只消费 coordinator receipt，不能仅凭 dataUpdatedAt/完成时间判断新旧。
3. 所有 config writer 只提交自己拥有的最小 `ConfigPatch`；`LanguageSwitch` 严格 `{language}`，`RuntimeList` 严格 `{defaultRuntime}`，Settings 每 scope 严格字段投影。source ratchet 枚举 `/api/config` GET/PUT callsite，禁止 `{...query.data}` 全量回写；write receipt 的 query update 也走 coordinator。
4. active Tab 组件接收 `{draft, onDraftChange, state}`；卸载后 registry 仍保留。
5. `SectionForm` Save 接收 leaf key 与 submitted revision，按钮在 clean 时 disabled 并说明“没有需要保存的更改”。
6. 保存成功只清匹配 request/submitted revision 的 scope；System Agents 保持既有顺序：config dirty 时先保存 config，成功后才写 fusion Agent；fusion-only dirty 不发 config PUT。fusion Agent mutation 严格只发送 `{runtime}` patch，不把 route baseline 的其他 Agent 字段回写。任一步失败不清另一 scope。
7. config query refetch 按每个 leaf 投影 dispatch causal remote receipt；clean leaf 跟随，dirty leaf 按规则 stale。`GET(A) issued → PUT(B) settle → GET(A) complete` 必须停在 B，并由 post-settle GET(C) 收敛。
8. 切到有 dirty/stale 的 leaf 时，nav 显示中性 dirty dot/文字；stale 额外显示 attention，不用 danger 冒充校验失败。
9. dirty + remote change 提供：保留本地并保存、查看服务器值、放弃本地。无字段级 merge。
10. Network 的 persisted `bindPort` 为空时，daemon effective port 只作为 suggestion/placeholder，不 dispatch user edit、不制造假 dirty；提供显式“固定当前端口”动作才把它写入 draft。
11. Runtime delete 走共享 `ConfirmDialog`；成功后焦点到下一张卡/列表标题。

### 3.3 Agent `JsonField`

`JsonField` 改成受控 raw/parse 合同，或至少上报：

```ts
interface JsonFieldChange<T> {
  raw: string
  parsed?: T
  error?: string
}
```

- route draft 保留 raw；invalid raw 设置 dirty + invalid，Save/Create disabled并可聚焦错误。两个 JSON 字段各有稳定 focus target。
- 从合法 A 输入非法 B，不能继续把 A 当当前值提交。
- 两端都合法时 semantic equality 比较 canonical parsed value，纯空格/键序变化不制造永久 dirty；任一端非法时比较 raw，保证错误输入不消失。
- reset/import/remote follow 同时更新 raw 与 parsed，避免 child effect 覆盖用户输入。
- Agent tab badge 可显示 Advanced error，但普通 Ports/Resources count 仍 neutral。

### 3.4 Skill detail

Skill route 管理 `metadataBody` 与按 `{path,op}` 拆分的 file operation scopes；inline `newPath` 也是 dirty scope，不能只保留 selected file/draft map。

- `SkillFileTree` 从私有 save owner 改为受控 editor adapter：上报 selected file、newPath、draft/op map、dirty/inFlight/valid，并暴露由 parent 调用的 submit step；树内切文件仍用局部确认/保持，但 route guard 能看到 dirty。
- metadata 与每个 file PUT/DELETE 共享 composite OCC token。页头“保存所有更改”先捕获 semantic payload/revision，执行时从当前 token 开始；每次成功必须把响应 fresh token 传给下一 operation，不能预捕获同一个 token。file ops 按稳定 path/op 顺序逐个结算；成功 op 从 pending 集移除，第三项失败时只保留失败与未执行项 dirty，retry 不重复已成功 PUT/DELETE。
- 任一步出现 ambiguous transport outcome，pipeline 停止且不得沿旧 token 继续。parent 用现有读接口执行稳定快照核对：先读取 composite `tokenBefore`，再 refetch metadata、file tree 与受影响 path 内容，最后重读 `tokenAfter`；只有两 token 相同才允许消费中间数据。PUT/create 的 stable remote 内容等于该 request submitted payload、DELETE 的 stable tree/GET 确认 path 不存在时，按 matching request/submitted revision 结算该步成功；remote 不同则以 stable fresh token 更新 baseline、保留 draft dirty/stale；token 变化时最多自动重试整个核对 2 次，仍变化或任一 fetch 失败则保持“保存结果未知”、禁 Retry/History，只提供重新核对。在途 newer revision 永不被旧意图清除。不得把分别读取的 B content 与 C token 拼成一个 authoritative snapshot。
- 文件内容编辑、create、delete 全部改为 staged op：Add 是“加入待保存更改”，Delete 是“标记删除”，均可在提交前撤销；页面显示 per-path pending status。`newPath` 尚未 Add 时也作为 command draft 参与离页 guard，但 Save All 会先要求用户 Add 或清空，不暗中创建。这样页面只有一个持久化入口，不保留看起来同名却作用域不同的 Save。
- History 在任一 dirty 时显示“先保存或放弃更改以查看稳定版本”，不静默展示旧 history。
- Overview 内容并入 Edit；managed path/源路径进入 collapsed Technical information。

### 3.5 Workgroup panels 与 ZIP import

- Workgroup route 把 config scope 和完整 members state 接入同一 registry；切 panel 保留 draft，关闭/切成员时若新 target 无法并存则用共享事务确认，明确 Save/Discard/Cancel。
- `UpdateWorkgroup` 是 config+members full-replace 且 member id 重建，所以 Save All 必须从两个 scope 捕获 **一个组合 payload**，只发一次 PUT。响应按请求 payload index + semantic field 校验重建 `localKey -> server member id`；不匹配 fail closed/refetch，不按旧 id 猜。成功后仅在两个 scope 各自 revision 仍等于 submitted revision 时 clean；在途新改动继续 dirty。绝不串行发送“新 config+旧 members”与“旧 config+新 members”。
- ZIP `select`（已有文件）与 `review` 均 dirty；parse error 仍 dirty；commit 成功后的 stable result clean。child 通过 callback 上报，不把 File 对象序列化进全局 store。review→select、替换文件都保留/确认 dirty；commit in-flight 按 mutating-busy guard 禁止内部离页，settle 后再处理。

## 4. 页面级信息架构

### 4.1 Settings rail 与 panel measure

desktop：

```text
[执行环境]     [panel title + short purpose]
 Runtime       [form/list measure]
 System agents
 Limits

[可靠性]
 Recovery
 GC
...
```

- rail 约 190–220px；field panel `max-inline-size: 52rem`，Runtime/list 可 `max-inline-size: 60rem`。
- rail 与 panel 以 CSS grid `minmax(0, 1fr)`；不让帮助文本决定整页宽。
- section title/一句用途在 panel 内，不重复 PageHeader。
- 390px grouped Select 下方紧接 panel title；不存在隐藏横向 tablist。

Runtime row desktop 使用 `grid-template-columns:minmax(0,1fr) auto`，meta 在 main 内可换行；`<=720px` 改一列，actions 自己 wrap。删除确认文案含 runtime 名称与影响。

### 4.2 Memory

- nav model 由 server-returned capability、candidate/fusion route access 与 counts 构造；pending count 与“该 leaf 是否可访问”是两件事，零待办不能隐藏一个有权限的正常入口。不可见 leaf 在 resolver 稳定后过滤。
- candidate 列表/badge 只统计服务端返回 `canManage === true` 的 rows；Compare/Dialog/row action 都传递并消费同一 server field，不在前端用 actor/owner 重新推导 ACL。Fusion 使用其 owner/admin-scoped endpoint capability。目标优先 candidate pending，其次 fusion pending；若两者都有，可落 Candidate 并在 group badge 显示总数；用户在 rail 可直接看到 Fusion count。
- 当前 badge 是主 Memory `<Link>` 内的纯 `<span>`，不能直接改成嵌套 Link。`NavItem` 扩展为 row container：主导航 Link 进入 `?tab=all`，pending accessory 是独立 sibling Link/button-link，带“打开 N 个待处理项”的 accessible name；desktop/mobile 共用 destination 派生，mobile 点击仍先执行 stable-trigger/close handoff。零 pending 时 accessory 不挂载。
- `/memory` 普通入口默认 `all`；旧显式 `?tab=approval-queue` 等全部保留。
- Compare callbacks 与 row action 共用响应中的 `memory.canManage`，不再在 Dialog 退化成 `isAdmin`。
- All 的 view mode 与 filter 至少提升到 route/page state，切 leaf 返回不丢；selection 可以在离开 leaf 时清除，但需可预测并有测试。
- edit detail fetch 挂载稳定 Dialog shell，提供 loading/error/retry；不等成功后才突然出现 Dialog。

### 4.3 Task detail

`task-detail-tabs.ts` 继续产出 leaf availability，另产 group metadata：

```ts
interface TaskDetailNavigation {
  groups: PageSectionGroup<TaskDetailTab>[]
  availableTabs: TaskDetailTab[]
  defaultForGroup: Record<TaskDetailGroup, TaskDetailTab | undefined>
}
```

capability 规则集中到纯 `deriveTaskDetailCapabilities(task, relatedData)`，必须与 backend consumer 的多仓语义同源：

- Outputs：现有 `hasOutputs`；
- Worktree files/diff/structure：扫描 task 的 repo/worktree 投影与每个 `repos[]` 条目，不得只看 top-level `baseCommit`。多仓任务 top-level 可以为 null，但任一 repo 有可读 base/head/worktree 时仍显示 backend 实际支持的 diff/structure；不以 panel 请求 404 作为隐藏依据；
- Orchestration/chatroom：task kind/config；
- Questions/feedback：实际功能与权限。

async room config / `dwPhase` 未稳定前沿用现有“不规范化 URL”合同；稳定后 invalid/unavailable replace，用户点击 push。所有程序化 `navigate({tab})` tests 不改 key。

Task Outputs：选择面实现为 vertical tablist 时只 active option `tabIndex=0`，Up/Down/Home/End 与 panel ids 完整；若不需要 tab 语义，则用普通 button list，所有按钮可 Tab，移除 listbox role。v1 优先 vertical tablist，与 Worktree/Structural 模型一致。

### 4.4 Resource form microcopy

Agent Resources 主层只回答：

- 这个 Agent 能使用哪些 Skill/MCP/Plugin；
- 它需要哪些协作 Agent；
- 缺少能力时会发生什么。

`dependsOn closure`、cache path、环境变量、离线 spawn 等放进“技术说明”Disclosure。字段 label 用业务名，原 wire/key 保留。

MCP/Plugin action panel 顶部固定 `ExecutionBasisBanner`：显示 saved spec/runtime identity、`operationConfigHash` 的短可读版本与本地 dirty 状态。所有 operation result 使用现有 `LoadingState` / `ErrorBanner` / `EmptyState` / `NoticeBanner`，不靠 `data ?? null` 合并状态。MCP field error 必须翻译 i18n key 并接 `aria-invalid/aria-describedby`。

## 5. 响应式与视觉合同

### 5.1 断点

- AppShell：沿用 RFC-198 `<=900px` compact shell。
- `PageSectionNav`：独立读取自身 container；`>=56rem` rail/inline，低于该值 grouped Select。不能直接由 viewport `900px` 推导，因为 901px 仍有 desktop sidebar、可用内容反而比 900px 更窄。
- form layout：沿用 `<=720px` 单列与 44px target。
- ResourceSplit：`>1080px` list+detail；`<=1080px` list-or-detail。该 feature 断点独立于 shell/content。

必须成对测 1081/1080、901/900、721/720，防 CSS 与 JS media query 差 1px。

### 5.2 几何 oracle

- 390×844：body `scrollWidth <= clientWidth`；section selector 全宽可见；Runtime row 子项 bounding box 不相交；最后一个字段/动作可滚到。
- 640×400：selector + panel title + 至少一个主要字段/列表行可见；sticky/action 不遮最后内容。
- 1280×800：Settings field measure <=840px；rail 后 panel >=640px；Task panel 保持当前 page content 可用宽度，不因 nav 减少超过 16px chrome；Agent overflow control 仅在真实溢出时出现。
- 901/900：直接量 PageSectionNav container 与 panel；不足 56rem 两边都用 compact Select，不允许 901px 挂 rail 后只剩约 400px panel。
- 1081/1080 ResourceSplit：1081 同时 list/detail；1080 只一个 pane。若 selected detail 存在且焦点在将隐藏的 list，转交到 detail Back control（无 Back 时 detail heading）；焦点原在 detail 则保持。无 selection 时 list 保持可见。dirty detail 不因 resize 卸载丢失。
- 200% zoom：layout 自然进入 compact presentation；focus 从将卸载的 nav 移到等价 Select，不落 body。

### 5.3 色彩与状态

- neutral badge：数量/文件/端口；
- attention：待处理、dirty、stale；
- danger：blocking validation/error；
- success 不用于“有内容”；仅表示操作成功。

所有 tone 同时有可读 label/tooltip/旁文。dark/light 使用现有 semantic token，不新增硬编码 brand 色。

## 6. 焦点、历史与可访问性

1. PageSectionNav leaf 选择后，desktop focus 可留在 current link；compact Select 选择后 focus 留 Select，panel heading 使用 `tabIndex=-1` 仅在错误 handoff/显式“跳到内容”时聚焦。
2. 保存校验失败：先激活含错 leaf，等待 mount，再 focus `firstInvalidTarget`；live region 只播报一次“未保存，已转到 X 的第一个问题”。
3. browser Back/Forward 更新 nav/current panel，不抢焦点到 heading；若原 focused element 被卸载，回 current nav control。
4. overflow scroll buttons 有 visible focus、disabled/hidden 与 scroll state一致；不被 arrow-key tab roving 当成 tab。
5. rail/PeerNav 用 `aria-current`；TabBar 用 tab semantics；vertical selector选择其一并完整实现，严禁混用。
6. `ariaLabel` 类型合同、route-link-tab-class、半套 listbox、badge tone 与 URL key 建 source/AST ratchet。

## 7. 操作编排

### 7.1 Save-and-operate

MCP/Plugin：

```text
click Save and Probe
  -> validate current config
  -> invalid: activate Config + focus error + stop
  -> save submitted revision
  -> save failed: keep dirty + stop
  -> current revision changed while saving: show still-dirty; ask user to retry, do not probe old submit
  -> read operationConfigHash from exact PUT receipt
  -> POST operation with expectedConfigHash
  -> server loads resource once, recomputes hash, mismatch: 409 and zero side effect
  -> match: execute against that captured resource and return configHashUsed
  -> render exact operation receipt/result
```

shared 新增 domain-separated canonical projector/hash。虽然 wire 名为 `operationConfigHash`，它不是“只含运行参数的最小 hash”，而是 operation 可能读取或完整 receipt 可能覆盖的 **exact saved resource revision**：

- MCP projection 含 stable id、name、description、type、config、enabled、ownerUserId/visibility/aclRevision 与 updatedAt 等全部可变行状态；Plugin projection 含 stable id、name、description、spec、options、enabled、ownerUserId/visibility/aclRevision、sourceKind、immutable cachedPath/install generation、resolvedVersion、installedAt 与 updatedAt。任何会 bump resource updatedAt 或改变完整 response 的 mutation 都必须改变 hash；golden/source ratchet 枚举字段，禁止漏投影；
- npm/git Plugin 的每次成功 install 使用唯一 generation/cachedPath，所以同版本重装也产生新 hash；file source 是外部可变目录，不提供 Check/Upgrade，Updates 只解释“由外部路径管理”，避免把不可冻结内容宣称为原子升级；
- GET/PUT resource wire 返回 `operationConfigHash`；Probe/Check/Upgrade body 要求 `expectedConfigHash`；
- route 在同一次 visible/owner resource load 后比较 hash，匹配后把该 captured row 交给 service，禁止 service 再按 id 读取另一版；409 使用稳定 `resource-operation-stale` code；response 回显 `configHashUsed`。Upgrade 还返回 finalize 后带新 `operationConfigHash` 的 resource。

仅在 operation 开始前比较仍不够：Plugin install 与 MCP probe 都是异步长操作。backend 新增按稳定 resource id keyed、settle 后自动清 map entry 的 `ResourceOperationCoordinator`；当前架构为单 daemon，因此它是所有 HTTP/service mutation 的单进程线性化边界。未来若支持多 daemon，必须换 DB/distributed fence，不能沿用内存锁宣称安全。

Plugin 规则：

1. PUT（含 spec install）、rename、delete、upgrade 与 generic ACL/owner-transfer PUT 全部通过同一 plugin-id coordinator；create 在分配 stable id 后也复用同一 immutable-generation publisher。generic `mountAclEndpoints` 必须接受 resource-specific coordinator adapter，锁内按 stable id 重新 load/鉴权，不能在锁外拿旧 owner 后直接写。source ratchet 枚举所有 production install/mutation/ACL callsite，禁止绕过。
2. npm/git install 不再原地写 `<pluginsDir>/<pluginId>`。每个 request 用不可碰撞 opId/ULID 在同 filesystem 的唯一 generation 目录准备 package、运行 npm、校验 entry/package/version/source identity；整个阶段不修改当前 DB 指向的 cachedPath。generation 根写原子 manifest，至少含 pluginId/opId/sourceKind/requested spec、resolved package entry、sourceIdentity、integrity/commit 与完成标记：npm identity 来自 lock resolved+integrity（display version 仍为 package semver），git identity 必须解析最终 commit SHA，不能退化成 `package.json.version`；现有 `resolvedVersion` 对 git 按 schema 注释保存 commit display，对 npm 保持 semver。校验成功后仍在 coordinator 锁内用一次 DB row update 发布新 spec/cachedPath/generation/hash；DB 失败清/留 orphan 均不能伤当前 generation。进程在 install 前/中/DB 前崩溃只留未引用 generation；DB commit 后崩溃则 DB 已指向完整新 generation，旧 generation 仍完整。
3. Upgrade 在锁内重新 load visible/owned row、比较 expected hash，并 **持锁覆盖 staging install 到 DB finalize 全窗口**；其他 PUT/rename/delete/ACL 等待。PUT spec install 同样走 immutable generation。publish 必须在一个同步 DB transaction 内再次按 id reload、重验当前 owner/hash，再用 stable id + captured exact projection 的 **全部持久化列** 做 null-safe conditional WHERE；不能只比较毫秒级 updatedAt/aclRevision。0 row 视为 stale/permission 变化，零 publish、current cache 不变。异常必须 release lock，但锁不是 rollback 手段，atomic publish 才是 DB/cache 自洽来源。
4. Check-update 可在锁内 capture+hash 后释放做网络读取；临时目录必须用 `mkdtemp`/ULID 真唯一且与 live generation 分离。available 比较 candidate manifest 与 current generation manifest 的 sourceIdentity：git 新 commit 即使 package version 相同也 available，npm 比较 resolved/integrity identity；禁止只比较 `resolvedVersion` 文案。legacy generation 缺 manifest 时 fail closed 为 identity unknown，并提供一次“重新安装以建立更新基线”，不猜 no-change。返回前重新入锁并比较当前 hash；变化则丢弃结果并 409，不把旧 `updateReady` 放进当前 UI。相同 `{pluginId, hash}` Check 可 join 同一完整 operation promise，但不同 hash 绝不共享目录/receipt。
5. Upgrade response 返回 finalize 后的新 resource/hash 与 `configHashUsed`；等待中的后续 PUT 再执行时会产生下一 hash。
6. generation GC 只删除不被任一 Plugin row cachedPath 引用、已超过安全 grace 且不被活跃 runtime/reference oracle 使用的目录；无法证明安全就保留。daemon 启动/定期 orphan scan 覆盖 partial staging、DB finalize 前崩溃与旧 generation；delete 在 coordinator 内删 row 后再按同规则回收所有该 id generation。零 DB migration。

MCP 规则：

1. PUT/rename/delete、generic ACL/owner-transfer PUT 与 Probe 的 start/finalize 都走同一 stable mcp-id coordinator；ACL adapter 在锁内按 id 重新 load/鉴权，不得再按可变 `mcp.name` 做 mutation/in-flight 身份。
2. coordinator 为每个真正开始的 Probe 分配该 id 下单调 generation，并以 `{mcpId, operationConfigHash}` 对 **完整 start→I/O→finalize promise** 去重：同 hash caller join 同一 persisted/409 receipt，不重复 raw I/O/upsert；不同 hash 获得不同 generation，绝不复用 `probeMcp` 的旧 name-only Promise。settle 后清对应 in-flight key，generation 在同 id 仍有任务时保持单调。
3. Probe 在 start lock 内 load+ACL+expected-hash capture，释放锁执行外部 I/O；完成后重新入锁，按 id reload 并重算 hash。missing/mismatch 或 generation 不是该 id 最新时丢弃 result、零 upsert，分别返回稳定 stale/superseded 409；只有 current hash + latest generation 在同一锁内 upsert。raw `probeMcp` 变为不带全局 name dedup 的低层 I/O，或显式接受 stable id+hash key；source ratchet 禁 name-only dedup 回归。
4. exact MCP projection 覆盖所有会更新 `mcp.updatedAt` 的 mutation；rename/description 等真实变化即使发生在同一毫秒也因字段变化令旧 Probe 409。semantic no-op PUT 必须直接返回 existing，不能只 bump timestamp。
5. 为保持持久化 `startedAt > mcp.updatedAt` 在毫秒碰撞下仍稳定，coordinator 同时维护 per-id logical clock。Probe start 在锁内读取 current MCP、persisted last probe 与 active generation，取 `startedAt = max(clockNow, mcp.updatedAt + 1, persistedProbe.startedAt + 1, activeLastStartedAt + 1)`；finish 至少为 startedAt。任何 MCP PUT/rename/ACL mutation 的 next updatedAt 取 `max(clockNow, existing.updatedAt + 1, persistedProbe.startedAt + 1, activeLastStartedAt + 1)`。这样 Save→Probe 同毫秒 fresh，Probe→Save 同毫秒 stale；跨 daemon 由 persisted MCP/probe timestamps 接续，无需新列。immediate response 仍以 final `configHashUsed` 判 fresh，后续 GET 沿用现有 strict comparator。

确定性交错测试必须能暂停 Plugin install / MCP probe：hash 已匹配后发 foreign PUT 或 owner transfer。Plugin 中 PUT/ACL 等待 Upgrade atomic publish 后执行，最终 DB/cache/owner 与线性化顺序自洽；冻结时钟并在 pre-publish transaction 前注入改 spec+cachedPath/name 的 bypass writer，full-row conditional WHERE 必须 0-row 拒绝。MCP 中 PUT/ACL 可先完成，旧 probe finalization 409 且 last probe 未被覆盖；排队期间已失去 owner 的请求在锁内重鉴权后拒绝。另锁 MCP `A(H1) paused → PUT(H2) → B(H2) → B complete → A late`、同 hash A-slow/B-fast join、rename/name-key 回归、Save→Probe/Probe→Save 同毫秒 logical clock 与 error/success；Plugin 锁 install/DB failure/current-reader、同 package version 新 git commit/source identity、同版本新 generation、legacy identity unknown、进程恢复 orphan 与并发 Check 唯一目录。

frontend 还有独立 late-receipt fence：每个 operation scope 保存 `{requestId, expectedHash}`，只让 matching current request settle。Probe/Check 结果仅在 `configHashUsed === currentResource.operationConfigHash` 时进入 result cache；Upgrade 用 functional query CAS，只在 current resource hash 仍等于 `configHashUsed` 时以 response resource/new hash 替换，否则丢弃旧 response、显示“结果基于旧版本”并 invalidate/refetch。Updates cache key 至少为 `{stableId, configHashUsed}`，不能在回调时读取可能已变化的 `query.data` 伪造 fingerprint。确定性交错锁 `operation finalize 200 → later PUT 200/cache H2 → old operation response last` 零 query/result rollback。

这是 RFC-201 唯一 API/wire 增量，无 DB migration；backend 另外把 Plugin live install 改为 immutable generation publication，并把 MCP raw probe 去重提升到完整 operation coordinator。Plugin Upgrade 必须基于最近一次成功 Check 的同 hash，或由 backend 在 upgrade 内 fresh check；不能把旧 `updateReady` cache 当授权。

### 7.2 Multi-scope save

Skill：

- 捕获 `{scopeId, submittedRevision, semanticPayload}` 列表；token 不预捕获；
- 按 metadata → sorted path/op 顺序串行，每一步读取上一 receipt 的 fresh composite token；
- 已成功 scope clean；失败/未执行 scope 保持 dirty；
- 页面 summary 显示“1 项已保存，1 项未保存”，不显示全局绿色成功；
- retry 只提交仍 dirty scope；
- submit 期间新编辑的 scope revision 不被旧 receipt 清除。

Workgroup 不走上述 partial pipeline。config+members 合成单个 `UpdateWorkgroup`、单 PUT/单 receipt；只有请求成功后分别按两个 submitted revision 结算 UI scope。

## 8. 测试策略

### 8.1 纯函数/组件

- PageSectionNav group flatten、active、capability filter、default-for-group、container mode、compact Select、real Link/Cmd-click、Task single-row 几何。
- TabBar overflow start/end、1px tolerance、resize、reduced motion、badge tone、required label。
- edit-scope reducer：unique request id、single-flight、late settle、clean follow、dirty same-remote、dirty foreign-remote、submit race、unknown validity、mutating-busy guard、raw invalid；config receipt 的 issued epoch/read floor 与 `GET(A)→PUT(B)→A late`。
- exact operation-revision projector 全字段 golden/source ratchet；MCP stable-id+hash full-operation dedup、latest generation、match/foreign-write/superseded 409、captured-row zero reread；keyed coordinator 的排队、异常 release 与 map entry settle cleanup。
- Plugin immutable generation publisher：unique path、atomic manifest/source identity、validation、DB publish、current reader 不变、failure/orphan/recovery/GC；Check `mkdtemp`/ULID collision 与 same-package-version/new-git-commit。
- task group/availability 与所有 legacy wire key，含 top-level `baseCommit=null` 但 `repos[]` 有 diff/structure 的多仓 fixture。
- memory badge source-to-target 与 server-returned `canManage` oracle。

### 8.2 Rendered route tests

- Settings 九 leaf draft roundtrip、Back/Forward、refetch stale、discard/save、hidden error focus；`GET(A) issued→PUT(B) settle→GET(A) late→GET(C)` 因果 receipt；LanguageSwitch stale cache 只发 `{language}`；全部 config writer 最小 patch；System Agents 双 scope/config-first/fusion-only；Network effective-port hydration 零假 dirty。
- Agent invalid JSON 从 clean 进入 dirty，Save/guard/active badge。
- Skill metadata + 两个 file op 串联三个 fresh token，第三步失败只留未结项 dirty；staged create/delete/newPath/History gate；committed-but-response-lost 用 token-before/content-tree/token-after 稳定快照，锁 B-content→foreign-C→C-token 不误 clean。
- Workgroup config+member 同时 dirty 合成一次 PUT，服务端同时包含两侧修改；response member-id remap、在途新 edit 仍 dirty。
- ZIP select/review/result dirty lifecycle、review→select/替换文件/commit-busy navigation。
- MCP/Plugin clean/dirty/save-and-operate、transport error/no-change；foreign write 在 operation 开始前发生时 409 且零执行，在 hash-match 后发生时锁 Plugin immutable publish、让 MCP stale/superseded completion 409 且零 upsert；同 hash join、H1/H2、rename、A-slow/B-fast、install/DB failure、same-version generation、concurrent Check unique dir 与 frontend late-receipt CAS。
- Memory admin/owner/viewer nav、Compare action、deep-link fallback。
- Task plain/dynamic/workgroup group model、async config、capability-hidden tabs、external links；顶部横幅关闭、签名变化重现与有界 stack。
- Task Output vertical keyboard model；Clarify PeerNav semantics。

### 8.3 真实浏览器/E2E

Canonical viewports：1280×800、1081/1080、901/900、721/720、390×844、640×400；中文/英文至少覆盖 1280 与 390；一组 light/dark；200% zoom；reduced-motion。

必走场景：

1. Settings dirty 跨 3 个 leaf、Back/Forward、server refetch、save/discard。
2. Agent raw-invalid 离页 guard。
3. Skill 正文+两个文件操作按 fresh token 串联，第三步失败后 retry 不重复前两步。
4. Workgroup config+member 同时 dirty 只发一次 PUT；Task 旧深链进入正确 group，多仓 capability 与异步变化不抢用户选择。
5. MCP dirty → save and probe；保存失败零 probe request；save/probe 间 foreign write 稳定 409；probe 已发起后的 foreign write 与同配置旧 completion 都不覆盖较新结果。Plugin 长操作用可暂停 installer 的 backend integration test 锁 immutable generation；route test 锁 operation 200 晚于后续 PUT 到前端时 query/result cache 不回滚。
6. Memory badge candidate/fusion 两种深链与非 admin 权限。
7. ResourceSplit 1081/1080 resize 保持 draft、selection、focus。
8. axe 扫描 Settings/Memory/Task/Agent/Skill/MCP；Tab/Shift+Tab、Arrow/Home/End 与 Select 路径。

视觉断言同时量 bounding box 与 screenshot；不得只用 body overflow 或 snapshot 文案代替几何。

## 9. 迁移与回滚

- 无 DB migration；只有 `operationConfigHash/expectedConfigHash/configHashUsed` wire 增量。Plugin 改 immutable filesystem generation + orphan GC，MCP generation 留在单 daemon coordinator；均不增加持久化列。其余组件可按页面逐批迁移。
- B1 edit-scope reducer/adapter 可先接 Settings/Agent，再接 Skill/Workgroup；未迁页面继续旧 owner，不做半接线的双 guard。
- PageSectionNav 按 Settings → Memory → Task 迁；每页保持旧 `?tab=` resolver，因此回滚 UI 不需 URL 数据迁移。
- TabBar 新 badge 默认 neutral 是有意视觉修正；若回滚 overflow control，不回滚 required accessible name 与 badge semantic contract。
- ResourceSplit 1080 是当前 production 行为的文档化与门禁，不把实现回退到旧 720。

## 10. RFC-199 接缝

RFC-199 同步修订：

1. T13.2：ValidationPanel own scroll 与 compact/short-height validation surface；具体实现、焦点与 canvas 几何全部归 RFC-199。
2. T13.5：`OutputEdit`/`ReviewEdit` 的 editable raw references 迁 selector；Edge endpoint 节点只显示业务名+技术 ID，target-port selector 复用 B5 transition，端点重连走 ConnectionDialog。
3. T13 新增 Inspector 内部层级：Edit / Prompt preview 保持两项；复杂 Review/Loop 表单在 Edit 内用 Basics / Flow / Advanced / Technical sections，不继续堆同级 tabs。
4. G3/G4 增加大量 validation issues 的 canvas 高度、scroll、focus oracle。

以上是 external seam，不是 RFC-201 的实施项，也不阻断 RFC-201 Done；RFC-201 只验证自己的 shared CSS/TabBar 改动未让当前 editor 基线回退，并单独报告 RFC-199 的目标门状态。RFC-201 不等待 RFC-199 完全结束即可先做 Settings 草稿安全；两个 RFC 同时触及 `styles.css`、i18n 或 `NodeInspector.tsx` 时必须精确 path/hunk 协调，不能覆盖并行工作。
