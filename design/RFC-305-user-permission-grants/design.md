# RFC-305 · 统一权限目录与用户级附加授权 — 技术设计

> 本文实现 [proposal.md](./proposal.md) 的最终裁决：账户角色只选择权限预设，授权消费者只读取有效权限。

## 1. 不变量

### I1. 角色不是授权轴

```text
role ──selects──> preset permissions
                         │
stored grants ───────────┼──> effective account permissions ──> authorization consumers
                         │
account:self ─intrinsic──┘
```

唯一账户权限公式：

```ts
effective = new Set([...ROLE_PERMISSIONS[role], ...canonicalAdditionalPermissions])
```

允许读取 `role` 的位置只有预设归约、持久化/wire/审计和展示/筛选。以下位置不得读取角色决定放行：

- HTTP `RouteMeta`、MCP tool admission；
- route handler、application service、resource ACL；
- WebSocket subscribe / receive / broadcast；
- scheduled、call、workgroup、webhook 等后台委派；
- 前端 route、导航、按钮和数据请求开关。

### I2. 权限闭集和产品目录同构

`PERMISSIONS` 与 `PERMISSION_CATALOG` 必须一一对应。角色预设、用户清单、双语文案、PAT 规则和存储校验都从共享定义派生，
不得在 Dialog、route 或 service 维护第二份可授予列表。

### I3. 一个写入所有者

用户角色、grant、access revision 和 access audit 只有 `identity-access` infrastructure repository 可以写。旧
`services/users.ts` 是兼容 facade，不归约权限、不直接更新这些列或表。

### I4. 当前 authority 而非 credential-time 快照

每个 direct 请求和新的 delegated admission 重新读取当前用户状态、角色、grants 与 revision。WebSocket 的每次投递还需用 DB
revision 围栏。进程内刷新事件可以丢失，不能成为正确性前提。

## 2. RFC-294 模块落位

生产目录：

```text
packages/backend/src/modules/identity-access/
├── domain/
│   └── userAccessPolicy.ts
├── application/
│   ├── accessAdmission.ts
│   ├── errors.ts
│   ├── operationContext.ts
│   ├── view.ts
│   ├── commands/
│   │   ├── createManagedUser.ts
│   │   └── updateUserAccess.ts
│   ├── queries/
│   │   ├── getUserAccess.ts
│   │   ├── resolveAuthority.ts
│   │   └── resolveDelegatedAuthority.ts
│   └── ports/
│       ├── identityAccessObserver.ts
│       ├── userAccessAuditRepository.ts
│       ├── userAccessRepository.ts
│       └── userAccessTransaction.ts
├── infrastructure/
│   ├── identityAccessObservability.ts
│   ├── sqliteUserAccessAuditRepository.ts
│   └── sqliteUserAccessRepository.ts
├── public/
│   ├── commands.ts
│   ├── events.ts
│   ├── participants.ts
│   ├── queries.ts
│   └── types.ts
└── composition.ts
```

职责：

| 层                  | 拥有                                               | 不拥有                     |
| ------------------- | -------------------------------------------------- | -------------------------- |
| `domain`            | grant 规范化、预设替换、访问不变量、纯 transition  | DB、HTTP、WS、日志         |
| `application`       | command/query、admission、opaque context、事务编排 | SQL、Hono、React           |
| `application/ports` | repository、transaction、observer、event port      | adapter 实现               |
| `infrastructure`    | SQLite 和可观测性 adapter                          | 业务授权分支               |
| `public`            | exact command/query/participant/event/type 合同    | domain/infrastructure 导出 |
| `composition`       | 唯一装配                                           | 业务规则                   |

外部模块只可 import `public/*` 或 `composition.ts` 的审核入口；禁止跨界 import `domain`、`application` 或 `infrastructure`。

### 2.1 兼容 facade

| 存量位置                 | 本 RFC 后职责                                       | 删除波次                             |
| ------------------------ | --------------------------------------------------- | ------------------------------------ |
| `auth/actor.ts`          | 把 current authority 投影成存量 `Actor.permissions` | RFC-294 W4/W9                        |
| `auth/session.ts`        | credential lookup 与 current actor adapter          | RFC-294 W4/W9                        |
| `services/users.ts`      | CLI/OIDC/旧调用兼容，访问写转发 exact command       | RFC-294 identity vertical slice 后续 |
| `routes/users.ts`        | HTTP codec、context 构造、public error 映射         | RFC-294 W4-A                         |
| `ws/revalidationHook.ts` | post-commit 定向刷新加速                            | RFC-294 committed event/outbox 波次  |

架构测试冻结 public exact exports、外部 import allowlist 和 writer 分母。

## 3. 共享权限模型

### 3.1 闭集

`packages/shared/src/schemas/permission.ts` 定义：

```ts
type PermissionDelegationMode = 'account-additive' | 'intrinsic'

interface PermissionCatalogEntry {
  permission: Permission
  group: PermissionGroup
  labelKey: PermissionLabelKey
  descriptionKey: PermissionDescriptionKey
  delegation: PermissionDelegationMode
  risk: 'standard' | 'elevated' | 'critical'
  token: 'matrix' | 'account-range' | 'never'
  constraints: readonly PermissionConstraint[]
}
```

当前闭集为 72 点：`user` 预设 48、`manager` 预设 60、`admin` 预设 72。只有 `account:self` 是 `intrinsic`；其余 71 点均
为 `account-additive`。某点是否可选只由“非内在且不在当前预设”派生：

```ts
grantableAdditionalPermissions(role) = PERMISSIONS.filter(
  (permission) =>
    PERMISSION_CATALOG[permission].delegation === 'account-additive' &&
    !ROLE_PERMISSIONS[role].includes(permission),
)
```

因此普通 `user` 当前可选 24 点，勾满后：

```text
resolveEffectiveAccountPermissions(user, all 24 grants)
  == new Set(ROLE_PERMISSIONS.admin)
```

### 3.2 五个显式 capability

历史角色谓词映射为：

| 权限                              | 生产消费点                                                               |
| --------------------------------- | ------------------------------------------------------------------------ |
| `resource-acl:bypass`             | `services/resourceAcl.ts` 及依赖其统一 helper 的资源操作                 |
| `memory-distill-jobs:manage`      | memory distill HTTP routes、WS channel 与前端入口                        |
| `intent:audit`                    | Intent session 列表/详情、turn session 与 provenance 只读投影            |
| `mcp-runtime-tests:audit`         | MCP runtime test exact-id transcript 读取；不授予 latest 枚举或 mutation |
| `webhook-triggers:override-owner` | Webhook trigger update/delete 的 owner 行级门                            |

没有 `ROLE_CAPABILITY_CATALOG`，没有 `RouteMeta.identity`，也没有 `isResourceAdminRole`。

### 3.3 写入规范化与坏行处理

严格写边界依次拒绝：

1. 非 `PermissionSchema` 值：`user-permission-invalid`；
2. 重复值：`user-permission-duplicate`；
3. `intrinsic` 值：`user-permission-not-grantable`；
4. 与目标预设重复：`user-permission-redundant`。

规范顺序始终按 `PERMISSIONS`，使 API、DB、审计和测试稳定。读取 DB 时使用 fail-closed 版本：坏行不进入 authority，并向
observer 发诊断；不因修复失败而阻断其余合法权限。

### 3.4 角色替换语义

新客户端提交完整 `{ role, additionalPermissions, expectedRevision }`。角色变化替换预设，附加列表代表目标状态下明确选择的差集。
旧 `PATCH { role }` 只作为一版兼容 adapter：保留当前显式 grants 中在新预设下仍非冗余的点，不把旧预设的隐含能力转换为
grant，因此之后降级不会“复活”旧基线。

## 4. 持久化

迁移 `0162_rfc305_user_permission_grants.sql`：

```text
users.access_revision INTEGER NOT NULL DEFAULT 0

user_permission_grants
  PK(user_id, permission)
  user_id -> users(id) ON DELETE CASCADE
  permission TEXT
  granted_by_user_id TEXT NULL
  granted_at INTEGER

user_access_audit
  id PK
  target_user_id / actor_user_id / actor_kind
  operation_id / correlation_id
  before_role / after_role
  added_permissions_json / removed_permissions_json
  access_revision / created_at
```

`permission` 不加 SQL enum CHECK；shared catalog 是演进中的权威，module 写入严格校验，读取 fail closed。grant 随账户删除；audit
不对 target/actor 建 FK，删除账户后仍保留历史。SQLite trigger 拒绝 audit UPDATE/DELETE，append-only 不是 repository 约定。

迁移不回填 grant；所有存量账户 revision=0，权限行为等于原角色预设。

Bootstrap 与 OIDC 自动建号仍须和各自的登录策略/identity 行同事务，但不得自行写 `users.role`。两条路径经
`identity-access/public/commands` 的 exact transaction participant 写入初始 user/revision=0/create audit；实际 Drizzle
`insert(users)` 只存在于 identity-access SQLite repository。这样既不拆散跨上下文原子性，也不制造第二个角色 writer。

## 5. Authority 与 operation context

### 5.1 Direct request

`DirectOperationContextFactory` 只接受已认证 principal，铸造 opaque `RequestAuthority`。subject claim 与 source/transport 放在模块私有
`WeakMap`，外部不能用对象字面量伪造可信 context。

```text
credential lookup
  -> authenticated principal {userId, source}
  -> identity-access uses one joined DB statement to resolve active row + canonical grants + revision
  -> build Actor with effective permissions
  -> route permission AND gate
  -> row-level/application authorization
```

session、PAT 和 daemon 都经过同一 current-account resolver。PAT 在最终 Actor 投影时再应用 §8 公式。

### 5.2 Delegated authority

scheduled、call-workflow、call-workgroup 与 webhook 只持久化 subject ref。开始新的 durable attempt 时：

1. `ResolveDelegatedAuthority` 重新读取 current subject；missing/disabled 拒绝；
2. 模块铸造带 user id、revision、source 的 opaque `DelegatedAuthorityRef`；
3. `DelegatedOperationContextFactory.fromDurableAttempt` 校验 WeakMap claim，绑定 source/attempt/idempotency；
4. command 在新的副作用边界使用该 context。

这样 durable payload 不存完整 permissions，也不能伪造任意 authority。

## 6. 访问命令

### 6.1 Admission

访问配置写入只接受：

```text
(source=cli AND transport=cli)
OR
(source=session AND transport=http AND actor active AND permissions has users:write)
```

不读取操作者角色。PAT、daemon HTTP 和 delegated context 不进入访问配置工作流。旧 profile/status-only 管理可接受 active
session 或 daemon HTTP，只要有效权限含 `users:write`。

### 6.2 CreateManagedUser

同一事务：

1. 解析可信 context 并按 `users:write` admission；
2. 严格规范化目标角色下的 additional grants；
3. 校验 system username / username unique；
4. 插入 user（revision=0）与 grants；
5. 写 revision=0 的 create audit；
6. commit 后记录 observer 结果。

### 6.3 UpdateUserAccess

请求契约：

```ts
interface ExactAccessSnapshot {
  role: Role
  additionalPermissions: readonly Permission[]
  expectedRevision: number
}
```

事务算法：

1. 重读操作者当前 row/grants，在事务内按 `users:write` admission；
2. 重读目标与当前 grants；
3. access 写先比较 `expectedRevision`；
4. 计算规范 transition、before/after effective permissions；
5. 校验 self/system/last-access-administrator/status 不变量；
6. conditional update `WHERE access_revision = expected`；
7. 差量删/增 grant，写 append-only audit；
8. commit 后发 `AuthorityRevisionChanged` 和 observer 事件。

任何异常都回滚 user、grant、revision、audit；post-commit 刷新失败只告警，不能补偿已提交事务。

### 6.4 不变量

- `__system__` 不可修改；
- interactive actor 不能修改自己的访问快照；
- 不能禁用自己；
- 不能让系统失去最后一个 active、非 system、有效权限含 `users:write` 的账户；
- last-access-administrator 以 capability 判定，不读取 role；
- profile/status-only/no-op 不推进 access revision；
- access 变化必须推进一次 revision 并写一次 audit。

## 7. HTTP 合同

shared schema：

```ts
CreateUserBody = {
  username, email?, displayName, role, password?, sendInvite?,
  additionalPermissions: Permission[]
}

UserAccessPatch = {
  role: Role,
  additionalPermissions: Permission[],
  expectedRevision: number
}

PatchUserBody = {
  displayName?, email?, status?, forcePasswordChange?,
  access?: UserAccessPatch,
  role?: Role // deprecated compatibility; cannot coexist with access
}

AdminUserView = User + {
  additionalPermissions: Permission[],
  accessRevision: number,
  hasOidcIdentity: boolean
}
```

`routes/users.ts` 只做 parse、operation context 构造、public view 与 error 映射。路由粗门仍声明 `users:read` / `users:write`；真正的
访问快照命令在模块内再次校验可信 source/transport/current authority，避免 route metadata 成为唯一保护。目录 list/detail 的
模块内 query admission 要求 `users:read`；profile/status 与访问快照 mutation 要求 `users:write`。actor 自身的 role+grants 以及返回的
每个用户访问视图都来自单条 join 查询快照，不跨 `await` 拼接两个版本。

主要错误：

| code                                   | HTTP | 条件                                                  |
| -------------------------------------- | ---: | ----------------------------------------------------- |
| `user-directory-forbidden`             |  403 | directory query 缺 `users:read` 或 source 不可信      |
| `user-management-forbidden`            |  403 | profile/status 管理缺 `users:write` 或 source 不可信  |
| `user-access-management-forbidden`     |  403 | access mutation 不是 active `users:write` session/CLI |
| `user-access-stale`                    |  409 | revision CAS 冲突                                     |
| `user-access-ambiguous`                |  422 | legacy role 与 access 同时出现                        |
| `user-permission-invalid`              |  422 | 未知权限                                              |
| `user-permission-duplicate`            |  422 | 重复 grant                                            |
| `user-permission-not-grantable`        |  422 | intrinsic grant                                       |
| `user-permission-redundant`            |  422 | 与目标预设重复                                        |
| `self-access-change-forbidden`         |  422 | 修改自己的访问快照                                    |
| `last-access-administrator-protection` |  422 | 移除最后 active `users:write` 账户                    |

## 8. PAT

PAT 账户上限使用当前有效账户权限，不再只用角色预设：

```ts
tokenPermissions =
  (READ_POINTS union storedMatrix)
  intersect effectiveAccountPermissions
  minus SYSTEM_DOMAIN_POINTS
  minus (DELETE_POINTS minus storedMatrix)
```

`grantableMatrixPoints` 同样接受 effective account set。所有五个新 capability 都是 system-domain，和 `users:*`、`settings:*`、
`scripts:author` 等一样永不进入 PAT。存量 PAT 保存的矩阵不变；账户 grant 撤销/恢复会在每次请求自然收窄/恢复其允许的交集。

## 9. WebSocket 与前端刷新

每个 WS connection 保存 subject 与 authority revision。订阅、入帧和广播前核对 DB 中用户 active 状态与 revision；不匹配则拒绝
继续使用旧 actor。认证后的 `AppShell` 常驻 `/ws/authority`，因此 users/account/settings 等不挂业务 socket 的页面也能收到变更。
access commit 后的 targeted refresh 会：

- 重新解析该用户连接或关闭失活连接；
- 在重跑业务 channel gate 前发 `authority.changed`，即使该 channel 随后因撤权以 4403 关闭也不丢刷新信号；
- 前端 `useWebSocket` invalidates `ACTOR_QUERY_KEY`，重新读取 `/api/auth/me`；
- 前端权限 hook fail closed：me 未加载或 payload 非法时不放行。

`memory-distill-jobs` channel 明确要求 `memory-distill-jobs:manage`，拒绝码为 `permission-required`。

## 10. 前端模型

`packages/frontend/src/lib/user-permissions.ts` 从 shared `PERMISSIONS`、`PERMISSION_CATALOG`、`ROLE_PERMISSIONS` 派生行模型：

```text
source = intrinsic | preset | additional | available
checked = intrinsic/preset/additional
disabled = intrinsic/preset
```

`CreateUserDialog` 与 `EditUserDialog` 只传 role、selected additional set 和 callbacks，不包含权限 id 表。共享
`UserPermissionCatalog` 负责分组、搜索、风险/约束标签和 Checkbox。新增权限只需：

1. 增加 shared `PERMISSIONS` 项；
2. 补 `PERMISSION_CATALOG` 元数据；
3. 补中英文 label/description；
4. 接入真实消费者并更新 reverse coverage。

完成后两个弹窗自然出现。

角色切换只重算预设与当前显式 grants；它不会把旧预设的全部有效权限复制为 grant。409 时保留本地 draft，用户选择“加载最新访问”
后再重新应用修改。

所有前端功能门已改为具体 permission，例如：

- 用户目录/操作：`users:read` / `users:write`；
- 设置：`settings:read` / `settings:write`；
- 记忆蒸馏：`memory-distill-jobs:manage`；
- Webhook endpoint 明文：`webhook-endpoints:manage`；
- 导航项：对应页面 permission。

## 11. 架构与行为防护

### 11.1 静态/AST 锁

`rfc305-architecture-lock.test.ts` 验证：

- `identity-access/public` exact 文件和 export 集合；
- 模块外 import allowlist；
- role/grant/revision/audit 唯一 writer；AST 同时锁所有 Drizzle `insert(users)`，不能再用 `.values({ role })` 绕过分母；
- RouteMeta/MCP 无 `identity`；
- backend/frontend 生产代码无账户角色字面量授权比较；仅明确的展示/非账户 protocol role allowlist；
- 退役 helper（`isResourceAdminRole`、`useIsAdmin`、`adminShortCircuit` 等）零引用；
- 每个 system-domain 点至少一个生产消费方；
- 两个用户 Dialog 只使用共享 catalog 组件；
- delegated opaque factory、WS DB revision 和前端 refresh fence 存在。

### 11.2 行为矩阵

| 场景                                     | 预期                                                    |
| ---------------------------------------- | ------------------------------------------------------- |
| `user` 无 grant                          | 48 点 baseline                                          |
| `user + scripts:author`                  | 脚本敏感投影/保存开放，private ACL 仍拒绝               |
| `user + resource-acl:bypass`             | 他人 private 资源开放；撤销后恢复 404                   |
| `user + memory-distill-jobs:manage`      | distill HTTP/WS 开放；撤销后 403/refusal                |
| `user + intent:audit`                    | 跨 owner 只读；mutation 仍 404；撤销即时收敛            |
| `user + mcp-runtime-tests:audit`         | exact-id transcript 可读；latest/mutation 仍拒绝        |
| `user + webhook-triggers:override-owner` | 有对应 update/delete 粗门时可跨 owner 写；撤销后 404    |
| `user + users:read/write`                | 可管理其他用户，无角色提升                              |
| `user + 全 24`                           | effective set 与 admin 72 点完全相同，角色 wire 仍 user |
| 任意 PAT + system points                 | 五个新 capability 与其他 system-domain 点均被剔除       |

### 11.3 迁移/OCC/失败路径

覆盖新库和 161→162 升级、grant PK/FK、audit 删除账户后保留、DB trigger 拒绝 audit 更新/删除、并发 CAS、事务回滚、坏 grant
fail closed、self/system/last users:write、profile no-op、禁用/启用、邀请激活和 legacy role adapter。

## 12. RFC-294 后续边界

本 RFC 已完成一个真实 bounded-context 纵切，但不宣称 RFC-294 全部完成：

- W4-A operation catalog 尚未统一 HTTP/MCP binding；目标 `AdmissionPolicy` 只包含 permissions 与 publicReason，不再含 identity；
- current `Actor` 仍是 legacy consumer surface；
- post-commit refresh 尚未迁通用 committed-event/outbox；
- route/service facade 将在对应消费者清零后删除。

这些债不得成为重新引入角色授权判断或第三套权限目录的理由。
