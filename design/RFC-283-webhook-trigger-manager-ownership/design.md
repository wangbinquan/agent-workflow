# RFC-283 · 技术设计

状态：Approved，设计门第三轮修订后待第四轮复审。语义以 `proposal.md` 的授权矩阵和
D1–D18 为准。

## 1. 权限目录与令牌矩阵

### 1.1 角色基线

`packages/shared/src/schemas/permission.ts`：

- `MANAGER_EXTRA` 增加：
  - `webhook-triggers:create`
  - `webhook-triggers:update`
  - `webhook-triggers:delete`
- `USER_BASELINE` 不变；`webhook-endpoints:manage` 不变。
- 改写现有“Webhook 写面 admin 独占”注释，明确 trigger 写面是
  `admin 全局 / manager owner-only / user none`，endpoint 写面才是 admin-only。
- `MATRIX_RESOURCES` 增加 `webhook-triggers`，避免 `grantableMatrixPoints` 与
  `buildMatrix`/Full preset 出现隐藏点。

### 1.2 PAT 与通用 MCP 资源面

trigger 路由现有 `tokenAccess:'allow'` 保持。令牌权限仍由：

```text
(READ_POINTS ∪ selected matrix) ∩ ROLE_PERMISSIONS[role]
```

产生；Delete 继续显式选择。前端 token matrix 为 `webhook-triggers` 增加中英文资源名。

在 `MATRIX_RESOURCES` 与 MCP trigger kind 变得可用之前，新增 `0149_rfc283_*` 数据迁移完成安全
cutover：对所有 `revoked_at IS NULL` 且 `scopes_json` 是合法 JSON array 的既有 PAT，保持原数组
顺序并剥离 `webhook-triggers:create/update/delete`。这三点过去可由 admin 的 Full preset 存入，
却因 UI 无 trigger 行、MCP 无 trigger kind 而形成隐藏/部分不可达授权；不能在新增 surface 时把
旧选择静默解释为新授权。畸形 JSON 不改写，仍由 `safeParseScopes` fail-closed 成空；撤销 token 不
复活，保留原 scopes 供历史盘点。迁移后只有从可见矩阵新签发的 PAT 才能取得 trigger 写点。

`packages/backend/src/mcp/tools.ts` 的 `RESOURCE_ROUTES` / `RESOURCE_KINDS` 补两类：

`webhook-triggers`：

- list `GET /api/webhook-triggers`
- get `GET /api/webhook-triggers/:id`
- create `POST /api/webhook-triggers`
- update `PUT /api/webhook-triggers/:id`
- delete `DELETE /api/webhook-triggers/:id`
- note 明示 create 额外要求 `tasks:execute`；update 触及重新武装字段、reset 时也要求
  `tasks:execute`；update/delete/reset 均受 owner 门。

只读 `webhook-endpoints`：

- list `GET /api/webhook-endpoints`
- get `GET /api/webhook-endpoints/:id`
- 不声明 create/update/delete；`permissionDomainFor` 不为它合成不存在的权限点。
- MCP dispatch actor 仍是 PAT，正式端点路由只返回 `urlToken=null`、`ingressUrl=null` 与公开 hint；
  endpoint Secret/完整 URL 和管理动作不进入 MCP。

`packages/backend/src/mcp/resourceSchemas.ts` 不直接把 REST 的
`CreateWebhookTriggerSchema` / `UpdateWebhookTriggerSchema` 转成文档：两者的 `launchPayload` 是
`z.unknown()`，kind 约束藏在 `superRefine`/服务层，直接转换会得到无约束 schema。改为提供
trigger 专用的 schema override：

- create 由 `launchKind` 枚举成 workflow/agent/workgroup 三个 `oneOf` 分支，各分支复用
  `Webhook*PayloadTemplateSchema` 生成 `launchPayload`；
- update 不含 `launchPayload` 时允许普通 partial；含 `launchPayload` 时要求同时回显现有且不可变的
  `launchKind`，再进入对应 `oneOf` 分支；正式 PUT 已允许回显相同 kind；
- common 字段仍从正式 REST schema 派生，payload 三分支从 shared Zod schema 派生，不手抄字段；
- parity 测试分别以三种 payload 证明 MCP 文档示例能通过正式 REST schema，并锁住
  `launchPayload` 不得退化为 `{}`。

工具仍 dispatch 到正式 API，不复制 permission/owner 授权逻辑。

## 2. 后端 owner 写门

`packages/backend/src/routes/webhookTriggers.ts`：

```ts
function canWrite(actor: Actor, row: Row): boolean {
  return row.ownerUserId === actor.user.id || actor.user.role === 'admin'
}

function requireWrite(actor: Actor, row: Row): void {
  if (!canWrite(actor, row)) {
    throw new NotFoundError('webhook-trigger-not-found', ...)
  }
}
```

- 删除 `isResourceAdminRole` 依赖；manager 不再借通用 resource-admin 身份跨 owner。
- PUT、DELETE、`POST /:id/streams/reset` 继续共用唯一 `requireWrite`；路由预读只作快速拒绝，
  写入前在事务内重新读取 trigger 并再次执行 owner/admin 判定。
- 这项围栏及其 manager-other 404 回归必须先于 `MANAGER_EXTRA` 的三个新点落入可运行 main。
- POST create 继续无行级门，固定 `ownerUserId = actor.user.id`；异步保存校验后在一个
  `dbTxSync` 中重验 endpoint 存在性与 target identity/ACL/builtin，再 INSERT。
- GET list/detail/fires 不恢复 owner 过滤。
- 不新增 DB 列、迁移、owner 转移或 ACL 表。

权限中间件先执行：user 在方法门 403；manager 对他人规则在 `requireWrite` 404；admin 旁路。

### 2.1 重新武装未来启动

create 已由路由元数据静态要求 `webhook-triggers:create AND tasks:execute`，保持不变。PUT 的
`tasks:execute` 是 payload-conditional，不能机械加到整条路由；否则仅改名或禁用也会被窄 PAT
错误拒绝。定义：

```text
armsFutureFire(patch, freshRow) =
  (patch.enabled === true && freshRow.enabled === false)
  OR patch contains any of:
     repoScope / eventTypes / branchFilter / commandPrefix / ignoreUsernames /
     launchRefId / launchPayload / maxConsecutiveFires / autoRegisterRepos
```

上述字段无论是放宽还是收紧、无论结果是否 disabled，都视为重新武装：精确证明“只收紧”需要
理解 glob、事件集合、ignore 反向语义和熔断阈值，另留一个检测分支会形成绕过面。纯 `name`、
`enabled:false` 以及不可变字段的同值回显不要求 `tasks:execute`。

PUT 先对预读行做快速 arming 检查；保存期异步校验完成后进入同步事务，重新 SELECT fresh trigger，
重新执行 owner 门、immutable 门与 `armsFutureFire`，并以 fresh 行构造写入。异步保存门的精确输入
代际沿用 RFC-268 的 launch-config 四列：

```text
launch_ref_id / launch_payload / event_types / auto_register_repos
```

patch 触及其中任一列时，事务内逐字节比较 fresh 值与异步校验前的 pre-read 值；任一变化就以
`webhook-trigger-update-conflict` 回滚并要求重载。不得使用 `updatedAt`：fire 会更新运行状态与该列，
不能让正常投递制造配置保存伪冲突。patch 不触及四列时可叠加到 fresh 行，因为并发的新四列由其
自己的写事务验证；owner/immutable/arming 仍必须按 fresh 行重算。

create/PUT 在最终写事务里把完整候选用 `renderWebhookLaunch` 生成 rehearsal payload，并复用/导出
scheduled task 现有的同步 target identity fence，重验 canonical target 存在、当前 actor 可见和
builtin 禁止。异步阶段继续负责 definition、输入映射与 launch shape；同步阶段只封住其 await 窗口
内可能发生的 target 删除/ACL 收权。测试同时证明 fire 单改 `updatedAt` 不冲突、四列任一并发改动
会 409、target 删除/收权会拒绝且 trigger 零变化。

`POST /:id/streams/reset` 恒会重新开放被熔断的未来启动，因此路由元数据改为
`webhook-triggers:update AND tasks:execute`，handler 内仍显式 `requireLaunchPermission`。trigger
owner 判定、launch permission 判定与 stream UPDATE 放进同一事务并基于 fresh trigger 行执行。

测试必须包含只有 `webhook-triggers:update`、没有 `tasks:execute` 的 manager PAT：允许 rename 与
disable；拒绝 enable、每一种匹配/目标/payload/阈值字段以及 reset，且 trigger/stream 零变化。

### 2.2 删除精确确认与 token 快照

`DELETE /api/webhook-triggers/:id` 在 `requireWrite` 之后、实际删除之前解析 JSON body：

```text
缺 confirm / 非字符串 -> 422 delete-confirm-required
confirm !== row.name   -> 422 delete-confirm-mismatch
confirm === row.name   -> DELETE
```

Web UI 的既有二次确认完成后用 `api.deleteJson` 传 `{confirm: row.name}`；MCP
`resource_write.confirm` 已原样合并进 DELETE body，因此两条通道落到同一道精确比名保护。后端
开始拒绝 bodyless DELETE 与 Web caller 改造必须在同一原子批次完成，并以 Web 集成测试锁住，
避免可运行 main 的中间状态打断删除。

DELETE 在事务内重读 fresh row，再依次执行 owner/admin 门、针对 fresh `row.name` 的精确确认、
`captureDeleteSnapshot(c, actor, row)`，最后删除。错名、空名与他人规则都保持数据不变；owner 404
先于名称校验，不能用确认错误探测他人规则名。snapshot 仅对 PAT 生效，REST 审计中间件与 MCP
dispatcher 分别从同一个 Context 提取，session 删除行为不变；REST PAT/MCP 成功删除都要断言存在
脱敏快照，失败删除不得产生成功删除快照。

## 3. 前端能力拆分

`packages/frontend/src/components/webhooks/TriggersPanel.tsx` 不再用一个 `canAdmin` 控制整个
面板，而是从当前 actor 的 permission 快照派生：

```text
canCreate = has(create) && has(tasks:execute)
canOwnUpdate(row) = has(update) && (isAdmin || row.ownerUserId === actor.id)
canEdit(row) = canOwnUpdate(row) && has(tasks:execute)
canToggle(row, next) = canOwnUpdate(row) && (!next || has(tasks:execute))
canDelete(row) = has(delete) && (isAdmin || row.ownerUserId === actor.id)
canReset(row)  = canOwnUpdate(row) && has(tasks:execute)
```

渲染规则：

- 页头/空态“新建”看 `canCreate`；
- 编辑看 `canEdit(row)`；Switch 的禁用方向看 `canOwnUpdate(row)`，启用方向再叠
  `tasks:execute`；session 角色通常两者同时具备，但该拆分与后端窄 PAT 契约一致；
- 删除看 `canDelete(row)`；
- FiresDialog 接收 `canReset`，只在自己的/管理员可管规则上显示 reset；
- fires 查看对所有角色保留；
- 他人规则继续显示 Enabled/Disabled 只读 chip。

请求边界不信任挂载时布尔值，也不把 React Query 中已结算但可能 30 秒内仍 fresh 的 `/me` 当作
新鲜授权。每个 create、update、toggle、delete、reset mutation 在触发业务请求前都先执行异步
`refreshActorAtRequest`：

1. 捕获当前 request identity（token、base URL、auth revision）、actor id 与 action generation；
   `setBaseUrl` 的有效值变化与 token 变化一样推进 auth revision，防止换 daemon 与 A→B→A；
2. 直接通过 `apiRequest` 发一条 `cache:'no-store'` 的 `/api/auth/me` 请求，**不调用**共享 query 的
   `fetchQuery/refetchQueries`，所以既有 `usePermission`/`currentActorAtRequest` 不会因
   `fetchStatus:'fetching'` 暂时 fail-closed 并把合法 Dialog 关掉；
3. API client 的 `RequestOptions` 增 `cache?: RequestCache` 并原样传入 `RequestInit`；JSON
   `apiRequest`、multipart 与 blob 三条请求流都在入口调用同一个 transport identity helper，一次性
   捕获 token/base URL/revision，用捕获的 URL 发包。三条流的 401 都仅当 store 仍与三者完全一致时
   才 `clearToken`，旧 token/旧 daemon 的迟到 401 只让旧调用失败，不能登出新身份；
4. 响应后先确认 request identity 与 action generation 未变，再用严格 schema 解析 `MeResponse`；
5. 对 `meQueryOptions(capturedToken, capturedBaseUrl).queryKey` 执行 exact `cancelQueries`，等待取消完成
   后再次核对 request identity/action generation，再 `setQueryData(fresh)`。共享 query 的 queryFn 已
   消费 AbortSignal，因此被取消的旧响应不能迟到覆写 fresh actor；actor query key 同时包含 base URL；
6. 写回 fresh actor 后复核目标动作 permission、actor id/role 与 row owner，然后在无额外 await 的
   同一 continuation 中发 trigger 业务请求。若 fresh 权限不再允许，写回让整页收权但不发业务请求。

刷新失败、返回 malformed/null、permission 丢失、actor 换号或 request identity 漂移均递增本地 action generation，关闭
不再有权的 draft/确认态并 reset mutation；不得退回旧缓存。create、update、delete、reset 各按
自己的 permission 校验；enable/匹配/目标/payload/阈值/reset 的 preflight 还要检查
`tasks:execute`，避免把必然 403 的动作留在 stale UI。响应 callback 继续校验 auth revision、action
generation 和 actor identity，丢弃旧账号请求结果。后端方法门/owner/事务 arming 门仍是最终安全
边界，覆盖刷新后到业务请求之间的不可消除竞态。

actor query key 不允许各调用方重新拼装。新增单一 `actorQueryKey(token, baseUrl)`（名字可随实现保持
仓内风格），`meQueryOptions`、`currentActorAtRequest`、repos 的 request-boundary 写门、
`AccountSecurityPanel` 换 session 后的精确发布、`AccountTokensPanel` inventory 刷新及所有相应测试都
调用该 factory。`ACTOR_QUERY_KEY` 只保留作 prefix invalidate；任何 `setQueryData` 只写当前
token×base URL 的精确 key，不能用 prefix 把 daemon A 的响应铺到 B 的 actor cache。

actor 新鲜不等于业务数据新鲜。`TriggersPanel` 为 trigger list、endpoint choices、workflow/agent/
workgroup targets、fires 建立统一的非敏感 transport cache key（`base URL + auth revision`），
`useUserLookup` 也把同一 key 纳入 owner lookup query。每个由 row/target 打开的编辑、删除、reset
确认态都保存来源 transport key；auth store 通知一旦改变该 key，立即推进 action generation、关闭旧
draft/确认并 reset mutation。mutation 入口在发送 `/api/auth/me` **之前**先比来源 key，fresh actor
写回后再比一次，随后才可无额外 await 地发送业务请求。这样 A→B、token 换号与 A→B→A 都不能把
A 缓存的 trigger/endpoint/target id 提交给 B，即使克隆/恢复出来的两个 daemon 复用了相同 id。

## 4. 归属标签

列表数据已有 `ownerUserId`，wire schema 不变。

- 对 `rows.map(row.ownerUserId)` 调一次 `useUserLookup`；
- owner 文本优先 `UserPublic.displayName`，其次 `ownerUserId`；
- 每张 Card 复用 `StatusChip`/既有 chip 原语显示归属，不新增私有 badge CSS；
- 本人：标签同时表达 `我的规则` 与 owner displayName（可见文本或 title 均必须包含可识别 owner）；
- 他人：`所有者：{displayName}`；
- testid：`webhook-trigger-owner-${row.id}`；
- 标签进入卡片的 chip/facts 区，在 390px 下允许自然换行，不挤压 footer actions。

新增 i18n 键（英文 + 中文类型镜像）：`ownerLabel`、`ownedByMe`，必要时补只读归属提示；不复用
ACL visibility 文案，因为 trigger 没有 visibility/grants。

## 5. 文档同步

`docs/webhook-triggers.md` 更新安全模型：

- endpoint manage = admin session only；修复当前误写的 admin/manager；
- trigger read = 全员；write = admin 任意、manager owner-only、user none；
- PAT/MCP 写仍显式 scope + owner 门。

历史 RFC-257/RFC-260 不回写结论，只由 RFC-283 明确修订其 admin-only 写面。

## 6. 测试策略

### 6.1 shared

- `permission.test.ts`：manager 精确快照 +3；user 负向不变；endpoint manage 仍 manager=false；
  grantable/token resolve 覆盖 manager trigger CRUD。
- `token-matrix.test.ts`：admin/manager 显示 trigger 行；user 不显示；Full preset 选中的每个 point
  都有可见 cell；Delete 不进 preset。
- `0149` migration 专项：旧 admin Full 的 create/update、手工 delete 都被剥离且顺序保留；无关
  scopes、revoked rows 保持；malformed scopes 仍无权限；迁移后新签发显式 scopes 正常生效。

### 6.2 backend

扩 `rfc260-webhook-read-visibility.test.ts` 或新增 RFC-283 专项矩阵：

1. manager create 201 + owner 落自己；user 403；缺 `tasks:execute` 的 manager PAT create 403；
2. manager own PUT/toggle/DELETE/reset 成功；DELETE 必须带精确规则名；
3. manager 对 admin/另一 manager 的 PUT/DELETE/reset 返回 404 且行/stream 未变化；错名 DELETE
   返回 422 且行不变；
4. admin 对 manager-owned 行成功；
5. manager/user 读他人 list/detail/fires 仍 200；
6. manager PAT scopes 正/负矩阵，owner 限制与 session 同构；update-only 窄 PAT 只可 rename/disable，
   对 enable、每个匹配/目标/payload/阈值字段与 reset 都 403；并发改行时事务内 fresh 判定不被绕过；
   launch-config 四列逐列 CAS、fire runtime update 不冲突、target 删除/ACL 收权零写入；
7. REST PAT 与 MCP 成功 DELETE 均产生脱敏 snapshot；拒绝的 DELETE 无删除副作用。

`rfc247-mcp-server.test.ts` 更新 resource-kind 漂移锁并覆盖 trigger generic resource dispatch 不绕过
正式路由；MCP-only actor 能 list/get 脱敏 endpoint、不能写 endpoint；三种 launch kind 的 body
schema 非空且示例均通过正式 REST schema；错名 generic delete 不删除。

### 6.3 frontend

扩 `rfc260-webhook-readonly-view.test.tsx` 与 `rfc257-webhook-pages-inline.test.tsx`：

- manager 同时看到自己和他人卡：页头有 New；自己有 Switch/Edit/Delete；他人零写动作；
- FiresDialog 仅自己的 skipped-circuit-open 行有 Reset；
- admin 两行都有动作；user 两行都只读且无 New；
- owner 标签 displayName、我的标记、lookup 失败回退 id；
- manager→user、A→B、`/me` no-store 刷新 error 时旧 handler只发 auth GET、不发 trigger 写请求，
  Dialog/确认态关闭；
- 同一 manager 的成功 refresh 期间 Dialog 不关闭且 auth GET 后恰好继续一条 trigger 写请求；
- API client 断言 `RequestInit.cache === 'no-store'`；token/base URL/ABA 切换后旧请求的迟到 401 不清
  新 token（JSON/multipart/blob 三流都覆盖）；已在途旧 actor query 被 exact cancel，迟到响应不能
  覆写 fresh actor；actor 的所有手工 key 消费者都用共享 factory；
- daemon/token 切换后 trigger、endpoint、workflow/agent/workgroup、fires 与 owner lookup 都命中新
  transport key；A 上打开的 edit/delete/reset/create draft 在 B 上不发 auth GET 或业务写请求，B 的
  同 id fixture 也不被误操作；
- 390px/card footer 与 owner chip 的布局源码/DOM 断言，必要时纳入 visual regression。

## 7. 改动面

| 模块                           | 改动                                                |
| ------------------------------ | --------------------------------------------------- |
| shared permission.ts           | manager +3、矩阵资源 +1、注释                       |
| backend migration 0149         | 未撤销旧 PAT 剥离三个 trigger 写 scope               |
| backend webhookTriggers.ts     | owner/admin 围栏、fresh arming 门、DELETE 确认/快照 |
| backend scheduledTasks/trigger validation | 导出并复用同步 target identity fence       |
| frontend auth store/api client/useActor | base URL revision、三流条件 401、actor key factory |
| frontend TriggersPanel.tsx     | capability × owner、no-store auth、owner 标签/确认  |
| frontend query consumers       | webhook transport re-key、actor 手工消费者迁移      |
| frontend i18n                  | trigger owner + token matrix resource 文案          |
| backend mcp/tools.ts           | trigger CRUD + endpoint 只读 resource 描述          |
| backend mcp/resourceSchemas.ts | trigger kind-aware create/update schema override    |
| docs/webhook-triggers.md       | 现行角色/owner 模型                                 |
| tests                          | shared/backend/frontend/MCP/token matrix            |

除旧 PAT scope 安全 cutover 的数据迁移外无 schema 迁移；无 response wire 变更、无 endpoint 写权限/
dispatch/scheduler 行为改动；trigger DELETE
request 新增强制 `{confirm: 当前规则名}`，update/reset 的 launch-arming 权限与既有
`tasks:execute` 委托对齐。
