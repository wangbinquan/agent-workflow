# RFC-198 — 全局界面 UX 一致性与响应式基础：技术设计

## 1. 现状分层与必须保持的不变量

### 1.1 当前入口

| 层                 | 当前实现                                                   | 本 RFC 处理                                                                 |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| auth gate / shell  | `routes/__root.tsx` 内联 desktop sidebar 与 bare outlet    | 抽 shell 组件；补 mobile bar/sheet；token-null 不渲染 protected outlet      |
| navigation model   | `lib/nav.ts` + `NavGroup.tsx`                              | route/group key 不变；文案、icon、假 chevron、mobile close contract 收敛    |
| theme / global CSS | `styles.css` 单文件 tokens + 大量 route skin               | 拆 text/fill semantic tokens；补响应式基础；删除核实无引用的旧 selector     |
| page chrome        | route 手写 `.page__header/.page__actions`                  | 薄 `PageHeader`，普通页与 shared page shell 迁移                            |
| page states        | `EmptyState/LoadingState/ErrorBanner` 与私有 box 混用      | 完成 action/retry/notice/i18n contract，迁顶层状态                          |
| tabs               | `TabBar` + 局部 state + 手写 tablist                       | roving keyboard、panel id、scroll；页面级 URL 单源                          |
| tables             | 原生 table + `.data-table`                                 | 新 `TableViewport` 只负责语义与内部滚动；Agent import table 由 RFC-197 退役 |
| forms/cards        | shared primitive + Auth/Account/Users/Settings 私有 chrome | 最小扩 API 后迁移等价结构，不改表单 payload                                 |
| dialogs            | shared `Dialog` + 7 处 browser native dialog               | 新 `ConfirmDialog`/feature dialog，native call 清零                         |
| split pages        | `split/ResourceSplitPage.tsx`                              | 保持 dirty guard；手机 list/detail 单焦点模式                               |
| visual gate        | opt-in 12 scenes，实际 1280×720                            | canonical 1280×800 + mobile/dark 场景 + main push 触发                      |

### 1.2 不变量

- `NAV_GROUPS` route 顺序、`resolveActiveNav` fallback、Memory badge 与权限隐藏不变。
- `/auth` redirect 必须保留完整 pathname + search；OIDC fragment 的启动期消费顺序不变。
- 现有 query key、mutation payload、HTTP method、conflict choice、OCC、ACL 与 cache invalidation 不变。
- RFC-169 split dirty key、keep-mounted tab panel 与 unsaved-changes guard 不变。
- RFC-192 table 字段、排序/过滤、row click/modified click 与 scheduled action 不变。
- RFC-194/195/196 的 Dialog、focus、状态机、权限矩阵与 testid 不变；只移除 global shell 局部补丁。
- RFC-197 独占 `AgentImportDialog` 的三阶段、预览、异步读取、result 与 feature CSS；本 RFC 不改其任务流。
- page-level URL tab 只改变 UI state 的持久位置；默认 tab 与业务请求内容不变。
- light/dark 配置 wire 不变；仍由 `useApplyTheme` 把 resolved theme 写入 `html[data-theme]`。
- 所有旧 deep link 继续可打开；新 query 参数必须 validate + invalid fallback，不能抛 route error。

## 2. 目标组件图

```text
RootComponent
├─ /auth → BareShell → Outlet
├─ token null → BareShell → RouteTransitionState
└─ authenticated → AppShell
   ├─ DesktopSidebar (>900)
   │  └─ ShellNavigation
   ├─ CompactTopBar (<=900)
   │  ├─ Menu trigger → MobileNavDialog
   │  │  └─ ShellNavigation
   │  └─ Inbox trigger → InboxDrawer (existing)
   └─ main.content → Outlet

StandardRoute
├─ PageHeader
├─ Notice/Error/Loading/Empty
├─ TabBar + TabPanel(s)
├─ TableViewport → table.data-table
└─ feature content

ResourceSplitPage
├─ master rail (shared search/state/new action)
└─ detail (desktop alongside; mobile mutually exclusive + back)
```

新增/调整文件以以下边界为准：

- `components/shell/AppShell.tsx`
- `components/shell/ShellNavigation.tsx`
- `components/shell/MobileNavDialog.tsx`
- `components/shell/MobileTopBar.tsx`
- `components/PageHeader.tsx`
- `components/TableViewport.tsx`
- `components/ConfirmDialog.tsx`
- `components/TabBar.tsx`、`components/split/TabPanels.tsx`
- `components/Form.tsx`、`Card.tsx`、`ErrorBanner.tsx`/`NoticeBanner.tsx`
- `components/split/ResourceSplitPage.tsx`、`components/gallery/ResourceGalleryPage.tsx`

不创建第二份 token 文件或平行的 `MobileDialog`/`MobileForm` primitive。

## 3. Token 与主题

### 3.1 颜色角色

现有 `--accent` 同时服务 foreground 与 fill，必须拆开：

```css
:root {
  --accent: #1f5fda; /* link / active text / focus */
  --accent-fill: #1f5fda; /* filled controls */
  --on-accent: #fff;

  --success-fg: #1b6d34;
  --success-bg: color-mix(in srgb, var(--success-fg) 12%, var(--panel));
  --success-border: color-mix(in srgb, var(--success-fg) 36%, var(--border));
  /* warn / info / danger foreground/background/border 同形 */
  --danger-fill: #b42318;
  --on-danger: #fff;
}

:root[data-theme='dark'] {
  --accent: #8eb8ff;
  --accent-fill: #2759a5;
  --on-accent: #fff;
  /* semantic foregrounds 改为暗底可读的亮色，fill 仍独立 */
}
```

最终数值以自动对比度测试为准；设计约束是：

- normal text `<18px` foreground/background >= 4.5:1；
- large/bold text >= 3:1；
- control boundary/focus/non-text indicator >= 3:1；
- disabled 控件例外但不能与 enabled 只差 opacity 且无 `disabled` 语义。

旧 `--success/--warn/--info/--danger` 暂保留为 **foreground alias**，但 Foundation 批次在改变暗色
`--accent` 数值前必须完成全 `styles.css` 的 text-bearing fill 迁移：凡 `background:var(--accent)` / semantic
alias 且元素包含文字或图标标签者，改用 `--accent-fill/--on-accent` 或 `--danger-fill/--on-danger`；只有无文字的
dot、track、handle、纯装饰 indicator 可逐项注释进入 allowlist。source ratchet 禁止 foreground token 再作为
text-bearing fill。这样 Foundation 不依赖“后续 route 触达”来恢复对比度，旧 selector 在本批结束即保持可读。
inventory 还必须显式处理当前未定义的 `--warning`：`task-error-banner--warning` 迁为
`--warn-bg/--warn-border/--warn-fg`；canvas 中带 fallback 的 `var(--warning,#e0a000)` 逐项分类为装饰 handle 或
带文字 badge 后迁到相应角色。computed-style/contrast test 必须证明这些生产 callsite 的声明有效，不只 grep
新 token 名。

同批建立 undefined-token ratchet：production CSS 中无 fallback 的 `var(--token)` 必须在 root/theme 或明确的
runtime-injected allowlist 有定义。当前 `--fg` 迁 `--text`，`--surface-2/--surface-border` 迁既有
panel/border 角色；正式定义 `--font-ui` 与 `--font-mono`，再把 `--mono/--mono-font` 漂移名收敛到
`--font-mono`。RFC-197 owner 将删除的 dead selector 不由本 RFC 越权改写，但仍不能作为最终 ratchet 例外；
合入顺序需保证 gate 开启时这些 selector 已由 owner 删除或由 RFC-198 在无并发 hunk 后迁完。

### 3.2 显式主题优先级

所有 system fallback 必须使用 `:root:not([data-theme])`：

```css
:root[data-theme='dark'] .markdown-diff-view .diff-ins {
  /* dark */
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .markdown-diff-view .diff-ins {
    /* same dark */
  }
}
```

禁止裸 `@media (prefers-color-scheme: dark) { .feature ... }`。新增源码守卫扫描该形状；合法的 system-only
媒体规则必须有显式注释与 allowlist。

### 3.3 Typography、spacing 与 focus

- 不增加 font dependency；`--font-ui` 指向现有 system stack，`body/button/input/textarea/select` 同源。
- `.page__title` 固定 `var(--font-xl)`、1.25 line-height、600–650 weight；h1/h2 默认 margin 不再决定布局。
- `.btn`、`.nav-item`、`.tabs__tab`、`.segmented__option`、form controls、table viewport 复用
  `--focus-ring-color/--focus-ring-width/--focus-ring-offset`。
- `prefers-reduced-motion` 关闭 shell sheet、chevron、card hover 位移；颜色/边框瞬时反馈保留。

交互尺寸不以一句“全局 36px”误伤 dense UI：

| shape                                              | desktop actual target | <=720px contract           |
| -------------------------------------------------- | --------------------- | -------------------------- |
| default button/input/select/tab/nav                | >=36px                | >=44px（nav/tab/main）     |
| page header action / Dialog footer / danger        | >=36px                | >=44px                     |
| `.btn--sm` in table/card/toolbar compact container | >=32px                | >=36px                     |
| `.btn--xs` icon/inline row action                  | >=28px + >=8px gap    | >=36px；主/破坏动作不得 xs |
| canvas port/resize handle、diff line target        | 专用尺寸例外          | 保留键盘/列表替代入口      |

sm/xs 不能出现在 page primary 或 Dialog footer；source ratchet 锁允许容器。真实浏览器在 390px/200% zoom 量
`getBoundingClientRect()`，覆盖 default、compact、primary/danger、nav/tab，不用 CSS 字符串推断 hit area。

## 4. App shell 与导航

### 4.1 Root 分支

`RootComponent` 的顺序固定：

```tsx
if (pathname === '/auth')
  return (
    <BareShell>
      <Outlet />
    </BareShell>
  )
if (token === null)
  return (
    <BareShell>
      <RouteTransitionState />
    </BareShell>
  )
return (
  <AppShell>
    <Outlet />
  </AppShell>
)
```

`beforeLoad` 仍是 redirect 权威；`RouteTransitionState` 只防止 React commit 的短暂 protected-outlet flash，
不另发 auth 请求、不自行拼 redirect。

### 4.2 Shared navigation API

```ts
interface ShellNavigationProps {
  active: ActiveNav
  mode: 'desktop' | 'mobile'
  onNavigate?: () => void
  focusTargetRef?: RefObject<HTMLAnchorElement | null>
}
```

- Home 与 `NAV_GROUPS` 只在此组件 map；`NavGroup/NavItem` 接 `onNavigate` 并在 Link click 后调用。
- mobile 模式把当前 active route Link 写入 `focusTargetRef`；未知/detail fallback 无具体 item 时写 Home，
  `MobileNavDialog.initialFocusRef` 由此得到确定性首焦点。
- badge factory 继续由 shell 注入；Memory badge 不搬进 nav data，避免 data model 依赖 React/query。
- footer account/language/settings 使用 `ShellFooter` 同源组合；desktop/mobile 只换 layout class。
  `ShellFooter` 把同一个 `onNavigate` 注入 UserMenu 的 Account/Users links 与 SettingsGearButton，不能只让主
  NavItem 知道 mobile sheet。LanguageSwitch 不换 route，保持 sheet 打开；logout 由 auth shell unmount 收口。
- mobile route click 的事件顺序：`onNavigate()` 先同步 focus stable menu trigger、记录 pending navigation、关
  sheet，router Link 自己完成导航；不手写 `location.href`。Dialog 保持默认 focus restore，不新增“导航时跳过
  restore”的危险分支。
- location 真正 commit 后 AppShell 才把焦点从 menu trigger 移到新页面 `<main tabIndex=-1>`/首个 h1。若
  `UnsavedChangesGuard` 阻断，guard 以 menu trigger 为稳定返回点：Stay/ESC 后焦点仍在 menu，Discard proceed
  后才由 location effect focus 新 main。Account、Users、Settings 三条 footer route 与主 nav 都覆盖直达、dirty
  Stay/Discard；logout 单测 auth shell unmount。

### 4.3 Breakpoint 与 DOM 可达性

canonical shell breakpoint 为 `900px`；内容原语仍以 `720px` 作为手机级 stack 边界：

- `>900px`：`.desktop-sidebar { display:flex }`，`.mobile-topbar { display:none }`。
- `<=900px`：shell grid 一列 + `grid-template-rows: auto minmax(0,1fr)`；desktop sidebar `display:none`；
  content padding `var(--space-3)`，mobile bar `display:flex`。
- shell 保留 `100vh` fallback，并在支持时使用 `100dvh`；mobile bar/sheet/footer 纳入
  `env(safe-area-inset-*)`，iOS 地址栏与刘海不能遮入口或最后一个 footer action。
- `useCompactShell` 以 `useSyncExternalStore(matchMedia('(max-width:900px)'))` 同步当前模式；SPA 不做 SSR
  hydration，`matchMedia` 不可用的测试 fallback 为 desktop。`AppShell` 条件渲染一种 shell，绝不同时
  mount 两套 UserMenu/Inbox queries/导航 links。
- Dialog 只在 mobile 且 `mobileNavOpen` 时 mount；从 mobile resize 到 desktop 时状态同步关闭，防止
  overlay 继续锁 body。AppShell 的 `<main tabIndex=-1>` ref 跨两种 shell 保持 stable，并作为
  MobileNavDialog 的 `restoreFocusFallbackRef`；compact→desktop/200% zoom 跨 900 时 menu trigger 与 dialog
  同时卸载，关闭后必须 focus main，而不是掉到 body。
- 901/900、768×1024、721/720、390px、200% zoom 均锁 body 无横向 overflow；768 还断言 header actions
  与 form field 的 bounding box 可用宽度，不能只用 document scrollWidth 代替可用性。

### 4.4 Mobile nav dialog

复用 `Dialog` focus/portal/stack/scroll lock，仅通过 `panelClassName="mobile-nav-dialog"` 改 skin：

- overlay panel `inset:0 auto 0 0`，width `min(88vw, 320px)`，`height/max-height:100vh` fallback，并在支持时
  同时覆盖为 `100dvh`；显式重置 shared `.dialog__panel` 的居中 margin/transform 与
  `max-height:calc(100vh - 144px)`，否则 footer 会被旧上限截短；
- Dialog header title 为 brand，body 包 navigation，footer 包 account/language/settings；
- first focus 是当前 active nav item，否则 Home；triggerRef 是 mobile menu button；
- 与 Inbox Dialog 互斥：打开 menu 先 `setInboxOpen(false)`，打开 inbox 先关 menu；Dialog stack 仍兜底。
- `InboxFooterButton` 增 `variant='sidebar'|'compact'`；当前 shell 只挂载一个实例，query keys/count merge/
  failure-soft 语义逐字保持，compact 只隐藏视觉 label 并使用独立 testid。
- Inbox panel placement 同步新 shell 三段边界：`>900px` 保持 RFC-195 的 sidebar-adjacent placement；
  `721–900px` 改为 topbar 下方右对齐（`left:auto`，right/safe-area gap，width
  `min(420px, calc(100vw - 24px))`，max-height 扣 topbar 与 safe area）；`<=720px` 继续 RFC-195 full-screen。
  901/900、768、721/720 browser test 量 panel bounding box、footer 可达、无 body/main overflow 与 trigger focus。

### 4.5 Navigation labels/icons

只改 `nav.group.*` 翻译，不改 `GroupKey`：

| key       | zh-CN      | en-US         |
| --------- | ---------- | ------------- |
| agents    | 能力资源   | Resources     |
| workflows | 编排       | Orchestration |
| tasks     | 运行与仓库 | Operations    |
| memory    | 知识       | Knowledge     |

`SubNavItem` 增 `icon: ResourceIconKey`（或由 `to` 的穷举映射派生）；icon 组件统一 18px/currentColor/
`aria-hidden`。`NavGroup` 删除 chevron DOM，header 仅 section label。

## 5. PageHeader 与动作

### 5.1 API/DOM

```ts
interface PageHeaderProps {
  title: ReactNode
  headingLevel?: 1 | 2
  meta?: ReactNode
  back?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  'data-testid'?: string
}
```

```html
<header class="page__header page__header--row">
  <div class="page__heading">
    <!-- optional back -->
    <HeadingTag class="page__title">…</HeadingTag>
    <div class="page__meta">…</div>
    <!-- optional dynamic/contextual children -->
  </div>
  <div class="page__actions">…</div>
</header>
```

- `headingLevel` 默认 `1`；`HeadingTag` 只可为 `h1|h2`。split rail 已有页面级 h1 时 detail 必须传 2，
  不能嵌套 heading 或在同一 desktop outline 中产生两个 h1。
- `meta` 只承载 id/version/save state/count 等动态事实，不承载通用产品说明。
- `actions` 为空时不渲染空 wrapper。
- `PageHeader` 不判断按钮主次；callsite 负责，但 `page-header-primary-ratchet` 用可见 DOM state 锁
  PageHeader + initial EmptyState 这一 page-chrome group 不超过一个 `.btn--primary`。card/row/contextual
  selection、独立 section 与 Dialog footer 分别计数，不做全页静态 class-count。editable detail 的 Save 是唯一
  header primary，Launch/extra/ACL 为 secondary，Delete 为 danger；只有不含 Save 的独立 editor 以 Launch
  为 primary。

### 5.2 Responsive

- desktop：heading `min-width:0`，actions `flex-wrap:wrap; justify-content:flex-end`。
- mobile：header 纵向；actions `width:100%`、可 wrap；DOM 与视觉顺序都保持 `extra → ACL → Save → Delete`，
  不用 CSS `order` 制造键盘分叉。Save 可获得更大 flex/独占一行，但不能越过最后的 danger Delete。
- 长 title/id 允许 wrap/`overflow-wrap:anywhere`，不能推 actions 出 viewport。

### 5.3 迁移矩阵

| 形状          | 路由/组件                                                                   |
| ------------- | --------------------------------------------------------------------------- |
| gallery       | `ResourceGalleryPage`（Workflows/Workgroups）                               |
| lists         | Tasks、Scheduled、Repos、Reviews、Clarify、Users、Memory、Settings、Account |
| detail shared | `DetailHeaderActions` 与 Agent/MCP/Plugin/Skill detail                      |
| editor        | Workflow editor 只换 header DOM/state primitive，不重做 canvas              |
| create/detail | `tasks.new.tsx`、`fusions.detail.tsx`、`memory.distill-jobs.$jobId.tsx`     |
| excluded      | Workgroup room、Review document pane、Node drawer、fullscreen preview       |

初始未过滤空列表只在 `EmptyState` 放主 CTA，header 同一按钮不渲染；有数据或过滤无结果时主 CTA 只在 header，
no-match state 只有 clear-search。Memory 这类 tabbed dashboard 的 page-level primary 常驻 header，单个 panel
empty 不复制它；split rail 的创建按钮是该 shape 唯一入口，detail placeholder 无 CTA。迁移矩阵中
每个 standard route 必须明确迁移或落在 excluded 行，不能被 source ratchet 的笼统例外掩盖。

同一主 CTA 在 header/empty 两个互斥位置复用 stable ref/testid；Dialog 的 triggerRef 读取当前 connected
实例。尤其 Repos import 打开期间若列表从 empty 变有数据，EmptyState trigger 卸载、header trigger 挂载，
关闭后必须 focus 新 header trigger 而不是 body；该状态转换有 rendered test。

## 6. Tabs 与 URL 状态

### 6.1 TabBar API 墠量

```ts
interface TabBarProps<K extends string> {
  // existing props...
  idPrefix?: string
  activation?: 'automatic' | 'manual' // default automatic
}
```

- `idPrefix` 存在时 tab id=`${prefix}-tab-${key}`，controls=`${prefix}-panel-${key}`；API 为迁移期兼容仍 optional，
  但 RFC 完成 ratchet 要求所有真正的 TabBar callsite 都显式提供稳定 prefix。
- `TabPanels` 同增 `idPrefix`，panel id/labelledby 使用同一纯函数 `tabDomIds(prefix,key)`。
- 手写 panel 的 callsite 也调用该 helper，禁止复制字符串模板。
- active tab `tabIndex=0`，inactive `-1`；Left/Right 循环，Home/End 到首尾。
- automatic 模式在 focus 移动时立即 `onSelect`；manual 仅 Space/Enter 激活，当前 callsite 全用 automatic。
- 保留当前并发落地的 `TabDef.disabled`：disabled tab 维持 native `disabled` 且永远 `tabIndex=-1`；Arrow 与
  Home/End 只在 enabled tabs 中循环/取首尾，automatic/manual 均不得对 disabled key 调 `onSelect`。若 active
  tab 在 busy 期间变 disabled，`aria-selected`/panel 暂不被 primitive 私自改写，roving focus target 改为首个
  enabled tab；caller 业务状态解除或显式选择后再更新 active。全 disabled 时不制造假 selection。
- `.tabs` 自己 `overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:thin`，active tab 调
  `scrollIntoView({block:'nearest',inline:'nearest'})`，reduced motion 使用 `behavior:'auto'`。

`role=tab` 只用于切换互斥 panel，不继续把筛选器伪装成 tabs：

| 分类              | callsite                                                        | 迁移合同                                         |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| filter/view mode  | reviews/clarify lists、`MemoryAllList`、review detail diff mode | 迁 `Segmented`/toolbar filter，无 tab/tabpanel   |
| page tabs         | Memory、Settings、Task detail、Auth                             | stable idPrefix + 对应 role=tabpanel             |
| editable sections | Agent/MCP/Plugin/Skill detail、AgentForm、skills.new            | local state 保持；补 idPrefix/panel，不写 URL    |
| inspector tabs    | NodeInspector、NodeDetailDrawer                                 | stable idPrefix + 手写 panel 使用 `tabDomIds`    |
| concurrent seam   | AgentImportDialog                                               | 只补 id/panel a11y wiring，不改 RFC-197 状态/CSS |

`TabPanels` 或轻量 `TabPanel` 负责 `role=tabpanel/id/aria-labelledby`；true-tab callsite 不允许只渲染带
`aria-controls` 的 tab 而没有目标 panel。AgentImportDialog 的 hunk 必须等 RFC-197 owner 完成后逐 diff 合入，若仍
同函数并发修改则暂停该 seam；允许的改动仅为 id/role/labelledby，不接管其三阶段、disabled/source tab 或结果状态。

### 6.2 Page-level search schemas

每个 route 自己定义 union 与 fallback，不建立跨业务的万能 tab enum：

```ts
validateSearch: (raw): { tab?: SettingsTab } => ({
  tab: isSettingsTab(raw.tab) ? raw.tab : undefined,
})
```

| 页面        | 默认             | query                                                                                         |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------- |
| Memory      | `approval-queue` | `approval-queue\|all\|by-scope\|distill-jobs\|fusion`；保留既有 `focus`                       |
| Settings    | `runtime`        | `runtime\|systemAgents\|limits\|recovery\|gc\|network\|appearance\|rendering\|authentication` |
| Task detail | 按 task shape    | 下述完整 `TaskDetailTab` wire key                                                             |

Task detail 不另造 `overview/runs/questions` 等展示别名。合法 wire key 是
`workflow-status|node-runs|details|outputs|worktree-files|worktree-diff|worktree-structure|feedback|task-questions|chatroom|dw-orchestration`，并继续由
`lib/task-detail-tabs.ts` 的 `TaskDetailTab`、`availableTabs` 与 `defaultDynamicTab` 单一维护。route validator 只做
union 级语法校验；它不能在异步数据到达前假装知道 tab 是否可用。

新增纯 resolver / navigation helper，所有旧 `setTab` 写点都必须收敛到它：

1. task 未加载，或 workgroup 的 room config / `hasOutputs` / dynamic phase 尚未达到现有
   `availableTabs` 所需的稳定分类时返回 `pending`，不改 URL、不先渲染错误 panel；workgroup 不能先按
   turn-engine canonicalize 再被 late dynamic config 推翻。
2. workgroup room query terminal error 返回 `error`，不能永久 pending，也不能误判为 turn-engine。保留 raw
   search、不 canonicalize，显示 `ErrorBanner + retry`；`details` 是所有 shape 的安全交集，错误态仍提供该
   action，若 URL 已是/用户切到 `details` 则渲染 details panel。retry 成功后再进入正常 resolver。
3. 分类稳定后，若 search tab 合法且在当前 `availableTabs` 内，显式 search 胜出；否则用 shape 默认：plain
   为 `workflow-status`，turn-engine workgroup 为 `chatroom`，dynamic workgroup 为
   `defaultDynamicTab(dwPhase)`。
4. 首次缺省、invalid、`outputs` 不可用或 shape 改变导致的 fallback 用 `replace:true` 写回 canonical tab；
   只改 `tab` 并保留其他 search。用户 TabBar 点击，以及 question/failed-node/structural-diff 等显式用户跳转
   用 push，浏览器 Back 可回前一 panel。
5. 初始 dynamic default 只在每个 task id 的首次稳定分类应用；后续 phase 变化不覆盖有效的 URL/手选 tab。
   若当前 tab 后来确实从 `availableTabs` 消失，才 replace 到当时 shape 默认。导航 task id 时重置该一次性状态。

对应 unit/route tests 必须覆盖 plain、turn-engine、dynamic、late room config、room error→retry、错误态 details、
phase default、无 outputs、invalid/跨 shape deep link、显式 programmatic jump、search 保留与 Back/Forward，锁定
URL 与 panel 永远一致。

Agent/MCP/Plugin/Skill split detail、create/import wizard、Node Inspector、Dialog tabs 保持 local state，
避免把临时编辑状态污染 URL。前四类还是同一 dirty form 的分区；`UnsavedChangesGuard` 会正确拦 route/search
navigation，却不拦组件内 local tab，因此 RFC-198 不增加“same-resource search 免拦”的危险特例。

### 6.3 Hash 兼容

Settings mount 时若 search 无 tab 且 hash=`runtime`，使用 functional search updater
`navigate({replace:true,search:(prev)=>({...prev,tab:'runtime'}),hash:''})`；保留其他 search，只消费该 legacy
hash，并继续触发一次既有 runtime flash。invalid/absent tab fallback=`runtime`。不在两个来源间双向同步，
Homepage runtime Link 直接写新 search。

## 7. TableViewport

### 7.1 DOM/API

```tsx
<div className="table-viewport">
  <div
    className="table-viewport__scroller"
    role="region"
    aria-label={label}
    tabIndex={hasOverflow ? 0 : undefined}
  >
    {children /* exactly one table */}
  </div>
  <span className="table-viewport__hint" aria-hidden="true" />
</div>
```

props 精确为
`children: ReactElement<ComponentPropsWithoutRef<'table'>, 'table'>`；第一个 generic 是 table props，不是 DOM
element instance。组件校验 `children.type === 'table'` 只在开发/测试断言，不在生产 throw；自定义 Table component
不在本轮 API 内。`minWidth` 映射 CSS modifier，callsite 仍决定列与 cell 内容：

- sm=560px（3–4 列）；md=720px（5–6 列）；lg=920px（7+ 列/动作密集）。
- desktop 宽度够时 table 仍 100%，scroller 无滚动条；mobile 只在 scroller 内 overflow-x。
- 用同一个 `ResizeObserver` 同时 observe scroller 与 direct table child，并在 mount、children/rows commit、
  `minWidth` 变化后同步 measure；只 observe scroller content box 不足以捕获异步长 cell。scroll 事件更新
  `scrollLeft/clientWidth/scrollWidth` 与 `data-overflow-start/end`；只有真实 overflow 时 region 进入 Tab 顺序，
  仅控制左右渐隐，不改变数据。测试覆盖初始无 overflow→异步变宽→变窄及 viewport resize。
- focus、`overflow-x:auto` 与 scrollLeft 量测都在 `.table-viewport__scroller` 同一节点；ArrowLeft/Right
  使用浏览器原生滚动。table 内 button/link 键盘行为不劫持。

### 7.2 调用点

第一批必须覆盖所有顶层 table：Tasks、Scheduled、Repos、Users、Reviews、Clarify；第二批覆盖
Task detail output、Scheduled history、Memory jobs、Skill version history、Account 的 sessions/tokens/identities
三表、TaskDiagnosePanel，以及 BatchImportDialog 的多失败行 table。迁移只在 table 外加 viewport，保留
`account-table`/`diagnose-table` class、testid、row/cell DOM 与事件合同；这些不可控 id/subject/path 在 390px
必须滚内部 scroller，不能靠“结构不等价”豁免让 body overflow。

## 8. 状态与反馈

### 8.1 NoticeBanner + ErrorBanner

新增通用 `NoticeBanner`：

```ts
interface NoticeBannerProps {
  tone: 'info' | 'success' | 'warning' | 'error'
  title?: string
  children: ReactNode
  action?: ReactNode
  size?: 'compact' | 'comfortable'
}
```

- error 使用 `role=alert`；其余用 `role=status`/`aria-live=polite`，避免所有 notice 打断读屏。
- icon 用 inline SVG + 文本，不使用字面 `⚠`。
- `ErrorBanner` 保留兼容 API，内部 `describeApiError(error)` 后委托 `NoticeBanner tone="error"`。
- route 不再自己 `${code}: ${message}`；动态业务提示若有专属翻译继续显式传 message。

### 8.2 Empty/Loading

`EmptyState` API 不需重做，只补 surface CSS 与调用点 props：

- comfortable：有 border/background、最大文案宽度与 action；用于初始空列表/整页空态。
- compact：透明、紧凑；用于过滤无结果、panel 局部空态。
- `ResourceGalleryPage` 增 `emptyDescription/emptyIcon/emptyAction/onRetry/onClearSearch`。
- `ResourceSplitPage` 增同类 list props；error 有旧 data 时显示 compact banner，不清 rail。

`LoadingState` comfortable 维持稳定最小高度，避免列表从一行文本跳到整页；button pending 不塞入该组件，
仍用 label + `aria-busy`。

### 8.3 Root transition

`RouteTransitionState` 是 full viewport compact loading，文案为“正在前往登录页”；它不读取用户信息，
不会把上一账号缓存渲染进 DOM。

## 9. Form、Card 与 Dialog

### 9.1 Form typed allowlist

`TextInputProps` 从当前手写字段扩到：

```ts
type TextInputType = 'text' | 'search' | 'email' | 'password' | 'url' | 'tel' | 'number'

interface TextInputProps {
  value: string
  onChange: (value: string) => void
  type?: TextInputType
  id?: string
  name?: string
  autoComplete?: string
  autoFocus?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  required?: boolean
  inputRef?: Ref<HTMLInputElement>
  // existing placeholder/disabled/className/aria/testid are preserved
}
```

`pattern` 与 `inputRef` 是 live API（校验与 Dialog initial focus），必须兼容并加回归；`number` 只为既有兼容，
新增数值字段继续使用 `NumberInput`。`TextArea` 保留并公开并发已落地的
`textareaRef?: Ref<HTMLTextAreaElement>`，同步 `id/name/autoComplete/autoFocus/minLength/required/aria-*`。
不使用无约束 `{...rest}` 把
`defaultValue/onInput/dangerouslySetInnerHTML` 等混入受控 primitive。

迁移时 label/description/error 必须走 `Field`，但 hidden/file 与 native checkbox 语义例外写入全局 Form
ratchet allowlist。payload builder、trim、validation、autocomplete 安全属性保持原行为。

### 9.2 Card

`Card` 增 `as?: 'div'|'section'` 与 `aria-labelledby`；Link root 分支仍优先且不接受 `as`。Account section
使用 `<Card as="section" header={<h2 id=...>}>`，不更改表单 submit/权限。

### 9.3 ConfirmDialog

```ts
interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  onConfirm: () => void | Promise<void>
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
}
```

- `DialogProps` 新增 `dismissDisabled?: boolean`（默认 false）与
  `restoreFocusFallbackRef?: RefObject<HTMLElement|null>`；前者为 true 时 ESC handler 与 overlay click inert，
  header close button保留但 `disabled`。关闭时优先 focus 仍 connected 的 trigger，再用 stable fallback，最后才用
  open-time active element；每次 `.focus()` 后必须验证 `document.activeElement===target`，connected 但不可聚焦也要
  继续 fallback。既有 `closeOnOverlayClick/closeOnEsc` 默认与 nested/portal/focus contract 不变。
- 并发 RFC-197 已加入的 `bodyTabIndex?: 0` 与 body DOM/focus 行为是 live API，T2 只能定点扩 props/close 分支，
  不得重写或移除；既有 Dialog body initial-focus 回归与新 dismiss/fallback tests 同跑。
- `ConfirmDialog` 是 pending/error 的唯一 owner，不接受第二份外部 pending。confirm handler 用同步 ref 防 double
  fire，清旧 error 后 await `onConfirm`；fulfilled 才调用 `onClose`，catch `unknown` 后复位 pending 并以
  `<ErrorBanner error={error}>` 呈现，不产生 unhandled rejection，用户可重试。
- pending 时把 `dismissDisabled` 传给 Dialog，并锁 close/ESC/overlay/cancel/confirm；confirm button 带
  `aria-busy`。cancel 或成功关闭后按既有 Dialog contract 恢复 trigger focus；每次重新 open 清旧 error。
- caller 需要 mutation 状态时把 `mutateAsync` 作为 `onConfirm` 返回值；需要成功后留在多阶段 dialog 的流程
  直接组合 Dialog，而不滥用 ConfirmDialog。
- `ConfirmButton` 继续服务低风险二击确认；原生 browser confirm callsite 根据是否需要解释/异步选择
  `ConfirmDialog` 或现有 `ConfirmButton`。

### 9.4 Native-dialog 处置表

| 调用点                                 | 状态、提交与焦点合同                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow import conflict               | `WorkflowImportDialog` + Segmented/Radio；保留 yaml/conflict mode snapshot，详见 §11.1                                                         |
| Settings OIDC delete                   | snapshot provider id/name；`mutateAsync(force=false)`；reject 留错误；成功后 focus 相邻 row 的 Edit/Delete，无 row 则 Add provider button      |
| `SkillFileTree` dirty discard          | snapshot `pendingTargetPath`；confirm 前禁第二次选择；确认时 revalidate path；cancel 回 target tree item，缺失时 focus `tabIndex=-1` tree root |
| Repo batch override URL                | 当前 BatchImportDialog 拥有 `editingRowId + draftUrl + pending + error`；只提交 snapshot row；成功/取消回该 row                                |
| Review unknown version/round           | replace 前 snapshot one-shot warning；canonical URL 上保留到 dismiss/route-id change；Back 不重播                                              |
| WorkflowCanvas delete wrapper children | snapshot wrapper id + sorted child ids；confirm 时集合不一致则拒绝并提示；menu 卸载后 focus stable canvas root                                 |

BatchImportDialog 的多失败行同一时刻只允许一个 `editingRowId`；390px 下其五列表格使用 `TableViewport`，pending
期间不能换 row。提交沿用 live payload：`draftUrl.trim()` 为空时 POST body 是 `{}`（等价普通 retry），非空才是
`{url: trimmed}`，禁止发 `{url:''}`；成功清 draft/error 并 focus 对应 retry/row fallback。Review warning 用
local/location state 承接：先保存
翻译后的 message，再 replace invalid search；replace 后 banner 仍在 canonical URL 上可读且 live region 宣告，dismiss、
切换 review/task id 或 unmount 才清，刷新 canonical URL 与 Back 都不会循环重放。

Canvas context-menu item 打开 dialog 后本身会 unmount，故不能把它当唯一 trigger。callsite 传 canvas root 为
`restoreFocusFallbackRef`；若 wrapper 或 child-id 集合在等待期间变化，`onConfirm` reject 到 ErrorBanner，用户必须
从最新图重新发起，绝不对 stale snapshot 执行破坏动作。按下表适用维度做定向测试，native-dialog ratchet
只作为最后一道源码锁，不能替代行为测试。

适用测试维度按流程区分，不强迫 warning 流程伪造 pending/confirm：

| callsite                       | 必锁行为                                                                                           | 测试落点                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Workflow import                | select/conflict new/overwrite/cancel、pending/reject、yaml+mode、focus                             | `workflows-pages.test.tsx` + 新 import dialog test            |
| OIDC delete                    | cancel/single confirm、force=false payload、pending/reject/success、trigger-unmount fallback focus | `oidc-confirm-dialog.test.tsx`                                |
| Skill dirty discard            | target path snapshot、cancel、confirm/revalidate、pending/reject、tree focus                       | `skill-file-tree-canonical-token.test.tsx` + 新 behavior test |
| Repo override                  | row snapshot、whitespace `{}`/trimmed `{url}`、pending/reject/cancel、row focus、390 table         | `batch-import-dialog.test.tsx`                                |
| Review invalid version / round | one-shot message、replace/search、dismiss、route-id reset、Back/refresh 不重播、无 blocking alert  | 两个既有 review tests 改行为断言                              |
| Canvas wrapper delete          | id/children snapshot、changed graph reject、delete payload、single fire、canvas fallback focus     | `wrapper-context-menu.test.ts` + 新 rendered test             |

## 10. Split master/detail

### 10.1 API 墠量

```ts
interface ResourceSplitPageProps {
  // existing...
  listTo: LinkProps['to']
  mobileBackLabel: string
  mobileBackTestId?: string
  emptyDescription?: string
  emptyIcon?: ReactNode
  onRetry?: () => void
}
```

root 增 `data-mobile-view="list|detail"`：`selectedKey !== null || newActive` 时为 detail，否则 list。

### 10.2 CSS/行为

- 721–1080：保持现有上下 stack，rail max-height 15rem。
- <=720 list：显示 rail，隐藏 detail；rail border/padding 按 mobile surface 收敛。
- <=720 detail：隐藏 rail，detail 顶部显示 router Link 返回 `listTo`；dirty guard 在导航时照常拦截。
- 浏览器 Back 仍回上一 URL；显式 back link 是可发现入口，不劫持 history。
- 不依赖 `:has(.skill-import)`；Skill new 作为 `newActive` 自动进入 detail。RFC-196 的
  `.skill-import__mobile-back` DOM 与 route shell hack 在 shared split back 通过后退役，Skills 把原 accessible
  label/testid 传给 `mobileBackLabel/mobileBackTestId`，同屏始终只有一个“返回技能列表”。

### 10.3 CTA 去重

rail 底部 `split__new` 是唯一创建动作。desktop detail 未选择时只显示“选择一个资源查看详情”的
comfortable EmptyState，不带第二个 New；route-specific empty child 移除重复 CTA。

## 11. Route 接缝迁移

### 11.1 Workflow import

`WorkflowImportDialog` 状态：

```ts
type WorkflowImportState =
  | { kind: 'select'; file: File | null; error: string | null }
  | {
      kind: 'conflict'
      file: File
      yaml: string
      choice: 'new' | 'overwrite'
      error: string | null
    }
  | { kind: 'result'; message: string }
```

- `file.text()` 也在 try/catch 内；读取 reject 留在 select.error，不产生 unhandled promise。读取成功后提交
  `postYaml(yaml,'fail')`；非 conflict error 留 select 可重试。
- conflict 进入明确选择且默认 `choice='new'`（保持 live prompt 的安全默认）；overwrite 必须用户显式选择，
  submit 原样传 `'new'|'overwrite'`。
- success await/invalidate `['workflows']`，显示结果与关闭/继续；API helper 与错误码不改。
- trigger focus restore；同文件可重选；in-flight 禁换文件/重复提交。

### 11.2 Homepage/Workflows deep action

本节窄幅 supersede RFC-190 `newWorkflow` 的 secondary `/workflows` 落点，不再把它描述成纯接缝不变。
`/workflows` 增 search `{create?: boolean}`；`create=1` 时打开 QuickCreateDialog，消费后立即 replace 清除一次性
flag，保留其他 search。Homepage CTA 用 typed Link 且保留既有 testid；关闭、刷新 canonical URL 与 Back 均不
重开。TaskFeed 两个内部 `<a>` 改 typed Link，search status 保留。route test 锁 one-shot、history 与 testid。

### 11.3 Settings/Auth/Account/Users

- Settings 顶层 `PageHeader + URL TabBar`；tab panel 使用同 idPrefix。
- Authentication list 用 `StatusChip + TableViewport + shared states`，表单迁 Field；删除走 ConfirmDialog。
- Runtime actions允许 wrap，Dialog form grid 手机一列；不改 runtime test/enable/default/delete 语义。
- Auth 的 password/OIDC/token 三种方式迁 shared TabBar/Form，但 Auth card 品牌布局保留；OIDC tab 仍仅在
  providers 异步非空后出现，late availability 不得把 password/token 的 active panel 弄失配。切 tab 清 error、
  保留三类输入与 safe redirect/fragment 消费顺序。password field 只在 Auth 页面首次落地 focus 一次；移除
  password/token panel 每次 mount 的 `autoFocus`，Arrow/Home/End automatic activation 后焦点必须留在 active
  tab，不能被新 panel input 抢走。
- Account SectionShell 迁 Card，Users create/edit fields 迁 Form；角色/权限/登出行为不变。

### 11.4 普通列表/详情

- Tasks/Scheduled/Repos/Reviews/Clarify/Memory 迁 PageHeader、shared states、TableViewport。
- Workflow editor loading/error 迁 shared state，actions wrap；canvas DOM/尺寸算法不动。
- Resource gallery 空态加 contextual action；画廊 card 本身不重画。

## 12. CSS 收口与 ratchet

### 12.1 删除策略

只删除同时满足以下条件的 selector：

1. `rg` 在 production TSX/TS/HTML 零调用；
2. 不被 E2E locator、snapshot setup、Markdown/third-party injection 使用；
3. 对应 route 已迁共享 primitive；
4. source test 更新为“旧 selector 不得复活”。

首批候选：review decision 自建 chrome、重复 account section、局部 skill primary dark patch、重复
`.form-field__label` 后段 override。旧 Agent import chrome/feature CSS 由 RFC-197 独占清理；本 RFC 不碰。
删除前逐个列证据，不按 class 前缀批量删。

### 12.2 全局 source ratchet

- production 无 `window.alert|prompt|confirm` / bare `confirm(`；测试 fixture allowlist。
- 新 modal 必须走 `Dialog/ConfirmDialog`；`ReviewDocPane` 的非模态内部 role 作为解释型例外。
- 通用 text input 无裸 `<input>`，hidden/file/checkbox/radio 与明确组件内部实现 allowlist。
- standard route header 使用 `PageHeader` 或列明专用 viewport exception。
- top-level native table 必须由 `TableViewport` 包裹；prose/canvas/virtual tree 例外。
- dark media rule 必须尊重 `:root:not([data-theme])`。
- `--accent/--danger/--success/--warn/--info` 等 foreground token 不得作为包含文字的 background；仅
  allowlist 的 dot/track/handle/装饰 indicator 可例外，filled control 必须使用 `*-fill/on-*` pair。

## 13. 测试设计

### 13.1 Unit/component

- `app-shell-layout.test.tsx`：auth/token-null/authenticated 三分支；desktop/mobile shell 单一可达性。
- `shell-navigation.test.tsx`：分组文案、icons、active/fallback/badge/permission、onNavigate。
- `mobile-nav-dialog.test.tsx`：open/route close/ESC/overlay/focus restore、resize/zoom close 后 main active、inbox
  mutual exclusion。
- `theme-contrast.test.ts` + browser axe：token pair、explicit-vs-system selector、primary/status contrast。
- `page-header.test.tsx`：DOM、无空 wrapper、title/meta/actions、默认 h1/split h2 与同屏 heading outline。
- `tab-bar.test.tsx`：roving、Arrow/Home/End、automatic selection、ids、scroll；`tab-panels` 关联。
- `table-viewport.test.tsx`：region/label/tabIndex/overflow edge state、不吞 table events。
- `notice-banner.test.tsx` / `error-banner.test.tsx`：role、i18n error、action、tone。
- `form.test.tsx`：新增 allowlist、password/autocomplete/aria、pattern/inputRef/textareaRef/number 兼容及 Dialog
  initial focus；非法 uncontrolled prop 无 API。
- `confirm-dialog.test.tsx`：single fire、全部 dismiss pending lock、reject 无 unhandled/错误可见/复位、
  trigger 与 disconnected-trigger fallback focus restore。
- `resource-split-page.test.tsx`：mobile view flag/back/CTA 唯一/dirty guard 不回退。
- route tests：真实 URL tab union 与 Task async resolver、`#runtime` compatibility、workflow create one-shot/
  import state；Auth initial field focus + 三 tab automatic focus/OIDC late availability；7 个 native-dialog callsite
  按 §9.4 表的适用维度验证；最后再跑 ratchet。

### 13.2 Browser matrix

新 `e2e/ux-consistency.spec.ts` 用固定 API fixture/隔离 daemon覆盖：

| viewport/theme        | 场景                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| 1280×800 light        | home/shell、workflow gallery、agent split、tasks table、settings form、workflow dialog      |
| 1024×768 light        | desktop shell、page actions、split stack、table                                             |
| 901×800 + 900×800     | shell breakpoint、唯一 shell/focus/tab order、无 body overflow                              |
| 768×1024 light        | compact shell + tablet content；header/form field/action bounding width、split/table        |
| 721×800 + 720×800     | content/form/split stack 边界，不再当 shell breakpoint                                      |
| 390×844 light         | mobile nav、split list→detail、tasks table、settings tabs/form、confirm/import dialog       |
| 1280×800 dark         | primary/status/diff/settings/dialog                                                         |
| 390×844 dark          | nav、table、form、dialog 代表面                                                             |
| OS/app theme 反向组合 | OS dark+app light 与 OS light+app dark；primary/diff/status computed colors + axe（自动化） |

每个代表场景至少断言：

- `document.documentElement.scrollWidth <= clientWidth`；
- `.content` / AppShell 实际 main scroll host 同样满足 `scrollWidth <= clientWidth`；shell 的
  `overflow:hidden` 不能掩盖 page 横向滚动。table 场景还要证明 TableViewport scroller 自身
  `scrollWidth > clientWidth`，滚动它后 main scroll host 的 `scrollLeft===0`；Dialog table 同理断言
  `.dialog__body` 不横滚、内部 scroller 横滚。
- primary action 与当前 heading 可见；
- keyboard-only 可到达主操作/导航/table region；
- focus 不落到 CSS hidden shell；
- axe 无 critical/serious；主题专项再锁 WCAG contrast。

### 13.3 Visual

- 在 project `use` 的 device spread **之后** 显式写 viewport 1280×800，保证注释/配置/PNG 一致。
- 刷新现有 darwin/linux 12 场景；增加 5 个手机代表截图，不穷举所有 route。**现有与新增的每个 scene**
  都在截图前显式 set theme 并声明 clean/seeded/empty fixture；不得继承前序 scene 的 seed 数据或末尾 dark
  theme。需要时按 fixture 拆 daemon/describe，单独 `--grep` 任一 scene 与整文件运行必须同样稳定，测试
  declaration order 不构成合同。
- 组件级 `toHaveScreenshot()` 锁 nav open、PageHeader actions、table edge、empty state、Dialog footer，避免
  整页 0.2% threshold 吞掉局部退化。
- README 更新实际场景数、Dialog 范围、Playwright 版本与 Linux baseline 流程。
- visual workflow 保留 path-filtered `pull_request`、scheduled、workflow_dispatch 并新增 `push: main`；paths
  覆盖 visual spec、`playwright.config.ts`、root `package.json`/`bun.lock` 与统一脚本。CI 只调用
  `bun run test:visual`，不再手写第二套 env/Playwright 命令。
- root script body 固定为
  `RUN_VISUAL_REGRESSION=1 playwright test e2e/visual-regression.spec.ts --project=chromium`；retries 由调用方/
  config 传入。必须同时断言实际执行场景数，不能忘记 env 后让 opt-in tests 全 skip 也绿。
- root scripts 增稳定的精确路径清单：`lint:repo-ui` 只含本 RFC 的 UX/visual/nav/keyboard/a11y TS specs、
  harness/fixture 与 Playwright config；`format:check:repo-ui` 再含两个 visual README、visual/CI YAML 与 root
  `package.json`。`bun.lock` 无 Prettier parser、`bunfig.toml` 也不进 ESLint/Prettier，只作为 install/path-filter/
  定点 diff 输入；
  不用 `e2e/**` 泛扫把无关历史债混入。T8a 先以纯格式/类型-import commit 清掉清单内既有
  `inbox-fixtures.ts` Prettier 与 `nav-redesign.spec.ts` lint 基线，再开启组合 root gate。workflow 至少经
  Prettier YAML parse；不能依赖只扫 packages 的旧门。
- root `package.json` 原有 scripts 必须链新门：
  `lint = bun run --filter '*' lint && bun run lint:repo-ui`，
  `format:check = prettier --check "packages/**/*.{ts,tsx,json,md}" && bun run format:check:repo-ui`。因此下述既有
  `bun run lint/format:check` 与 CI 会真实执行 non-package gate，而不是只定义两个无人调用的脚本。

### 13.4 完整门

```bash
bun run typecheck
bun run test
bun run --filter @agent-workflow/shared test
bun run --filter @agent-workflow/frontend test
bun run lint
bun run format:check
bun run build:binary
bun run e2e
bun run test:visual
```

Dialog/focus 变更另跑 WebKit keyboard/mobile 代表面；visual baseline 更新必须先人工看 diff，再更新、复跑。
`.github/workflows/ci.yml` 不能再用受 `bunfig.toml test.root=packages/backend/tests` 限制的 `bun test` 冒充
“backend + shared”：现有 steps/Codecov 更名并明确是 backend-only coverage，另加两平台都执行的
`bun run --filter @agent-workflow/shared test`。把 bunfig 注释改成真实发现范围；frontend 继续走 Vitest，
不混入 root Bun discovery。

## 14. 风险与回滚边界

| 风险                                     | 护栏                                                              |
| ---------------------------------------- | ----------------------------------------------------------------- |
| shell 重构让权限入口丢失                 | desktop/mobile 同组件 + admin/regular/daemon actor matrix         |
| hidden desktop/mobile 重复进入 tab order | breakpoint browser test + `display:none`/conditional Dialog mount |
| URL tab 清掉其他 search                  | functional updater 只改 `tab`，保留 status/path 等字段            |
| table 内滚影响 row click                 | wrapper 不绑定 click/keydown，既有 row navigation tests 原样保留  |
| token 全局改色导致 route 漂移            | text/fill alias 分阶段迁，visual diff + axe，不一次删除旧 alias   |
| native dialog 改造改变业务选择           | 每个 callsite 对拍原 payload/mode/cancel 分支，后端零改           |
| split mobile 隐藏 dirty detail           | CSS 只控制展示，组件仍 mounted；导航继续经过 dirty guard          |
| visual baseline 大量 churn               | 先固定 canonical viewport，平台分别更新；截图 diff 人工批准后入库 |

回滚以 plan 明定的 6 个顺序 PR 为边界：foundation、shell、layout primitives、standard pages、transactional
UX、cleanup/browser evidence。每个 PR 在合入当时独立验证；叶 PR 可单独 revert，已有 downstream consumer 时
必须按 PR6→PR1 逆依赖顺序回滚，不能撤底层 primitive 留上层 import。不把“PR/Commit”留给实现阶段临时选择，
也不使用兼容 flag 长期并存两套 UI。
