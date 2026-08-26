# RFC-244 · 技术设计 —— 高密度任务运行中心

状态：Done（首轮与 focused 复审 findings 已全部折入 Draft v3；closing 设计门与固定 SHA 实现门
均 `APPROVED — P0=0/P1=0/P2=0`；2026-08-01 用户批准并授权上库；最终代码 SHA
`1fbbd46388d458afda526115786c045ea17ac133`）。

## 0. 摘要

本 RFC 将 `/tasks` 从「一次拉 500 条再前端筛的宽表」改为「服务端分页的响应式任务树」。

- 新增静态路由 `GET /api/tasks/page`，放在 `/api/tasks/:id` visibility middleware 之前；旧
  `GET /api/tasks` 与全部既有调用方保持兼容。
- 首层为四个业务视图；精确状态与其他维度进入筛选面板，所有查询状态进入 URL。
- 后端先建立 ACL-only authorized set，再完成归属/搜索/视图筛选、facet、可见祖先闭包和 keyset
  pagination；ownership scope 不充当父子关系的授权边界。
- 前端始终按树呈现；未授权/dangling parent 在服务端成为边界，不再由客户端探测。
- 列表查询使用显式轻量 projection，禁止读取 task 大 JSON；页内 enrichment 继续批量化。
- 桌面常态 56px / 子行 48px；移动端重排成单列记录，不横向滚动。

## 1. 当前事实与需要保留的契约

### 1.1 现有列表

`packages/frontend/src/routes/tasks.tsx` 当前：

- URL 只保存一个 `status`；主体、名称和子任务范围是 component state；
- 请求 `/api/tasks?include_owner=true&limit=500`，主体与名称在客户端过滤；
- 默认顶层，`include_children=true` 改成 flat 列表；默认模式通过
  `GET /api/tasks?parent_id=<id>` 懒加载直接子任务；
- 8 列依次为状态、任务、主体、Owner、仓库、开始、耗时、展开；
- `useTasksSync()` 让 `['tasks']` 前缀在 task WS 事件后失效。

### 1.2 现有后端

`packages/backend/src/routes/tasks.ts` 的 `GET /api/tasks` 支持：

- 单个 `status`；
- `workflow_id`、`repo_path`、`scheduled_task_id`；
- `include_children=true` 或 `parent_id`；
- `scope=mine|shared|all`；
- `include_owner=true`；
- `limit` 上限 500。

它返回数组而非分页 envelope。`listTaskSummaryRows` 以
`.select({ task: tasks, workflowName: workflows.name })` 读取完整 task row，再批量补
`openAlertCount`、`failureCode`、Owner 与 visible direct child count。

### 1.3 不变量

1. ACL 权威仍是 `canViewTask` 的语义：`tasks:read:all` 可读全部，否则 owner / collaborator 可读。
   SQL 侧抽出 alias-aware `taskAuthorizationCondition(db, taskRef, actor)`；既有
   `taskVisibilityCondition(..., mine|shared)` 继续服务 legacy scope，不拿 `shared` 充当 authorized
   set。无 `tasks:read:all` 的 actor 请求 `scope=all` 仍收敛为 `mine`。
2. `TaskSummarySchema`、`TaskListItemSchema`、既有 task WS message 形状和旧 `/api/tasks` wire 不改；
   只 additive 新增 `task.members.changed` / `lifecycle.alert.resolved` 通知与可等待的 revalidation
   adapter，legacy hook 的既有 variant 和既有调用点的 fire-and-forget 策略不变。
3. `taskExecutionKind()` 仍是 workflow / workgroup / agent 主体分类单源。
4. `TaskStatusChip`、`OwnerLabel`、`RelativeTime`、`formatDurationMs`、`TaskSubjectLink`、
   `shouldRowNavigate` 与公共反馈组件继续复用；RFC-192 的 wall-clock `taskDurationCell` 留给 legacy
   列表，新 endpoint 用 RFC-207 running clock 的专用 helper。
5. 子任务可见不蕴含父任务可见；任何树算法必须在每一行先做 task visibility，再谈祖先关系。
6. Owner 唯一 identity 不能成为 hover-only 信息；普通内容目标行高不能变成裁切上限。

## 2. 信息架构与交互

### 2.1 页面结构

桌面布局：

```text
任务                                                     [新建任务]
追踪运行状态、处理阻塞并查看调用链

[全部 128] [进行中 12] [需处理 5] [已结束 111]
[搜索任务、ID、主体或仓库……………………] [筛选 2] [清除]

任务                              执行              时间           Owner       ▸
▾ 发布支付服务                     ● 运行中           2 分钟前       王小明
  workflow · api-service · 01K…    已运行 03:18                    @xiaoming
  ├─ 安全审计                      ◐ 等待复核         1 分钟前       李娜
  └─ 部署预检                      ✓ 已完成           30 秒前        系统
▸ 每晚依赖升级                     ! 失败             昨天           Ops Bot
  scheduled · monorepo · 01J…      checkout failed                  @ops-bot

                                           [加载更多]
```

≤720px 的同一行重排为：

```text
▾  发布支付服务                         ● 运行中
   workflow · api-service · 01K…
   2 分钟前 · 已运行 03:18
   Owner  王小明  @xiaoming
```

移动端不维护第二套数据/交互组件；同一语义 DOM 通过 task-specific responsive CSS 改变列布局。

本节布局的权威细化见 [visual-contract.md](./visual-contract.md)：标题到列表必须形成一个完整 surface；
展开控件位于任务名左侧，最右 chevron 只表达进入详情；展开子任务进入带左侧 rail 的 inset well。

### 2.2 四个业务视图

shared 新增穷举常量，backend predicate、frontend label 和测试均从同一处消费：

```ts
export const TASK_LIST_VIEWS = ['all', 'active', 'attention', 'finished'] as const

export const TASK_LIST_ACTIVE_STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
] as const

export const TASK_LIST_FINISHED_STATUSES = ['done', 'failed', 'canceled', 'interrupted'] as const

export const TASK_LIST_ATTENTION_STATUSES = ['failed', 'awaiting_review', 'awaiting_human'] as const
```

口径：

| 视图   | SQL predicate                                                                 | 说明                           |
| ------ | ----------------------------------------------------------------------------- | ------------------------------ |
| 全部   | 无额外 view predicate                                                         | 默认；全部可见任务，包含子任务 |
| 进行中 | `status IN TASK_LIST_ACTIVE_STATUSES`                                         | 包含等待人工的非终态任务       |
| 需处理 | `status IN TASK_LIST_ATTENTION_STATUSES OR unresolved lifecycle alert EXISTS` | 行动队列，与其他视图重叠       |
| 已结束 | `status IN TASK_LIST_FINISHED_STATUSES`                                       | 终态集合                       |

`attention` 的 alert predicate 与 `openAlertCount` 都以
`lifecycle_alerts.resolved_at IS NULL` 为单源，不在前端猜。新 task status 加入 shared 枚举时，
穷举测试必须要求它明确归入 active 或 finished，attention 可选。

Facet 数字在 ACL + 搜索 + 高级筛选之后、当前 view 之前计算；计数单位是**匹配 task row**，包括
子任务，不是根分支数。因为视图允许重叠，四个数字不要求相加等于「全部」。祖先 context row 不
计入任何 facet。

### 2.3 搜索与筛选

首屏控制只有：

1. 四个业务视图；
2. 一个 search input；
3. 一个「筛选」按钮，显示 active filter count；
4. 有条件出现的「清除」。

筛选面板固定使用现有 `Dialog`（传 `triggerRef` 做 focus restore）、`Form`、`Segmented` 与
`MultiSelect`，不手写新 modal/popover/checkbox chrome。首版维度：

- 精确状态：`MultiSelect(allowCustom={false})`，保留公共组件默认的 searchable combobox 行为，
  options 直接来自 `TASK_STATUS`；输入按本地化 label / wire value 过滤，键盘 Enter 切换当前项；
- 主体：全部 / workflow / workgroup / agent；
- 归属范围：「我参与的」= owner 或 collaborator（legacy `mine`）/「与我共享」= collaborator 且
  非 owner（legacy `shared`）/「全部归属」= authorized set 全部（仅 `tasks:read:all` 展示）；
- 来源：全部 / 手动 / 定时。

交互口径：

- search 使用公共 `TextInput type="search"`；250ms trailing debounce 后以 router `replace` 写入 q，
  Enter/清空立即 flush。IME composition 期间不提交，compositionend 后才启动 debounce；browser
  back/forward 或外部 URL 变化反向同步 input draft。
- filter dialog 内允许本地 draft；「应用」一次性写 URL、关闭并把 focus 还给 trigger，「取消」不
  改 URL。active count 按非默认**维度**计数（选 3 个 statuses 仍算 1 维），不含独立的 q/view。
- 「清除」只清 q + advanced dimensions，保留当前业务 view；若产品需要回到 all，用户直接点「全部」。

搜索最大 100 个 Unicode code point，trim 后空串视为未设置。服务端大小写不敏感匹配：

- `tasks.name` 与完整 task id；
- workflow live display name、`tasks.source_agent_name`、冻结 workgroup name；
- `tasks.repo_path`、已脱敏 `tasks.repo_url`；
- `task_repos` 中任一 repo path / 已脱敏 URL（`EXISTS`，不把整组 repo 行载入列表）。

SQL LIKE 必须对 `%`、`_` 和 escape 字符自身转义；不得把 raw URL credential、worktree path、
inputs、prompt 或 workflow snapshot 纳入搜索或 response。首版定义 substring 语义，不偷偷改成
token-only FTS；FTS 是有独立兼容性设计后才可做的后续优化。

### 2.4 URL contract

`TasksSearch` 扩为：

```ts
interface TasksSearch {
  view?: 'active' | 'attention' | 'finished' // all 省略
  q?: string
  statuses?: string // 按 TASK_STATUS 顺序排序的逗号串
  subject?: 'workflow' | 'workgroup' | 'agent' // all 省略
  scope?: 'mine' | 'shared' | 'all' // actor 默认值省略
  origin?: 'manual' | 'scheduled' // all 省略
}
```

`validateSearch` 负责 trim、去重、枚举校验和 canonical ordering；status 重复值去重而非报错，
去重后为空或包含空 token 才报错。默认值从 URL 省略。每次筛选变化都通过 TanStack Router
`navigate` 更新 search，而不是写 component-local filter state。actor 加载后再做 effective-scope
canonicalization：管理员默认 `all`、普通 actor 默认 `mine`；普通 actor 的 `scope=all` 收敛并
replace 为省略的 `mine`，不会把无效扩权意图留在可复制 URL 中。cursor 不进入 URL：页面恢复的是
筛选意图，不承诺恢复一个不断变化的实时数据快照。

### 2.5 紧凑行信息层级

桌面收敛为五个视觉列：

1. **任务**：可展开分支先显示 24×24 展开按钮，随后是单行省略的主链接名称；无分支时保留同宽
   spacer。次行显示 `主体 · repo · short id`，按需附「定时」来源；`N 个子任务`紧邻名称。子行只
   用 inset well、rail 与缩进表达层级，不在每行重复「子任务」badge。
2. **执行**：`TaskStatusChip`；次行按真实数据选择一个最高优先级说明：未解决告警、失败摘要 /
   failure code、等待人工文案、运行/排队计时。最多一行并安全截断，完整诊断在任务详情。
3. **时间**：`RelativeTime(startedAt)` + 新 `taskOperationsRunningDuration`。后者使用 RFC-207 的
   `runningMs/runningSince`：
   `effective = runningMs + (status==='running' && runningSince!=null ? max(0, now-runningSince) : 0)`；
   running 显示「已运行 X」，waiting/terminal 显示「累计运行 X」（0 时为 `—`），pending 显示
   「排队 X」并只用 `now-startedAt` 表达等待。它不复用 RFC-192 的 wall-clock duration，也不把
   人工停等算进运行时长。列标题「时间」替代两个窄列。
4. **Owner**：给公共 `OwnerLabel` 增加向后兼容 `wrap?: boolean`（默认 false 保持现有调用方）；本页
   传 true，使 display name 与 username/stable id 都可换行、无 ellipsis/hover-only 正文。普通身份仍
   在 56px 内；超长身份让该行自然增高。
5. **进入详情提示**：无障碍隐藏的右向 chevron，只说明整行空白可进入详情。它不控制子任务；真正
   展开按钮属于第一列，且仅在 `qualifyingChildCount > 0` 时出现，移动端扩大到 44×44。

普通父行 `min-height: 56px`，直接/深层子行 `min-height: 48px`；单元格纵向 padding 6px。
不得设置固定 `height`、`max-height` 或在 Owner 身份上使用不可恢复的裁切。任务名保持单行省略并
提供 `title`；仓库/失败摘要可单行省略并提供非唯一的 `title`；详情主链接始终可达。

### 2.6 树、筛选与展开状态

列表永远只有一种呈现规则：

- 无筛选时，根分支默认折叠；每个 task 只出现一次。
- row 自身匹配时返回 `matchKind='self'`。
- 只有可见后代匹配时，必要的可见祖先以 `matchKind='context'` 返回；UI 显示
  「包含 N 个匹配子任务」并自动展开通向匹配项的分支。
- context 自动展开只在 query fingerprint 变化时重建；之后用户手动折叠优先，避免 UI 与用户抢
  控制权。
- 原 parent 不在 ACL-only authorized set 中时，该 task 的 `parentAvailability='unavailable'`，它
  成为当前可见树的根。UI 只显示中性「父任务不可用」，不发详情 probe，不区分 ACL 隐藏与异常
  dangling。正常父删除由 RFC-243 FK cascade 同时移除后代，不把 deleted parent 描述成持久 orphan。
- 一个父任务有很多直接子分支时，子层也以 cursor 分页，并在该父行下显示「加载更多子任务」。
- 子分支 load/error/empty 只占该分支的一行；删除竞态导致空页时收起 expander 并重新请求父页
  计数，不保留错误的「无子任务」长期缓存。

### 2.7 行导航与辅助技术

本页明确选择**原生嵌套列表**，不使用 native table + sibling `<tr>`，也不声明 `role=tree/treegrid`：

```text
<div class="task-operations__head" aria-hidden="true">视觉列标题…</div>
<ol class="task-operations__list" aria-label="任务">
  <li>
    <div class="task-operations__row">五列内容；每列含 sr-only 字段名</div>
    <ol id="task-children-{id}" aria-label="{name} 的子任务" hidden>…</ol>
  </li>
</ol>
```

- 原生 `<ol>/<li>` 嵌套直接表达层级；视觉缩进是第二线索，无需伪造 `aria-level` 或 roving focus。
- 任务名是原生 `<Link>`，是键盘主入口；row wrapper 本身不加 `tabIndex/role=button`，鼠标点击空白
  区仍复用 `shouldRowNavigate`，不会制造重复键盘停靠点。
- 展开是 `<button>`，包含 `aria-expanded`、指向稳定 branch `<ol>` id 的 `aria-controls` 和带 qualifying
  子任务数量的 label。可展开行的 branch `<ol>` 始终挂载，折叠时 `hidden`；loading/error/empty 各以
  合法 `<li>` 呈现，所以 controls target 不悬空。
- 桌面视觉列标题 `aria-hidden`；每行「任务 / 执行 / 时间 / Owner」单元都带 `.sr-only` 字段名，
  mobile grid reflow 后仍保留同一阅读顺序与字段语义。
- 业务视图是单选集合，当前值通过现有 `Segmented` 语义表达。
- 搜索结果数、追加 sibling 数和 dirty 后重建通过已有 managed live-region 模式播报，不逐条播报
  WS 状态变化。
- focus 在筛选应用后回到触发器；清除筛选后回到搜索框；分支加载失败的 retry 保留在分支内。
- 验收除 axe 外必须覆盖 Safari VoiceOver 与键盘：列表层级朗读、展开/折叠、branch loading/error、
  load-more 后焦点不丢；不因 desktop/mobile CSS 切换改变 DOM role。

## 3. 新 list-only wire

### 3.1 路由与 query

新增 `GET /api/tasks/page`，必须在 `app.use('/api/tasks/:id', ...)` 之前注册。query：

```text
view=all|active|attention|finished       default all
q=<trimmed string>                      max 100 code points
statuses=pending,running,...            optional, TASK_STATUS order/canonical
subject=all|workflow|workgroup|agent    default all
scope=mine|shared|all                   same collapse rules as GET /api/tasks
origin=all|manual|scheduled             default all
parent_id=<authorized task id>          omitted = root siblings
cursor=<opaque base64url>               optional
limit=1..100                            default 50
```

`view` 与 `statuses` 是交集；例如 `view=finished&statuses=failed,canceled` 只返回失败/取消。
未知枚举、空 token、去重后为空、过长 q、坏 cursor 与不匹配的 cursor fingerprint 统一 422
`task-page-filter-invalid` / `task-page-cursor-invalid`；重复合法 status 去重并按 shared 顺序
canonicalize，不静默换语义。

### 3.2 Shared schema

```ts
export const TaskListMatchKindSchema = z.enum(['self', 'context'])
export const TaskParentAvailabilitySchema = z.enum(['none', 'visible', 'unavailable'])

export const TaskOperationsListItemSchema = TaskListItemSchema.extend({
  executionClock: z
    .object({
      runningMs: z.number().int().nonnegative(),
      runningSince: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  listContext: z
    .object({
      matchKind: TaskListMatchKindSchema,
      parentAvailability: TaskParentAvailabilitySchema,
      qualifyingChildCount: z.number().int().nonnegative(),
      matchingDescendantCount: z.number().int().nonnegative(),
      branchStartedAt: z.number().int().nonnegative(),
    })
    .strict(),
}).strict()

export const TaskOperationsFacetsSchema = z
  .object({
    all: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
  })
  .strict()

const TaskOperationsPageBaseSchema = z
  .object({
    items: z.array(TaskOperationsListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()

export const TaskOperationsRootPageSchema = TaskOperationsPageBaseSchema.extend({
  kind: z.literal('root'),
  facets: TaskOperationsFacetsSchema,
}).strict()

export const TaskOperationsChildPageSchema = TaskOperationsPageBaseSchema.extend({
  kind: z.literal('children'),
  parentId: z.string(),
}).strict()

export const TaskOperationsPageSchema = z.discriminatedUnion('kind', [
  TaskOperationsRootPageSchema,
  TaskOperationsChildPageSchema,
])
```

说明：

- `childCount` 保留 RFC-243 的「全部直接可见子任务」语义，方便无筛选态与其他消费方；
  `qualifyingChildCount` 是当前 query 下应出现的直接子分支数，决定本页 expander。
- `matchingDescendantCount` 只计 self-match 的可见后代，不把 context rows 加进去。
- `branchStartedAt` 是该可见匹配分支中最大的 task `startedAt`，只用于稳定排序与 cursor；UI 不把
  它文案化为「最近活动」。
- `executionClock` 是 RFC-207 canonical accounting；`runningSince` 只在 `status='running'` 时参与
  当前累计值，脏组合（非 running 但非空，或 running 但为空）不猜补历史，按 `runningMs` 降级并
  由 invariant/source test 报警。它只存在于新 endpoint，不扩 legacy `TaskSummary`。
- root response 才携带 facets；child response 用 `kind='children' + parentId` 且 schema 中根本没有
  facets，避免每次展开重复全局 aggregate。
- endpoint 总是返回 Owner；不再需要 `include_owner`。

### 3.3 Cursor

cursor 是无权限含义的 opaque base64url strict JSON：

```ts
interface TaskPageCursorV1 {
  v: 1
  branchStartedAt: number
  taskId: string
  filterFingerprint: string
}
```

服务端用 canonical query（含 actor user id、`tasks:read:all` capability、已收敛后的 scope、parent
id、limit 以外的筛选）计算 fingerprint。cursor 只提供 keyset 边界，所有 ACL 和 filter 每次重算；
跨 actor 复用或篡改 cursor 都会 422，不能扩大可见性。
排序固定为 `(branchStartedAt DESC, taskId DESC)`，query 取 `limit + 1` 判定下一页。cursor 不依赖
offset，删除旧任务不会让全部后续页整体漂移。

## 4. Backend 查询设计

### 4.1 授权集与 ownership filter 分层

新 service 独立于 `listTasks`，建议命名 `listTaskOperationsPage`。先抽 alias-aware helper：

```ts
taskAuthorizationCondition(db, taskRef, actor)
// tasks:read:all => no predicate; otherwise owner OR collaborator

taskOwnershipScopeCondition(db, taskRef, actorUserId, effectiveScope)
// mine => owner OR collaborator; shared => collaborator AND NOT owner; all => true
```

既有 `taskVisibilityCondition(db, { actorUserId, scope })` 保留公开语义，并内部委托相同 predicate
片段；overview/legacy list 无行为变化。新 endpoint 的固定上游是 `authorized_tasks`，它只表达
`canViewTask` 等价权限，不含 ownership scope。`scope` 在 `filter_matches` 才参与，因此管理员选
「与我共享」时，一个自己有权访问但不满足 scope 的 parent 仍可作为 context，不会被伪装成
`unavailable`。

### 4.2 Root query plan

只有 `parent_id` 省略时运行全局 root plan：

1. `authorized_tasks`：显式轻量列 + ACL-only predicate；绝不先构建全库 ancestry。
2. `non_view_matches`：在 authorized rows 上应用 ownership scope、q、subject、origin 与 exact
   statuses；它也是 facet 基础集合。
3. `self_matches`：在 `non_view_matches` 上再应用当前 view predicate。
4. `qualified`：从 self-match 向上递归吸收仍在 `authorized_tasks` 内的祖先；使用 `UNION` 去重，
   以 `invocation_depth` 上界 + visited id 防御坏数据循环。
5. `display_edges`：只有 original parent 在 `authorized_tasks` 时才连接；否则当前 task 是 authorized
   root 并标 `unavailable`。一个 parent 仅因 scope/q/view 不匹配时仍作为 context，且
   `parentAvailability='visible'`。
6. `branch_stats`：只对 qualified root siblings 计算分支内 `MAX(self_match.started_at)`、直接
   qualifying child 数与 matching descendant 数，再应用 keyset + `limit + 1`。
7. facets 从 `non_view_matches` 做一次 conditional aggregate：view 自身不参与；attention 用
   unresolved alert `EXISTS`；每个 self-match task row 计一次，context 不计数。

root service 返回 `TaskOperationsRootPageSchema`。四个 facets 可重叠，不要求相加等于 all；不能为
每个 tab 各发 HTTP。

### 4.3 Child query plan

`parent_id` 请求使用独立、子树受限的 plan，不重跑 root CTE 或 facets：

1. 用单行 task lookup + `taskAuthorizationCondition` 权威验证 parent；不可见/不存在统一 404，不形成
   存在 oracle。
2. child plan **不声明/物化全局 `authorized_tasks`**。它以
   `tasks.parent_task_id = parentId AND taskAuthorizationCondition(...)` 为 `authorized_subtree` anchor，
   每个 recursive step 再对 child row 应用同一 ACL predicate，向下得到 bounded subtree；scope/q/
   status/subject/origin/view 只在此 subtree 求 self-match。
3. 从 subtree self-match 向上闭包，但在 parent 边界停止；由此得到应返回的 direct qualifying
   children 及每个 child 的 descendant match stats。
4. 只对这些 direct siblings 应用 `(branchStartedAt,id)` keyset + `limit + 1`，返回
   `TaskOperationsChildPageSchema`，不计算/返回 facets。

`matchingDescendantCount > 0` 的 direct child 会在前端自动展开并递归请求自己的 child page；因此
深层匹配路径可见，但每个请求只扫描一个已授权 parent 的 bounded subtree。一个父有大量 direct
children 时仍可分页；同一 query 中每个 task 只在其 authorized parent 分支出现一次。

### 4.4 轻量 projection

`authorized_tasks` 只选择：

- id、name、status、startedAt、runningMs、runningSince、finishedAt；
- errorSummary、failedNodeId；
- workflowId、repoPath、repoUrl、cachedRepoId、repoCount；
- scheduledTaskId、workgroupId、sourceAgentName/sourceAgentId、spaceKind；
- parentTaskId、invocationDepth、ownerUserId；
- workflow display name join；冻结 workgroup name 用统一 SQL expression 得到标量：

  ```sql
  CASE
    WHEN json_valid(workgroup_config_json)
      AND json_type(workgroup_config_json, '$.workgroupName') = 'text'
    THEN NULLIF(json_extract(workgroup_config_json, '$.workgroupName'), '')
    ELSE NULL
  END
  ```

  projection 与 search 共用同一 `frozen_workgroup_name` CTE 列，不裸调 `json_extract`，不把完整
  config 返回。

明确禁止选择：

- `workflow_snapshot`；
- `inputs`；
- `workgroup_config_json` 完整文本；
- `ref_closure_json`；
- worktree/base/ref 等列表未显示字段。

该 projection 由独立 row mapper 生成 `TaskListItem` 的全部 required/optional 公共字段，再附
`executionClock/listContext`；不调用需要完整 task row 的 `rowToSummary`，也不把内部
`failedNodeId` 输出。为避免第二套业务语义漂移，抽出并复用主体分类、repo display 所需映射、
frozen workgroup name 表达式、running clock、failure/open-alert enrichment。schema parse 是 route
发出 response 前的硬门。corrupt/missing/wrong-type workgroup JSON 必须与 legacy mapper 一样降级
`workgroupName=null`，不得令整页 5xx。

### 4.5 批量 enrichment

仅对本页 `items`：

1. `loadOwnerIdentities`：按既有 200 ids 批次；
2. unresolved lifecycle alert count：一条 grouped query；
3. `loadTaskFailureCodes`：一条 batched projection；
4. direct authorized child count：保留 `childCount` 时，以一条 grouped query 在 ACL-only
   `taskAuthorizationCondition` 下计算；不能受 scope/q/view 影响。query-specific 展开数仍来自
   `qualifyingChildCount`。

不得为 context/self、根/子或不同执行主体分叉出 per-row query。Facet 与 tree stats 在主 CTE
完成，不再由 enrichment 反向改变匹配集合。

### 4.6 索引与迁移 0128

新增 `0128_rfc244_task_list_indexes.sql` 与 schema 对应索引：

- `idx_tasks_list_started_id (started_at, id)`；
- `idx_tasks_list_status_started_id (status, started_at, id)`；
- `idx_tasks_list_parent_started_id (parent_task_id, started_at, id)`；
- `idx_tasks_list_owner_started_id (owner_user_id, started_at, id)`。

新 composite index 覆盖后，迁移删除被完全前缀覆盖的旧 `idx_tasks_status`、`idx_tasks_parent` 和
`idx_tasks_owner`，避免重复写放大；`idx_tasks_workflow` 与 scheduled index 保留。实施前以当前
SQLite 的 `EXPLAIN QUERY PLAN` 锁定无搜索的常用 root/child/status 路径使用对应 index。

substring search 仍可能扫描 authorized lightweight rows。首版接受该成本，但用 20k task 合成数据做
非 flaky benchmark 记录。benchmark 必须包含「1 个 root 请求 + 20 个已展开 parent 的 child 请求」
与深层 search auto-expand，而不只测孤立 endpoint；断言 child plan 先命中 parent composite index、
不出现全局 facet aggregate。若真实数据证明不足，后续 RFC 再定义 FTS tokenizer、同步与兼容语义，
不能在本 RFC 偷换搜索行为。

### 4.7 Legacy endpoint

以下保持 byte-compatible：

- `GET /api/tasks` 默认 `TaskSummary[]`；
- `include_owner=true` 的 `TaskListItem[]`；
- `include_children=true` flat 语义；
- `parent_id` direct children；
- 旧单 status、workflow/repo/scheduled/limit/scope query；
- detail、overview、scheduled history 与 `useTaskChildren`；
- 既有 WS variant 的 payload shape 与 legacy invalidation 策略。新增
  `task.members.changed/lifecycle.alert.resolved` 为 additive variant，audience context 永不进 wire。

`/tasks` 路由迁移成功后，旧列表参数仍是公开兼容面，不在同一 RFC 删除。RFC-243 的 overview
「只计顶层任务」口径也不跟随新页面 facet 改变。

## 5. Frontend 设计

### 5.1 数据 hook

新增 `useTaskOperationsPage(filters, parentId?)`，内部使用 `useInfiniteQuery`：

- query key 独立为 `['task-operations', canonicalFilters, parentId]`，故意不受 legacy
  `useTasksSync` 的 `['tasks']` prefix 立即 refetch 覆盖；
- page param 只含 cursor；首批 50；
- selector 按 id 去重，保持 server 顺序；
- 「加载更多」由显式按钮触发，不用自动无限滚动，避免键盘焦点和错误恢复不确定；
- 根与每个展开父任务拥有独立 infinite query，未展开不请求。

现有 `useTaskChildren` 保留给任务详情 `ChildTaskLink`，任务列表不再用它，也不改其 legacy wire。

### 5.2 组件边界

`routes/tasks.tsx` 只负责 URL state、顶层 query 和页面状态，拆出 route-local 组件：

- `TaskViewTabs`：业务视图与 facets；
- `TaskListToolbar`：search、filter summary、clear；
- `TaskListFilterDialog`：精确状态/主体/scope/origin；
- `TaskOperationsTree`：视觉 column header、原生 nested list、根 page 和加载更多；
- `TaskTreeRow` / `TaskChildBranch`：递归树与局部状态。

不新增第二套 Button/Input/Dialog/Chip shell。继续使用 `PageHeader`、`TextInput`、`Dialog`、
`MultiSelect`、`Segmented`、`TaskStatusChip`、`OwnerLabel`、`RelativeTime`、`FeedbackStack`、
`ErrorBanner`、`LoadingState`、`EmptyState`。`TableViewport` 的 contract 强制 direct native table，
与 §2.7 的 nested-list semantics 不兼容，因此本页不使用/扩它；任务记录树是内容结构，不复制
table viewport 的 scroll/fade chrome，也不抽象成第二套通用表格组件。

公共组件只做一个最小扩展：`OwnerLabel.wrap`；false 的现有 ellipsis 行为 byte-compatible，true 只加
modifier class 解除 display-name nowrap/overflow 并允许 identity 换行。不得在 task route 复制 Owner
identity 解析或用 title 替代正文。

### 5.3 Operations-specific dirty channel

> **2026-08-26 已被取代（缺陷修复，非 RFC）**：用户实测报「每次任务状态更新都会刷新整个任务
> 列表，导致任务列表一直在闪」。本节第 1–2 点描述的「置脏横幅 + 15 秒 `resetQueries` 整表
> 重建」正是那个现象的来源——`resetQueries` 把缓存清回初始态，于是整屏换成 loading、
> `VirtualList` 连滚动位置一起重挂、展开着的子分支全塌、已翻的页塌回第 1 页。用户当日拍板
> 改为：**任一帧到达即做保留数据的 `invalidateQueries` 就地重取，新行也自动进来，横幅与手动
> 刷新按钮取消**。现行实现见 `packages/frontend/src/hooks/useTaskOperationsSync.ts` 的文件注释；
> 判据在 `packages/frontend/tests/{task-operations-sync,tasks-list-live-update}.test.tsx` 与
> `e2e/rfc319-task-list-and-filters.spec.ts` 的 TASK-21。本节其余部分（frame 集合、授权可见性、
> URL filters / expansion 保留、live region 播报）不变，仅供历史对照。

`/tasks` 不再调用 `useTasksSync()`，改用 `useTaskOperationsSync()`。它复用同一 `/ws/tasks` 物理
连接，但 rules 对下列 frame 只做 side effect（return void），绝不直接 invalidate query：

- `task.created` / `task.status` / `task.deleted`；
- additive `task.members.changed`（owner/collaborator full-replace）；
- `lifecycle.alert`（new/promoted）；
- additive `lifecycle.alert.resolved`。

hook 收到任一已授权 frame、WS reconnect `reconcileOnOpen` 或 disconnected polling fallback 时：

1. `invalidateQueries({queryKey:['task-operations'], refetchType:'none'})`，设置 page-local dirty flag，
   显示公共 NoticeBanner「任务列表已更新」；不内联改 status/删除，避免 row 与 facet/tree 不一致。
2. 用户点「刷新」立即原子清掉所有 root/child pages 并从第一页重建；第一次 dirty 后 15 秒仍未
   手动刷新则自动执行同一动作。WS 持续 disconnected 时每 15 秒执行一次 fallback rebuild。
3. URL filters 与用户手动 expansion id 保留；所有 cursor/page data 一起重建，expanded branches
   重新请求。selector 仍按 id 去重，防御请求交错。
4. banner/rebuild 通过 managed live region 播报一次；无关 sibling event 不抢 child retry 或
   load-more button 的 focus。新 task 不在用户扫读时静默插入首屏。

为补齐事件真值：

- lifecycle alert 从 open/promoted 变为 resolved 的所有权威写路径（invariant scan、manual/auto
  repair）在事务提交后广播 `lifecycle.alert.resolved {taskId}`；既有 `lifecycle.alert` 行为不改。
- `updateTaskMembers` 在事务内冻结 before/after owner/member audience 并集；提交后先
  `await triggerRevalidationAndWait(db, 'task-members-changed')`，确认本轮冻结连接已全部刷新或关闭，
  再广播 `task.members.changed {taskId}` + 非序列化 audience-transition context。这样 frame 不会命中
  `gatedSubscribe` 的 `revalidating` 丢弃窗口，新加入与刚移除的用户都能把列表回真。legacy
  `useTasksSync` 对这个 additive variant 继续采用 broad `['tasks']` invalidate，既有 variants 的策略
  不变。
- `deleteTask` 在删除事务内冻结整个 FK cascade set 的 `taskId/ownerUserId/collaboratorUserIds`，提交
  后为每个删除 task 广播既有 `task.deleted` + 非序列化 `task.deleted-audience` context。registry
  对该 context 按 `tasks:read:all` / frozen owner/member gate，不能在 row 已不存在时回查失败；因此
  cold socket 与 child-only actor 都收到自己此前可见 row 的删除 dirty signal。

`revalidationHook.ts` 只增加可等待适配层，不把所有既有写路径改成同步等待：

- registered `TriggerImpl` 返回 `Promise<void>`；现有 `triggerRevalidation()` 仍返回 `void`，以
  fire-and-forget 方式调用同一 implementation；新 `triggerRevalidationAndWait()` 返回该 Promise，未
  注册 WS server 的单测进程直接返回 resolved Promise；
- `connections.ts` 的 implementation 仍先同步冻结 live connection snapshot，再**返回**
  `revalidateAllConnections()` 的完成 Promise；Promise 只在该 snapshot 的连接逐个刷新 actor 或
  fail-closed 关闭后完成，异常收尾不得留下 `revalidating=true` 的存活连接；
- `updateTaskMembers` 只调用 awaited 版本一次，不先触发 fire-and-forget 版本；成员 mutation 已提交后
  即使 revalidation 失败也不得回滚伪装，错误路径须 fail closed、记录日志并在冻结连接清理后完成，
  然后再发 audience-transition frame。

本 RFC 不承诺跨实时状态变化的 snapshot isolation；它承诺每个 HTTP response 自洽、dirty 后最迟
15 秒重建、客户端不渲染重复 id。legacy `useTasksSync` 与其 lifecycle.alert 负向网络测试保持不变。

### 5.4 反馈状态

- 首屏 loading：公共 `LoadingState`，toolbar 可见但 disabled，不出现空态闪烁。
- 真空数据库：`EmptyState` + 新建任务 CTA。
- 有任务但当前 query 无匹配：compact `EmptyState` + 清除筛选。
- 首层 error：`ErrorBanner` + retry；若有 stale data，保留 data 并把 banner 放在 `FeedbackStack`。
- child error：父行下 inline `ErrorBanner` + retry；不影响 siblings。
- load-more error：保留全部已加载 rows，在末尾显示 retry。
- filter apply：关闭面板、回到顶部、重置分页与 expansion auto-state；不保留旧 query 子分支。

### 5.5 Responsive CSS

Desktop（>720px）：

- 标题、副标题、动作、toolbar、表头与列表处于同一 bordered surface；nested list row grid 宽度为
  容器 100%，不设置固定最小宽；视觉列宽以 visual contract 的任务优先比例为准；
- row `min-height` 由 cell padding + line-height 达成，禁止 `transform: scale` 或缩小全局字号；
- 首层 child branch 放入 `margin: 0 22px 8px 55px` 的 inset well，使用左侧 rail 与轻底色；深层仍
  由 native nested list 保留真实层级，并显示短 ID。

Mobile（≤720px）：

- 隐藏 `aria-hidden` 视觉表头；每行 sr-only 字段名仍在，row/cells 以 grid 重排，不改变 DOM 内容
  次序或 native list nesting；
- task + status 同首行，meta/time/owner 后续排列；Owner 可换行；
- 展开按钮 44×44；整行空白点击进入详情，但任务名原生链接仍是键盘入口；
- toolbar 的 views 与 tools 分为两层；search 与 filter 仍在同一 tools 行。四个 view 可横向滚动于
  **自身 segmented 容器**，页面和结果列表不横向滚动；
- 390×568 下 filter dialog 主 action 不被软键盘/viewport bottom 遮挡。

## 6. 安全、隐私与失败边界

1. ACL-only `authorized_tasks` 是所有搜索、树、计数、facet 和 enrichment 的上游；不能先构建全局
   ancestry 再在外层过滤，否则会泄露隐藏父任务的存在或分支规模。ownership scope 只能出现在
   self-match filter，不能缩窄 ancestry/edge 授权集。
2. `parentAvailability='unavailable'` 合并「未授权 / 异常 dangling」；不提供原因 oracle。正常删除
   由 FK cascade 移除后代，不能把 deleted parent 写成持久 orphan 合同。
3. invisible parent 的 id 只沿既有可见 child 的 `parentTaskId` 合同存在；新 response 不附加父的
   名称、Owner、状态或 linkability。
4. scope 在 route 层按 actor permission 收敛，URL replace 与 cursor fingerprint 都使用 effective
   值；fingerprint 还绑定 actor/capability。cursor 从不充当授权凭据。
5. 搜索只覆盖已公开、已脱敏或 task 可见后已有的 display 字段；不查 inputs、prompt、session、
   worktree、credential 或 refs。
6. Owner enrichment 只接收本页已可见 task 的 owner id；system/missing/mismatch 的既有 fail-closed
   展示不变。
7. child query 的 parent visibility 在 server 验证；不能凭猜中 id 枚举其 visible child 数。
8. response schema 失败按 endpoint error 返回，不把 raw DB payload 降级透传到前端；冻结
   workgroup config 属历史 fail-soft 字段，必须先 `json_valid/json_type` 并降级 null，不能让坏 JSON
   触发 endpoint 5xx。
9. 删除与成员变更 audience 只存在于 broadcaster context，不序列化；alert-resolved 仍按 live task
   visibility gate。任何 unknown/future WS variant fail closed。

## 7. 测试策略

### 7.1 Shared

- 四个 view 常量覆盖全部 `TASK_STATUS`；active/finished 不重叠且并集完整；attention overlap 明示。
- query canonicalizer：未知/重复/乱序 status、默认省略、q trim/长度、scope/origin/subject。
- `TaskOperationsListItemSchema` / root-child page discriminated union / cursor codec strict；未知 key、
  负 running clock/计数、child response 偷带 facets、坏 context 拒绝。

### 7.2 Backend service / route

- default all + 50 limit；limit 1/100/101；同 startedAt 以 id 稳定排序；两页无重复。
- cursor 坏 base64/JSON/version/fingerprint/parent/filter → 422；cursor 不绕 ACL。
- active/attention/finished 矩阵，failed 与 awaiting overlap，unresolved/resolved alert 差异。
- q 对 name/id/workflow/workgroup/agent/主 repo/多 repo 命中；LIKE metachar literal；credential 不可搜。
- exact statuses、subject、scope、origin 的交集与 facets-before-view 口径；重复 status 去重。
- owner/collaborator/admin/shared visibility；无权限 `scope=all` 收敛并 canonical replace；隐藏 row 不
  进入 facets。管理员在 `scope=shared` 下 child self-match + authorized owner parent 的反例必须返回
  parent context/visible，证明 ownership filter 未污染 ACL ancestry。
- authorized child + unauthorized parent → child root/unavailable；异常 dangling 同中性态；正常 parent
  delete cascade 不留 orphan；不返回父投影；child endpoint 不形成 oracle。
- descendant match → visible ancestors context；context 不计 facets；多个匹配后代只返回一个祖先。
- root/child cursor、深层分支、无 child、删除竞态、坏 parent cycle 防御；child response 无 facets，
  query-plan 锁 parent index 先限 subtree，不扫描 global facets。
- page enrichment 固定批次数，无 per-row SQL；response owner/alert/failure/childCount 正确。
- corrupt/missing/wrong-type workgroup config 在 default/search 下均 `workgroupName=null` 且不 5xx；与
  legacy list parity。
- `executionClock` strict wire 与 running/waiting/terminal/pending/dirty-combination duration helper。
- alert new/promoted/resolved 与 member change 都产生 authorized dirty signal；member change 用
  before/after audience 并集，且 awaited revalidation 完成前不得广播、完成后 frame 不得被
  `revalidating` 丢弃；锁住无 WS implementation 的 resolved path、既有 fire-and-forget caller 与
  revalidation 异常 fail-closed 收尾。parent cascade 为每个 task 冻结 audience 后广播，覆盖 cold
  socket、added/removed member、child-only actor、admin 与 outsider 负例。
- SQL/source lock：列表 projection 不含 `workflowSnapshot/inputs/refClosureJson`，不出现
  `.select({ task: tasks })`；`EXPLAIN QUERY PLAN` 覆盖常用 index。
- legacy `/api/tasks` 全部既有 contract tests 保持通过。

### 7.3 Frontend

- 默认 all；tab/facet；高级筛选 active count；全部 URL round-trip/canonicalization。
- 状态 `MultiSelect` 保留默认搜索；输入本地化 label / wire value 可缩窄选项，键盘 Enter 切换且
  `allowCustom=false` 不产生自定义状态。
- 搜索防抖/提交、clear、浏览器 back/forward、reload；筛选变化重置 pagination/auto expansion。
- 树唯一性、context auto-expand、manual collapse 优先、unavailable parent 无 detail probe。
- root/child load more、id de-dupe、首层/child/load-more error retry 不丢已加载数据。
- 任务 metadata、状态 detail 优先级、Owner 全 identity、长 name/repo/error、scheduled source。
- 原生主 link、row click guard、nested `<ol>/<li>`、稳定 branch controls target、focus restoration、
  live-region 与 axe；source lock 禁止 `role=tree/treegrid` 半套实现、native table sibling tree 和
  route-local checkbox group。
- operations dirty hook 不被 `['tasks']` prefix 立即 refetch；事件只出 banner，用户/15s rebuild；
  reconnect/disconnected fallback、alert resolve、cascade delete、focus 不跳。
- CSS/source test 锁 desktop 56/48 `min-height`、无 fixed height、mobile 44 hit area、无全局字号缩小。
- zh-CN/en-US i18n typecheck；无 raw key。

### 7.4 Playwright / visual

固定 seed 至少包含：

- 30+ 根任务，覆盖 8 个状态、alert、manual/scheduled、长 task/repo/Owner；
- 三层父子链、一个 parent 未授权的 authorized child、一个异常 dangling child、多直接子任务分页；
- 搜索只命中深层 child；facets overlap；load more。

验证：

- 1280×800 紧凑列表与完整四列，不裁 Owner，不横向滚动；
- 390×844、390×568 单列、筛选面板、44px target、无 horizontal overflow；
- 搜索深层 child 后 ancestry 自动展开，刷新 URL 后结果相同；
- 首层/child/load-more 人工失败 fixture；
- Safari VoiceOver + 键盘验证 nested list 层级、展开/折叠、branch loading/error 与 load-more focus；
- desktop/mobile screenshot 在 hosted Ubuntu 基线生成并复核。

## 8. 发布与回退

一个 RFC、一个 PR，按三个可独立验证的提交批次实施：backend wire → frontend → acceptance/docs。

上线顺序：

1. shared schema、0128 migration、新 endpoint 与 backend tests；旧列表仍工作。
2. frontend 切新 endpoint；旧 endpoint 保留给其他消费者与快速回退。
3. 视觉/e2e、实现门、文档收口。

若新页面出现阻断，可将 `/tasks` query 临时切回 legacy endpoint；0128 只有索引变化，不改变 task
数据语义。不能以回退为由删除新 schema/migration 或破坏已有数据库前向版本。

## 9. 与既有 RFC 的关系

- **RFC-192**：保留「状态优先、整行进入详情、失败信息就地可见」；其 8 列、原始状态 chip、
  client-side latest-500 filter 与横向窄屏方案由 RFC-244 取代。
- **RFC-232**：Owner list-only identity、批量 enrichment 与 fail-closed 展示全部保留；只改变任务页
  的列宽和 responsive 排列。
- **RFC-243**：父子数据模型、`childCount` ACL 口径和详情 child link 保留；任务页的顶层默认、
  flat scope toggle、前端 parent probe 与「每行子任务 badge」由统一树替代；父删除仍按其 FK cascade，
  RFC-244 只补 cascade set 的 WS audience 通知。overview 口径不变。

## 10. 设计门检查点

设计门重点攻击：

1. recursive CTE 是否可能跨 ACL 边界或形成 parent 存在 oracle；
2. ownership scope 是否污染 authorized ancestry / parentAvailability；
3. context ancestor + sibling pagination 是否漏/重 branch，child expansion 是否重复全局 facets/scan；
4. attention/openAlertCount 与 member/delete/alert-resolve dirty 事件是否可能产生多个真值；
5. cursor 在 task status/child creation 实时变化下是否给出诚实保证；
6. list-only mapper、corrupt workgroup JSON 与 RFC-207 running clock 是否漂移；
7. native nested list 在 desktop/mobile 的 DOM、controls target 与 VoiceOver/键盘是否真实可用；
8. 0128 index 替换是否覆盖 legacy/root/child query plan 且不扩大写放大。

首轮结果 0 P0 / 5 P1 / 3 P2 已折入 Draft v2；focused 复审结果 0 P0 / 1 P1 / 1 P2 已折入
Draft v3；closing 复审为 `APPROVED — P0=0/P1=0/P2=0`，逐项记录见
`design-gate-2026-08-01.md`。T4 已完成；用户于 2026-08-01 以 “ok” 正式批准，T5 完成并进入
生产实现。

## 11. 最终实施状态

截至 2026-08-01，设计中的 shared、DB/backend、frontend、acceptance 与发布切片均已实现。固定
SHA `1fbbd46388d458afda526115786c045ea17ac133` 的实现门结论为
`APPROVED — P0=0/P1=0/P2=0`，详见
[implementation-gate-2026-08-01.md](./implementation-gate-2026-08-01.md)。

任务页 hosted-Ubuntu visual run `30697676219` 在 UI SHA
`e8e42b6c170889274cc04029c7202c632d842dab` 上 27/27；Chromium/WebKit RFC-244 Playwright 各
4/4，Safari + VoiceOver 人工走查通过；最终代码 exact-SHA main CI run `30700645728` 全绿。
RFC-244 已发布并标记为 Done。
