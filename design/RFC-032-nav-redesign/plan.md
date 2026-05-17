# RFC-032 — 任务分解

按 design.md §9 拆 3 个 PR，每个 PR 自带测试 + 可独立回退。

## PR1 — Shell 重构（分组侧栏 + RuntimeNavDot + SettingsGear + 删主题按钮）

| ID | 子任务 | 依赖 |
| --- | --- | --- |
| RFC-032-T1 | 新建 `packages/frontend/src/lib/nav.ts`：`NAV_GROUPS` 常量 + `resolveActiveNav` 纯函数 + 类型定义 | — |
| RFC-032-T2 | 新建 `packages/frontend/src/lib/nav.test.ts`：覆盖 design.md §8.1 全部 case | T1 |
| RFC-032-T3 | i18n：`zh-CN.ts` / `en-US.ts` 加 `nav.home` / `nav.group.{agents,workflows,tasks}` / `nav.runtime` / `nav.settingsIcon.{label,tooltip}` 键 + `Resources` 接口同步 | — |
| RFC-032-T4 | 新组件 `components/shell/NavGroup.tsx` + `NavItem` 内联子组件：消费 `NAV_GROUPS` + `resolveActiveNav` + `useTranslation` | T1, T3 |
| RFC-032-T5 | 新组件 `components/shell/RuntimeNavDot.tsx`：发 `/api/runtime/opencode` query（key `['runtime','opencode','sidebar']`，staleTime 30s），4 态 dot + tooltip + 嵌入 NavItem `/runtime` 行右侧 | T3 |
| RFC-032-T6 | 新组件 `components/shell/SettingsGearButton.tsx`：齿轮 icon-button + `aria-label = t('nav.settingsIcon.label')` + `aria-current="page"` 当 onSettings 真 + 点击 `navigate('/settings')` | T3 |
| RFC-032-T7 | `__root.tsx` 重写：保留 auth gate + bare shell，登录态换成 `<Brand/> <HomeLink/> <NavGroup×3/> <InboxFooterPlaceholder/> <SidebarFooter><LanguageSwitch/><SettingsGearButton/></SidebarFooter>`；删主题按钮；PR1 阶段 inbox 入口暂为 placeholder（评审 / 反问还挂在 "工作流" 组作为子条目，PR2 删掉） | T4, T5, T6 |
| RFC-032-T8 | `styles.css`：保留 `.sidebar*` 但加 `.nav-group{,__header,__chevron}` / `.nav-item{,--top,--home,--active}` / `.nav-runtime-dot` / `.settings-gear{,--active}` 新样式；删 `.theme-toggle` 类 + 其调用点（如有）；加 dark 主题覆盖 | T7 |
| RFC-032-T9 | Settings 页加 `#runtime` hash 锚点高亮：runtime 卡片在 `location.hash === '#runtime'` 时背景闪 2s（CSS animation + `useEffect` 设 timeout） | — |
| RFC-032-T10 | 新测试 `tests/runtime-nav-dot.test.tsx`：design.md §8.2 四态断言 | T5 |
| RFC-032-T11 | 新测试 `tests/settings-gear-button.test.tsx`：默认 / active / 点击三态 | T6 |
| RFC-032-T12 | 新测试 `tests/shell-no-theme-toggle.test.ts` + `shell-nav-wiring.test.ts`：design.md §8.3 源代码层兜底 | T7, T8 |
| RFC-032-T13 | Playwright e2e `tests-e2e/nav-redesign.spec.ts` 第 1 + 4 + 5 条 case（happy path + settings gear + auth gate） | T7 |
| RFC-032-T14 | `bun run typecheck && bun run test && bun run format:check` 全绿 → push → 查 CI（按 feedback_post_commit_ci_check） | all above |

**PR1 验收**：
- 侧栏 3 组 + footer 齿轮在各路由下高亮正确；
- 右上齿轮在 `/settings` 下 active，其他路由 inactive；
- runtime nav dot 4 种 daemon 状态都有视觉反馈；
- chrome DOM 不再有主题切换按钮（grep 锁）；
- 所有现有 e2e（特别是 review / clarify / agent crud / settings appearance theme）仍 pass。

## PR2 — Inbox 合并

| ID | 子任务 | 依赖 |
| --- | --- | --- |
| RFC-032-T15 | i18n：加 `nav.inbox.{label,tabAll,tabReviews,tabClarify,empty}` 键 + `Resources` 同步 | PR1 落地 |
| RFC-032-T16 | 新组件 `components/shell/InboxFooterButton.tsx`：合并两 `useQuery` 算总和；count=0 不渲染 badge；count>99 显 `99+` | T15 |
| RFC-032-T17 | 新组件 `components/shell/InboxDrawer.tsx`：portal 渲染到 body；segmented 切换；列表项点击跳详情；ESC / outside-click 关闭；初始焦点到首 segmented | T15 |
| RFC-032-T18 | `__root.tsx`：把 PR1 阶段挂在 "工作流" 子导航下的 `/reviews` `/clarify` placeholder 移除；`NAV_GROUPS` 改回 design.md §3 终态（工作流子导航只剩 1 项）；插入 `<InboxFooterButton/>` 在 SidebarFooter 之上；维护 drawer open 状态（lift state 到 root） | T16, T17 |
| RFC-032-T19 | 单测 `tests/inbox-footer-button.test.tsx`：design.md §8.2 全部 case | T16 |
| RFC-032-T20 | 单测 `tests/inbox-drawer.test.tsx`：design.md §8.2 全部 case + ESC / outside click | T17 |
| RFC-032-T21 | `nav.test.ts` 更新 `/reviews` / `/clarify` 的归属断言（design §3 已经定义为 `activeGroup:'workflows', activeItemTo:null`） | T18 |
| RFC-032-T22 | Playwright e2e 第 2 条 case（inbox flow） | T18 |
| RFC-032-T23 | typecheck / test / format / push / CI 查 | all above |

**PR2 验收**：
- inbox footer button 合并 count 准确（手测 + e2e）；
- drawer 三段过滤、ESC、外部点击、列表点击跳转都符合预期；
- reviews / clarify 详情页本身行为零回归。

## PR3 — 首页（Homepage 任务驱动仪表盘）

| ID | 子任务 | 依赖 |
| --- | --- | --- |
| RFC-032-T24 | i18n：加 `home.*` 系列键（greet × 3 / date / startTask / runtime{Ready,Checking,Missing} / section.*  / section.empty.* / section.error.* / taskRow.*）+ `Resources` 同步 | PR2 落地 |
| RFC-032-T25 | 新文件 `lib/homepage.ts`：`mergeInboxItems` / `pickGreetingKey` / `formatRelativeTime` 纯函数 | T24 |
| RFC-032-T26 | `lib/homepage.test.ts`：design.md §8.1 后半段断言 | T25 |
| RFC-032-T27 | 新组件 `components/home/HomepageGreeting.tsx`：问候 + 时间 + runtime status + 启动任务按钮（runtime 用 query key `['runtime','opencode','home']`） | T24, T25 |
| RFC-032-T28 | 新组件 `components/home/HomepageSection.tsx`：通用 wrapper，传 title / count / variant / linkLabel / linkTo / children | T24 |
| RFC-032-T29 | 新组件 `components/home/RunningTaskList.tsx`：useQuery 运行中 + awaiting 任务，按 design.md §4.4 决定走单端点多 status 还是前端合并 N 个 query；空 / error / loading 兜底 | T28 |
| RFC-032-T30 | 新组件 `components/home/InboxPreviewList.tsx`：merge reviews + clarify pending 列表 → mergeInboxItems → 渲染 8 项；点击 → router navigate + 调侧栏 inbox drawer 同一 store 状态打开 drawer（**或 v1 简化**：仅 router navigate，不联动 drawer） | T28, T25 |
| RFC-032-T31 | 新组件 `components/home/RecentlyDoneList.tsx`：useQuery 已完成任务，渲染 8 项 | T28 |
| RFC-032-T32 | 新组件 `components/home/Homepage.tsx`：组装 greeting + 3 sections | T27, T29, T30, T31 |
| RFC-032-T33 | `routes/index.tsx` 改造：`isFirstRun` 分支保留 Onboarding；否则 `<Homepage />`（删 `<Navigate to="/agents">`） | T32 |
| RFC-032-T34 | `styles.css` 加 `.homepage{,__greet,__greet-title,__greet-date}` / `.homepage-section{,__head,__title,__count,__link}` / `.task-row{,__id,__name,__meta,__status}` / `.inbox-row{,__text,__meta}` / `.status--running/--awaiting/--done/--failed` + dark 主题覆盖 | T33 |
| RFC-032-T35 | 单测 `tests/homepage.test.tsx` + `tests/index-page-routing.test.tsx`：design.md §8.2 全部 case，含源码层 grep 锁 `<Navigate.*agents`  已不存在 | T33 |
| RFC-032-T36 | Playwright e2e 第 3 + 6 + 7 条 case（runtime → settings#runtime / onboarding / homepage 三 section） | T33 |
| RFC-032-T37 | typecheck / test / format / push / CI 查 | all above |

**PR3 验收**：
- `/` 在非首次运行下渲染 Homepage 三个 section；
- 首次运行下仍渲染 Onboarding（P-5-10 不破）；
- "等你处理" section 与侧栏 inbox footer button 数字一致；
- 点击行可跳详情（reviews / clarify / tasks 三类路由）；
- runtime greeting 状态与侧栏 runtime nav dot 一致；
- 所有 e2e（含 onboarding）仍 pass。

## RFC 完工标准

- 3 PR 全部 merged 到 main；
- CI 在 main 上至少跑过一次绿（含 e2e）；
- `design/plan.md` RFC 索引把 RFC-032 改 `Done`；
- `STATE.md` 已完成 RFC 表加 RFC-032 一行；
- 旧 sidebar 截图存档不留。

## 不在本 RFC 范围内的（写出来防止 scope creep）

- 移动端响应式 / 折叠菜单（<768px）。
- 用户偏好（"我永远想看见 inbox 展开" / 首页 widget 自定义顺序）持久化。
- 真合并后端 `/api/inbox/pending-count` 端点。
- `/runtime` 独立路由 / 独立页面。
- 顶栏快捷键完整 cheatsheet 弹窗。
- 首页 WebSocket 实时刷新（v1 用 `refetchInterval` 轮询）。
- 任何 UX 标准件抽出（StatusChip / Dialog / EmptyState / DetailLayout / Form 推广）—— 由 RFC-035 处理。

以上若有需要，开 follow-up RFC。
