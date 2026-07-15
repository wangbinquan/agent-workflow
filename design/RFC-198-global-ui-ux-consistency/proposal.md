# RFC-198 — 全局界面 UX 一致性与响应式基础

> **状态**：In Progress（2026-07-15 用户已批准）
>
> **触发**：2026-07-15 用户「整个界面做下 UX 优化，让视觉更一致、功能更直观易用」。
>
> **范围**：frontend 全局 shell、主题 token、公共 UI 原语与高频页面接缝；保持现有 backend/API/DB/ACL/业务状态机。

## 1. 背景与现场证据

仓库已经通过 RFC-035/124/150/151 建立 `Card`、`Dialog`、`Form`、`TabBar`、`Segmented`、
`EmptyState`、`LoadingState`、`ErrorBanner` 等公共原语，近期 RFC-190/191/192/194/195/196/197 也分别
重做或规划了首页、资源画廊、运行列表、代理端口、收件箱、Skill ZIP 与 Agent `agent.md` 导入。当前问题
不再是“没有组件”，而是 **全局骨架与长尾调用点没有完成第二阶段收敛**：

1. `.app-shell` 始终是 `220px + 1fr` 双栏，`.content` 还有 32px 横向 padding；390px 下除
   `/skills/new` 的 route-scoped 特例外，绝大多数页面只剩极窄主区。RFC-196 的局部隐藏 sidebar
   证明现状只能靠页面补丁活下来，不能覆盖全站。
2. 页面标题、actions、空态与加载/错误分别由各 route 手拼。`page__actions` 不换行，工作流编辑器
   同时平铺启动、校验、导出、重命名、权限、删除；空列表通常只有一行 “No …”，没有下一步动作。
3. 导航分组名与首项重名，分组标题右侧的 `▾` 不可点击却暗示可以折叠；资源 icon 已存在，sidebar
   仍主要依赖纯文字扫描。
4. `TabBar` 只有 `role=tab`/`aria-selected`，没有 roving tab index、方向键、Home/End、panel 关联或
   窄屏滚动。Memory、Settings、Task detail 等页面级 tab 又各自使用本地 state，刷新、返回、分享会
   丢失所处上下文。
5. `/tasks` 有 7 列，Scheduled/Repos/Users/Reviews/Clarify 也使用宽表；`.data-table` 自己
   `overflow:hidden`，却没有可聚焦、带语义的横向滚动容器。手机端只能挤压或让整页溢出。
6. `ErrorBanner` 绕过已有 `describeApiError`，顶层 route 仍混用裸 `.error-box`、`.muted` loading 和
   私有 info box。首次鉴权未完成时，root 还可能在 bare shell 内短暂渲染受保护页面及失败请求，
   用户看到的是“系统坏了”而非明确的登录过渡。
7. Form API 缺少常用 input 属性，导致 Auth、Account、Users、Settings/OIDC 继续复制输入框视觉与
   focus 规则；Settings Authentication 与同页其他 section 形成视觉孤岛。
8. 仍有 7 处原生 `window.alert/prompt/confirm` 或全局 `confirm()`：Workflow 导入冲突、OIDC 删除、
   Skill 文件切换、Repo 批量导入、Review 未知版本、Canvas wrapper 删除等都绕过共享 Dialog，
   无 pending 锁、焦点恢复和统一动作层级。
9. 暗色主题把同一个 `--accent` 同时当文字色与 filled-control 背景；`#6aa3ff` 配白字约 2.53:1。
   Markdown diff 的暗色 CSS 只看 OS media，不尊重显式 `data-theme`，会出现“系统暗色 + 应用浅色”
   仍套暗色 diff 的反向主题错误。Skill import 只能用局部 token 补丁维持对比度。
10. 当前 visual spec 默认跳过；配置注释/README 说 1280×800，而 device project 实际覆盖成
    1280×720。现有 12 个视觉场景无移动版，dark 只覆盖 Inbox，Happy DOM 单测又无法证明真实几何。

因此本 RFC 不是再做一轮页面级“换圆角”，而是把 **视觉 token、响应式壳层、页面骨架、状态反馈、
键盘合同与真实浏览器回归** 收敛成全站可复用规则，再迁移高频长尾。

## 2. 目标

1. 形成稳定的桌面与手机 shell：所有导航、收件箱、账号、语言和管理入口在 390px 仍可达。
2. 统一页面标题、主次动作、间距、focus、表单、状态色与 surface 层级，保留现有品牌辨识度。
3. 让导航名称、icon、active 状态与页面主操作可以被快速扫描，不制造不可交互的假 affordance。
4. 让 page-level tab 可刷新、可返回、可分享，并达到标准横向 tab 键盘交互。
5. 让数据表、tabs、dialog、form grid、split master/detail 在窄屏有明确降级策略，不产生 body 横向滚动。
6. 统一 loading/error/empty/notice/retry；空态必须告诉用户“现在是什么状态、下一步能做什么”。
7. 清除原生 alert/prompt/confirm 与重复 form/card chrome，复用共享 Dialog/Form/Card。
8. 修正显式主题优先级和 filled-control 对比度，以 light/dark + system preference 反向组合验收。
9. 建立可信的桌面、断点、手机、dark、a11y 与视觉基线门，避免只靠 CSS 字符串测试宣称完成。
10. 保持现有 URL 主路径、API wire、权限、安全校验、业务状态机与近期 RFC 的任务语义。

## 3. 非目标

- 不改 backend/API/DB/schema/migration/ACL/WebSocket，也不新增服务端聚合接口。
- 不重设计 Workflow Canvas、Node Inspector、Review annotation、diff/prose 内容模型或 Workgroup room。
- 不推翻 RFC-190 首页能力门户、RFC-191 资源画廊、RFC-192 运行列表字段/行交互、RFC-194 端口编辑器、
  RFC-195 Inbox Dialog、RFC-196 Skill ZIP 三阶段导入、RFC-197 Agent `agent.md` 导入；只修它们与全局
  shell/原语的接缝。`AgentImportDialog` 的阶段/预览/异步读取/结果状态与 feature CSS 由 RFC-197 独占。
- 不重新加入 RFC-155 已删除的全站标题下“系统原理说明小字”。`PageHeader` 不默认渲染 description；
  只有动态状态、必要上下文和 actionable empty state 才提供解释。
- 不用一个 columns/rows DSL 强吞所有表格，不把 canvas node、消息、review bubble 等语义不同的 surface
  机械换成 `Card`。
- 不把所有 secondary action 强塞进新下拉菜单；本轮先统一顺序、wrap/stack 与 mobile 可达性。
- 不增加新字体包、图标依赖、动画框架或前端状态库；优先复用已安装资产与现有 inline SVG。
- 不做全仓零白名单的裸 HTML 元素禁令；hidden/file/checkbox、canvas 专用控件和语义明确的例外保留。

## 4. 产品决策

### D1 — 视觉方向：克制、专业、信息清楚，不做“全站卡片化”

- 保留当前蓝色 accent、浅/暗主题与多色 pipeline 品牌图形；不换 logo、不造第三套主题。
- 层级主要由统一 typography、spacing、border、surface 与主次动作建立，不靠高饱和渐变铺满页面。
- 标准页标题统一使用 `--font-xl` 与固定 line-height；section、label、meta 使用现有字号 token。
- 普通页面继续全宽自适应；画布/房间/preview 等专用 viewport 不套通用 max-width。
- default button/form/nav control 的实际 block size 最小 36px；dense table/toolbar 的 sm/xs 可为 32/28px，
  但仅限明确 compact 容器且相邻目标有足够间距。`<=720px` 的 page actions、Dialog footer、mobile nav 与
  destructive/primary target 最小 44px；canvas port/resize handle 等精密控件列专用例外并保留键盘替代。
  所有键盘 focus 使用同一可见 ring。

### D2 — 颜色 token 拆分文字与填充语义

- `--accent` 继续表示链接、active text、focus ring；新增 `--accent-fill` 与 `--on-accent` 专供 primary
  button、active segmented 等 filled controls。
- success/warn/info/danger 补齐 `*-fg`、`*-bg`、`*-border`；旧 alias 暂时兼容，公共 primitive 先迁。
- primary、danger、StatusChip、ErrorBanner、tabs、nav 在 light/dark 下都锁定 AA 对比度；11px chip 若无法
  达标则提高字重/字号或换更深/更浅 foreground，不再做 route-scoped 颜色补丁。
- Foundation 在改变暗色 foreground 前一次迁完所有“foreground token 作为带文字 fill”的 selector；文字/图标
  fill 必须使用 `*-fill/on-*`，只有无文字 indicator 可带注释白名单，source ratchet 防止旧写法复活。
- production CSS 中无 fallback 的 `var(--token)` 必须有定义或明确 runtime allowlist；本轮收敛现存
  `--warning/--fg/--mono/--mono-font/--surface-*` 漂移，并正式定义 UI/monospace font token。
- Markdown diff 同时提供 `:root[data-theme='dark']` 与
  `@media (...) { :root:not([data-theme]) ... }`，显式用户选择永远高于 OS fallback。

### D3 — 一份导航内容，两种 shell 呈现

抽取 `ShellNavigation`，桌面 sidebar 与手机 Dialog sheet 共用同一组件、权限判断和 route 数据；当前
viewport 只挂载其中一种 shell，避免隐藏副本继续查询或进入 tab order：

- `>900px`：保留 220px 固定 sidebar；品牌、Home、分组资源、Inbox、User/Language/Settings 顺序不变。
- `<=900px`：shell 改为一列，顶部 56px compact bar；左侧 menu，中央品牌/当前 section，右侧 Inbox。
- menu 打开共享 `Dialog` 的 left-sheet skin；包含完整导航、账号、语言与有权限才出现的 Settings/Users。
- Inbox 在 `>900` 保持 sidebar-adjacent，`721–900` 改为 topbar 下右对齐，`<=720` 继续 RFC-195 full-screen；
  不能在无 sidebar 的 tablet 仍扣 220px 偏移。
- 选择任一 nav/footer route 后先关闭 sheet 再导航并把焦点送到新页面 main/heading；ESC/overlay/close 才把焦点
  回 menu trigger，body scroll lock 复用 Dialog。Account/Users/Settings 与主 nav 使用同一 `onNavigate` 合同。
- safe-area、200% zoom、长中英文标签下无裁切；desktop sidebar 与 mobile sheet 不能同时进入 tab order。
- compact→desktop（含 200% zoom 跨断点）会同时卸载 menu trigger/sheet，焦点必须回 stable main landmark，
  不能落到 body。
- 删除 `/skills/new` 的 route-scoped sidebar 与返回入口特例：全局 shell 承担导航，shared split back 接管并保留
  RFC-196 的 accessible label/testid/focus/390px 回归，页面不再渲染第二个“返回技能列表”。

### D4 — 导航只改信息表达，不改 route 归属

- route 顺序、active resolver 与 URL 不变；group key 也保持兼容。
- 分组显示名改为「能力资源 / 编排 / 运行与仓库 / 知识」（英文对应 Resources / Orchestration /
  Operations / Knowledge），避免“代理组里第一项又叫代理”的重复，也准确覆盖 Tasks/Scheduled/Repos。
- 删除不可交互的 `▾`；本轮不引入折叠记忆或 disclosure state。
- 每个 item 使用既有资源 icon；补 Home/Task 等缺失 icon。icon 为辅助，accessible name 仍来自文字。
- Memory pending badge、review/clarify fallback highlight、权限隐藏规则逐字保持。

### D5 — 薄 `PageHeader` + 明确动作层级

新增薄公共 `PageHeader`，只封装现有 `.page__header/.page__actions` 合同：

```ts
interface PageHeaderProps {
  title: ReactNode
  headingLevel?: 1 | 2
  meta?: ReactNode
  back?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}
```

- 不提供默认 subtitle，不把页面业务内容藏进 primitive。
- `headingLevel` 默认 1；split detail 显式使用 2，不能与 rail 的页面级 h1 形成双 h1。
- 标准列表的 **page chrome**（PageHeader + initial EmptyState）最多一个主 CTA：Workflows/Workgroups/Tasks/
  Scheduled 以「新建」为主；Repos 以「批量导入」为主；Users 以「新建用户」为主；Import/Filter 等为
  secondary。tabbed dashboard（Memory）的“新建记忆”常驻 PageHeader，单个 panel empty 不复制页面级 CTA。
  card/row/contextual
  selection、独立 section submit 与 Dialog footer 是各自局部 action group，不计入全页静态 class 总数，但每个
  group 仍最多一个 primary。
- editable detail 以 Save 为唯一 primary，Launch/extra/ACL 为 secondary，Delete 为 danger；独立 editor 才以
  Launch 为 primary，保持 `extra → ACL → Save → Delete` 的 DOM 顺序。
- 初始未过滤空列表把同一个主行动只放在 `EmptyState`，header 不重复；有数据或过滤无结果时主行动只在
  header，no-match state 只提供“清除筛选”。split rail 的创建按钮始终是该 shape 的唯一创建入口。
- desktop action row 可 wrap；`<=720px` title/meta 独占一行，actions 换行并让 primary 保持最易触达。
- `DetailHeaderActions`、`ResourceGalleryPage` 与普通顶层 route 迁到同一 header contract；split/canvas 的
  专用 chrome 只复用 token 和响应式规则。

### D6 — Page-level tab 由 URL 驱动，`TabBar` 完成键盘合同

- `TabBar` 为横向 tablist 增加 active=`tabIndex 0`、其余 `-1`、Left/Right、Home/End、循环移动、
  `aria-controls`/tabpanel id，并在窄屏提供自身横向滚动；页面 body 不随 tab 横向滚动。
- Memory、Settings、Task detail 这类无未保存草稿的 page-level tabs 使用 validated `?tab=`；Memory 默认
  `approval-queue`，Settings 默认 `runtime`，Task detail 的完整 `TaskDetailTab` wire key 不另造别名。
- Task detail 在 task kind、异步 room config、`hasOutputs` 与 `dwPhase` 未稳定前不规范化 URL；稳定后按
  “显式且可用 tab → shape/phase 默认”解析。无效/不可用与异步 fallback 用 replace，用户点击及显式页面跳转
  用 push，并保留其他 search；late dynamic config/phase 不覆盖用户已选 tab。
- Agent/MCP/Plugin/Skill split detail 的 tabs 是同一未保存表单的分区，继续使用 local state；把它们写进
  URL 会被 `UnsavedChangesGuard` 当成离页导航并错误弹确认，本 RFC 不为 tab 特判 dirty guard。
- Settings 兼容既有 `#runtime` 深链，首次解析后规范化成 `?tab=runtime`；首页 runtime link 改写新 URL。
- Node Inspector、Dialog、局部 display mode 等非页面级 tabs 继续本地 state；Review diff mode 改用
  `Segmented`，不假装成文档 tab。
- Auth 的 password/OIDC/token 三种登录方式迁共享 `TabBar variant="segment"` + Form；OIDC 仍按 providers
  异步可用性出现，切 tab 清错误但保留输入；只在页面首次落地 focus password field，键盘切 tab 后焦点留在
  active tab。`/auth` 本身不把 tab 写入 URL。

### D7 — `TableViewport` 是滚动与语义边界，不重写 table 模型

新增轻量 `TableViewport`：

```ts
interface TableViewportProps {
  label: string
  minWidth?: 'sm' | 'md' | 'lg'
  children: ReactElement<ComponentPropsWithoutRef<'table'>, 'table'>
}
```

- 实际 `overflow-x:auto` 的 scroller 同时持有 `role=region`、`aria-label`，只在真实 overflow 时加入
  `tabIndex=0`；focus ring 明确当前可滚区域，宽度充足时不额外占用一次 Tab，方向键可使用浏览器原生滚动。
- 用渐隐/短提示表达“可横向滚动”，滚到边缘后自动消失；`prefers-reduced-motion` 无位移动画。
- table 保留原生语义与既有 row/cell testid；不隐藏业务列、不改变 RFC-192 字段与 row-click。
- 迁移 Tasks、Scheduled、Repos、Users、Reviews、Clarify、Memory jobs 与 Skill version history；后者从
  无样式 `.table` 收敛到 `data-table data-table--compact`。Agent import 的旧 table 由 RFC-197 直接退役，
  本 RFC 不先套 TableViewport。
- Account 的 sessions/tokens/identities 三表、TaskDiagnosePanel 与 BatchImportDialog 失败行表也必须迁，保留
  既有 class/testid/row 行为；canvas/prose 内 table 不使用该 primitive。

### D8 — loading/error/empty/notice 形成同一状态合同

- 新增 `NoticeBanner` 统一 info/success/warning/error 的视觉与 role；`ErrorBanner` 改用
  `describeApiError` 后委托 error tone。错误用 `role=alert`，其他反馈使用对应 status/notice 语义，
  不把所有反馈都染红。
- initial loading 使用 `LoadingState`；有 stale data 的 background refetch 不清屏，保留内容并给轻量状态。
- comfortable `EmptyState` 形成安静 surface；顶层空列表必须有 title、情境 description、icon 与当前页面
  主行动。过滤无结果使用 compact state +「清除筛选」，不重复“新建”。
- `ResourceGalleryPage` 与 `ResourceSplitPage` 支持 error retry、empty action/description；已有数据与错误可并存。
- Auth token 为空且当前不是 `/auth` 时，root 不再渲染受保护 `Outlet`；只显示中性 route-transition 状态，
  `beforeLoad` 继续负责带完整 redirect 的登录跳转。

### D9 — Form/Card/Dialog 补齐能力后迁长尾，不新增私有替代品

- `TextInput/TextArea` 增加受控 allowlist：`type`（text/search/email/password/url/tel）、name/id、
  autoComplete、autoFocus、min/maxLength、required、aria 属性；焦点、error、disabled 仍由共享 CSS 管。
- 既有 `pattern`、`inputRef` 与兼容 `type=number` 不得在扩 API 时丢失；新增数值字段仍优先 `NumberInput`。
- Dialog footer 可 wrap，手机端纵向排列；2/3 列 `.form-grid` 在 720px 收成一列且所有 track
  `minmax(0,1fr)`。
- `Card` 最小增加 section root/heading 语义；Account `SectionShell`、OIDC/settings 简单 section 迁入，
  复杂消息/节点 surface 不迁。
- Auth、Account、Users、Settings/OIDC 的通用文字字段迁共享 `Field/TextInput/TextArea/Switch/Select`；
  file、hidden、原生 checkbox 的合法语义例外保留。
- `TaskDiagnosePanel` 删除重复 `.dialog__footer` wrapper；确认 TSX 零引用后删除旧 overlay/panel/form CSS。

### D10 — 原生 alert/prompt/confirm 清零

- 新增 `ConfirmDialog`（共享 Dialog 的薄包装）：内部 await `onConfirm` 并拥有 pending/error；只在成功后关闭，
  reject 留在 dialog 的 ErrorBanner。pending 时通过 Dialog 的 `dismissDisabled` 同时锁 ESC/overlay/close/cancel/
  confirm，保证 single-fire 与完成后 trigger focus restore；复杂多选仍直接组合 `Dialog + Form/Segmented`。
- Workflow import 改为 `WorkflowImportDialog`：复用 `FileDropzone` 选 YAML，冲突时明确选择“导入为新工作流 /
  覆盖 / 取消”，成功/失败留在 dialog 内；API `postYaml` 与 conflict mode 不变。
- Repo batch override URL 改为当前 dialog 内的 `Field + TextInput`；OIDC/Canvas/Skill dirty discard 使用
  ConfirmDialog。
- Review 未知 version/round 改为页面 `ErrorBanner/notice`，不阻塞浏览器线程。
- 新源码 ratchet 全仓扫描 `window.alert/prompt/confirm` 与裸 `confirm(`；仅测试 fixture 可白名单。

### D11 — Split master/detail 与首页入口收掉重复动作

- `ResourceSplitPage` 保留 RFC-169 master/detail 与 dirty guard；`721–1080px` 仍可堆叠。
- `<=720px`：列表 route 只显示 master rail；选择资源/新建后只显示 detail，并有显式“返回列表”。
- desktop 未选择资源时，detail empty state 提供说明但不重复 rail 底部「新建」按钮；手机列表页的主按钮
  仍在 rail 内可见。
- search 改共享 `TextInput`；空列表/过滤无结果分开，retry 与 clear-search 可操作。
- 本决策窄幅 supersede RFC-190 的 Homepage `newWorkflow` secondary `/workflows` 落点：改用
  `/workflows?create=1` 直达 Quick Create；保留 CTA testid。`/workflows` 验证 search，消费后以 replace 清除
  一次性 flag，关闭、刷新与 Back 不会重开。`TaskFeed` 内部 `<a>` 改 router `Link` 并保留原 search。

### D12 — 测试基线本身也必须可信

- Playwright project 显式锁 1280×800，修正 device preset 覆盖；README、注释与实际截图一致。
- 新 `e2e/ux-consistency.spec.ts` 使用隔离 daemon，覆盖 1280×800、901/900 shell 边界、768×1024、
  721/720 content 边界、390×844 与 dark；768 下还断言字段/动作实际可用宽度，不只检查 body overflow。
- mobile 必测：导航全可达/关闭/focus restore、无 body overflow、page actions 可见、tabs 可操作、table
  内滚不带动 body、split list/detail 往返、Dialog footer 不裁切。
- axe 至少覆盖 shell/home、gallery、split、table、settings/form、Dialog 的 light/dark + desktop/mobile 代表面。
- 浏览器自动化显式覆盖 OS dark + app light、OS light + app dark 两组反向主题，断言 data-theme 与
  primary/diff/status computed colors，而不只做 CSS 文本锁。
- visual spec 保留现有 12 场景并增加 homepage、agents split、tasks table、settings、mobile-nav 的手机基线；
  每个新增 scene 显式建立 theme 与 seeded/empty fixture，不能继承前序 daemon 状态。
- visual workflow 保留现有 path-filtered pull_request、scheduled、manual，新增 `push main`；paths 同时覆盖
  `playwright.config.ts`、root package/lock、visual spec/config/script 及其 `harness/inbox-fixtures` 直接依赖，CI 与
  本地统一调用 `bun run test:visual`。
- 新 `test:visual` 脚本显式运行 opt-in spec；默认 e2e 的 skip 语义写入 README，交付门单独执行 visual。
- root lint/format gate 扩到本 RFC 触达的 e2e、Playwright config、workflow、README 与 root package 文件，
  不能用只扫描 `packages/**` 的现有 scripts 代替。

## 5. 目标形态

### 5.1 Desktop

```text
┌──────────── 220px sidebar ────────────┬─────────────────────────────────────┐
│ Agent Workflow                        │ 页面标题              [次] [主操作] │
│ 首页                                  │ 动态状态 / meta（可选，不放套话）   │
│ 能力资源                              ├─────────────────────────────────────┤
│   ◇ Agents   ◇ Skills                 │ 页面内容 / 可操作空态 / table frame │
│   ◇ MCPs     ◇ Plugins                │                                     │
│ 编排 · 运行与仓库 · 知识              │                                     │
│                                       │                                     │
│ Inbox                                 │                                     │
│ Account · Language · Settings         │                                     │
└───────────────────────────────────────┴─────────────────────────────────────┘
```

### 5.2 Mobile

```text
┌──────────────── 390px ────────────────┐
│ [☰] Agent Workflow / 当前区      [Inbox]
├───────────────────────────────────────┤
│ 页面标题                              │
│ [主操作] [次操作…]                    │
│                                       │
│ 内容                                  │
│ ┌ 可横向滚动的 table region ────────┐ │
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘

Menu → left Dialog sheet（完整导航 + 账号/语言/设置）
Split list → 选择资源 → detail（显式返回列表）
```

## 6. 验收标准

- [ ] 390×844 下所有顶层导航入口可达；无受保护页面被 220px sidebar 挤压，Skill route 无专属 shell hack。
- [ ] desktop/mobile 导航共用一份内容与权限判断；route change、ESC、overlay、focus restore 全锁。
- [ ] 导航无假 chevron，group label 不与首 item 重名，icon/active/badge 在 light/dark 可辨。
- [ ] 标准页使用统一 PageHeader；split detail 保持 h2；action 可 wrap/stack，每个 shape 的 primary/empty CTA
      唯一且符合 D5。
- [ ] 显式 light/dark 永远压过 OS preference；filled control 与 semantic chip/banner 达到 AA。
- [ ] TabBar 支持 roving tabindex、箭头、Home/End、panel 关联与窄屏滚动。
- [ ] Memory/Settings/Task detail page tabs 使用真实 wire key，可深链、刷新、Back/Forward；Task 的 plain/
      turn-engine/dynamic + late-config/outputs fallback 不出现 URL-panel 分叉；旧 `#runtime` 兼容；editable
      resource detail tabs 保持 local，dirty 草稿内切 tab 不弹离页确认。
- [ ] 所有核心 data table 位于可聚焦 TableViewport 内；390px 只滚 table，不滚 body。
- [ ] 顶层初始 loading/error/empty/retry 全走共享状态；empty list 与 no-match 有不同动作。
- [ ] Auth/Account/Users/Settings 通用字段不再复制 form chrome；Dialog/Form mobile 无裁切。
- [ ] production frontend 中原生 alert/prompt/confirm 清零；每个替代流程有 pending/focus/error 回归。
- [ ] Resource split 手机端 list/detail 单焦点往返；Skill 只有一个 shared back；desktop 不再出现两个同义
      「新建」CTA。
- [ ] Homepage 工作流 CTA 直达创建态且一次性 flag 不因关闭/刷新/Back 重开，内部任务链接不再整页刷新。
- [ ] 1280×800、901/900、768×1024、721/720、390×844、light/dark/反向 OS theme、axe、keyboard、visual
      基线与 backend/shared/frontend/非 packages 文件门禁全绿。
- [ ] 无 backend/API/DB/ACL/业务状态机变化；近期 RFC 的 testid、wire 与安全不变量零退化。

## 7. 与既有 RFC 的关系

- **RFC-032**：保留导航 route 分组/active fallback，补上当时明确不做的 mobile responsive shell，并删除
  不可交互 chevron。
- **RFC-035**：复用其 tokens/primitive，完成 Form/Empty/Loading/Error/Dialog/Table 的第二阶段迁移。
- **RFC-124**：实现其延期的简单 Card chrome 收敛，不吞专用复杂 surface。
- **RFC-150/151**：增强既有 TabBar 与 DetailHeaderActions，不另造重复 tab/header 系统。
- **RFC-155**：继续禁止全站静态解释小字；本 RFC 的直观性来自结构、动作和 actionable state。
- **RFC-169**：保留 split 状态/dirty guard，补手机 list/detail 导航与重复 CTA 收敛。
- **RFC-190**：仅 D11 明确 supersede Homepage 工作流 CTA 的 `/workflows` 落点。
- **RFC-191**：保留 QuickCreate 流程、画廊卡片与业务状态；窄幅 supersede 其“空画廊 header CTA +
  EmptyState 字节级/visual 零 churn”合同，改成空态内唯一主 CTA，并更新旧测试/visual baseline。
- **RFC-192**：保留字段、筛选、row/action 与状态语义；窄幅 supersede 其“空 DB 与改版前字节一致 / tasks.png
  零 churn”合同，按 D5/D8 使用唯一 empty CTA，并更新旧 source/visual lock。
- **RFC-193–195**：保持近期页面的业务设计，只统一全局 shell、token、primitive 与入口接缝。
- **RFC-196**：保持 Skill ZIP 三阶段状态机；用 shared shell/split back 取代其临时手机 shell/back DOM，并迁移
  原 testid/focus/390px 合同，不能并存两个返回入口。
- **RFC-197**：其 Agent `agent.md` 三阶段导入、预览、读取隔离、结果与 feature CSS 为独占范围；本 RFC
  只提供已批准的全局 token/Dialog/Form 接缝，不修改 `AgentImportDialog` 任务流。
