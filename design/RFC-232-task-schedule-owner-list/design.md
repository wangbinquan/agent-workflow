# RFC-232 · 技术设计

## 1. 当前事实

### 1.1 Task

- 权威归属是 `tasks.owner_user_id`，nullable；历史/daemon 行可空。
- `taskVisibilityCondition` 先按 owner / collaborator 收窄；只有持
  `tasks:read:all` 的 actor 才能看全量。
- `TaskSummary` 是 REST list、首页和 WebSocket 共用的紧凑类型，当前没有 owner。
- `/api/tasks` 最多返回 500 行。

### 1.2 Scheduled task

- `ScheduledTask.ownerUserId` 已是必填字符串。
- `/api/scheduled-tasks` 先按 owner-or-resource-admin 口径过滤，再把行返回给前端。
- 列表当前只缺 owner 的公开显示身份与列渲染。

### 1.3 现有用户公开投影

现有 `UserPublicSchema` 包含 `id / username / displayName / role / status`。本功能不需要
账号角色或状态，因此新增更窄的显示投影：

```ts
export const OwnerIdentitySchema = UserPublicSchema.pick({
  id: true,
  username: true,
  displayName: true,
}).strict()
```

本 RFC **不在前端再发 owner lookup**。两张 list response 由后端在同一批列表读取中附带每行
owner 的 `OwnerIdentity | null`，因此：

- 没有前端 per-row / 分块请求或 200-id 截断；后端 identity loader 用固定 200-id SQL batch
  合并完整结果，不依赖 SQLite 的环境变量上限；
- 不新增可跨登录态独立复用的 `['users','lookup', ids]` cache；
- owner 与它所属的可见列表行同生共灭，不会脱离任务 ACL 单独请求；
- 不需要为了两列 owner 改造全站 auth、QueryClient、mutation 或 logout 生命周期。

## 2. List-only wire

### 2.1 Task

保留 `TaskSummarySchema` 与 `task.created` WebSocket wire 不变，新增只用于
`GET /api/tasks` 的 schema：

```ts
export const TaskListItemSchema = TaskSummarySchema.extend({
  ownerUserId: z.string().nullable(),
  owner: OwnerIdentitySchema.nullable(),
}).strict()
```

`GET /api/tasks` 新增默认关闭的 `include_owner` boolean query。未传或 `false` 时调用原
`listTasks` 并返回原 `TaskSummary[]`；只有 `/tasks` 页面传 `include_owner=true` 时调用
`listTaskItems` 并返回 `TaskListItem[]`。route 必须复用
`parseBoolQuery(c, 'include_owner', { default: false })`：接受 missing / `0` / `1` /
`false` / `true`，未知值按统一协议返回 422。
因此首页的 10 秒轮询、定时任务历史的 30 秒轮询和实时事件都不会携带 owner，也不会把列表
展示字段误扩成所有 `TaskSummary` producer 的通用契约。

现有 `listTasks` 不是只有主 SELECT：它还批量派生 `openAlertCount` 与 `failureCode`。为避免
两个 producer 漂移，把其完整流程抽成内部 canonical
`listTaskSummaryRows(): Array<{ summary: TaskSummary; ownerUserId: string | null }>`：

- 原主查询已经以 `task: tasks` 取得 `ownerUserId`，无需另查 task；
- 原 alert count、failure code 与 `rowToSummary` enrichment 原样只保留一份；
- `listTasks` 只投影 `summary`；
- `listTaskItems` 先取得同一批 canonical rows，再把非空、非 `SYSTEM_USER_ID` 的 owner ids
  交给共享 backend helper `loadOwnerIdentities`；helper 去重后按
  `OWNER_IDENTITY_SQL_BATCH_SIZE = 200` 分批执行 `users WHERE id IN (...)`，把全部 batch
  无截断合并为一个 Map，最后按原顺序附加 `ownerUserId + owner`。

因此 opt-in 只多一次 helper 调用；任务路由最多 500 行，即最多三条窄 identity SQL，没有第二份
summary mapper，也没有 per-row 查询：

- 可见任务：返回 `ownerUserId`；关联用户存在时返回 `owner`；
- `ownerUserId = null` 或 `__system__`：`owner = null`；
- 用户被物理删除/异常缺失：保留 stable `ownerUserId`，`owner = null`；
- 不可见任务：不会出现在 SQL rows，也不会把 owner identity 带进 HTTP response。

### 2.2 Scheduled task

保留详情/CRUD 使用的 `ScheduledTaskSchema` 不变，新增：

```ts
export const ScheduledTaskListItemSchema = ScheduledTaskSchema.extend({
  owner: OwnerIdentitySchema.nullable(),
}).strict()
```

保留 `listScheduledTasks(): ScheduledTask[]` 给 overview、详情/CRUD 与既有测试使用；新增只供
HTTP list route 使用的 `listScheduledTaskItems(db, actor): ScheduledTaskListItem[]`。它必须：

1. 调用原 `listScheduledTasks()`；该函数继续独占 `rowToScheduledTask` canonical mapper，
   保留逐字段坏 JSON degradation、legacy breadcrumb 与 `redactPayloadCredentials`；
2. 用原 `canViewScheduledTask(actor, row)` 先过滤 visible rows；
3. 仅把 visible rows 的非 system owner ids 交给同一个 `loadOwnerIdentities`，由其按 200-id
   SQL batch 无截断合并；scheduled 列表即使没有分页，也不会生成无上限单个 `IN (...)`；
4. 在原 DTO 上只附加 `owner`，不重解析/重建任何 schedule 字段。

route 直接返回该函数结果；详情、创建、更新、删除、overview 与 WebSocket wire 均不变化，
隐藏 schedule 的 owner id 也不会进入 identity query。

### 2.3 兼容旧 daemon

新 schema 对新 backend producer 是严格 required；前端 `OwnerLabel` 的输入仍允许
`ownerUserId` / `owner` 为 `undefined`，用于连接旧 daemon 时的运行时降级：

- task list 缺 `ownerUserId`：显示「未知归属」；
- scheduled list 有 `ownerUserId` 但缺 `owner`：显示 stable id；
- 新 daemon 的类型/测试确保两个 list producer 不会漏字段。

## 3. Owner 展示原语

新增 `components/OwnerLabel.tsx`：

```ts
interface OwnerLabelProps {
  ownerUserId?: string | null
  owner?: OwnerIdentity | null
}
```

显示规则：

1. `ownerUserId === undefined`：显示本地化 `acl.unknownOwner`；
2. `ownerUserId === null || ownerUserId === '__system__'`：显示既有
   `acl.systemOwner`；
3. `owner?.id === ownerUserId`：主文案显示 `owner.displayName` 并单行截断；下一行以 muted
   文本完整显示 `@owner.username`，允许在固定宽度内 `overflow-wrap:anywhere`，不依赖 hover、
   focus 或 screen reader 才能辨认；
4. owner 缺失或 id 不匹配：回退 stable `ownerUserId`，绝不把另一用户的投影配给该行；
5. `title` 可作为鼠标 hover 的冗余便利，但不是任何信息的唯一载体；generic `span` 不设置
   `aria-label`；
6. `.owner-label` 有明确 max-width；displayName 单行 ellipsis，username/stable-id 完整可见
   并可换行。

不修改 `ResourceBadges`，避免把其既有 sentinel/fallback 文案扩散到其他资源页。

## 4. 前端接线

### 4.1 `/tasks`

query 类型改为 `TaskListItem[]`，请求增加 `include_owner=true`，query key、过滤、排序与同步
失效策略不变。`filterTaskRows` 改为保留子类型的泛型
`<T extends TaskSummary>(rows: T[], ...): T[]`，避免筛选后擦掉 list-only 字段。在
`TaskSubjectLink` 后、仓库前加入 Owner：

```tsx
<th>{t('acl.owner')}</th>
...
<td className="data-table__owner-cell">
  <OwnerLabel ownerUserId={row.ownerUserId} owner={row.owner} />
</td>
```

### 4.2 `/scheduled`

query 类型改为 `ScheduledTaskListItem[]`，在名称后、周期前加入同样的表头与单元格。Switch、
run-now、行点击和列表 invalidation 不变。

## 5. 信息边界与失败模式

- owner 公开身份只随 actor 已可见的行返回；不新增 owner 搜索 endpoint，也不改变任何 ACL。
- `loadOwnerIdentities` 的每条 SQL 最多 200 个 bind 参数，调用次数按去重 owner 数量线性分批；
  这是 backend 内部容量保护，不产生额外 HTTP，也不按行查询或截断结果。
- `__system__` 在数据库中有真实 user row，但 `loadOwnerIdentities` 在 SQL 前显式剔除
  `SYSTEM_USER_ID`，两个 mapper 均归一为 `owner=null`，不会把不满足普通 username schema
  的 sentinel 投影到 wire。
- identity lookup miss/历史用户缺失时保留 stable id，主表不会 loading 或失败。
- owner id 与 owner object 不一致时 fail closed 到 stable id。
- 旧 daemon 缺 task owner 字段时显示 unknown，不猜成 system。
- 两张 response 的缓存生命周期与原列表完全一致；本 RFC 不新增独立身份 cache。全站既有
  auth/cache 生命周期问题若需统一整改，应单独立安全 RFC，不与两列展示耦合。
- 128 字符显示名在列内截断；完整唯一 username 作为可见次级文本保留，触屏和键盘用户无需
  hover。
- 窄屏继续由 `TableViewport` 横向滚动，不隐藏 Owner 或操作列。

## 6. 测试

### Shared / backend

- `OwnerIdentitySchema` 与两个 ListItem schema 均 `.strict()`；不仅拒绝漏字段，也拒绝 raw
  response 夹带 role/status/email 或其他未知 key。
- task list：默认 response 仍过 `TaskSummarySchema` 且不含 owner；`include_owner=true` 才过
  `TaskListItemSchema`。覆盖真实 owner、system/null、缺失用户，以及 visibility 过滤后不可见
  owner 不出现在 body；default 与 opt-in 去掉两个 owner key 后逐字段相等，显式锁
  `openAlertCount` 与 `failureCode`。
- scheduled list：response 过 `ScheduledTaskListItemSchema`；覆盖 owner batch projection、system、
  缺失用户 fallback 数据、owner/admin visibility；另锁 credentialed `repoUrl` 脱敏与
  legacy/corrupt JSON degradation 和原 list 完全同义；以至少 201 个不同 owner 跨过 backend
  batch 边界，断言结果完整无截断；overview 仍走原 service。
- `TaskSummarySchema` 与 `task.created` wire 保持原样；捕获真实 `tasksListBroadcaster` 的
  `task.created` frame，对 raw `task` 做 exact-key（至少显式断言无 `ownerUserId` / `owner`），
  防止非 strict 旧 schema strip 未知字段后误绿。
- contract registry 的 `/api/tasks` happy case 带 `include_owner=true` 并用非空 fixture 过
  `z.array(TaskListItemSchema)`；scheduled harness 增加非空 human-owned row，再过
  `z.array(ScheduledTaskListItemSchema)`。独立 route 测试以 raw-object exact keys 断言默认
  task response 没有 `ownerUserId` / `owner`，避免非 strict 旧 schema 把夹带字段 strip 后误绿。
- boolean query 覆盖 missing/false/0/true/1/invalid；源码/请求回归锁只有 `/tasks` 传字符串
  `'true'`，首页与 scheduled history 不传。

### Frontend

- `OwnerLabel`：resolved / id fallback / system / unknown / mismatched owner 五分支。
- tasks/scheduled 两张表的列顺序、截断显示名、可见完整 username 与 stable-id fallback。
- `filterTaskRows` 的 type-level 回归证明 `TaskListItem[]` 输入仍返回 `TaskListItem[]`。
- 现有过滤、Switch、run-now、行点击与 invalidation 不回归。

### Browser / static

- desktop 与 390px：Owner 可见，长显示名截断、完整 username 可见，横向滚动后操作仍可达。
- axe 无新增 violation；同名 owner 的可见次级文本含不同 `@username`；键盘与触屏不依赖
  title 即可读取唯一 identity。
- shared/backend/frontend 定向测试、typecheck、lint、format。

## 7. 不做

- 不新增 owner filter、排序、头像或 profile link。
- 不改 owner 转让、task collaborator、scheduled 权限。
- 不新增 migration。
- 不新增 `/users/lookup` 请求，不改其 200-id 上限。
- 不改 auth store、QueryClient、HTTP/WS 401、mutation 或 logout。
