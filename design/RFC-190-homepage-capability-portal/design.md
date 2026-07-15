# RFC-190 · 技术设计

状态：Draft（Codex 设计门已过一轮：0 P0 / 9 P1 / 6 P2，全部折入 v2，处置表见 §8；待用户批准）
研究基线：2026-07-15 两路并行深读（后端 ACL/计数面 · 前端首页/Onboarding 测试锁清单），所有 file:line 以当日 main 为准。

## 1、范围与既有锁（不变式）

本 RFC 改动面 = 后端新增一个只读聚合端点 + 前端 `components/home/*` 与 `Onboarding.tsx` 重排 + `/memory` 路由加 `tab` 深链参数 + styles.css/i18n 增量。以下**既有测试锁必须保持成立**（迁移可以改测试文件，但断言强度不得下降）：

| 锁 | 出处 | 处置 |
| --- | --- | --- |
| testid `homepage` / `homepage-section-inbox` / `-running` / `-recent`、**inbox 在 running 之上**、`homepage-start-task`(href=/tasks/new)、`homepage-runtime`、`task-row-<id>`、`inbox-preview-{review,clarify}-<key>`；**空数据下三个 section testid 仍须存在**（homepage.test.tsx:181-191） | `tests/homepage.test.tsx`、`e2e/nav-redesign.spec.ts:92-135` | 全部保留：三个任务组以子分组形式**恒渲染**于「任务动态」单卡内（不做统一空态收敛，设计门 P1-1），testid 挂子分组容器 |
| 「打开收件箱」必须是 `<button>`（无 href）且翻转 `stores/inbox` `setInboxOpen(true)` | `tests/homepage.test.tsx:289-305` | 子分组头部动作原样保留 |
| `HomepageGreeting.tsx` 源码必须含 `/api/runtimes/status`、不得含 `/api/runtime/opencode` | `tests/homepage-runtime-status.test.ts:145-152` | 文件名与 runtime 探测逻辑不动，hero 在该文件内扩展 |
| `home.taskRow.status*` 键**不得复活**；任务行状态文案走 `tasks.status.*` + `<StatusChip>`/`TASK_STATUS_KIND` | `tests/task-status-i18n.test.ts:37-58`、`tests/status-chip-grep.test.ts` | task-row.tsx 不动 |
| i18n zh/en 扁平键集全等（新增键三处同改：`Resources` 接口 + zhCN + enUS） | `tests/i18n-keys-symmetry.test.ts:28-35` | 新键按 §3.8 清单三处落 |
| `.onboarding` 必须保留 `max-width:\d+px` | `tests/page-fills-content-width.test.ts:32-50` | 保留（720→960px，仍满足断言） |
| Onboarding 四步标题正则（`/1\..*agent/i` 等）、手动创建 CTA 指向 workflows 列表页、demo 导入 POST `/api/workflows/import?onConflict=new` | `tests/onboarding.test.tsx`、`tests/workflows-pages.test.tsx:451-452` | 四步/导入/skip 全保留，翻新只加 hero 与能力介绍 |
| `.capability-card*` 类名已被 `AgentCapabilityCard` 占用（`capabilityCard.*` i18n 亦锁） | `tests/agent-capability-card.test.tsx:51` | 新卡片不引入新 chrome，复用 `.card`（§3.5），布局类命名 `.home-cap*` |
| 品牌渐变 id `aw-stream-a/b/c` 源级锁在 `__root.tsx`；页面内 id 不得重复 | `tests/sidebar-brand-icon.test.ts` | hero SVG 用自有 id `aw-pipe-a/b/c`，色值复制品牌三组渐变 |
| `/` 全页 axe 无 critical/serious | `e2e/a11y.spec.ts:199-206` | hero SVG `aria-hidden`，卡片为带可达名称的 `<Link>`；**注意该用例现状跑在空库=Onboarding 上**（P1-5），需补种子后 homepage 的 axe case |
| 后端 API contract registry：`routes/*.ts` 任何新端点缺登记直接红 | `tests/api-contract-coverage.test.ts:79-89`、`tests/contracts/README.md:24-39` | `GET /api/overview` 登记 `contracts/registry.ts` + happy fixture（P1-4） |
| 视觉基线 `homepage-chromium-{darwin,linux}.png` **实际截的是 Onboarding**（空库首跑；已读图核实） | `e2e/visual-regression.spec.ts:35-38,120-125`、`e2e/harness.ts:95-108` | 拆两用例：空库 Onboarding 基线 + 种子后真 Homepage 基线（§4.3，P1-5） |

无 DB migration、无既有端点行为变更；`GET /api/overview` 为纯新增只读面。

## 2、后端：`GET /api/overview`

### 2.1 契约（shared schema）

新文件 `packages/shared/src/schemas/overview.ts`（`index.ts` 加 `export *`）：

```ts
export const OverviewResourcesSchema = z.object({
  // per-key null 规则 = 镜像对应列表路由的粗粒度门（server.ts:128-151）：
  // 列表路由有 `<res>:read` 粗门的 key，actor 缺该权限 → null（不泄露存在性）；
  // workgroups / scheduled 的列表路由无粗门（任意认证 actor 可读、行级过滤）→
  // 恒为数字，与列表口径一致（设计门 P1-3：不虚构不存在的权限点）。
  agents: z.number().int().nonnegative().nullable(),      // agents:read
  skills: z.number().int().nonnegative().nullable(),      // skills:read
  mcps: z.number().int().nonnegative().nullable(),        // mcps:read
  plugins: z.number().int().nonnegative().nullable(),     // plugins:read
  workflows: z.number().int().nonnegative().nullable(),   // workflows:read
  workgroups: z.number().int().nonnegative(),             // 无粗门，恒计数
  repos: z.number().int().nonnegative().nullable(),       // repos:read
  scheduled: z.number().int().nonnegative(),              // 无粗门，恒计数（行级 owner/admin）
  memories: z.number().int().nonnegative().nullable(),    // memory:read
})
export const OverviewTasksSchema = z.object({
  running: z.number().int().nonnegative(),
  awaiting: z.number().int().nonnegative(),   // awaiting_review + awaiting_human
  done7d: z.number().int().nonnegative(),     // status='done'  且 finishedAt ≥ now-7d
  failed7d: z.number().int().nonnegative(),   // status='failed' 且 finishedAt ≥ now-7d
})
export const OverviewResponseSchema = z.object({
  resources: OverviewResourcesSchema,
  tasks: OverviewTasksSchema.nullable(),      // 真值表见 §2.3；两个 read 权限都缺 → null
  generatedAt: z.string(),                    // ISO；与 7d cutoff 同一次时钟捕获
})
```

「成功率」不进契约，由前端 `done7d/(done7d+failed7d)` 现算（分母 0 不显示）——避免后端定死展示口径。

### 2.2 计数口径（逐资源）

| key | 数据源 | 可见性过滤 | 权限（缺则 null） |
| --- | --- | --- | --- |
| agents | `excludeBuiltinAgents(listAgents(db))` | `filterVisibleRows(db, actor, 'agent', …)`（`services/resourceAcl.ts:104-113`） | `agents:read` |
| skills | `listSkills(db)`（本身只回 `reservation_state='ready'`，`services/skill.ts:61-63`） | 同上 `'skill'` | `skills:read` |
| mcps / plugins / workflows / workgroups | 各 list service；workflows 走 `excludeBuiltinWorkflows` | 同上（六类均在 `ACL_TABLES`，`resourceAcl.ts:64-71`） | `mcps:read` / `plugins:read` / `workflows:read` / workgroups **无粗门恒计数** |
| repos | **新增轻量 `countCachedRepos(db)`**（`select count(*) from cached_repos`）——不复用 `listCachedRepos`：它每 repo 一次任务引用 `count(tasks)`（`gitRepoCache.ts:643-657`），整表调用是 1+N 查询 + 全量 DTO（设计门 P1-6） | 无（表无 owner/visibility，与 `/api/cached-repos` 全员同数） | `repos:read` |
| scheduled | `listScheduledTasks(db)` | `canViewScheduledTask(actor,row)`（现在 `routes/scheduledTasks.ts:33-38`，**本 RFC 移入 `services/scheduledTasks.ts` 导出**，route 与 overview 共用单源） | 无粗门恒计数（行级已表达） |
| memories | `listMemories(db, { status: 'approved' })` | `filterMemoriesByScopeVisibility(db, actor, rows)`（`services/memory.ts:760-803`） | `memory:read` |

- 六 ACL 类沿用「整表加载 + JS 后过滤」既有约定（`resourceAcl.ts:98-102` 明文档定），保证与列表接口口径永不漂移；repos 是唯一例外（只要 cardinality，count(*) 与列表长度恒等，oracle 测试锁住等式）。
- memories 取 `approved`（平台「可用记忆池」；candidate 已有侧栏 pending 徽标表达，不混）。

### 2.3 任务统计（真值表 + 可注入时钟）

权限真值表（镜像 `routes/tasks.ts:143-162` 的 scope 决策，设计门 P1-2）：

| actor 权限 | scope | tasks 字段 |
| --- | --- | --- |
| 有 `tasks:read:all`（不论是否有 own） | 全量（无可见性谓词） | 计数 |
| 仅 `tasks:read:own` | owner OR `task_collaborators` 成员 | 计数 |
| 两者皆无（scoped PAT） | — | `null` |

- 可见性谓词与 `listTasks` 同源：现谓词内联在 `services/task.ts:2487-2504`。本 RFC 抽 `taskVisibilityCondition(visibility)` 于 `services/task.ts` 导出，`listTasks` 与 overview 共用（防两处漂移）。
- 4 个 `count()`（drizzle `count()` 先例：`services/task.ts:2518-2529`）：`running`（status='running'）、`awaiting`（IN awaiting_review/awaiting_human）、`done7d` / `failed7d`（status 匹配且 `finishedAt >= cutoff`；`finishedAt` nullable epoch-ms，`schema.ts:732`；canceled/interrupted 不进 7d 口径）。`finishedAt` 无索引——单机规模 + 60s 轮询可接受，不为此加 migration。
- **时钟注入**（设计门 P2-1）：`buildOverview(db, actor, now: () => number = Date.now)`——单次捕获 `const t = now()`，同时用于 `cutoff = t - 7*86_400_000` 与 `generatedAt`（仓内惯例：`services/autoResume.ts:38-43` 的 `now?: () => number`）。测试用固定 now 断言边界前 1ms / 恰好 / 后 1ms。

### 2.4 装配

- 新 `packages/backend/src/routes/overview.ts`：`export function mountOverviewRoutes(app, deps)`，handler = `c.json(await buildOverview(deps.db, actorOf(c)))`；`server.ts` 注册块（`:182-213`）加一行。仅靠 `/api/*` `multiAuth`（`server.ts:97`），**不加**粗粒度门——权限粒度由 per-key null 表达。
- **API contract registry**（设计门 P1-4）：`tests/contracts/registry.ts` 登记 `GET /api/overview` + authenticated happy fixture（响应过 `OverviewResponseSchema`）+ 匿名 401 锁——否则 `api-contract-coverage.test.ts:79-89` 必红。
- 新 `packages/backend/src/services/overview.ts`：`buildOverview` 纯读、无副作用。
- 归属/用户名等**不进响应**（只有数字），与 RFC-099 prompt-isolation 无交集。

### 2.5 失败模式

- 单资源计数抛错（如 fs 索引损坏）→ 整请求 500（一致性优先，前端有降级）；不做部分成功语义。
- 未认证 → 既有 `multiAuth` 401（contract fixture 锁）。

## 3、前端

### 3.1 组件树（非首跑）

```
<div class="page homepage" data-testid="homepage">
  <HomepageGreeting/>            // 演进为 hero：左=问候+runtime 行+脉搏行+CTA；右=<PipelineHero/>
  <CapabilityGrid/>              // 新：六卡矩阵（/api/overview）
  <TaskFeed/>                    // 新：任务动态单卡（三子分组恒渲染，替换原三个 <HomepageSection>）
</div>
```

`HomepageSection.tsx` 迁移后无调用方 → 删除（删除优于 deprecate）；其 `__count`/`__link` 等样式类被 TaskFeed 子分组头沿用，CSS 不重写。

### 3.2 取数：`useOverview`

`components/home/useOverview.ts`：`useQuery({ queryKey: OVERVIEW_HOME_QUERY_KEY=['overview','home'], queryFn: api.get('/api/overview'), staleTime: 30_000, refetchInterval: 60_000 })`。CapabilityGrid 与 HomepageGreeting（脉搏行）共用；错误→卡片显示占位「—」+ 一条 compact 重试行（复用 `home.section.error.*` 文案），不阻塞其余首页。

### 3.3 PipelineHero（平台特点视觉）

- `components/home/PipelineHero.tsx`，纯手写 SVG（零依赖），`.pipeline-hero` 命名空间；外层 `<Link to="/workflows" aria-label={t('home.pipeline.open')}>`，`<svg aria-hidden="true">`。
- 拓扑与平台核心抽象**逐段对齐**（设计门 P1-8；`CLAUDE.md` Code→Audit→Fix：审计结果先聚合再进 fixer；fan-out aggregator 现实见 `scheduler.ts` aggregator 收集 shard 输出）：`[git 快照] → [编码] ⇉ [审计]×3（扇出）→ [聚合] → [修复]`。聚合画为小型汇合节点（kind 标 `AGG`），三条审计边扇入其左侧。
- 节点视觉呼应画布 `.canvas-node`（`styles.css:4667-4707`：`var(--panel)` 底、`var(--border)` 1px、radius 8、uppercase kind 小标 + 标题），kind 标示 `GIT / AGENT / AGENT ×3 / AGG / AGENT`。
- 三条扇出边分别用品牌三渐变色（stop 值复制 `__root.tsx:87-119`：`#10b981→#06b6d4`、`#3b82f6→#a855f7`、`#ec4899→#f97316`），渐变 id `aw-pipe-a/b/c`（避免与源级锁的 `aw-stream-*` 撞 id）；干线边用 `var(--border-strong)`。
- 动画（纯 CSS，三套 selector 单列便于测试锁）：①`.pipeline-hero__edge`：`stroke-dasharray`+`stroke-dashoffset` 匀速行进；②`.pipeline-hero__dot`：光点 `<circle>` 走 CSS `offset-path: path('…')` 循环；③`.pipeline-hero__node--live`：审计组呼吸。**三者均在 `@media (prefers-reduced-motion: reduce)` 内逐 selector `animation: none`**（仓内 idiom：`styles.css:5192-5200`/`5233-5242`；测试锁到 selector 粒度，设计门 P2-3）。
- 主题：全部用 token（`--panel/--border/--text/--muted/--accent`），`data-theme` 级联自动适配暗色；渐变 stop 为品牌常量、双主题同值（与侧栏 logo 同理）。
- 节点文字 `<text>` 用 i18n（`home.pipeline.snapshot/code/audit/aggregate/fix`）；SVG 下方一行 caption（`home.pipeline.caption`，muted）。
- 响应式：hero 右列 `min-width` 不足（<~900px 容器）时管线换行至问候语下方；`viewBox` 等比缩放。
- e2e 视觉回归以 `animations:'disabled'` 截图，CSS 动画被冻结，基线稳定。

### 3.4 hero 脉搏行

`HomepageGreeting.tsx` 内（文件名/`describeRuntimes`/`__test__` 出口不动，源级锁 §1）：runtime 行下加一行 muted 小字 `home.pulse.line`（插值 running/awaiting/done7d + 成功率；成功率分母 0、`tasks:null` 或查询未回时整行省略）。CTA 区在「启动任务」旁加次级 `<Link to="/workflows" class="btn">`（`home.newWorkflow`）。

### 3.5 CapabilityGrid（六卡，复用 Card 原语）

- **卡片 chrome 复用公共 `Card`**（设计门 P1-9）：最小扩展 `components/Card.tsx`——新增可选 `to?: string` prop，传入时根节点渲染 TanStack `<Link to>`（保持 `.card card--interactive` 类与全部槽位、向后兼容 div 用法，所有调用方受益）。`.home-cap*` 只承担**布局**（`.home-cap-grid` = CSS grid `repeat(auto-fit, minmax(220px,1fr))`；卡内 icon/count/title/desc 排布类 `.home-cap__*`），**不产生第二套边框/hover/focus chrome**。
- `components/home/CapabilityGrid.tsx`；六卡（testid `home-cap-<key>`）：代理→`/agents`、工作流→`/workflows`、工作组→`/workgroups`、记忆→**`/memory?tab=all`**、定时任务→`/scheduled`、仓库→`/repos`。
- **/memory 深链**（设计门 P2-6）：`/memory` 路由加 `validateSearch`（可选 `tab` ∈ MemoryTab 枚举，`routes/memory.tsx:31`，缺省 `'approval-queue'` 行为不变），初始 tab 取 search；受测试保护。卡片计数=approved 池 → 落地 `all` tab（its 默认 view 即 approved，`MemoryAllList.tsx:42-45`），数字与落地页可对账。
- 卡内容：图标 + 大数字（`resources[key]`；null→「—」muted，aria 文案 `home.cap.countUnavailable`）+ 名称 + 一句能力描述（`home.cap.<key>.desc`，产品口径：工作流=「画布编排：git 快照、循环、多进程扇出」、工作组=「领导者带队的自治多代理协作」等）。
- 代理卡副行：`home.cap.agents.sub`（`技能 {{skills}} · MCP {{mcps}} · 插件 {{plugins}}`；任一为 null 时省略该项，全 null 整行省略）。
- 图标：扩展既有公共图标模块 `components/icons/resourceIcons.tsx`（已有 AGENT/SKILL/MCP/PLUGIN 等，16×16 `stroke="currentColor"` `aria-hidden`）——新增 `WORKFLOW_ICON / WORKGROUP_ICON / MEMORY_ICON / SCHEDULE_ICON / REPO_ICON`，全库复用而非首页私有。
- intro 变体（Onboarding 用）：`<CapabilityGrid variant="intro"/>` 不发请求、不渲染计数行。

### 3.6 TaskFeed（三区合并单列）

- `components/home/TaskFeed.tsx`：一张 `.homepage-section` 卡，标题 `home.feed.title`（任务动态）；**不设总数 chip**（三组口径不同且互有重叠——running 组含 awaiting、inbox 是 action 数，homepage.test.tsx:194-196 注释已明示重叠；设计门 P2-4）。
- 体内三个子分组**恒渲染**、按序 **inbox → running → recent**（顺序锁）；各子分组保留自己的空态/加载/错误呈现（子组件现状），**不做整卡统一空态**（设计门 P1-1——空态白板问题已由 hero+六卡解决）。
- 子分组头复用 `.homepage-section__title/__count/__count--warn/__link` 类：inbox 头动作为 `<button>` `setInboxOpen(true)`（锁）、running 头链接 `/tasks?status=running`、recent 头链接 `/tasks`；子分组容器分别挂 `data-testid="homepage-section-inbox/-running/-recent"`（锁）。
- 三个列表组件 `InboxPreviewList/RunningTaskList/RecentlyDoneList` **零改动**复用（query key、行 testid、轮询节奏全保留）。

### 3.7 Onboarding 翻新

- 保留：探测逻辑 `useOnboardingProbe`/`computeIsFirstRun`、四步骤列表（标题维持 `1. …agent` 数字前缀模式）、demo 导入 mutation、skip 链接——全部测试锁不动。
- 新增：页首 hero（`<PipelineHero/>` 复用 + `onboarding.heroTitle/heroIntro` 开场白，直述平台能力：多代理流水线编排/进程级隔离/人机协同）+ 步骤列表上方 `<CapabilityGrid variant="intro"/>`（不发请求、无计数，首跑空库不出一排 0）。
- `.onboarding` `max-width` 720→960px（容纳 hero；仍满足源级断言「存在 max-width」）。

### 3.8 i18n 新键（三处同改：`Resources` 接口 + zhCN + enUS）

`home.pipeline.{snapshot,code,audit,aggregate,fix,caption,open}`；`home.pulse.line`；`home.newWorkflow`；`home.cap.{agents,workflows,workgroups,memory,scheduled,repos}.{title,desc}` + `home.cap.agents.sub` + `home.cap.countUnavailable`；`home.feed.title`；`onboarding.{heroTitle,heroIntro}`。不新增 `home.taskRow.*` 任何键。

## 4、测试策略（随各任务落地，无「先实现后补测」段）

### 4.1 后端（`packages/backend/tests/rfc190-overview-route.test.ts` + contract registry）

harness 复制 `rfc099-resource-routes.test.ts:27-66`（in-memory db + `createApp` + alice/bob/admin + Bearer `req`）。必写 case：

1. **口径 oracle（防漂移主锁）**：对 alice/bob/admin 三 actor——`overview.resources.<k>` 恒等于对应列表接口返回长度（六 ACL 类种子含 private/public/granted 混合；skills 含 reserving 行验证不计；agents/workflows 含 builtin 验证不计；repos 直插 `cached_repos` 两行、断言 `countCachedRepos == (GET /api/cached-repos).items.length`；scheduled owner 隔离；memories 含 agent-scope private 资源上的行验证 scope 过滤 + 非 approved 不计）。
2. **任务窗口（固定时钟）**：直插 tasks + task_collaborators 行（`tasks-visibility.test.ts` 种子法），`buildOverview(db, actor, () => T0)` 固定 T0——owner/协作者/无关三视角 running/awaiting；`finishedAt = T0-7d-1ms / T0-7d / T0-7d+1ms` 三点边界；canceled/interrupted 不进 7d。
3. **权限真值表（buildOverview 单元 × 伪造 actor 权限集）**：缺 `repos:read` → `repos:null` 其余照常；`tasks:read:all` 仅有 → tasks=全量口径；仅 `tasks:read:own` → mine 口径；两者皆无 → `tasks:null`；workgroups/scheduled 在无关 scope 下仍为数字。
4. **contract registry**：`GET /api/overview` 登记 + happy fixture 过 `OverviewResponseSchema` + 匿名 401（`api-contract-coverage.test.ts` 门禁）。
5. `generatedAt` 可 `Date.parse` 且等于注入 now 的 ISO。

### 4.2 前端（vitest；沿用 homepage.test.tsx 的 fetch-spy + QueryClient 包装模式）

1. `homepage.test.tsx` 迁移：fetch mock 增加 `/api/overview` 合法 fixture 分支；既有全部断言（testid/顺序/空数据三 section 存在/收件箱按钮/runtime 行）原样跑绿。
2. **`index-page-routing.test.tsx`**：mock 增 `/api/overview` 合法 fixture（其兜底 `[]` 不符合契约，设计门 P2-2）；first-run/non-first-run 分支锁不变。
3. 新 `capability-grid.test.tsx`：六卡计数渲染、null→「—」、href 表（含 `/memory?tab=all`）、agents 副行、intro 变体零 `/api/overview` 请求（fetch spy 断言）、Card `to` 扩展的回归（div 用法调用方不受影响）。
4. 新 `pipeline-hero.test.tsx`：svg `aria-hidden`、外层 Link aria-label、渐变 id 前缀 `aw-pipe-`（并断言不含 `aw-stream-`）、含 aggregate 节点文案；**源级锁**（`running-node-highlight-styles.test.ts:67-75` 模式）：reduce-motion 块内 `.pipeline-hero__edge/.pipeline-hero__dot/.pipeline-hero__node--live` 三 selector 均 `animation: none`。
5. `onboarding.test.tsx` 增量：hero 与 intro 网格渲染；四步/导入既有断言不动。
6. `/memory` tab 深链：search→初始 tab 的路由测试（缺省行为不变）。
7. i18n symmetry / task-status-i18n 等全局锁自动生效。

### 4.3 e2e / 视觉（P1-5 拆分）

- 现有「homepage」visual/a11y 用例实测跑在空库=Onboarding 上（已读 PNG 核实）。拆为两组：
  - **Onboarding**：空库 `/` → 更名基线 `onboarding.png`（覆盖翻新后首跑页）+ axe。
  - **Homepage（非首跑）**：按 `nav-redesign.spec.ts:92-130` 种子法先建 agent+workflow，等待 `[data-testid="homepage"]` 再截 `homepage.png` + axe——新 hero/六卡/任务动态首次获得真实视觉与 a11y 覆盖。
- `nav-redesign.spec.ts` 首页断言（testid 集）应零改动跑绿。
- 基线刷新：darwin 本地 `RUN_VISUAL_REGRESSION=1 bun run e2e e2e/visual-regression.spec.ts --update-snapshots`；linux 按 `e2e/visual-regression.README.md` nightly 流程；新旧 PNG 同 PR 提交。
- 手动视觉自查（feedback_frontend_visual_verify_repro）：light+dark **+ 窄屏（<900px）** 三态截图，与 /agents /workflows 并排对齐。

## 5、失败模式与降级

- `/api/overview` 请求失败：六卡显示「—」+ compact 重试行；hero 脉搏行省略；任务动态区不受影响（独立取数）。
- 慢查询：纯 count/整表扫（repos 已改 count(*)，P1-6），单机 SQLite 规模远低于可感知阈值；60s 轮询无叠加请求（react-query 去重）。
- 空库非首跑（有 agent 无任务）：卡片显示真实 0，任务动态三组各自空态——页面不再是白板（hero + 卡片恒在）。

## 6、决策记录

- **D1** 计数复用「整表 + filterVisibleRows」而非 SQL count（repos 除外，P1-6 改 `countCachedRepos`）：与列表路由口径机械一致，oracle 测试再上一道锁。
- **D2**（v2 重写）per-key null 原则 = **镜像对应列表路由的粗粒度门**：有粗门缺权限 → null（不泄露存在性）；无粗门（workgroups/scheduled/tasks 族）→ 与列表路由同样对任意认证 actor 计数。session 用户基线含全部 read，实际只影响 scoped PAT。
- **D3** memories 计 `approved`，卡片深链 `/memory?tab=all`（落地页默认 view 即 approved，数字可对账）。
- **D4** `canViewScheduledTask` 与任务可见性谓词各抽单源（service 层导出）：overview 与列表路由共用，防第二份实现漂移。
- **D5**（v2 修订）三任务区合并为单卡三子分组**恒渲染**：保留全部 testid/顺序/空数据存在性/收件箱按钮锁；不做统一空态、不设总数 chip（口径重叠，P1-1/P2-4）。
- **D6** hero 动画纯 CSS（dashoffset + offset-path + 呼吸，三 selector 单列）：零依赖、`animations:'disabled'` 下天然冻结、reduce-motion 逐 selector 关断可测；不用 SMIL。
- **D7** `HomepageGreeting.tsx` 原地演进不改名：源级锁 grep 该文件名。
- **D8**（v2 重写）卡片 chrome 复用公共 `Card`，最小扩展 `to` prop（Link 根、向后兼容）；`.home-cap*` 仅承担布局，不 fork chrome。
- **D9** 成功率前端现算：展示口径（分母 0 隐藏）属 UI 决策，后端只给事实计数。
- **D10** `buildOverview` 注入 `now`（单次捕获，cutoff 与 generatedAt 同源）：7d 边界可测且无时序偶然（P2-1）。
- **D11** tasks 权限真值表三行（read:all → 全量 / read:own → mine / 皆无 → null），镜像 `routes/tasks.ts:143-162`；不在本 RFC 顺手改 `/api/tasks` 粗门现状（记录为已知口径，超范围）。

## 7、待批准确认点

1. memories 计数口径 = `approved` + 深链 `/memory?tab=all`（连带给 `/memory` 加 `tab` search 参数）。
2. hero 脉搏行（运行中/等待/7d 完成+成功率一行小字）进本期范围。
3. `.onboarding` 拓宽 720→960px。
4. e2e 视觉基线拆分：`onboarding.png`（空库）+ `homepage.png`（种子后非首跑）——旧「homepage」基线实际是 Onboarding，本次更名归位。

## 8、设计门处置表（Codex 2026-07-15，18m，NOT APPROVE → v2 全折入）

| # | 发现 | 处置 |
| --- | --- | --- |
| P1-1 | TaskFeed 统一空态与三 section testid/空数据存在性锁矛盾 | 采纳方案一：三子分组恒渲染、各自空态，不做统一空态（§3.6、§1、D5） |
| P1-2 | tasks 权限判定漏 `tasks:read:all` | 真值表三行入契约与测试（§2.3、§4.1-3、D11） |
| P1-3 | workgroups/scheduled 无对应权限点，per-key null 承诺不成立 | D2 重写为「镜像列表路由粗门」原则；两 key 改恒计数、schema 注释与测试对齐（§2.1、§4.1-3） |
| P1-4 | 漏 API contract registry 登记（必红门禁） | §2.4/§4.1-4 增登记 + happy fixture + 匿名 401 |
| P1-5 | 现有 homepage visual/a11y 基线实为 Onboarding（空库首跑） | 已读 PNG 实锤；§4.3 拆两用例、基线更名归位；§1 表更新 |
| P1-6 | `listCachedRepos` 计数产生 1+N 查询 | 新 `countCachedRepos(db)` count(*)；oracle 锁与列表长度恒等（§2.2、D1） |
| P1-7 | plan.md 测试后置违反 test-with-every-change | plan v2：测试并入各任务，原 T9 改全量交叉回归（plan.md） |
| P1-8 | hero 拓扑漏聚合节点、proposal/design 互相矛盾 | 统一为 快照→编码→审计×N→**聚合**→修复；补节点/i18n/测试（§3.3、§3.8、proposal G2） |
| P1-9 | 新 `.home-cap` chrome 绕开公共 `Card` 违反 UI 复用强制原则 | Card 最小扩展 `to` prop（Link 根）；`.home-cap*` 仅布局（§3.5、D8） |
| P2-1 | 7d 边界无可注入时钟 | `buildOverview` 注入 `now`，三点边界测试（§2.3、D10） |
| P2-2 | `index-page-routing.test.tsx` 漏 `/api/overview` mock | §4.2-2 列入迁移矩阵 |
| P2-3 | 动画/暗色/窄屏测试强度不足 | reduce-motion 锁到三 selector 粒度；手动自查加窄屏（§3.3、§4.2-4、§4.3） |
| P2-4 | TaskFeed 总数 chip 无无重复口径 | 删除总数 chip（§3.6、D5） |
| P2-5 | 门禁命令写法不可执行 + STATE 收尾 SHA 矛盾 | plan v2 T 收尾：完整 `bun run` 命令；实现 commit 验证 CI 后，STATE/索引 Done 作为 docs-only 后续提交再看一轮 CI |
| P2-6 | 记忆卡数字与落地页（approval-queue 默认 tab）对不上 | `/memory` 加受测试保护的 `tab` search 深链，卡片 → `?tab=all`（§3.5、D3、§7-1） |
