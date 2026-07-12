# RFC-169 · 技术设计——资源页双栏化（左卡片列表 + 右页签详情）

状态：Draft。产品决策见 `proposal.md`（D1–D5）；本文只谈怎么落。

## 0. 结论速览

- **零 migration；后端仅两处小件（UI 直接依赖，均堵现存漏洞）**——① 保护谓词 `isProtectedSkillMainFile`（canonical file identity + Unicode NFC + 完整 case-fold）+ 后端两入口 realpath/dev+inode 身份比较，同时接到 `writeSkillFile` 与 `deleteSkillFile`，堵 SKILL.md 别名（含 APFS `ſKILL.md` Unicode 等价名）写删的现存漏洞（R2-P1-3/R3-P1-4/R4-P1-1/F3，见 §5.2）；② 探针 `startedAt` 捕获前移到配置快照读取之前（R3-P2-5，见 §5.3）。**skills 详情保存/读取沿用现状 double-PUT LWW 基线（无 CAS）；双栏前端只做「保存留原地 = 版本操作简单互斥 + 成功后刷新版本历史并重播种草稿」（§5.2；不建精密版本一致性 gate）**——combined-save/单 fenced read/contentVersion CAS/复合 token/原子发布/全域 OCC + 深层版本一致性整套是 RFC-170 入口（slim 复审第四轮定案：基础 CAS 叠非原子发布不安全、不可从 170 剥离）。其余全部为前端改造（路由、组件、样式、i18n、测试）。
- **存储层深水区整体转 [RFC-170 skills 存储与 ACL 一致性加固](../RFC-170-skills-storage-acl-hardening/proposal.md)**：不透明复合 token（skillId+contentVersion+metaRevision）/世代 · 文件写删/ZIP/fusion 全域 OCC · 快照权威存储模型 + rename 原子发布 + 崩溃恢复 · quarantine 全链（含运行时注入）· 存量分叉待迁移决策 + 多代候选 · replace journal + replacing 世代互斥 · source 生命周期 ACL（user/system reconcile 拆分）· 创建 name reservation · ACL PUT `aclRevision` 六资源 CAS——**这些是先于本 RFC 的现存缺陷（今天就存在同名 ABA、跨窗口丢失更新、fusion 越权、权限过期写回等）；169 的 skills 保存/读取沿用现状 double-PUT LWW、一个都不碰、不引入也不放大，整套版本锁/OCC/CAS 交 170**（R5–R16 设计门发现全部归档到 RFC-170 §设计门记录）。
- 四页（agents / skills / mcps / plugins）改为**嵌套路由**：`/{res}` 是 layout route（左栏 + `<Outlet/>`），子路由 `/`（空态）、`/new`（内联新建）、`/$name`（plugins 为 `/$id`，编辑）。URL 形态与现状逐字节一致，外部深链零适配。
- 新公共原语四件：`ResourceSplitPage`（双栏骨架+左栏卡片列表）、`ResourceBadges`（可见性/归属徽标片段，从 `ResourceNameCell` 抽出）、`UnsavedChangesGuard`（`useBlocker` + 公共 `Dialog`）、`stableStringify` + `useDraftFromQuery` 脏判定扩展。
- 右栏三段：`DetailHeaderActions`（复用，固定）→ `TabBar`（RFC-150 复用，固定）→ 页签内容（独立滚动）。
- 保存语义变更：详情保存后**留在原地**（现状跳回列表）；新建成功 navigate 到新资源详情。`edit-routes-navigate-on-save.test.ts` 反向锁**有意翻转**。

## 1. 布局与样式

### 1.1 滚动模型

`.content` 已是钉死视口的滚动容器（`styles.css:2127-2132`），且已有 4 个 `:has()` 页面变体先例（`.content:has(.page--editor)` 等，`styles.css:3779/6184/6591/7231`）。沿用该模式：

```css
.content:has(.page--split) { overflow: hidden; }   /* 双栏页自己管滚动 */

.page--split {           /* 挂在 .page 上的变体 */
  height: 100%; min-width: 0;
  display: flex; flex-direction: column; min-height: 0;
}
.split {                  /* 双栏 grid，flex:1 吃满剩余高度 */
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);  /* 右列可收缩 */
  gap: var(--space-4);
}
.split__list   { display: flex; flex-direction: column; min-height: 0; min-width: 0;
                 border-right: 1px solid var(--border); padding-right: var(--space-3); }
.split__cards  { flex: 1; overflow: auto; min-height: 0;
                 display: flex; flex-direction: column; gap: 6px; }
.split__detail { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.split__detail-body { flex: 1; overflow: auto; min-height: 0; min-width: 0; }  /* 页签内容区，唯一滚动点 */
```

- **最小宽度链（设计门 P2-8）**：`overflow: hidden` 的 `.content` 配上 auto min-width 的 `1fr` 轨会**静默裁切**而不是收缩——外壳 `220px 1fr`、`.split` 右列、`.file-tree` 编辑列（`grid-template-columns: 260px 1fr`）三层都有此隐患（901px 视口右栏仅约 617px，嵌套文件树/超长路径即撑爆）。因此：所有参与的弹性轨一律 `minmax(0, 1fr)`（`.split` 右列、`.file-tree` 编辑列），`.content`/`.split__detail`/`.split__detail-body`/`.file-tree__editor` 补 `min-width: 0`；长路径/长 spec 一律 CSS 截断 + `title` 全文，宽内容（依赖树、diff 类）自带 `overflow-x: auto`。「超长 skill 路径 / plugin spec 在 901px 与 1280px 视口无横向溢出、无被裁切」为必写断言（jsdom 量不了像素，落为样式规则源码锁 + e2e 视口冒烟）。
- 左栏纵向结构：页标题（唯一 `<h1>`，见 §1.4）→ 搜索框 → 卡片滚动区 → 「+ 新建」按钮（固定底部，不随卡片滚走）。
- 右栏纵向结构：`DetailHeaderActions`（固定）→ `TabBar`（固定）→ `.split__detail-body`（滚动）。**长滚动只可能发生在单个页签内容超高时**（D5 验收）。
- agents「提示词」页签：内容区 `display:flex`，`MarkdownEditor` 撑满（`flex:1; min-height:0`）。若 `MarkdownEditor` 现实现不支持高度填充，给它加可选 `fill?: boolean`（向后兼容的最小扩展，Frontend consistency 规程第 2 条）。
- 窄视口降级（非目标里声明桌面优先，但不许破版）：断点按**内容区可用宽度**而非总视口标定——以「左栏 240px + 右栏最小可用 560px + 侧栏/边距」推导，初值取 `@media (max-width: 1080px)` 下 grid 变单列上下堆叠（左栏卡片区 `max-height: 240px`），实现期以真实 shell 实测微调；断点两侧均不得出现横向滚动（P2-8 的 901px 破版区间由此消除）。
- 既有四个 `:has()` 页面变体只改 padding，与新增规则无选择器冲突（设计门核实）。

### 1.2 卡片（`.split-card` 命名空间）

```
┌──────────────────────────────┐
│ code-worker ●                │  ← 标题 + 脏标记圆点（.split-card__dot）
│ 负责写代码的工人               │  ← 副标题一行截断（title attr 带全文）
│ [opencode·默认] [private]     │  ← 徽标行（chip-row，复用既有 chips）
└──────────────────────────────┘
```

- 整卡是一个 `<Link>`（`role=link`，卡内无其他可点元素——D 卡片零按钮）；选中态 `.is-selected` 沿 `task-outputs-panel__option.is-selected` 的 accent 底色语言（`styles.css:5529-5531`）；hover 同族。
- 脏标记：标题旁 6px 圆点，accent 色，`aria-label` 走 i18n（`splitPage.dirtyDot`）。
- 徽标不新造视觉：`StatusChip`、`chip chip--managed/--external/--local/--remote/--npm/--file/--git`、`McpProbeStatusChip` 全部原样复用，由每页拼好传入（§3 卡片模型用 `ReactNode` 槽）。

### 1.3 空态 / 加载 / 错误

- 左栏：`<LoadingState>` / `<ErrorBanner>` / 列表为空时 `<EmptyState>`（保留 `empty-loading-callsite.test.ts` 锁的组件调用形态）。
- 右栏空态（index 子路由）：`<EmptyState title=引导文案 action=新建按钮>`；**skills 页空态额外渲染 `<SkillSourcesCard/>`**（T-D3，见 §5.2）。
- 右栏深链 404：detail 子路由自身的 `query.error` → `<ErrorBanner>` 局部呈现，左栏不受影响（现状是整页 error-box，顺带修正）。

### 1.4 标题层级（a11y）

页面唯一 `<h1>` 是左栏页标题（`e2e/a11y.spec.ts:137-141` 断言 heading「Agents」继续成立）；右栏 `DetailHeaderActions` 的 `children` 槽由调用方改传 `<h2>{name}</h2>`（组件本身不动——标题块本来就是 children）。

## 2. 路由重构（TanStack code-based 嵌套）

现状三平级路由（`router.tsx:76-90`）改为父子：

```tsx
// routes/agents.tsx —— layout + index 两个导出（多路由单文件先例：workflows.tsx 的 Route + NewRedirectRoute，router.tsx:33-36）
export const Route = createRoute({ getParentRoute: () => RootRoute, path: '/agents', component: AgentsSplitLayout })
export const IndexRoute = createRoute({ getParentRoute: () => Route, path: '/', component: AgentsEmptyPane })
// routes/agents.new.tsx    → getParentRoute: () => agentsRoute, path: '/new'
// routes/agents.detail.tsx → getParentRoute: () => agentsRoute, path: '/$name'

// router.tsx
agentsRoute.addChildren([agentNewRoute, agentDetailRoute, agentsIndexRoute]),
```

- **URL 不变**：`/agents`、`/agents/new`、`/agents/$name` 逐字节一致；`/new` 静态段天然胜过 `/$name`（TanStack 按特异性打分），`addChildren` 内仍保持字面量在前的既有注释惯例（belt-and-suspenders）。
- 其余三页同构；**plugins 的参数是 `$id`**（`plugins.detail.tsx` 现状），卡片 `key`/选中态以 id 计。
- 选中态推导：layout 组件 `useParams({ strict: false })` 取合并 params（`name` / `id`），`useMatches()` 判断 `/new` 是否命中（「+ 新建」按钮激活态）。
- **参数切换必须显式重挂（T-D11，源码实锤）**：TanStack 的 matchId 虽含参数插值（`router-core/dist/esm/router.js:893` `matchId = route.id + interpolatedPath + loaderDepsHash`），但 React 树上 `Outlet → Match → MatchInner → Comp` 全链**不带 key**——组件 key 只来自 `remountDeps`（`react-router/dist/esm/Match.js:141-149`），本仓未配置（src 全量 grep 零命中、`router.tsx` 无 `defaultRemountDeps`）。因此 `/agents/a → /agents/b` 仅参数变化时 detail 组件**实例被 React 保留**，`useDraftFromQuery` 的 hydrate-once `loaded` 门不会重播种——**这在现有代码里已是潜伏 bug**：在 `/agents/a` 编辑页点依赖树节点（`AgentForm.tsx:212`）跳 `/agents/b`，表单顶着 a 的旧草稿、保存会把 a 的内容 PUT 进 b。双栏化后卡片点击让同路由参数切换变成**主交互路径**，此缺陷从边缘变成必踩。解法：四个 `$name`/`$id` detail 子路由声明 `remountDeps: ({ params }) => params`（router 原生、JSON.stringify 后作组件 key → 参数变即重挂），顺带天然满足「切资源页签复位到首个」（D5）与脏上报 effect 的卸载清理。回归测试必须锁「a→b 导航后表单呈现 b 的数据」（同时修复现存 bug）。不用全局 `defaultRemountDeps`：波及 tasks/reviews/clarify 等全部参数路由，本 RFC 不扩大爆炸半径。
- 为什么嵌套而非三平级路由各渲一份双栏：**左栏组件持续挂载**——切换选中时搜索词、滚动位置、probe 查询全保留（T-D1）；平级方案每次导航重挂左栏，React Query 能保数据但保不了 UI 状态。
- import 方向：children import 父 Route（`agents.new.tsx` → `agents.tsx`），父不 import 子，`router.tsx` 统一 `addChildren` —— 无环。改动共享导出后按 [reference_binary_build_module_cycle] 跑一次 `bun run build:binary` 冒烟。

## 3. 新公共原语契约

### 3.1 `components/split/ResourceSplitPage.tsx`

```tsx
export interface ResourceCardItem {
  key: string                    // agents/skills/mcps=name；plugins=id
  title: string
  subtitle?: string              // CSS 一行截断，title attr 全文
  badges?: ReactNode             // 每页拼好的既有 chips 片段
  to: string                     // '/agents/$name' 等
  params: Record<string, string>
  testid?: string
}
export interface ResourceSplitPageProps {
  title: string                  // 左栏 <h1>
  items: ResourceCardItem[] | undefined
  isLoading: boolean
  error: unknown                 // 组件内走 ErrorBanner
  selectedKey: string | null
  newActive: boolean
  newLabel: string
  newTo: string
  searchPlaceholder: string
  emptyListText: string          // 左栏空列表 EmptyState 文案
  children: ReactNode            // 右栏（<Outlet/>）
}
```

职责：双栏骨架、搜索框（受控本地 state）+ `filterResourceCards` 过滤、卡片渲染与选中态、「+ 新建」、**`SplitDirtyProvider` + `UnsavedChangesGuard` 的唯一挂载点**。四页拿到的视觉零分叉。

### 3.2 过滤纯函数 `lib/resource-card-filter.ts`

```ts
export function filterResourceCards<T extends { title: string; subtitle?: string }>(query: string, items: T[]): T[]
```

大小写不敏感、命中 `title || subtitle`、空 query 恒等返回。纯函数直接单测（首选可断言面）。

### 3.3 脏判定：`lib/stable-stringify.ts` + `useDraftFromQuery` 扩展

```ts
export function stableStringify(v: unknown): string
// 递归按 key 排序；丢弃 undefined 值成员（与 JSON.stringify 同语义）；数组保序。
```

`useDraftFromQuery` 最小扩展（向后兼容，现有调用方零改动）：

```ts
return { draft, setDraft, loaded,
  dirty,                       // loaded && stableStringify(draft) !== stableStringify(seed)
  commitSaved(submitted: D, saved: D)   // 保存成功回执（见下——不是无条件覆盖）
}
```

seed = 首次种子快照（hook 内 state）。`dirty` 用 `useMemo` 计算。

**提交快照契约（设计门 P1-1）**：保存期间字段仍可编辑（现状即如此——Save 只 disable 自己，`agents.detail.tsx:76-104`），所以 onSuccess **不得无条件覆盖草稿**：

- `save.mutate(draftSnapshot)` —— mutation variables 固化**提交时刻**的快照；
- onSuccess 调 `commitSaved(submitted, map(saved))`：
  - 若 `stableStringify(当前 draft) === stableStringify(submitted)`（用户没接着改）→ `draft = seed = saved`，转干净；
  - 否则（响应在途时用户又输入了）→ **只更新 seed 为 saved，draft 原样保留**——继续呈现用户的新输入且保持 dirty，绝不静默回滚。
- 失败路径不动 seed/draft（保持脏、逐通道报错，现状语义）。

**跨挂载的迟到回执（设计门 R2-P1-1 + R3-P1-1 勘误）**：`commitSaved` 只作用于发起 mutation 的 hook 实例。反例 A→B→A：A 保存在途→放弃切到 B→切回 A（remountDeps 新实例、从旧 cache 播种保存前值）→ 旧响应此后到达时新实例的 hydrate-once 门不重播 → 呈现旧值且干净，用户基于旧值再保存会覆盖已成功的第一次提交。**事实勘误（R3-P1-1 核实仓内 @tanstack/react-query@5.100.10）**：hook 级 `onSuccess` 由 `Mutation.execute` **无条件调用**（组件卸载也执行）——迟到回执**会**写 detail cache（对 clean-follow 有利）；三次定案后 onSuccess **不含 clearScope 等破坏性视图副作用**（reseed 落已卸载组件即 no-op），故无需 scope 门控。两层折法：

1. **迟到回执天然安全**：onSuccess 无 clearScope（三次定案），迟到 reseed 落已卸载组件即 no-op、不污染别的资源（切回同资源经 remountDeps 全新挂载、fresh load）——不需要 reporter 所有权/scopeId 那套；
2. **clean-follow / dirty-freeze（opt-in）**：`useDraftFromQuery` 加选项 `followWhenClean: true`（四页开启，其余调用方不动、hydrate-once 契约保持）——draft **干净**时跟随 `query.data` 的后台刷新重播种（seed=draft=新值）；**脏**时冻结 draft、只推进 seed。切回 A 时：迟到 onSuccess 写入的 saved cache + 挂载触发的后台 refetch（staleTime 默认 0）双通道把最新值 rebase 进干净草稿；残余窗=「PUT 尚未落库、refetch 也读到旧值、用户已强行离开又立刻回来编辑」，文档化接受（矩阵⑩ A→B→A 延迟响应回归测试）。clean-follow 顺带覆盖多浏览器页签并发编辑的干净侧刷新；
3. **详情 GET 写入 fence（R3-P1-2）**：staleTime=0 的详情 refetch 可能在 PUT 落库前读到旧值、却在 onSuccess 写入 saved 之后才返回——Query Core 会用这次 GET 把 cache 再写回旧值，clean-follow 随即把旧值重播种成干净草稿。因此 onSuccess 写 detail cache 前必须 `await qc.cancelQueries({ queryKey: detailKey, exact: true })`（取消在途详情 GET 再写 saved）；「延迟 GET 在 PUT 回执之后落地」是确定性必写测试（矩阵⑲）。

新建页（`useState` 草稿、无 query）用姊妹小 hook `useDirtyBaseline(draft, initial)`：返回 `{ dirty, resetBaseline(next: D) }`。**`resetBaseline` 显式收 next（设计门 P2-4）**——`agents.new` 的 `applyDefaults` 快照 effect（`agents.new.tsx:53-59`）改为分别计算：`resetBaseline(applyDefaults(emptyAgent(), cfg))`（基线吸收默认值）+ `setDraft(prev => applyDefaults(prev, cfg))`（吸收默认但**不吞用户已输入**）。同 tick 读旧 state 建基线、或把用户当前 draft 整体吸入基线，都会产生「纯净页误脏 / 真实修改误干净」——两个方向均有测试锁（慢 config 下未编辑保持 clean；先输入再 config 返回仍 dirty）。

### 3.4 `SplitDirtyContext` + `components/split/UnsavedChangesGuard.tsx`

右栏路由组件持有 draft，左栏卡片要画脏点、guard 要读脏值——跨 Outlet 通信用 context（`ResourceSplitPage` 提供）。**slim 复审第十四轮三次定案：脏保护收敛到父草稿级**——十四轮 slim 复审的 findings 几乎全部集中在「让每个子组件本地缓冲（`JsonField` 无效 JSON、`SkillFileTree` 每文件 draft、`ImportZipPanel` 暂存）在任何动作下都不丢」的精密协议（reporter registry / prepareSubmit-settle-lease / 两阶段 discard / SubmitPermit）上。但这个标准**远超「不比现状差」**：现状四页零脏保护（导航离页即静默丢），而双栏「保存留原地」让组件**保持挂载**、子缓冲反而比现状更安全（现状卸载即丢）。故 169 只做**父草稿级 guard**（strictly better than today）、子缓冲维持现状 best-effort，精密子缓冲追踪不做。

```ts
interface SplitDirtyCtx {
  dirtyKey: string | null   // 当前脏的 cardKey（父草稿 dirty ⇒ 画圆点 + guard 拦截），state
  report(cardKey: string, dirty: boolean): void   // 右栏组件把父草稿 dirty 上报（同步写 ref + 异步 setState）
}
// shouldBlockFn = dirtyRef.current !== null（父草稿 dirty，T-D5 同步 ref）
```

- **脏源 = 父草稿（useDraftFromQuery `dirty`，§3.3）**：右栏路由组件把它 `report(cardKey, dirty)` 上来；卡片圆点 = 该 cardKey 报了 dirty；guard `shouldBlockFn` 读 `dirtyRef`（同步 ref，T-D5——避免 onSuccess 同 tick 导航误判）。父草稿覆盖表单主体（名称/描述/提示词/端口/资源/高级、mcps/plugins 配置、skills 描述+正文），即用户 90% 的编辑——这是相对现状零 guard 的严格增益。
- **子组件本地缓冲维持现状 best-effort（三次定案）**：`JsonField` 的无效 JSON（无法进 payload、无法保存）、`SkillFileTree` 每文件未保存 draft、`ImportZipPanel` 暂存——这些**不进父草稿、guard 不追踪**；「保存留原地」使承载它们的组件保持挂载（不卸载）、比现状（导航离页即卸载丢失）**更安全**；仅在用户主动导航离页时随卸载丢失，**与现状同**。**完美子缓冲追踪（reporter registry / 两阶段 discard / 逐动作覆盖集）不在 169**——它追求的「任意子缓冲零丢失」超出「不比现状差」，随 170 的表单状态治理或后续 UI RFC 再评估。
- **页签面板 keep-mounted（保留，R2-P1-2）**：页签切换 CSS 隐藏而非卸载（`<div role="tabpanel" hidden>`），子组件本地缓冲跨页签存活（这本身就让子缓冲比条件卸载安全）；「切页签往返缓冲保留」必写测试。
- **保存/创建的迟到回执（无 clearScope，天然安全）**：save 成功 = `commitSaved` reseed 父草稿（§3.3）+ 集合 eager patch + exact invalidate，**留在原地不导航**；create 成功 = eager insert + `setQueryData(detail)` + `navigate` 到新资源。**onSuccess 里没有 clearScope/破坏性清理**——迟到回执（用户已切走、组件已卸载）的 `commitSaved` reseed 落到已卸载组件即 no-op（配合 remountDeps 重挂，每次进入是全新组件、全新 draft），不会污染别的资源；因此不需要 scopeId 门控 / finishPending / reporter 所有权那套。
- **新建视图的 key**：`/new` 没有对应卡片，reporter 用哨兵 cardKey `'__new__'`——guard 照常拦截，左栏无匹配卡片故不画点（新建激活态本身就在「+ 新建」按钮上）。

Guard 本体（`ResourceSplitPage` 内渲染单例）：

```tsx
const resolver = useBlocker({
  shouldBlockFn: () => anyDirty(registryRef.current),
  enableBeforeUnload: () => anyDirty(registryRef.current),   // 浏览器关闭/刷新原生提示
  withResolver: true,
})
// resolver.status === 'blocked' → <Dialog onClose={resolver.reset}>：
//   正文 splitPage.unsavedBody，
//   footer [放弃修改 → resolver.proceed()] [留在本页 → resolver.reset()]
```

**Dialog 关闭语义（设计门 P2-5）**：公共 `Dialog` 默认在 ESC / × / 遮罩点击时调 `onClose`（`Dialog.tsx:20-39,120-134,230-257`），而 `useBlocker` 的 blocked promise 只有 `proceed`/`reset` 才 resolve（`useBlocker.tsx:225-246`）——若关闭只是隐藏 Dialog，被拦的导航将永久悬挂、后续导航还可能覆盖 resolver。因此 **`onClose` 必须绑定 `resolver.reset`**（一切 dismiss = 留在本页），并且 ESC / × / 遮罩三个入口 + 「dismiss 之后再次导航仍能正常拦截」都是必写测试。

`useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver })` 已验证存在于本仓安装版本 `@tanstack/react-router@1.169.2`（`packages/frontend/node_modules/@tanstack/react-router/dist/esm/useBlocker.d.ts:33-44`：`BlockerResolver.status/'blocked'/proceed/reset`）。Dialog 走公共 `components/Dialog.tsx`（禁自写 overlay）。

覆盖面：页内点卡、点「+ 新建」、侧边栏、依赖树节点点击、浏览器后退——一切经 router 的导航统一被拦；刷新/关闭由 `enableBeforeUnload` 兜底。现状四页零防护，纯增益。

### 3.5 `components/ResourceBadges.tsx`（从 `ResourceNameCell` 抽片段）

`ResourceNameCell`（`components/ResourceNameCell.tsx:42-59`）的 private chip + owner badge 片段抽成 `<ResourceBadges visibility ownerUserId owners/>`；`ResourceNameCell` 保留 `<td>` 外壳改为内部复用它（**workflows.tsx:179 / workgroups.tsx:137 两个存续调用方零改动**），四页卡片直接用 `<ResourceBadges/>`。

## 4. 保存 / 创建 / 删除语义（行为变更点）

**cache transaction 契约（设计门 P2-6）**：集合 key `['{res}']` 与详情 key `['{res}', key]` 共前缀，TanStack Query 的非 exact invalidation 会连详情一起失效；嵌套布局下详情 query 保持 active，会**立即重拉**——后台请求一旦失败，query 置 error，若照现状渲染就把编辑器换成整页错误（「保存成功反而变错误页」）。因此：

- 集合失效一律 `invalidateQueries({ queryKey: ['{res}'], exact: true })`；
- 集合缓存**eager patch**（不等 refetch）：保存 `setQueryData(['{res}'], rows => rows === undefined ? rows : rows.map(...))` 就地替换该行；新建 insert；删除 remove——列表卡片即时反映，refetch 慢/失败也不显示旧值；
- **updater 必须空值安全（R2-P2-6）**：深链直达或列表查询失败时集合 cache 为 `undefined`，`rows.map` 会在服务端**已提交后**于 onSuccess 抛错、把成功的 mutation 翻成前端失败（commitSaved / 脏态清理全部不执行）。cache 缺失 → 不 patch（返回 undefined 原样），交给 exact invalidate 的 refetch 兜底；顺序契约 `cancelQueries(exact) → patch → exact invalidate`，防在途集合 fetch 落地覆盖 patch。「undefined 集合 cache 下 save/create/delete 成功且脏态清理完成」是必写测试；
- 详情 key：onSuccess 先 `await cancelQueries({ queryKey: detailKey, exact: true })` **取消在途详情 GET**、再 `setQueryData` 写入 saved（R3-P1-2 fence——否则读到旧值的慢 GET 在 saved 写入后返回、把 cache 打回旧值，clean-follow 会把旧值重播种成干净草稿）；写入后**不失效不重拉**；
- 详情渲染的错误态收窄：仅「无草稿可显示」（`draft === undefined`）时整区 `ErrorBanner`；draft 已种后的后台刷新失败只出顶部错误横幅、不吞编辑器（见 §6）。

| 动作 | 现状 | 改后 |
| --- | --- | --- |
| 详情保存成功 | `setQueryData` + `navigate('/{res}')`（agents.detail.tsx:50-54 等四处） | `setQueryData(detail)`（stale-race 契约不变，useDraftFromQuery.ts:10-22）+ 集合 eager patch + exact invalidate + `commitSaved(submitted, map(saved))`（§3.3）；**不导航** |
| 新建成功 | `invalidate` + `navigate('/{res}')` | 集合 eager insert + exact invalidate + `setQueryData(['{res}', key], created)` + `navigate('/{res}/$name'（plugins $id）)`（无 clearScope；请求期间父草稿新输入保持 dirty、导航交 guard 兜底）—— 新资源立即选中、卡片立即在场、编辑区秒开 |
| 删除成功 | `invalidate` + `navigate('/{res}')` | **删除=确认冻结、成功才破坏、失败恢复（R9-P1-2）**：确认对话框列明将丢弃的未保存修改但**只冻结不丢弃**、请求在途右栏编辑冻结、草稿保留。**失败** → 原样解冻（草稿完好 + 错误横幅）。**成功** → 集合 eager remove + exact invalidate + `navigate('/{res}')`（资源已不存在、无可保存对象，guard 对已删资源不拦）。两终态入矩阵㉛ |

skills 特例（沿用现状双通道 + 协调缓存，F1/F2）：skills 详情保存**保留现状双通道**（`skills.detail.tsx:87-92` `Promise.allSettled` 双 PUT——metadata PUT + content PUT），双栏唯一改动=**全部必需 PUT fulfilled 后 `commitSaved` 只调一次、不导航**（保存留原地）；部分失败沿现状逐通道报错（`DetailHeaderActions.errors`，不 reseed、保持脏、可重试）。
  - **协调缓存步骤（F2——skills 不套用通用「写后不重拉详情」规则）**：两个 PUT 并发且非同快照（metadata PUT 可能先返回旧 `contentVersion=N`，content PUT 才推进到 N+1，而 `SkillContent` 响应不含版本号），若照通用契约「写后不重拉」，保存留原地时历史面板会继续显示 N、漏 N+1、给出错误的 current/diff/restore 控件；若保留每通道 invalidation，meta 的迟到 GET 又可能在 content 成功后覆盖。因此 skills 保存成功（双 PUT allSettled 全 fulfilled）后 best-effort refetch detail(content)+versions（拿权威最新版本历史、不显示陈旧 N），成功 reseed 草稿；版本操作（save/restore/文件写）用标准 `isPending` 按钮互斥（任一 pending 时禁其余，现有表单惯例）。深层同页竞态窗口/不确定提交/离线/跨页一致性转 170（三次定案：不建精密前端 gate）。「保存成功→best-effort refetch 后历史=权威最新」「版本操作 isPending 互斥」是必写测试（矩阵㉔a）。
  - skills 新建只种 meta cache，content 由详情页首拉（沿现状双查询播种，与 combined-save/单 fenced read 一并转 170）。

## 5. 每页迁移细节

### 5.1 agents

- `routes/agents.tsx` → layout：`useResourceList`（不动）+ runtimes 查询（现 `agents.tsx:36-40`，卡片「运行时·默认」徽标继续用）+ 卡片模型组装。徽标：运行时名（继承默认时 `StatusChip neutral` 加「默认」，语义同现表格 `agents.tsx:102-108`）、`<ResourceBadges/>`、`builtin`。
- **`AgentForm` 重构为五页签**（D5/5.1.1）：基础 / 提示词 / 端口 / 资源与依赖 / 高级。`TabBar` 局部 state；`FormSection` 的 collapsible 用法与 `hasResourceContent`/`hasAdvancedContent` 的 rising-edge 自动展开效果（`AgentForm.tsx:89-100`）整体退役，改为两个纯函数徽标：`portBadgeCount(v) = inputs.length + outputs.length`、`resourceRefCount(v) = skills+mcp+plugins+dependsOn 总数`（`TabBar` 的 `badge` 槽，`TabBar.tsx:22-27`）。
- 依赖树预览并入「资源与依赖」页签（点击节点 navigate 到其他 agent——会被 guard 正确拦截，正是想要的）。
- `agents.new` 内联进右栏：YAML 导入按钮保留（`AgentImportDialog` 不动）；`applyDefaults` 快照 effect 加 `resetBaseline`（§3.3）；创建按钮进 `DetailHeaderActions` 形态还是保留 `.form-actions`？——新建视图**没有** ACL/删除，不硬套 `DetailHeaderActions`：右栏 header 为「标题 + 导入 + 创建」的轻 header（复用 `.page__header--row`/`.page__actions` class，不新造 chrome）。
- 详情 header：`DetailHeaderActions` 原样（启动 extra / ACL / 保存 / 删除），children 改 `<h2>`。

### 5.2 skills

- layout：卡片徽标 = `chip--managed/--external` + `<ResourceBadges/>`；`labelById` 源名不进卡片（避免噪音），源归属看空态面板。
- **空态（index 子路由）承载 `<SkillSourcesCard/>`**（T-D3）：源文件夹 rescan/remove 是全局操作，语义属于「未聚焦某个技能」；现列表页底部堆叠（`skills.tsx:146`）迁走后列表页不再有纵向第二内容块。原 name cell 的 source-pill 锚点（`#source-<id>`）随表格退役——卡片不带源链接。
- 详情四页签：**概览**（描述 Field + 来源/路径元信息）/ **内容**（SKILL.md：`MarkdownEditor` 或 external 只读 `pre`，沿 `skillCapabilities` 门控）/ **文件**（`<SkillFileTree/>` 整体入驻——其内部 260px+1fr 双栏（`styles.css:3637-3646`）在整栏宽度下无嵌套挤压）/ **历史**（`SkillVersionHistory`，`caps.showVersionHistory` 时才有此页签）。`page--wide` 变体随整页布局退役。
- **SKILL.md 写删守卫（后端小件①，零 migration）**：现状 SKILL.md 存在双写入口且删除路径可被别名绕过——`SkillFileTree` 的 `handleAdd` 对任意相对路径直接 PUT 空正文（输入 `SKILL.md`/`./SKILL.md` 即截空主文件），`deleteSkillFile` 只做 `normalizeSlash(relPath) === 'SKILL.md'` 词法判等（`services/skill.ts:416-438`）——`./SKILL.md`、APFS 大小写不敏感下的 `skill.md`、**尾随分隔符 `SKILL.md/`（`normalize` 保留尾随 `/`，但 `safeJoin`〔`util/safePath.ts:34-40`〕会 resolve 回根 SKILL.md）** 都能**真删/截空主文件**（现存漏洞）。收敛为纯函数 `isProtectedSkillMainFile(relPath)`：**先归一到「无尾随分隔符的 canonical relative-file identity」（剥尾随 `/`、折叠 `.`/`//`、目录形式路径一律拒），再 Unicode 规范化（NFC）+ 完整 Unicode case-fold 精确命中根 `SKILL.md`**——**仅 ASCII case-fold 不够（F3）**：APFS 默认对 Unicode 等价名不敏感，`ſKILL.md`（首字符 U+017F long-s）与 `SKILL.md` 解析到同一 inode、`writeFileSync`/`unlinkSync` 命中主文件，而 ASCII fold 判它是普通文件。纯函数共享前后端；**且后端两入口（`writeSkillFile`+`deleteSkillFile`）对已存在候选与根 `SKILL.md` 再做 realpath / dev+inode 身份比较兜底**（谓词的词法层挡纯别名、身份层挡文件系统等价——这是 API 可直接提交的别名，非需预置 symlink 的 170 边角，故落 169）。前端「内容」页签是 SKILL.md 唯一编辑口，`SkillFileTree` 中该行**只读展示**（加可选 prop `readonlyPaths?: string[]`）。「Add/Save/DELETE 对 `SKILL.md`/`./SKILL.md`/`SKILL.md/`/`./SKILL.md//`/`skill.md`/`Skill.md`/**`ſKILL.md` 等 Unicode 等价名**/嵌套 dot-segment 全拒 + `skillset.md`/`docs/SKILL.md` 正常写删」+ APFS inode 回归是必写测试（矩阵⑭）。**需预置 symlink 的间接身份边角仍属 RFC-170。**
- **详情保存沿用现状 double-PUT + reseed 留原地（后端零改动，三次定案）**：combined-save/单快照读/contentVersion CAS 整套经 slim 复审证明不能安全从 170 剥离（基础 CAS 叠现状非原子发布不安全，见 §0/RFC-170），故 **169 的 skills 保存/读取整套沿用现状**（meta/content 双查询播种 + 双 PUT，LWW）。双栏前端改动：① onSuccess 从 `navigate` 改为「全 PUT fulfilled 才 `commitSaved` reseed 父草稿一次 + 不导航」（**保存留原地**）；② 保存成功后 **best-effort refetch** detail(content)+versions 刷新版本历史（否则历史面板显示陈旧 current/diff/restore）；③ 版本操作（save/restore/文件 Add·Save·Delete）用**标准 `isPending` 按钮互斥**（任一 pending 时禁其余，现有表单/`DetailHeaderActions` 惯例）；④ restore 成功 `restoreEpoch` 重挂 rebase、`restore.isPending` 与保存互斥。**同页竞态窗口（两 PUT 离 pending 后到 refetch settle 的间隙）、不确定提交后的 content 精确 rebase、离线/跨页/跨窗口持久版本一致性——整套随 combined-save/CAS/快照权威转 RFC-170**（三次定案：这些是后端非原子双 PUT 的症状、前端补偿协议是超「不比现状差」的兔子洞，169 只保证「同页顺序操作 + best-effort 刷新」的现实高频路径、不比现状〔保存后导航离页〕更差）。skills 双通道错误呈现沿用 `DetailHeaderActions.errors`。「保存留原地 reseed + best-effort refetch 后历史=权威最新」「版本操作 isPending 互斥」「restore→再保存不回退」是必写测试（矩阵㉔⑮⑳㉔a）。
- 新建：四模式页签（managed/external/folder/zip，`skills.new.tsx:84-96`）**保持原 TabBar 结构整体入驻右栏**——它是「创建模式」页签，与详情「配置组」页签同一原语不同语义，不合并；面板同样 keep-mounted（§3.4）。`ImportZipPanel` 的暂存/已选文件维持现状本地状态（三次定案：子缓冲 best-effort、不进父草稿追踪，§3.4；keep-mounted 使其跨页签存活）。folder 模式注册成功后现状 navigate `/skills`（`skills.new.tsx:57-68`）——改后落空态（源面板正好在那，注册结果立即可见，语义反而更顺）。**并发创建 name reservation、ZIP 覆盖 OCC 转 RFC-170。**

### 5.3 mcps

- layout：卡片徽标 = `chip--local/--remote` + enabled=false 时「已禁用」chip + `McpProbeStatusChip`（probe 数据沿既有 `useMcpProbes()`（`['mcps','probes']`），layout 查询、probesByName 索引复用 `mcps.tsx:46-55` 逻辑）+ `<ResourceBadges/>`。probe 查询失败 → 无状态 chip（failure-soft）。
- **探针结果绑定配置指纹（设计门 P2-7 + R2-P2-5 勘误 + R3-P2-5 时序收紧）**：保存 MCP 会更新配置与 `updatedAt`（`services/mcp.ts:68-96`）但持久 probe 不清除——旧 command/URL 的绿色结果会被当成当前状态。probe schema **没有 `probedAt`**（只有 `startedAt`/`finishedAt`/`updatedAt`），且完成时间无法证明配置所有权。判定用**启动时间严判**：`probeFreshness = probe.startedAt > mcp.updatedAt`（毫秒相等判 stale，fail-closed；纯函数单测含「探测启动→保存新配置→探测完成仍判 stale」竞态 case）。但现状探针路径是「读配置快照 → await ACL → runProbe 记 startedAt」——配置更新落在快照读取之后、startedAt 记录之前时，探测用的是旧配置、`startedAt` 却大于新 `updatedAt`（TOCTOU 窗口可跨多毫秒，R3-P2-5）。**后端守卫之二（零 schema 改动）**：探针流程把 `startedAt` 的捕获**前移到读取配置快照之前**（时间戳在前、快照在后 ⟹ `startedAt > updatedAt` 蕴含快照读于保存之后，判定变为可靠；注入时钟做确定性并发测试，矩阵㉑）。不满足则显示中性「需重新探测」chip；MCP 保存成功顺带失效 `['mcps','probes']`。持久化配置 hash 属后端扩展，超出本 RFC；残余风险修订为：单守护进程同墙钟下无已知窗口，跨进程/时钟回拨场景不在承诺内。
- **列表展开行体系退役**：`McpExpandedSummary`、`mcp-row-expand-*`、Status/Latency/Tools 三列、每行 re-probe（`mcps.tsx:189-256`）删除；信息承接=卡片状态 chip + 详情「工具与探测」页签。
- 详情两页签：**配置**（`McpFields`，零改动）/ **工具与探测**（`<McpInventoryPanel/>` 从「表单上方堆叠」（`mcps.detail.tsx:117`）移入，含 re-probe；latency/toolCount 在其 capabilities 区已有呈现）。
- 新建：单配置组，**不显示页签条**（单页签无意义）；`McpFields` + 创建按钮轻 header。

### 5.4 plugins

- **`$id` 路由**：卡片 key=id、`to='/plugins/$id'`；删除仍 `deleteBy:'id'`。
- layout：卡片徽标 = `chip--npm/--file/--git` + 版本号（muted 文本）+ enabled=false「已禁用」chip + 「有可用更新」chip + `<ResourceBadges/>`。
- **updateInfo 提升为 query cache（T-D6，含设计门 P2-7 指纹）**：现状是列表页本地 `useState`（`plugins.tsx:43`），check-update 迁进详情页后跨组件失联。改为 `qc.setQueryData(['plugins','updates'], prev => ({...prev, [id]: entry}))` 字典，**entry 必须带输入指纹** `{ spec, resolvedVersion, info }`——spec 可被修改并重装、resolvedVersion 随之变（`plugin.ts:119-160`），呈现前校验指纹与当前行一致，不一致按「未检查」处理；plugin 保存 / 升级 / 删除的 onSuccess 清除该 id 的不匹配条目。读取走 `useQuery({ queryKey: ['plugins','updates'], enabled: false, gcTime: Infinity, staleTime: Infinity })`（React Query v5 对象签名；纯缓存承载无 fetcher；**gcTime 必须显式 Infinity**——默认 5min GC 会在无观察者期把手写缓存回收掉；会话内有效，刷新即空，与现状 useState 生命周期等价而非更长）。
- 详情两页签：**配置**（`PluginFields`）/ **更新**（当前版本/resolvedVersion、检查更新按钮、结果呈现、升级按钮；mutation 逻辑从 `plugins.tsx:45-64` 平移）。
- 新建：单配置组同 mcps。

## 6. 失败模式

| 场景 | 行为 |
| --- | --- |
| 深链到不存在资源 | 右栏 `ErrorBanner`（describeApiError），左栏正常可点 |
| 列表查询失败 | 左栏 `ErrorBanner`；右栏 detail 查询独立，深链仍可编辑 |
| draft 已种后详情 query 后台失败 | **不吞编辑器**：仅 `draft === undefined` 时整区 ErrorBanner；已加载则编辑器保留 + 顶部错误横幅（P2-6 错误态收窄） |
| 保存响应到达时用户已切走（旧组件已卸载） | onSuccess 无 clearScope、reseed 落已卸载组件即 no-op（remountDeps 重挂全新 draft）；detail cache 写入仍执行、数据不丢 |
| 脏值竞态（onSuccess 同 tick 导航） | `markClean` 同步写 ref，`shouldBlockFn` 读 ref（T-D5） |
| 保存失败 | 逐通道错误行（`DetailHeaderActions.errors`，plugins-page-wiring 锁的形态不变）；保持脏、guard 继续生效 |
| 浏览器刷新/关闭带脏 | `enableBeforeUnload` 原生确认 |
| React Query 后台 refetch | 不覆盖草稿（useDraftFromQuery hydrate-once 契约，不变） |
| probes / owners 查询失败 | 卡片降级渲染（无对应徽标），不阻塞列表 |
| skills 保存部分失败/刷新失败 | 沿现状逐通道报错（`DetailHeaderActions.errors`）、保持脏、可重试；全 fulfilled 才 `commitSaved` 一次 + best-effort refetch 刷新版本历史（刷新失败错误横幅可重试、无持久锁）（§5.2 简单互斥+刷新重播种，不确定提交深层一致性转 170） |
| 窄视口 | ≤900px 上下堆叠降级，无横向滚动 |

## 7. 测试策略

前置盘点（本 RFC 落地前由子 agent 全量扫描，结论按 [feedback_grep_locks_before_push] 在实现期再复核一遍 grep）：

### 7.1 必改（断言被有意推翻）

| 文件 | 现锁 | 改法 |
| --- | --- | --- |
| `tests/edit-routes-navigate-on-save.test.ts` | 保存后必须 `navigate('/{res}')`（:23-48） | **翻转**：锁「save onSuccess 不含 navigate + 含 reseed」，文件头注释链 RFC-169 D2 |
| `tests/skills-detail-save-channels.test.tsx:206,220` | 保存成功 navigate 一次 | 改断言 navigate 零次 + reseed 后 dirty=false |
| `tests/plugin-create-retry.test.tsx:133,164` | 创建成功 navigate 一次 | 改断言 navigate 目标为 `/plugins/$id` |
| `tests/agents-list-cell-wrapping.test.ts` / `skills-…` / `mcps-…` | 表格 td/class 结构 | 退役，由新 `split-card` 结构测试取代（截断/`title` attr 语义等价迁移） |
| `tests/mcps-list-probe-columns.test.tsx` | 三列 + 行展开 + 行内 re-probe | 重写为：卡片 probe chip + 「工具与探测」页签内容 + re-probe |
| `tests/rfc115-node-policy-global.test.ts:70-83` | `agents.tsx` 含 `colRuntime` 列头等 | 改锁卡片运行时徽标 + 「默认」tag 语义（i18n key 断言 :86-92 不动） |
| `tests/agent-form-sections.test.tsx` | RFC-155 折叠 section + rising-edge 自动展开 | 重写为五页签：页签存在性/切换/徽标计数/切资源复位（受 D5 影响，原「不受影响」判定作废） |
| `tests/mcps-detail-inventory-mounted.test.ts` | InventoryPanel 在表单上方 | 改锁「工具与探测」页签内挂载 |
| `tests/mcps-page-wiring.test.ts` / `plugins-page-wiring.test.ts` | list 含 `/new` Link、plugins 行内 check-update/upgrade（:106-110） | `/new` Link 仍在（「+ 新建」按钮）——断言保留；行内 upgrade 锁改「更新」页签锁 |
| `tests/skill-source-pill.test.tsx:15-30` | 逐字锁 `sourceFromPill` + `#source-<id>` 锚点布局 | **退役**（source-pill 随表格移除，源归属看空态面板）——设计门 P2-9 指出的漏列项 |
| `e2e/a11y.spec.ts:144-154` | `/agents/new` goto + FormSection 标题点击 | goto 不变（URL 保留）；断言改页签交互 |
| `e2e/visual-regression.spec.ts:85-89` | `agents.png` | 基线重生成（明暗、双 OS 由 CI 产出） |

### 7.2 需适配核对（大概率小改或存活）

`resource-list-shell.test.tsx`（hook 组存活；`ResourceNameCell` 组存活——workflows/workgroups 仍用，新增 `ResourceBadges` 抽取后的回归断言）、`e2e/rfc099-ownership-acl.spec.ts`（卡片名仍是 link、详情 URL 直达、ACL 按钮仍在 header → 预期存活，跑一遍确认）、`e2e/main.spec.ts` happy-path / rfc022（`getByText` / 依赖树，预期存活）、`empty-loading-callsite.test.ts`（Loading/Empty 组件继续使用）、`form-invalid-no-banner.test.tsx`（表单校验不动）、`skills-new-zip-tab.test.ts`（zip 页签保留）。

### 7.3 新增

- 纯函数：`stable-stringify.test.ts`（键序/嵌套/undefined 丢弃/数组保序）、`resource-card-filter.test.ts`、`agent-form-tab-badges.test.ts`（portBadgeCount/resourceRefCount）。
- 组件：`resource-split-page.test.tsx`（卡片渲染/选中高亮/搜索过滤/新建激活/三态/脏点 via context）、`unsaved-guard.test.tsx`（真 memory-history router 挂 blocker：脏→拦→Dialog→proceed/reset；markClean 后同 tick 导航不拦）。
- 每页集成：`{res}-split-page.test.tsx` ×4（空态/选中渲染表单/保存留原地 + reseed 后卡片脏点消失/新建成功选中）；skills 空态含 SourcesCard；plugins 更新页签 check-update→卡片 chip（cache 化链路）。
- **remountDeps 回归锁（T-D11，兼修现存 bug）**：`/agents/a → /agents/b` 参数导航后表单呈现 b 的数据（不是 a 的旧草稿）、页签复位；四页同锁。
- **设计门强制矩阵（P1/P2 反例逐条转测试）**：①保存在途继续输入→响应到达→新输入保留且仍脏（P1-1 反例一）；②A 保存在途放弃切到 B 编辑→A 响应到达→B 脏态不被清（P1-1 反例二）；③JsonField 无效 JSON 本地缓冲→切走被拦（P1-2）；④文件树/ZIP 面板本地改动→切走被拦（P1-2）；⑤skills「文件存新 SKILL.md→改描述→保存」正文不回退+历史刷新（P1-3）；⑥慢 config 下新建页未编辑保持 clean、先输入再返回仍脏（P2-4）；⑦guard Dialog ESC/×/遮罩三入口=留在本页、dismiss 后再导航仍拦（P2-5）；⑧保存成功后列表 refetch 失败→卡片仍显新值、详情不重拉不变错误页（P2-6）；⑨「探测后改配置」显示需重新探测、「检查更新后改 spec」回到未检查（P2-7）。
- **强制测试矩阵（169 scope，反例逐条转测试）**：
  - ⑩A→B→A 延迟保存响应→切回后 clean-follow rebase（父草稿）、不「干净但过期」；⑪切页签往返→子缓冲保留（keep-mounted）；⑫父草稿 dirty→切走弹确认、无 dirty 不弹。
  - ⑭SKILL.md 写删守卫：Add/Save/**DELETE** 对 `SKILL.md`/`./SKILL.md`/`SKILL.md/`/`skill.md`/`Skill.md`/**`ſKILL.md` Unicode 等价名**/嵌套 dot-segment 全拒 + APFS inode 回归、`skillset.md`/`docs/SKILL.md` 正常写删（纯函数前后端两 OS 语义一致 + 后端 realpath/inode 兜底）；⑮restore→内容页签呈现恢复后正文→再保存不回退（脏时先确认）；⑯探测启动→保存配置→探测完成仍判 stale；⑰undefined 集合 cache 下 save/create/delete 成功且脏态清理完成。
  - ⑱迟到保存回执（用户已切走、组件已卸载）→reseed no-op 不污染新资源（无 clearScope）；⑲慢详情 GET 在 PUT 回执后返回→cancel fence 生效、cache/草稿保持 saved；⑳skills restore→内容页签呈现恢复后正文→再保存不回退；㉑注入时钟：读旧配置快照→保存→再记 startedAt 的窗口在时间戳前移后消失。
  - ㉔skills restore 成功→restoreEpoch 重挂 rebase 到恢复后正文、restore.isPending 期间恢复按钮与保存互斥；㉔a skills 保存留原地：版本操作（save/restore/文件写）标准 isPending 按钮互斥、保存成功→best-effort refetch 后版本历史=权威最新（同页竞态窗口/不确定提交/离线/跨页深层一致性转 170）。（㉖ combined-save/单 fenced read/CAS 整套随保存协议转 RFC-170；子缓冲完美追踪 reporter registry/两阶段 discard/operationBusy 三次定案移出 169——父草稿级 guard 足够。）
  - ㉛删除=确认冻结（对话框列明将丢弃的未保存修改）、请求在途右栏编辑冻结/草稿保留、失败逐字恢复、成功导航空态（子缓冲完美追踪 ㉒㉓㉘ 三次定案移出 169——子缓冲维持现状 best-effort、stay-in-place 保持挂载反更安全；㉝ combined-save 原子性/失败契约随保存协议转 RFC-170）。
- **存储域测试矩阵整体转 [RFC-170](../RFC-170-skills-storage-acl-hardening/design.md)**：㉗跨窗口文件写/删/restore 版本栅栏 · ㉙双向+世代 OCC（ZIP×ZIP/ABA/仅元数据/缺 token）· ㉚崩溃恢复/quarantine/存量分叉升级 · ㉜fusion OCC · ㉞身份级 DELETE ABA · ㉟source 生命周期 ACL · ㊱ACL PUT aclRevision 六资源 · ㊲创建 reservation + replacing 世代互斥。
- 源码层兜底锁（wiring）：四个 layout 路由文件都 import `ResourceSplitPage`；`agents.tsx` 等四文件不再出现 `data-table`；`ResourceSplitPage.tsx` 内含唯一 `UnsavedChangesGuard` 挂载。
- i18n：新 key 双语齐备断言并入既有 i18n 锁模式。

### 7.4 门槛

每个任务批次随带测试（Test-with-every-change）；push 前 `bun run typecheck && bun run lint && bun run test && bun run format:check` + frontend vitest + `bun run build:binary` 冒烟；push 后按 [feedback_post_commit_ci_check] 查本 sha 的 CI。`agents.png` 基线经 CI 生成产物回填（沿既有 refresh 流程）。

## 8. 决策记录

| # | 决策 | 备选与否决理由 |
| --- | --- | --- |
| T-D1 | 嵌套 layout route + Outlet | 三平级路由各渲双栏：左栏重挂、搜索词/滚动丢失 |
| T-D2 | 保存留原地、翻转 navigate-on-save 锁 | 保留跳列表：与 master-detail 心智冲突（用户抱怨的三跳来回正源于此） |
| T-D3 | SkillSourcesCard 迁空态视图 | 左栏底部（挤压卡片区）/独立页签（它不属于任何单个技能）均不如空态语义贴切 |
| T-D4 | 页签为局部 state 不进 URL | 进 URL：深链语义膨胀、guard 与页签切换纠缠；settings 页先例即局部 state |
| T-D5 | 脏值 registry ref 同步读 + state 驱动渲染 | 纯 state：onSuccess 同 tick 导航被误拦 |
| T-D6 | plugins updateInfo 提升 query cache 字典（带 `{spec,resolvedVersion}` 指纹） | context/提升 state：与「检查在详情、呈现在卡片」的跨路由共享不符；无指纹：改 spec 重装后旧结果张冠李戴 |
| T-D7 | 卡片零按钮，行级操作全迁右栏 | 卡上 hover 按钮：视觉噪音 + 与 RFC-168 成员卡「点选进面板」心智不一致 |
| T-D8 | `ResourceNameCell` 保留（workflows/workgroups 仍用），抽 `ResourceBadges` 片段 | 直接删除：还有两个存续调用方 |
| T-D9 | 右栏标题降为 `<h2>`，`<h1>` 唯一在左栏 | 双 h1：a11y 回归（a11y.spec heading 断言） |
| T-D10 | mcps/plugins 新建单组不显示页签条 | 单页签的 TabBar：纯噪音 |
| T-D11 | 四个 detail 子路由声明 `remountDeps: ({params}) => params` | 不配置：参数切换不重挂、旧草稿串台（现存潜伏 bug，双栏后变主路径必踩）；全局 `defaultRemountDeps`：波及全部参数路由，爆炸半径过大；组件内 `key={name}` 包裹：绕开 router 原生机制、四页各写一遍 |
| T-D12 | 脏态 = 父草稿 dirty（useDraftFromQuery stableStringify，§3.3/§3.4；三次定案收窄） | reporter registry 追踪每个子缓冲：14 轮 slim 复审证明是超「不比现状差」的兔子洞；子缓冲维持现状 best-effort、stay-in-place 保持挂载反更安全 |
| T-D13 | SKILL.md 单一写入口（文件树只读该行 + 只提交脏通道 + 文件保存失效 content/meta/versions） | 双入口共存：跨页签互踩、旧正文覆盖新文件（设计门 P1-3）；从文件树整个隐藏 SKILL.md：用户会以为文件丢了 |

## 9. 设计门记录（Codex adversarial-review，2026-07-11 起）

**拆分后 scope 校准（2026-07-12）**：本 RFC 原设计门跑了 16 轮。**多数**存储/ACL findings（复合 token/世代、文件写删/ZIP/fusion 全域 OCC、快照权威、崩溃恢复/quarantine、迁移多代候选、replace journal、source ACL、创建 reservation、ACL PUT aclRevision）转 RFC-170；但 R5–R10 里穿插了几条**UI/保存协议**子发现仍**保留在 169**——R5-P1-3（reporter 协议改 `prepareSubmit(coveredTokens)`/动作建模 + ZIP 导航上移）、R6-P1-2（`settle(lease revision)` + 删 onSuccess clearScope→navigate）、R7-P2-2（`finishPending()` 同步终止 + 固定 `finishPending→settle→navigate`）、R8-P2-3/R9-P1-2/R10-P2-5（删除状态机：确认只冻结/失败逐字恢复/成功一次性破坏性导航许可）。**存储矩阵子集**（㉖㉝ combined-save/CAS + ㉗㉙㉚㉜㉞㉟㊱㊲ + 复合 token/跨窗口/快照权威/quarantine/fusion/ACL 细项）转 170；**169 保留矩阵 = ⑩–㉕㉘㉛ + 新增 ㉔a（skills 双 PUT 协调缓存）**（㉖ combined-save/㉝ 原子性均转 170）。**SKILL.md 守卫（R3-P1-4/R4-P1-1/F3）在 169 = 词法归一 + Unicode NFC + 完整 Unicode case-fold + 后端两入口 realpath/dev+inode 身份比较**（`ſKILL.md` 等 Unicode 等价名是 API 可直接提交的别名，必须落 169；仅需预置 symlink 的间接身份边角才转 170）；㉕（DELETE 别名）已并入 ⑭。**169 skills 保存 = 现状 double-PUT LWW + 简单互斥 + 刷新重播种（无 CAS、无精密 gate）；contentVersion CAS/combined-save/单 fenced read/深层版本一致性整套均属 RFC-170**（slim 复审十轮把补偿性前端 gate 越推越复杂、其最难洞是后端非原子症状→二次定案收窄）。下方 R1–R4 记录以本校准为准。

第一轮 verdict **needs-attention**：3 P1 + 6 P2，全部采纳折入上文——P1-1 提交快照/所有权（§3.3 `commitSaved` + §3.4 token 化 markClean）、P1-2 reporter registry + 三组件 `onDirtyChange` 最小扩展（§3.4）、P1-3 SKILL.md 单一写入口（§5.2）、P2-4 `resetBaseline(next)` 显式收参（§3.3）、P2-5 Dialog `onClose=reset`（§3.4）、P2-6 exact invalidation + eager patch + 错误态收窄（§4/§6）、P2-7 probe/updateInfo 输入指纹（§5.3/§5.4）、P2-8 `minmax(0,1fr)`/min-width 链 + 断点按容器宽度（§1.1）、P2-9 proposal §6.5 口径统一 + `skill-source-pill.test` 列册 + 强制测试矩阵（§7.1/§7.3）。评审期间独立实锤的 T-D11（remountDeps）与评审结论一致（评审确认「T-D11 已正确闭合路由重挂风险」）。

第二轮 verdict **needs-attention**：4 P1 + 2 P2（全部针对第一轮折法的洞），全部采纳——R2-P1-1 A→B→A 迟到回执致「干净但过期」→ 保存在途进 guard + clean-follow/dirty-freeze opt-in（§3.3，残余窗文档化）；R2-P1-2 页签卸载丢脏证据 / 终态单 token 清理不全 → 页签面板 keep-mounted + `clearScope()` 原子清理（§3.4，并修掉 §5.2 与 T13 的「ImportZipPanel 零改动」措辞冲突）；R2-P1-3 「新增文件」入口绕过只读行覆写 SKILL.md → 前端 canonical 检查 + 后端 `writeSkillFile` fail-closed（§5.2、§0 速览同步改口）；R2-P1-4 版本恢复绕过基线 → `onRestored` + 脏确认 + 三 key 失效 + clean-follow rebase（§5.2）；R2-P2-5 `probedAt` 字段不存在且完成时间无所有权 → `startedAt > updatedAt` 保守严判、同毫秒 fail-closed（§5.3）；R2-P2-6 集合 cache undefined 时 updater 抛错把成功保存翻成失败 → 空值安全 + `cancel → patch → exact invalidate` 顺序契约（§4）。矩阵增补 ⑩–⑰。

第三轮 verdict **needs-attention**：4 high + 1 medium（针对第二轮折法的洞），全部采纳——R3-P1-1 **事实勘误**（v5.100.10 hook 级 onSuccess 卸载后仍无条件执行）+ 迟到终态回调可清空 B 的脏 scope 并强制导航 → provider 单调 scopeId、mutation 发起时捕获、`clearScope(scopeId)`/navigate 双门控（§3.3/§3.4，矩阵⑱）；R3-P1-2 未取消的详情 GET 把 saved cache 打回旧值、clean-follow 重播种旧值为干净 → onSuccess 写 detail cache 前 `await cancelQueries(detailKey, exact)` fence（§3.3/§4，矩阵⑲）；R3-P1-3 restore 未清理 keep-mounted 文件编辑器与 `['skill-file*']` 缓存、旧缓冲可部分撤销恢复 → restore=全详情 scope 原子 rebase（`restoreEpoch` 容器 key 强制重挂 + 五组 key 失效，§5.2，矩阵⑳）；R3-P1-4 大小写不敏感 APFS 下 `skill.md`/`Skill.md` 绕过词法守卫 → 规范化 + ASCII case-fold、纯函数前后端共享两 OS 语义一致（realpath/inode 兜底再 scope 到 170；§5.2，矩阵⑭扩展）；R3-P2-5 探针「读快照→保存→记 startedAt」TOCTOU 跨多毫秒、残余声明不实 → 后端守卫之二：startedAt 捕获前移到快照读取之前（零 schema，§5.3，矩阵㉑）+ 残余声明修订。§0/proposal 非目标同步改口「后端两处小守卫」。

第四轮 verdict **needs-attention**：3 high（scopeId 门控/保存留原地/GET fence/startedAt 前移获评「基本闭合」），全部采纳——R4-P1-1 `deleteSkillFile` 词法判等可被 `./`、大小写、尾随分隔符别名绕过**真删主文件**（比写路径更狠的现存漏洞）→ 保护谓词 `isProtectedSkillMainFile` 抽单点、写删两入口共用 + 负向对照防误伤（§5.2/§0，矩阵⑭）；R4-P1-2 restoreEpoch 仍非原子——pending save 无法放弃可在恢复后落库撤销恢复、refetch 在途窗口输入以旧值为基 → restore 升级为**详情 scope 排他事务**（169 保留前端部分：pending 时禁入 / cancel→await 权威快照→再重挂解锁；跨窗口 `expectedVersion` 版本栅栏转 170）（§5.2，矩阵㉔）；R4-P1-3 clearScope 会把未提交的本地缓冲伪装成已保存（JsonField 无效 JSON 不进 payload、创建成功后唯一脏证据被清）→ token 分 `draft|buffer` 两类 + **终态动作发起前置检查**（当前路径 dirty buffer=按钮禁用带理由；其他模式 buffer=确认丢弃后才提交），onSuccess clearScope 语义收窄（§3.4，矩阵⑬修订+㉒㉓）。§0/proposal 后端改动清单更新为三处。

第五轮起（R5–R16）设计门发现**全部集中在 skills 存储层与 ACL 一致性域**（复合 token/世代 · 全域 OCC · 快照权威 · 崩溃恢复/quarantine · 存量迁移多代候选 · replace journal · source 生命周期 ACL · 创建 reservation · ACL PUT aclRevision）——这些是**先于本 RFC 的现存缺陷**、与双栏 UI 改造无因果关系。用户 2026-07-12 拍板**拆分**：169 收窄为 UI + 两小后端件（SKILL.md 守卫 + 探针修复；skills 保存/读取沿用现状 double-PUT LWW，combined-save/CAS 整套经 slim 复审第四轮定案转 170），R5–R16 的完整发现链（12 轮、24 findings）与存储矩阵子集（㉗㉙㉚㉜㉞㉟㊱㊲ 等）**整体归档到 [RFC-170 §设计门记录](../RFC-170-skills-storage-acl-hardening/design.md)**。169 本身在 UI 域自 R2 起四轮收敛、R5 后 UI 域零发现。

## 10. 实现期备注（IMPLEMENTATION-NOTE，不阻断设计门）

- **skills 保存的前端改动**：onSuccess 从「跳回 /skills」改为 reseed 父草稿留原地 + best-effort refetch detail+versions 刷新版本历史 + restore 成功 restoreEpoch 重挂 rebase；版本操作标准 `isPending` 按钮互斥（三次定案：不建精密前端版本一致性 gate、深层同页/跨页/离线一致性转 170）。双 PUT 通道/双查询播种/双通道错误沿用现状 `skills.detail.tsx`/`DetailHeaderActions.errors`。
- **combined-save / 单 fenced read / contentVersion CAS 及其实现备注整体在 [RFC-170 §实现期备注](../RFC-170-skills-storage-acl-hardening/design.md)。**
- **存储层实现备注（跨 OS 原子目录交换、ZIP 候选级 409、quarantine 注入点等）整体在 [RFC-170 §实现期备注](../RFC-170-skills-storage-acl-hardening/design.md)。**
