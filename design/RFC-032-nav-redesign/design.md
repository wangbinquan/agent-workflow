# RFC-032 — 技术设计

## 1. 影响范围

| 改 | 不改 |
| --- | --- |
| `packages/frontend/src/routes/__root.tsx` 重写 shell 部分 | 路由 URL 表（所有现有 routes 保留） |
| `packages/frontend/src/routes/index.tsx` 替换 `<Navigate to="/agents">` 为 `<Homepage />` 渲染（保留 Onboarding 分支） | DB schema、所有后端表 |
| `packages/frontend/src/styles.css` `--- Shell ---` 段（重新组织：keep `.sidebar` 但加 nav-group / inbox-footer / settings-icon；删 chrome 主题按钮的 `.theme-toggle`） + 新加 `.homepage*` 段 | 后端 routes（不新增、不删除） |
| `packages/frontend/src/components/LanguageSwitch.tsx`：保留组件，位置不动 | shared 包（无需变更） |
| 新文件 `packages/frontend/src/components/shell/{NavGroup,InboxFooterButton,InboxDrawer,SettingsGearButton,RuntimeNavDot}.tsx` | i18n 现有 `nav.{agents,...}` 文本 |
| 新文件 `packages/frontend/src/components/home/{Homepage,HomepageGreeting,HomepageSection,RunningTaskList,InboxPreviewList,RecentlyDoneList}.tsx` | `Resources` 接口里现有 nav 字段保留 |
| 新文件 `packages/frontend/src/lib/nav.ts`（`resolveActiveNav` 纯函数）+ `lib/homepage.ts`（task list 拼装 / inbox merge 纯函数） | 现有测试（不重命名、不删除） |
| `packages/frontend/src/routes/settings.tsx` 加 `#runtime` hash 锚点高亮 | |
| `packages/frontend/src/i18n/{en-US,zh-CN}.ts` 增量加键 + `Resources` 接口同步 | |
| 新测试文件（见 §测试策略） | |

**0 backend / 0 shared / 0 DB migration**。纯前端工作。

## 2. 组件拆分

```
__root.tsx (RootComponent)
├── AppShell                  // 240px sidebar + content grid
│   ├── Sidebar
│   │   ├── Brand
│   │   ├── HomeLink          // 单条目，always 第一，active 时 accent 实底
│   │   ├── NavGroup × 3      // agents / workflows / tasks
│   │   │   └── NavItem × n   // 含 RuntimeNavDot 作为 agents 组最后一项
│   │   ├── InboxFooterButton // 自带 useQuery 合并 reviews + clarify count
│   │   └── SidebarFooter
│   │       ├── LanguageSwitch
│   │       └── SettingsGearButton
│   ├── <Outlet/>             // main content
│   └── InboxDrawer           // portal 渲染到 body；ESC / 点空白关闭
└── routes/index.tsx
    └── IndexPage
        ├── Onboarding        // isFirstRun 分支不变
        └── Homepage          // 新；非首次运行渲染
            ├── HomepageGreeting     // 问候 + 时间 + runtime status + 启动任务按钮
            ├── HomepageSection (running)
            │   └── RunningTaskList
            ├── HomepageSection (inbox)
            │   └── InboxPreviewList
            └── HomepageSection (recent)
                └── RecentlyDoneList
```

## 3. 导航数据模型

集中定义在新文件 `lib/nav.ts`：

```ts
export type GroupKey = 'agents' | 'workflows' | 'tasks'

export interface SubNavItem {
  to: string
  i18nKey: string
  /** 'capability' 视觉上挨在一起；'runtime' 前面会渲染一条 separator */
  variant?: 'capability' | 'runtime'
}

export interface NavGroupEntry {
  key: GroupKey
  i18nKey: string
  subnav: SubNavItem[]
}

export const NAV_GROUPS: NavGroupEntry[] = [
  {
    key: 'agents',
    i18nKey: 'nav.group.agents',
    subnav: [
      { to: '/agents',  i18nKey: 'nav.agents',  variant: 'capability' },
      { to: '/skills',  i18nKey: 'nav.skills',  variant: 'capability' },
      { to: '/mcps',    i18nKey: 'nav.mcps',    variant: 'capability' },
      { to: '/plugins', i18nKey: 'nav.plugins', variant: 'capability' },
      { to: '/runtime', i18nKey: 'nav.runtime', variant: 'runtime'    },
    ],
  },
  {
    key: 'workflows',
    i18nKey: 'nav.group.workflows',
    subnav: [{ to: '/workflows', i18nKey: 'nav.workflows' }],
  },
  {
    key: 'tasks',
    i18nKey: 'nav.group.tasks',
    subnav: [
      { to: '/tasks', i18nKey: 'nav.tasks' },
      { to: '/repos', i18nKey: 'nav.repos' },
    ],
  },
]

export interface ActiveNav {
  /** true ⇔ 当前在 `/`，首页 link active */
  onHome: boolean
  /** true ⇔ 当前在 `/settings*`，齿轮按钮 active；其他 nav 全 inactive */
  onSettings: boolean
  /** 当前命中的 group（onHome / onSettings 时为 null） */
  activeGroup: GroupKey | null
  /** 当前命中的二级条目 `to`，没命中则 null */
  activeItemTo: string | null
}

/**
 * 把 pathname 映射到导航 active 状态。
 *
 * 特殊处理：
 * - `/`：onHome = true，其他全 false。
 * - `/settings*`：onSettings = true，nav 全 inactive（侧栏齿轮按钮 active）。
 * - `/runtime`：伪 URL，与 `/settings#runtime` 等价；点击时 navigate 到后者，
 *   但 activeItemTo 由 hash 决定无法在纯函数判定 —— v1 取舍：落在 `/settings`
 *   下 `nav.runtime` 不 active，由 Settings 页 RuntimeCard 自身的 hash 闪烁
 *   提示用户。
 * - `/reviews` / `/clarify`：业务上属于"工作流人工介入"，但 v1 它们不在主导航
 *   里（只能从 inbox drawer 打开）；详情页落到这两个 URL 时让 activeGroup = 'workflows'，
 *   activeItemTo = null。
 */
export function resolveActiveNav(pathname: string): ActiveNav {
  if (pathname === '/') return { onHome: true, onSettings: false, activeGroup: null, activeItemTo: null }
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return { onHome: false, onSettings: true, activeGroup: null, activeItemTo: null }
  }
  if (pathname.startsWith('/reviews') || pathname.startsWith('/clarify')) {
    return { onHome: false, onSettings: false, activeGroup: 'workflows', activeItemTo: null }
  }
  for (const g of NAV_GROUPS) {
    for (const sub of g.subnav) {
      if (pathname === sub.to || pathname.startsWith(sub.to + '/')) {
        return { onHome: false, onSettings: false, activeGroup: g.key, activeItemTo: sub.to }
      }
    }
  }
  return { onHome: false, onSettings: false, activeGroup: null, activeItemTo: null }
}
```

### 3.1 关于 `/runtime` 伪 URL 与 settings hash 锚点

`/runtime` 仅作为 nav 数据模型里的占位；`<NavItem>` 渲染时拦截 click 并 `navigate('/settings#runtime')`。Settings 页对 `location.hash === '#runtime'` 做以下处理：

- `useEffect` 触发 `<RuntimeCard>` `ref.scrollIntoView({ behavior: 'smooth' })`
- 卡片加 `--flash` 类 2 秒（CSS keyframes 把背景从 accent 14% → transparent）
- 切回 `/settings` 无 hash 时不闪

## 4. 首页（Homepage）数据流

### 4.1 `routes/index.tsx` 改造

```ts
function IndexPage() {
  const probe = useOnboardingProbe()
  if (probe.isLoading) return <div className="page muted">{t('common.loading')}</div>
  if (probe.isFirstRun) return <Onboarding />
  return <Homepage />                              // ← 从 Navigate to /agents 改成这里
}
```

### 4.2 Homepage 顶部 greeting

`<HomepageGreeting />` 拉两件事：
- 当前时刻（`useState<Date>` + setInterval 1min refresh），文案 `home.greet.{morning, afternoon, evening}` 三态由 `hour` 决定。
- `useQuery<RuntimeProbe>({ queryKey: ['runtime','opencode','home'], queryFn: GET /api/runtime/opencode, staleTime: 30s, refetchInterval: 60s })`，渲染状态点 + 版本号；不可达时显示 grey dot + "checking…"。

右侧 "启动任务" 主按钮 = `<Link to="/workflows">`（与现有 launcher 入口一致）。

### 4.3 三个 section 各自的数据源

| Section | useQuery 描述 | 端点 |
| --- | --- | --- |
| 运行中 | `['tasks','homepage','running']` | `GET /api/tasks?status=running,awaiting_human&limit=8` （详见 §4.4） |
| 等你处理 | merge of `['reviews','homepage','pending']` + `['clarify','homepage','pending']` | 各自 list，前端 merge by updatedAt desc, slice(0,8) |
| 最近完成 | `['tasks','homepage','recent']` | `GET /api/tasks?status=done,failed,canceled,exhausted,interrupted&limit=8&order=updatedAt:desc` |

### 4.4 后端 `/api/tasks` 多状态查询

**先确认端点是否支持 status=A,B,C 多值**。预读 `packages/backend/src/routes/tasks.ts`：

- 若已支持：直接用。
- 若只支持单 status：在前端发 N 个 useQuery 并合并（成本极低，纯加性 fetch，无需后端改）。

设计层认定**前端合并**为兜底路径，避免本 RFC 阻塞于后端契约扩展。Owner 在实现时先 grep 决定走哪条。

### 4.5 错误 / 空态 / loading 兜底

| 场景 | 行为 |
| --- | --- |
| `/api/tasks` 列表 401（用户被踢下线） | onError 触发 auth-gate redirect 到 `/auth`（与现有 api client 行为一致） |
| `/api/tasks` 5xx | section 内显示 `<ErrorBanner>` + 重试按钮，不影响其他 section |
| 运行中为空 | 显示 `home.section.empty.running`："暂无运行中任务" + "启动任务 →" 链接 |
| 收件箱为空 | 显示 `home.section.empty.inbox`："当前没有等你处理的事项 ✓" |
| 最近完成为空 | 显示 `home.section.empty.recent`："还没有完成过任务" |
| Greeting runtime probe 失败 | 灰色 dot + "checking…"，可点击跳 `/settings#runtime` |

**留意**：本 RFC 不引入新的 `<EmptyState />` shared 组件（那是 RFC-035 的事）；v1 用 `<div className="muted">` + 文案模拟，与全站现状一致。

## 5. 失败模式

| 场景 | 行为 |
| ---- | ---- |
| `/api/runtime/opencode` 401 / 网络挂 | sidebar runtime dot 灰；homepage greeting runtime "checking…"；点击仍跳 /settings |
| `/api/reviews/pending-count` 挂 | inbox footer button 用 clarify count 作为兜底；drawer 评审 tab 显示 "加载失败 [重试]"；首页"等你处理" section 只显示 clarify |
| 两个 pending-count 都挂 | inbox footer button 不显示 badge（保留 button 本体）；drawer 内显示统一 empty/error 状态；首页"等你处理" section 显示 ErrorBanner |
| pathname 不在任何 group 里 | `resolveActiveNav` 返回全 false / null，所有 nav 不高亮（防御性） |
| 用户处于 `/`（首页）但 onboarding probe 还在 loading | 短暂渲染 `<div className="muted">{t('common.loading')}</div>`，不闪 navigate（保留现状） |

## 6. i18n key 变更

新增（zh-CN / en-US 同步）：

```ts
nav: {
  // 现有字段全保留（agents/skills/mcps/plugins/workflows/tasks/repos/settings/reviews/clarify/brand）
  home:    '首页'      / 'Home',
  group: {
    agents:    '代理'    / 'Agents',
    workflows: '工作流'  / 'Workflows',
    tasks:     '任务'    / 'Tasks',
  },
  runtime: '运行时'    / 'Runtime',
  settingsIcon: {
    label:   '设置'        / 'Settings',
    tooltip: '设置（含主题切换）' / 'Settings (incl. theme)',
  },
  inbox: {
    label:     '收件箱'  / 'Inbox',
    tabAll:    '全部'    / 'All',
    tabReviews:'评审'    / 'Reviews',
    tabClarify:'反问'    / 'Clarify',
    empty:     '当前没有待处理事项' / 'Nothing waiting for you',
  },
},
home: {
  greet: {
    morning:   '早上好，{{name}}' / 'Good morning, {{name}}',
    afternoon: '下午好，{{name}}' / 'Good afternoon, {{name}}',
    evening:   '晚上好，{{name}}' / 'Good evening, {{name}}',
  },
  date:        '{{date}} {{weekday}} {{time}}' / same pattern,
  startTask:   '启动任务' / 'Start task',
  runtimeReady: 'opencode v{{version}} · ready' / same,
  runtimeChecking: '检查中…' / 'checking…',
  runtimeMissing: '未找到 opencode' / 'opencode not found',
  section: {
    running:   '运行中'       / 'Running',
    inbox:     '等你处理'     / 'Waiting on you',
    recent:    '最近完成'     / 'Recently finished',
    viewAll:   '查看全部 →'   / 'View all →',
    openInbox: '打开收件箱 →' / 'Open inbox →',
    viewTasks: '查看任务列表 →' / 'View tasks →',
    empty: {
      running: '暂无运行中任务'             / 'No running tasks',
      inbox:   '当前没有等你处理的事项 ✓' / 'Nothing waiting for you ✓',
      recent:  '还没有完成过任务'           / 'No finished tasks yet',
    },
    error: {
      generic: '加载失败' / 'Load failed',
      retry:   '重试'     / 'Retry',
    },
  },
  taskRow: {
    stepProgress: 'step {{current}} / {{total}} · {{nodeName}}' / same,
    relativeJustNow: '刚刚' / 'just now',
    relativeMinAgo:  '{{n}} 分钟前' / '{{n}} min ago',
    // ... 其他相对时间可以从已有 i18n 复用，看现有 helper
  },
},
```

**`Resources` 接口必须同步更新**（编译期类型检查）。

## 7. 与已落地 RFC 的兼容性

- **RFC-005（reviews） / RFC-023（clarify）**：badge 仍由这俩 RFC 的 pending-count 端点驱动，UI 位置从两个独立侧栏条目合并到 footer button + drawer。reviews 详情页 / clarify 详情页内部不变。Homepage "等你处理" 区调用相同的 list 端点。
- **RFC-025（language switch）**：`LanguageSwitch` 实例位置**不变**，仍在 `.sidebar__footer`；齿轮按钮加在它旁边；组件内部逻辑零改。
- **RFC-001（runtime probe）**：runtime 信号在三处复用 `/api/runtime/opencode`：sidebar runtime nav item、homepage greeting、Settings RuntimeCard。三处用**独立 query keys**（避免联动 refetch）：`['runtime','opencode','sidebar' | 'home' | 'settings']`。
- **P-5-10 Onboarding（首次运行）**：完全保留；`useOnboardingProbe` 不动，分支逻辑只是把 navigate 替换成 `<Homepage />`。
- **RFC-035（UX 一致性）**：本 RFC 引入新的 task-row / inbox-row / status chip 复用现有 `.status-chip` 体系；待 RFC-035 抽出 `<StatusChip />` shared 组件时，本 RFC 的 task/inbox row 一并迁移过去（这是 RFC-035 的工作，不在本 RFC PR 范围内）。

## 8. 测试策略

按 CLAUDE.md "Test-with-every-change"：每次 commit 必带覆盖该 commit 改动的测试。

### 8.1 纯函数（Vitest）

`packages/frontend/src/lib/nav.test.ts`：

- `resolveActiveNav('/')` → `{onHome:true, onSettings:false, activeGroup:null, activeItemTo:null}`
- `resolveActiveNav('/agents')` / `/agents/abc` → `activeGroup:'agents', activeItemTo:'/agents'`
- `resolveActiveNav('/skills')` / `/mcps` / `/plugins` → `activeGroup:'agents'`
- `resolveActiveNav('/workflows/edit/x')` → `activeGroup:'workflows'`
- `resolveActiveNav('/tasks/y')` / `/repos` → `activeGroup:'tasks'`
- `resolveActiveNav('/reviews/abc')` / `/clarify/xyz` → `activeGroup:'workflows', activeItemTo:null`
- `resolveActiveNav('/settings')` / `/settings/foo` → `onSettings:true, activeGroup:null`
- `resolveActiveNav('/random-unknown')` → 全 false / null

`packages/frontend/src/lib/homepage.test.ts`：

- `mergeInboxItems([], [])` → `[]`
- `mergeInboxItems(reviewsFixture, clarifyFixture)` → 按 updatedAt desc + slice(0,8)
- `pickGreetingKey(new Date('2026-05-18T03:00:00'))` → `'morning'`
- `pickGreetingKey(...)` 边界 06/12/18 三态
- `formatRelativeTime(now, 1min ago)` → `'1 分钟前'` / `'just now'` 边界

### 8.2 组件单测（Vitest + RTL）

`packages/frontend/tests/inbox-footer-button.test.tsx`：

- 两个 pending-count 都返回 3 → button badge 显示 `6`
- reviews=0, clarify=0 → button 不渲染 badge
- pending-count 报错 → button 仍渲染但无 badge，不抛
- count > 99 → 显示 `99+`（与现有 sidebar badge 行为一致）

`packages/frontend/tests/inbox-drawer.test.tsx`：

- 默认关闭；点 button 后渲染 drawer
- ESC 关闭；点外部关闭；点项不关闭
- 三 segmented 切换正确过滤 reviews / clarify
- mock list 端点 → drawer 渲染列表项 + 点击跳路由

`packages/frontend/tests/runtime-nav-dot.test.tsx`：

- `compatible:true, version:'0.13.2'` → 绿点 + ready tooltip
- `compatible:false, version:'0.10.0', minVersion:'0.12.0'` → 灰点 + incompatible tooltip
- `binary:null` → 红点 + missing tooltip
- query loading → 黄点 + checking tooltip

`packages/frontend/tests/settings-gear-button.test.tsx`：

- 默认渲染齿轮 SVG + aria-label
- `onSettings:true` → 按钮有 `aria-current="page"` + `--active` 类
- 点击触发 router navigate 到 `/settings`

`packages/frontend/tests/homepage.test.tsx`：

- mock 三个 useQuery 返回 fixture → 三个 section 都渲染 + 数量 badge
- mock 运行中为空 → 显示 `home.section.empty.running`
- mock 收件箱为空 → 显示 `home.section.empty.inbox`
- mock greeting hour=10 → 渲染 `home.greet.morning` 文案
- mock greeting hour=20 → 渲染 `home.greet.evening` 文案

`packages/frontend/tests/index-page-routing.test.tsx`：

- `isFirstRun:true` → 渲染 `<Onboarding />`，断言 DOM 含 onboarding 卡片关键文案
- `isFirstRun:false` → 渲染 `<Homepage />`，断言 DOM 含 `home.section.running` 文案
- 断言：**不**渲染 `<Navigate />` 到 `/agents`（源代码层 grep `routes/index.tsx` 不含 `Navigate.*agents`）

### 8.3 源代码层兜底

`packages/frontend/tests/shell-no-theme-toggle.test.ts`：

- `__root.tsx` 不含字符串 `toggleTheme` / `ThemeToggle`
- `Homepage*.tsx` 同上
- `styles.css` 仍保留主题切换相关变量（`useApplyTheme` 钩子依赖），但 `.theme-toggle` 类（如果原本存在）需删除

`packages/frontend/tests/shell-nav-wiring.test.ts`：

- `__root.tsx` 引用 `NavGroup` / `InboxFooterButton` / `SettingsGearButton`
- `__root.tsx` **不**引用 `.sidebar__link`（除非保留作 fallback；v1 选择保留以便 inspector 等组件复用）
- `routes/index.tsx` 引用 `Homepage` + 保留 `useOnboardingProbe` / `Onboarding`

### 8.4 Playwright e2e

`packages/frontend/tests-e2e/nav-redesign.spec.ts`：

1. happy path：登录后默认进 `/` → 渲染 Homepage（断言"运行中"标题存在）→ 点侧栏"代理"组下"技能" → URL 变 `/skills` 且二级 active 高亮、一级 agents 组高亮。
2. inbox：mock 两端点 count=2/3 → footer button badge 显示 "5" → 点 button → drawer 显示 5 项 → 点评审 segmented → 列表过滤为 2 项 → 点列表项 → URL 跳 `/reviews/xxx`，drawer 仍开。
3. runtime：mock `/api/runtime/opencode` 返回 incompatible → 侧栏 runtime dot 灰 → 点击 → URL 跳 `/settings#runtime` 且 Runtime 卡片背景闪一次。
4. settings gear：从 `/` 点 footer 齿轮 → URL 跳 `/settings`、齿轮按钮加 active 描边；点 "工作流" 切回 → 齿轮 inactive。
5. auth gate：未登录访问 `/agents` → 跳 `/auth`，无 sidebar。
6. onboarding：mock first-run probe → `/` 渲染 onboarding 卡片，无 homepage section。
7. homepage：mock probe non-first-run + 三个数据源 → `/` 渲染 Homepage 三个 section。

### 8.5 回归命名

测试文件 / describe 标题里写明锁的是哪类回归：

```ts
describe('RFC-032 resolveActiveNav — locks /reviews + /clarify mapping to activeGroup workflows (RFC-005 / RFC-023 badge merge)', ...)
describe('RFC-032 homepage — locks `/` non-first-run renders dashboard instead of Navigate to /agents (P-5-10 onboarding kept intact)', ...)
```

### 8.6 运行门槛

`bun run typecheck && bun run test && bun run format:check` 全绿才能 push。GitHub Actions 同跑此三项 + Playwright e2e。按 `feedback_post_commit_ci_check` push 后立刻查 CI。

## 9. 实现顺序与 PR 拆分

见 [plan.md](./plan.md)。

## 10. 与替代方案的本子之外注解

- 用户曾在中途说"是否能同时支持两种 layout"，**未采纳**。理由：双 shell 维护成本翻倍，对小工具而言不值（详见 mockup 讨论历史）。
- 用户曾在中途从 layout-b（顶栏）切回 layout-a（侧栏），**已对齐**。
- 用户决定主题切换归 settings，**已对齐**（chrome 不留主题按钮）。
- 用户决定首页用 homepage-a 任务驱动，**已对齐**（homepage-b/c 保留作历史）。
