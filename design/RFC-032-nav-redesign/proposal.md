# RFC-032 — 导航重构 + 任务驱动首页

> **Mockup 参考**：
>
> 外壳：
>
> - [`mockups/layout-a.html`](./mockups/layout-a.html) —— **采纳方案**：分组侧栏（3 业务组：代理 / 工作流 / 任务）+ footer 全局收件箱 + footer 语言切换 + footer 齿轮设置。
> - [`mockups/layout-b.html`](./mockups/layout-b.html) —— 备选（**未采纳**）：顶栏 tab + 子导航 + 浮窗收件箱 + 右上齿轮。保留作历史对照。
>
> 首页（`/` 路由）：
>
> - [`mockups/homepage-a.html`](./mockups/homepage-a.html) —— **采纳方案**：任务驱动仪表盘（运行中 / 等你处理 / 最近完成 三段 + 启动任务按钮）。
> - [`mockups/homepage-b.html`](./mockups/homepage-b.html) —— 备选（**未采纳**）：资源驱动仪表盘（4 张资源卡 + runtime 大状态条）。保留作历史对照。
> - [`mockups/homepage-c.html`](./mockups/homepage-c.html) —— 备选（**未采纳**）：混合仪表盘（任务 + 资源 side-by-side）。保留作历史对照。
>
> 5 份 mockup 浏览器直接 open 即可看；主题切换在 chrome 中**已不存在**（demo 文件保留 `toggleTheme()` 函数以便 console 调用）。

## 背景

当前外壳与首页两个问题：

### 外壳

侧栏是**10 项平铺**的扁平结构（代理 · 技能 · MCP · 插件 · 工作流 · 任务 · 评审 · 反问 · 远端仓 · 设置），新用户看到这十项无法立刻分辨"哪些是同类、谁服务谁、什么时候该用谁"：

1. **技能 / MCP / 插件本质上是代理的能力包**（dependsOn 闭包后注入到 opencode 子进程），但侧栏把它们摆成并列业务对象，让新人误以为是三个独立的产品。
2. **评审 / 反问都是"工作流卡住等人介入"**，是同一类心智事件（GitHub Notifications 风格），却拆成两个独立入口、两个独立 badge，新人看不出它们的共性。
3. **远端仓是任务运行的环境**（task worktree 的源），但作为顶级条目和"任务"并列，让人以为是某个一级业务。
4. **运行时**（opencode 二进制 + 版本）是代理跑起来的算力提供方，目前藏在 Settings → Runtime 卡片里，新人不知道它存在；侧栏也没有 daemon 健康度信号。
5. **设置不是业务一级**，但目前与代理 / 工作流 / 任务 / 评审等业务条目同级排在中间，加剧了"10 项无章法"的认知负担。

### 首页

`/` 路由**没有真正意义上的首页**：当前 `routes/index.tsx` 的逻辑是「首次运行展示 Onboarding，否则 `<Navigate to="/agents" replace />`」。结果是：

- **空环境**：跳 Onboarding（OK）。
- **非空环境**：直接重定向到代理列表页——这让"代理"被强行变成事实上的首页，但代理列表对运营态用户而言信息密度低（多数时候用户其实想知道"现在有什么在跑 / 有什么等我处理"），也不能在第一屏提供 runtime 健康度信号 / 快捷动作。

## 目标

**外壳**——让新用户**第一眼就看出心智结构**：

- 侧栏按**3 个业务心智组**纵向排列：**代理 · 工作流 · 任务**，每组带分隔标题，新人扫一眼就能映射到产品主流程。
- 每组下面的二级条目讲清"谁服务谁"：代理组下面是"代理 / 它的能力（技能 / MCP / 插件）/ 它的算力（运行时）"；任务组下面是"任务 / 任务的执行环境（远端仓）"。
- **评审 + 反问 合并成一个全局收件箱**入口，常驻侧栏底部 footer 区，单一红点 = 单一行动信号。
- **运行时**作为代理组下的一个特殊二级项（前置 `·` 分隔与能力子项区分），右侧带 daemon 状态颜色点（绿/灰/红/黄），点击跳 `/settings#runtime`。
- **设置移到 footer 区**作为齿轮图标按钮，与语言切换并列。**主题切换从 chrome 移除**——`/settings → Appearance` 是唯一切换主题入口（与现有 RFC-001 / RFC-025 Appearance tab 一致）。

**首页**——给登录后的非空环境用户一个**任务驱动仪表盘**：

- 顶部问候 + 当前时间 + opencode runtime 状态行内显示（无需绕到 settings 看版本）；右侧大号"启动任务"按钮。
- **运行中** section：列出 `status=running` 与 `awaiting_human` 的任务（最多 N 项，按 updatedAt desc）；每行展示 task id / 工作流名 / step 进度 / 状态 chip / 相对时间。"查看全部 →" 跳 `/tasks`。
- **等你处理** section：合并 reviews + clarify pending 列表（最多 N 项），每行展示类型 tag（评审 / 反问）+ 简短文案 + 来源（task / 节点）+ 相对时间 + "处理 →" 链接。"打开收件箱 →" 即触发侧栏 inbox drawer 同款。
- **最近完成** section：列出最近 N 个 `status ∈ {done, failed, canceled}` 的任务，让用户能快速回顾。
- 空环境（onboarding）路径完全保留，**不破坏 RFC-005 / P-5-10 现有 Onboarding 体验**。

**通用约束**：

- 不引入新的后端 / DB 改动；URL 路由保留（书签和 e2e 不破）。
- 不动现有页面内部布局（agents 列表 / workflow editor / task detail / review detail / settings 等保持现状）；UX 一致化由 [RFC-035](../RFC-035-ux-consistency/proposal.md) 独立处理（已立 stub，背景参考 `design/ux-audit.md`）。

## 非目标

- 不重构内部页面布局（属于 RFC-035 范围）。
- 不合并 reviews 与 clarify 的 DB 表 / API；只在前端把它们组合成一个"收件箱"视图。
- 不引入移动端响应式布局；目标分辨率仍是 ≥1280px 桌面。
- 不做用户偏好（"折叠某分组 / 永远展开收件箱 / 首页自定义模块顺序"）持久化；v1 用默认布局。
- 不动现有侧栏 brand SVG 的视觉。
- 不引入第二套 shell（顶栏方案）作为可选；理由见 §与替代方案对比。
- 首页**不**做实时跑动画 / WebSocket 推送：v1 用 `useQuery(refetchInterval: 10s)` 轮询足够；如需进一步实时化作为 follow-up。
- 首页**不**做用户自定义 widget / 拖拽布局：v1 模块固定顺序。
- 不引入新的"通知中心"概念：收件箱 = reviews + clarify 合并，不再扩展为 task error 通知 / runtime 告警等（这些走 settings / task detail 的固有路径）。

## 用户故事

外壳：

- **作为一个刚装完 daemon 的新用户**，我希望左侧栏一眼分出 3 个业务组让我知道平台主流程是 "配代理→画工作流→跑任务"，而不是面对 10 个看上去同级的入口陷入选择困难。
- **作为一个正在排查代理跑不起来的用户**，我希望左侧"代理 → 运行时"条目右边有个颜色点告诉我 daemon 是不是 ready，点进去能直接看到版本号。
- **作为一个被 workflow 反问 / 评审卡住的用户**，我希望左下角红点告诉我有多少件事在等我，点一下能直接进收件箱处理。
- **作为一个绑定能力的用户**，我希望"技能 / MCP / 插件"都明确归在代理组下面，告诉我"这些都是挂到代理身上的"。
- **作为一个老用户**，我打的旧书签（`/skills`, `/reviews/{id}` 等）仍能直接跳到对应页，不被改版破坏。
- **作为一个想换深色模式的用户**，我去 `/settings → Appearance` 一次性切换主题；chrome 不再保留主题按钮占位。

首页：

- **作为一个早上回来打开网页的用户**，我希望 `/` 直接告诉我"昨晚跑的任务还有 3 个在跑、12 件事等我处理、5 个已经完成"，而不是被默认丢到代理列表。
- **作为一个被反问卡住的用户**，我希望首页"等你处理"区域里点一下就能直接进入对应反问的处理界面，不用先去 `/clarify` 列表找。
- **作为一个想启动新任务的用户**，我希望首页右上角永远有一个"启动任务"按钮，不需要去工作流列表再点"启动"。
- **作为一个排查 daemon 异常的用户**，我希望首页顶部的问候语旁边就能看到 `● opencode v0.13.2`，知道 daemon 是健康的。

## 验收标准

外壳布局：

1. 侧栏宽 240px，垂直自上而下：brand → "首页" 单条目（active 时 accent 实底） → 3 个 nav-group（代理 / 工作流 / 任务，每组带 11px 大写小标题 + 一个 `▾` 占位 chevron 仅作视觉锚，**v1 不做实际折叠**）→ `margin-top:auto` 推开 → 收件箱 footer button → 底部 footer 行（语言切换 + 齿轮设置）。
2. 三个组的二级条目（v1 固定）：
   - **代理 · Agents**：代理 / 技能 / MCP / 插件 / 运行时（运行时前用一条浅色横线视觉分隔，表明它是"算力"而非"能力"）
   - **工作流 · Workflows**：工作流（仅一项；分组标题仍渲染，未来扩展时位置已留好）
   - **任务 · Tasks**：任务 / 远端仓
3. 每个二级条目高 ~32px，hover 时 accent 12% 浅底；active 时 accent 实底 + 白字。
4. 运行时条目右侧追加 daemon 状态颜色点（绿=ready / 黄=未探测过 / 红=connect-failed / 灰=版本低于最低门槛）；hover tooltip 显示版本号。
5. footer button：`📨 收件箱 [N]`，N = `reviews/pending-count` + `clarify/pending-count` 之和；N=0 时不显示 badge（保留 button 本体）。
6. footer 一行：左侧 LanguageSwitch（保留 RFC-025 现状）→ 右侧齿轮 icon button。齿轮按钮点击跳 `/settings`；落在 `/settings` 路由下时按钮加 `--active` 描边（accent 色）。
7. **chrome 中不再有主题切换按钮**。Settings → Appearance tab 是唯一的主题切换位置，`useApplyTheme` 钩子继续生效。

收件箱 drawer：

8. 点击 footer button 弹出**右侧浮窗 drawer**（≤360px 宽，绝对定位于 sidebar 右边缘外），不影响主内容；drawer 内含三个 segmented：全部 / 评审 / 反问；列表项点击跳转到对应 `/reviews/{id}` 或 `/clarify/{id}` 详情页。
9. drawer 用 ESC 键 / 点空白处关闭；浏览路由变化时不自动关闭（用户可一边浏览一边对照清单）。

首页 `/` 行为：

10. 首次运行 / 空环境（`useOnboardingProbe().isFirstRun === true`）：保留现有 Onboarding 卡片，**完全不变**。
11. 非首次运行：渲染 `<Homepage />` 仪表盘，**不再 `<Navigate to="/agents" />`**。
12. Homepage 渲染：
    - 顶部 `<HomepageGreeting />`：问候语 + 当前日期时间 + runtime 状态行内显示 + 右侧 "启动任务" 主按钮（跳 `/workflows`，匹配现有 launcher 入口）。
    - `<HomepageSection title="运行中" count=…>`：list `status ∈ {running, awaiting_human}` 任务（limit 8）；空态显示 "暂无运行中任务"。
    - `<HomepageSection title="等你处理" count=… --warn>`：merge reviews(pending) + clarify(pending) 列表 sort by updatedAt desc（limit 8）；count 用 warn 色（橙）。
    - `<HomepageSection title="最近完成" count=…>`：list `status ∈ {done, failed, canceled, exhausted, interrupted}` 任务（limit 8 by updatedAt desc）。
13. 每段 section 右上 "查看全部 / 打开收件箱 / 查看任务列表 →" 链接：分别跳 `/tasks?status=running` / 触发侧栏 inbox drawer / `/tasks?status=done`。

路由 / i18n：

14. 现有所有路由 URL 保留（`/agents`, `/skills`, `/mcps`, `/plugins`, `/workflows`, `/tasks`, `/reviews`, `/clarify`, `/repos`, `/settings`），书签不破。新增 / 是新行为（非新 URL）。
15. i18n 新增的键有清晰命名空间 `nav.group.{agents,workflows,tasks}` / `nav.home` / `nav.inbox.*` / `nav.runtime.*` / `nav.settingsIcon.*` / `home.greet.*` / `home.section.*` / `home.runtime.*` / `home.startTask`；现有 `nav.{agents,skills,...}` 文案保留作为子条目 label。

收尾 / 守卫：

16. 一级 / 二级 active 状态由**纯函数 `resolveActiveNav(pathname)`** 决定（不依赖 router 内部 state），便于单测覆盖每条路由的归属。
17. Playwright e2e：依次验证「点代理组下"技能" → URL 变 `/skills` 且 active 高亮」「点收件箱 footer button → drawer 弹出并显示合并 count」「点运行时条目 → 跳 `/settings#runtime`」「点齿轮 → 跳 `/settings` 且齿轮按钮加 active 描边」「未登录访问 `/agents` → 跳 `/auth`」「首次运行 `/` → 渲染 Onboarding」「非首次运行 `/` → 渲染仪表盘（断言"运行中" / "等你处理" / "最近完成" 三个 section 都存在）」七条核心 happy path。
18. 主题切换：Playwright e2e 进 `/settings → Appearance` 切换主题正常生效，**chrome DOM 不存在主题切换按钮**（源代码层 grep 守卫 `__root.tsx` / `Homepage*.tsx` 不含 `toggleTheme` / `ThemeToggle`）。
19. 回归：`app-shell--bare`（`/auth` 未登录态）行为字面保留；主题切换在 `/auth` 页也走 `useApplyTheme` 自动应用。

## 与替代方案对比

外壳 layout-a vs layout-b 的对比表（来自先前 mockup 讨论）：

| 维度 | layout-a 分组侧栏（采纳） | layout-b 顶栏 tab（未采纳） |
| --- | --- | --- |
| 第一眼心智识别 | 3 组标题直接呈现层级，新人扫一眼能映射主流程 | 3 个一级 tab 文字简短，子导航条要点过去才出现 |
| 占用屏幕空间 | 左侧 240px 固定 | 顶部 56 + 44 = 100px（在 settings 页消失为 56） |
| 收件箱位置 | footer button（侧栏内常驻可视） | 顶栏右上 chip（更接近 GitHub/Linear 习惯） |
| 二级导航发现成本 | 全部展开可见 | 只看到当前一级的子项 |

最终选择 layout-a 的核心理由：**新用户引导能力强**——3 组标题本身是文档。

首页 homepage-a vs b vs c：

| 维度 | A 任务驱动（采纳） | B 资源驱动 | C 混合 |
| --- | --- | --- | --- |
| 适用阶段 | 日常运营态 | 项目早期 / 环境搭建期 | 老用户 / 信息密度高 |
| 第一屏聚焦 | 我现在要处理什么 | 我有什么资产 | 任务 + 资产 side-by-side |
| 实现复杂度 | 中（3 个 useQuery） | 低（4 个 count 查询） | 高（A + B 合体） |
| 信息密度 | 中 | 低 | 高 |
| 与侧栏冗余 | 低（任务/收件箱在主区有详情） | 高（资源 count 与侧栏对象重叠） | 中 |

选 A 理由：**与侧栏分组互补**——侧栏告诉用户"有什么类型的对象"，首页告诉用户"现在哪些对象在动 / 等你"。B 跟侧栏在"资产清单"维度重叠（侧栏点开就能看 count）。C 信息密度过高，对新用户不友好。

## 与其他 RFC 的关系

- 不依赖任何进行中的 RFC（RFC-029 / RFC-030 / RFC-031 都是 task runner / inventory / plugin 路径，与外壳无关）。
- 与已落地 RFC-005（reviews badge）、RFC-023（clarify badge）兼容：本 RFC **复用**它们的 `/api/reviews/pending-count` 与 `/api/clarify/pending-count` 端点 + 详情列表端点（reviews list + clarify list），不删不改后端。
- **RFC-025（language switch）**：`LanguageSwitch` 组件位置不动（仍在 `.sidebar__footer`），齿轮按钮加在它旁边。
- **RFC-001（runtime probe）**：运行时条目与首页 greeting 处都复用 `/api/runtime/opencode` 端点；用独立 query key（侧栏用 `['runtime','opencode','sidebar']`，首页用 `['runtime','opencode','home']`）与 Settings 内 Runtime 卡片共存（避免联动 refetch）。
- **RFC-035（UX 一致性）**：本 RFC 落地后会暴露 UX 缺口（StatusChip 不统一、列表样式分裂等），由 RFC-035 follow-up 处理；本 RFC 在引入新的 task 行 / inbox 行视觉时**先使用现有 `.status-chip` 体系**，避免抢跑 RFC-035 的 StatusChip 统一收敛。
