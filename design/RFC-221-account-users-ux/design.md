# RFC-221 账户安全中心与响应式用户目录 UX 重构 — design

状态：Approved v5（2026-07-22；用户已批准，production/test 本地实现完成；实现门、精确 SHA CI 与剩余视觉验收仍待完成）。
以 `proposal.md` 为产品合同。

## 1. 设计原则与硬边界

1. **任务分层，不是换皮**：账户资料、安全、存量令牌各有独立目的地；用户管理不再靠横向表发现操作。
2. **OIDC 是账户级策略**：linked identity 数量大于零即 OIDC managed，不猜当前 session 的登录来源。
3. **禁用必须前后端一致**：PAT create、OIDC password mutation、identity unlink 都由 UI 删除入口且 API 拒绝。
4. **存量令牌只退不进**：不制造新 PAT，不自动打断现有 PAT；保留 list/revoke 作为退出通道。
5. **登录方式是服务端策略**：用户名密码开关不以“是否渲染表单”为事实源；登录落 session 与 Provider
   生命周期在数据库事务边界复核。
6. **Bootstrap 是一次性交接**：未交接时 daemon token 只能创建首位 admin；admin insert 与 token 永久退役
   同一事务，`__system__` 只保留为内部技术主体。
7. **一个动作一个事务面**：编辑、重置密码、停用、吊销各有独立 Dialog/ConfirmDialog；错误留在原位。
8. **窄屏没有次要列**：身份、角色、状态、操作在 390px 直接可见，不能靠横向滚动。
9. **复用共享原语**：PageHeader、PageSectionNav、Card、ChoiceCards、Dialog、ConfirmDialog、
   StatusChip、NoticeBanner、ErrorBanner、QueryState、RelativeTime、Field/TextInput/Select/Segmented。

## 2. 信息架构

### 2.1 Account

```
/account?section=overview
┌─────────────────────────────────────────────────────────────────┐
│ 我的账户                                                        │
├──────────────────┬──────────────────────────────────────────────┤
│ 账户概览    ●     │  [WB] 王彬权   @wangbinquan                  │
│ 登录与安全        │  管理员 · 活跃 · OIDC 托管                   │
│ 存量访问令牌      │                                              │
│                  │  登录身份（只读）                            │
│                  │  GitLab SSO · w***@example.com                │
└──────────────────┴──────────────────────────────────────────────┘
```

`PageSectionNav` 在稳定容器 >=56rem 时是 rail，较窄时是 compact Select。

### 2.2 Users

```
/users?q=&status=&role=
┌─────────────────────────────────────────────────────────────────┐
│ 用户管理                                      [新建用户]         │
│ 12 位用户 · 2 位管理员 · 3 位待登录 · 1 位停用                  │
│ [搜索姓名/用户名/邮箱______] [全部 活跃 待登录 停用] [全部角色⌄] │
├─────────────────────────────────────────────────────────────────┤
│ [AL] Alice Chen  @alice    alice@example.com                    │
│      普通用户  ● 活跃  OIDC 托管  2 小时前登录          [管理]   │
├─────────────────────────────────────────────────────────────────┤
│ [BO] Bob Li      @bob      —                                    │
│      管理员    ● 待登录  等待 OIDC  从未登录            [管理]   │
└─────────────────────────────────────────────────────────────────┘
  系统主体
  __system__ · daemon 内部主体 · 不可登录/编辑
```

手机行改为堆叠卡，管理按钮不进入三点菜单，也不移出 viewport。

### 2.3 Settings → Authentication

```text
/settings?section=authentication
┌─────────────────────────────────────────────────────────────────┐
│ 登录方式                                                        │
│ 用户名和密码登录                                  [  已开启  ] │
│ 尚无 enabled Provider 时必须保持开启。                          │
│ Bootstrap token                                   已永久退役   │
│                                                                 │
│ OIDC Providers                                      [新增]      │
│ GitLab SSO · enabled · 最近测试：由管理员主动执行                │
└─────────────────────────────────────────────────────────────────┘
```

登录方式卡位于 Provider 列表之前，是即时 mutation，不加入 `ConfigDraftProvider`：策略与 Provider
共同存于 SQLite，需要共用事务不变量，不能拆到 `config.json` 后制造跨存储竞态。

### 2.4 Auth 登录入口

公共 discovery 是判别联合，不允许混搭出“bootstrap 同时显示 OIDC/password”的状态：

- `mode='bootstrap'` → 唯一 daemon token form，成功后 `/setup/admin`；
- `mode='ready'` 且无 Provider → 唯一 username/password form（policy 不变量保证为 on）；
- `mode='ready'` 且有 Provider + password on → OIDC/password 两种方法；
- `mode='ready'` 且有 Provider + password off → 唯一 OIDC 方法；
- 单一方法不渲染冗余 TabBar；两个以上方法才使用 segment tabs；
- discovery loading/error 时不猜任何方法，只显示 Loading/Error + retry。

### 2.5 Bootstrap admin setup

```text
/setup/admin
┌─────────────────────────────────────────────────────────────────┐
│ 创建首位管理员                                                  │
│ 1 设置账户  →  2 Bootstrap token 永久失效  →  3 重新登录       │
│ 用户名       [____________________]                              │
│ 显示名       [____________________]                              │
│ 密码         [____________________]                              │
│ 确认密码     [____________________]                [完成交接]   │
└─────────────────────────────────────────────────────────────────┘
```

这是 bare-shell 安全设置页，不复用 RFC-211 的 `/onboarding` 学习页，也不显示 AppShell/nav/跳过按钮。

## 3. 路由状态

### 3.0 Bootstrap route

`/setup/admin?redirect=` 只接受 daemon token + `mode='bootstrap'`：

- token form 成功后 replace 进入，原 deep link 经 `safeInternalRedirect` 保留；
- 无 token → `/auth`；server 已 ready → 清 token 并 replace `/auth`；
- success → 先 clearToken，再 replace `/auth?setup=complete&redirect=...`；
- `/auth` 消费 `setup=complete` 一次性 NoticeBanner，但 URL 不携带密码或 token；
- RootShell 对 `/auth` 与 `/setup/admin` 都使用 BareShell；其他 route 的 bootstrap daemon actor 被强制导回 setup。

### 3.1 Account section

新增 `packages/frontend/src/lib/account-navigation.ts`：

```ts
export type AccountSection = 'overview' | 'security' | 'tokens'
export interface AccountSearch {
  section?: AccountSection
}
export function parseAccountSection(value: unknown): AccountSection
```

- URL 缺省为 overview，不强制把默认值写回；
- 非法值 replace 为 overview，永不渲染空 panel；
- rail Link 与 compact Select 共用 functional search update；
- 三个目的地是真实 link + 唯一 `aria-current=page`，不是伪 tab。

### 3.2 Users filters

`packages/frontend/src/lib/user-directory.ts`：

```ts
export type UserStatusFilter = 'all' | 'active' | 'invited' | 'disabled'
export type UserRoleFilter = 'all' | 'admin' | 'user'
export interface UsersSearch {
  q?: string
  status?: Exclude<UserStatusFilter, 'all'>
  role?: Exclude<UserRoleFilter, 'all'>
}
```

- URL 只写非默认值，未知 enum 丢弃；
- 搜索字符更新使用 replace，segment/role 显式切换进 history；
- 可见输入只 trim；匹配时做 NFKC + locale lowercase；
- 清除筛选一次删除 q/status/role，焦点留在搜索框。

## 4. 共享 wire 与呈现模型

### 4.1 MeResponse 收紧已有类型

`/api/auth/me` 已经返回 linkedIdentities 与 pats，但前端将两者写成 `unknown[]` 后又重复请求。
本 RFC 不加字段，只把前端合同改为共享类型：

```ts
interface MeResponse {
  user: UserPublic
  source: 'session' | 'pat' | 'daemon'
  permissions: Permission[]
  linkedIdentities: UserIdentity[]
  pats: PatPublic[]
}
```

Account overview/tokens 直接以 actor query 为单一 owner；identity 无 mutation、PAT revoke 成功后 invalidate
`ACTOR_QUERY_KEY`。`GET /api/auth/identities` 与 `GET /api/auth/pats` 仍为外部 API 保留。

`isOidcManaged(me) = me.linkedIdentities.length > 0`。前后端都以“是否存在 identity row”为事实源，
不以 source、email、status 或 user-agent 推断。

### 4.2 AdminUserView

管理端需要在 reset 前知道是否 OIDC 托管。新增共享 additive schema：

```ts
export const AdminUserViewSchema = UserSchema.extend({
  hasOidcIdentity: z.boolean(),
})
export type AdminUserView = z.infer<typeof AdminUserViewSchema>
```

`GET /api/users`、`GET /api/users/:id`、POST create 与 PATCH response 都返回 AdminUserView。
列表 materialization 用一次 identity userId 查询构造 Set，不对每个用户做 N+1。

- 已绑定 identity → `hasOidcIdentity=true`，显示“OIDC 托管”；
- invited 且 false → 显示“等待首次登录”，不冒充已经绑定；
- 其余 false → 显示“本地账户”；
- `__system__` 单独呈现，不使用该分类进入人类统计。

### 4.3 角色、状态、凭据归属

新增 `packages/frontend/src/lib/account-user-presentation.ts`：

```ts
export const USER_STATUS_PRESENTATION = {
  active: { kind: 'success', labelKey: 'users.statusOption.active' },
  invited: { kind: 'warn', labelKey: 'users.statusOption.invited' },
  disabled: { kind: 'danger', labelKey: 'users.statusOption.disabled' },
} as const

export const USER_ROLE_PRESENTATION = {
  admin: { kind: 'info', labelKey: 'users.roleOption.admin' },
  user: { kind: 'neutral', labelKey: 'users.roleOption.user' },
} as const
```

- status 用 `StatusChip withDot`；
- role 是分类，只映射 info/neutral；
- source 与 OIDC/local 归属是元数据，使用普通 text chip；
- raw enum 只作 data/test，不直接成为可见文案。

同文件提供首字母纯函数：displayName → username fallback；不引入头像网络请求或随机色。

### 4.4 User directory derive

`deriveUserDirectory(AdminUserView[], filters, locale)` 返回：

```ts
interface UserDirectoryModel {
  humans: AdminUserView[]
  system: AdminUserView | null
  visible: AdminUserView[]
  counts: {
    total: number
    admin: number
    invited: number
    disabled: number
    byStatus: Record<'active' | 'invited' | 'disabled', number>
  }
  emptyKind: 'none' | 'initial' | 'filtered'
}
```

顺序固定：

1. `id === '__system__'` 分离；
2. counts 只从 humans 计算，不随 query/role 变化；
3. query haystack = displayName + username + email；
4. 应用 status、role、query；
5. 用 Intl.Collator 按 displayName、username 稳定排序，不 mutate query cache；
6. humans 空是 initial empty，humans 非空但 visible 空是 filtered empty。

### 4.5 登录策略 wire

共享 schema 新增：

```ts
interface AuthLoginPolicy {
  passwordLoginEnabled: boolean
  bootstrapCompletedAt: number | null
  updatedAt: number
}

type AuthMethodDiscovery =
  | {
      mode: 'bootstrap'
      providers: []
      passwordLoginEnabled: false
      daemonTokenEnabled: true
    }
  | {
      mode: 'ready'
      providers: OidcProviderPublic[]
      passwordLoginEnabled: boolean
      daemonTokenEnabled: false
    }

interface UpdateAuthLoginPolicyBody {
  passwordLoginEnabled: boolean
}

interface CreateBootstrapAdminBody {
  username: string
  displayName: string
  email?: string
  password: string
}
```

- admin `GET /api/oidc/login-policy` 返回完整 `AuthLoginPolicy`；
- admin `PUT /api/oidc/login-policy` 只接受完整 boolean，不接受 truthy string/部分猜测；
- public `GET /api/auth/oidc/providers` 返回 `AuthMethodDiscovery`，不公开完成时间或 token；bootstrap 分支
  schema 锁 `providers=[]/password=false/token=true`，ready 分支锁 `token=false`；
- token-only `GET /api/auth/bootstrap/status` 返回 `{ required: true }`；
- token-only `POST /api/auth/bootstrap/admin` 只接受上述四个业务字段，role/status/forcePasswordChange/
  createdBy 等都不在 wire，unknown key 拒收；
- frontend auth/settings 均用共享 schema parse，禁止各自维护宽松 mirror；
- error union 增加 `password-login-disabled`、`password-login-requires-enabled-oidc`、
  `last-enabled-oidc-required`、`bootstrap-admin-required`、`bootstrap-already-complete`。

## 5. Account 组件

为避免 783 行 route 继续膨胀：

```text
routes/account.tsx
components/account/
  AccountOverviewPanel.tsx
  AccountSecurityPanel.tsx
  AccountTokensPanel.tsx
lib/
  account-navigation.ts
  account-user-presentation.ts
```

Route owner 只负责 PageHeader、actor gate、PageSectionNav、active panel 和 layout。

### 5.1 Actor gate

`useActor()` 是干净单查询，可用 `QueryState keepDataOnError`：

- initial loading → LoadingState；
- initial error → ErrorBanner + onRetry；
- null → sign-in EmptyState；
- cached actor + refetch error → 保留 nav/panel并叠 ErrorBanner；
- panels 不再各自重复拉 identities/PAT，sessions 保留独立 query。

### 5.2 OverviewPanel

顶部 Card：首字母、displayName、username、role/status、source、OIDC managed/local chip。

Identity list：

- provider display name/slug；
- email、linkedAt RelativeTime；
- subject 放在“技术标识”折叠区，长值 anywhere；
- **没有** button、menu item、mutation、ConfirmDialog 或 DELETE 调用；
- 空列表显示“本地账户，未关联 OIDC”轻量说明。

账户页仍不提供自助改名/邮箱。

### 5.3 SecurityPanel

`isOidcManaged=true`：

- 显示 info NoticeBanner：“此账户由 OIDC 身份提供方管理；请在身份提供方修改凭据”；
- 密码 form 不挂 DOM，避免 disabled input 给出“以后也许可改”的错误暗示；
- 会话列表照常可用。

`isOidcManaged=false`：

- 当前密码/new password 使用正确 autocomplete；
- pending 双击锁，错误 ErrorBanner，成功 NoticeBanner；
- response 类型 `{ ok: true; sessionToken?: string }`；
- 成功顺序：有 token → `setToken` → 清字段 → invalidate actor/sessions → success；
- 不能先 invalidate，旧 session 已被后端吊销；
- PAT/daemon actor 响应无 sessionToken 时不改当前 token。

后端 `POST /api/auth/change-password` 在解析/写入前调用统一 policy helper；OIDC managed 返回
`403 oidc-password-managed`，passwordHash、session 均零变化。

Session item 使用共享 SessionPublic，展示 userAgent、lastUsedAt RelativeTime、expiresAt 与短 id。API
无法可靠标记 current session，所以不按 user-agent 猜。吊销使用 ConfirmDialog。

### 5.4 TokensPanel：retirement-only

读取 `me.pats`，active/revoked 映射 success/danger StatusChip：

- 主信息：name、createdAt、lastUsedAt、状态；
- scope 默认只显示数量与少量摘要，原生 details 展开完整 code；
- active PAT 只有“吊销”，走 danger ConfirmDialog；
- 无 PAT 的 EmptyState 无 action，说明生成能力已关闭；
- route/header/panel 都不出现“新建”“生成”“选择权限”“复制密钥”。

不再存在 CreatePatDialog、PatPreset、PAT_SCOPE_GROUPS 前端 UI。后端可保留 schema/permission 定义以解析
历史 token，但 `POST /api/auth/pats` 变为 denial stub：

```ts
app.post('/api/auth/pats', requirePermission('account:self'), () => {
  throw new ForbiddenError('pat-creation-disabled', 'personal access token creation is disabled')
})
```

拒绝发生在 parse/hash/insert 前；能到达 route 的 session/PAT actor 都零写入，未持有该权限者仍由原权限门
更早拒绝。bootstrap daemon actor 被 allow-list 拦在 route 外，retired daemon token 无法通过 multiAuth。

## 6. Users 组件与事务状态机

```text
routes/users.tsx
components/users/
  UserDirectory.tsx
  UserDirectoryRow.tsx
  CreateUserDialog.tsx
  EditUserDialog.tsx
  ResetUserPasswordDialog.tsx
lib/user-directory.ts
```

### 6.1 Query/permission gate

- actor loading 时 PageHeader 仍挂载；
- 无 `users:read` 不发 GET users，显示权限 EmptyState；
- 列表 initial/loading/error/data 走 QueryState keepDataOnError；
- background error 保留目录与筛选，显示 retry ErrorBanner；
- frontend 使用共享 AdminUserView，不再维护漏字段 UserRow。

### 6.2 Directory row

Desktop grid；mobile：

`[Avatar] displayName                   [管理]
         @username · email
         [角色] [状态] [OIDC/本地] · 最近登录`

- 长邮箱 anywhere；
- role/status 不是 inline editable control；
- 当前 actor 加中性“你”chip；
- Manage >=44px；整行不 click，避免嵌套交互；
- filtered empty 不卸载 toolbar。

### 6.3 Route-owned dialog state

```ts
type UsersDialogState =
  | { kind: 'create'; trigger: 'header' | 'empty' }
  | { kind: 'edit'; userId: string; triggerRef: RefObject<HTMLElement> }
  | { kind: 'reset'; userId: string; triggerRef: RefObject<HTMLElement> }
  | { kind: 'disable'; userId: string; triggerRef: RefObject<HTMLElement> }
  | { kind: 'enable'; userId: string; triggerRef: RefObject<HTMLElement> }
  | null
```

任一时刻只挂一个 modal。edit → reset 保存 row trigger ref 但先卸载 edit。若 mutation 后行因筛选消失，
focus fallback 是 PageHeader“新建用户”。

### 6.4 CreateUserDialog

```ts
type CreateMode = 'password' | 'sso'
interface CreateUserDraft {
  username: string
  displayName: string
  email: string
  role: Role
  mode: CreateMode
  password: string
}
```

| mode     | email              | password        | payload     | 结果    |
| -------- | ------------------ | --------------- | ----------- | ------- |
| password | 可选，空→null/省略 | required 8..256 | 含 password | active  |
| sso      | required email     | 不渲染且不提交  | 无 password | invited |

- mode/role 用 ChoiceCards；
- 切 sso 时清 password，serialization 再保证忽略；
- 不提交 sendInvite，不声称发送邮件；
- 成功关闭、invalidate users、页面 NoticeBanner 提示 active/invited。
- `passwordLoginEnabled=false` 时仍允许选择 password mode 作为未来预置，但 Dialog 在提交前显示
  NoticeBanner：“当前全局禁止用户名密码登录；该账户需重新开启后才能使用此密码”。payload 和后端
  create 语义不变，不能把一个登录入口策略偷换成密码数据销毁策略。

新建 SSO invite 在首次成功绑定前 `hasOidcIdentity=false`；此时行显示“等待 OIDC”而不是
“OIDC 托管”。

### 6.5 EditUserDialog

draft 只含 displayName/email/role；`diffUserPatch(original, draft)`：

- displayName trim；email trim+lowercase，空串→null；
- 无 dirty 字段 Save disabled；
- self role 不 editable，system 不进入 Dialog；
- PATCH 只发 dirty keys，未编辑字段不被旧 snapshot 覆盖；
- dirty 字段并发仍沿用现有 last-write-wins；
- error 留字段/焦点，success 关闭+invalidate。

凭据区：

- `hasOidcIdentity=true`：NoticeBanner 说明 IdP 管理，不渲染 reset trigger；
- false：显示“重置密码”；invited 用户文案为“设置本地密码并激活”；
- 前端不是安全边界，reset API 必须复核。

### 6.6 Reset / disable / enable

ResetUserPasswordDialog 仅对 non-OIDC：

- newPassword + confirm（confirm 不进 payload）；
- “下次登录必须改密”序列化 force；
- warning：成功会 status→active 并撤销全部 Web sessions；
- 若全局 `passwordLoginEnabled=false`，同一 Dialog 额外说明新密码当前不能用于登录、重新开启后生效；
- 后端 reset service 在 hash/write 前复核 policy；OIDC managed 返回 `oidc-password-managed`。
- CLI `user reset-password` 复用同一 service，因此不能绕过该 policy。

Disable：

- active/invited 可触发，self/system 无入口；
- danger ConfirmDialog；last-admin/self 422 留在 Dialog；
- 不乐观删行。

Enable：

- 只对 disabled；
- 文案说明恢复已有登录方式，不设置密码/发邮件；
- PATCH `{ status:'active' }`。

## 7. 认证 policy、事务不变量与 denial endpoints

### 7.1 登录策略持久化与 admin API

新增 migration（实现时在重读 journal 后取下一个未占编号）与 Drizzle schema：

```text
auth_login_policy
  id                         TEXT PRIMARY KEY  // 固定 'global'
  password_login_enabled     INTEGER NOT NULL DEFAULT 1
  bootstrap_completed_at     INTEGER NULL
  updated_at                 INTEGER NOT NULL
```

迁移显式插入 singleton，password=true。`bootstrap_completed_at` backfill：存在 non-system active admin，且
至少有一个当前可接管凭据（passwordHash、enabled Provider 的 linked identity、未失效 session/PAT）时写 0；
否则 NULL，旧库由受限 setup 创建一位新的接管管理员。service 对缺行 fail closed 为“配置损坏”，不能静默
补一个会复活 daemon token 的默认值。单例 row 与 `oidc_providers/users` 同库，才能把 bootstrap 和
Provider policy 放入 `dbTxSync` 序列。

新增 `packages/backend/src/services/authLoginPolicy.ts`：

```ts
export function getAuthLoginPolicy(db: DbClient): AuthLoginPolicy
export function setPasswordLoginEnabled(
  db: DbClient,
  enabled: boolean,
  now?: number,
): AuthLoginPolicy
export function completeBootstrapWithAdmin(
  db: DbClient,
  prepared: PreparedBootstrapAdmin,
  now?: number,
): AdminUserView
```

路由：

- `GET /api/oidc/login-policy` + `oidc:read`；
- `PUT /api/oidc/login-policy` + `oidc:configure`；
- `GET /api/auth/oidc/providers` public，返回 bootstrap/ready discovery；
- `GET /api/auth/bootstrap/status`、`POST /api/auth/bootstrap/admin` 仅接受尚未退役的 daemon actor。

不把 flag 加到 `ConfigSchema`/`config.json`，也不经 `/api/config`：跨文件/DB 的 check-then-write 无法与
Provider disable/delete 原子化。RFC-222 的 manager 不拥有 `oidc:*`，因此也不能读写本设置。

### 7.2 AuthenticationTab 与 AuthPage 状态机

`AuthenticationTab` 增加 `['oidc-login-policy']` query 和 PUT mutation：

- initial loading/error 独立于 Provider 列表，错误可 retry；
- 无 enabled Provider 时 Switch 锁定在 on，并提示“先配置并启用第三方认证”；有 Provider 后关闭动作才展示
  warning ConfirmDialog；
- mutation pending 锁 Switch/确认按钮，不做 optimistic flip；成功以 server response 更新 cache；
- 关闭期间最后一个 enabled Provider 的 Edit/Delete 入口显示解释，但后端仍是最终边界；
- 重新开启直接 PUT，失败时视觉状态保持 server 值。

`AuthPage` discovery state 改为携带完整 `AuthMethodDiscovery`。tab/panel 从同一个 allow-list 构造，不能分别
分支：

1. loading：不挂任何 credential panel，只显示 LoadingState；
2. error：ErrorBanner + retry，不猜 token/password/OIDC 任一可用性；
3. bootstrap success：唯一 daemon token form；验证 actor 后 replace `/setup/admin`；
4. ready success：按 providers、passwordLoginEnabled 构造方法；单一方法直接挂 form/provider list，无 TabBar；
5. 多方法 one-shot 初始落点 OIDC → password；若用户已交互，迟到响应不抢焦点；
6. 旧页面在提交时收到 `password-login-disabled`，刷新 discovery、把 active tab reconcile 到首个允许方法，
   并显示本地化 NoticeBanner。

任何状态都保证 active tab 一定有 panel；关闭时 username/password input 不挂 DOM，而不是 disabled/hidden。

### 7.2.1 Bootstrap route 与服务端 allow-list

`multiAuth` 成功解析 daemon token 后读取 policy：

- `bootstrap_completed_at !== NULL` → 直接返回 null，HTTP/query/WS 均走统一 401；
- NULL → actor 仍映射到 `__system__`，但后置 `bootstrapGate` 只放行
  `/api/whoami`、`/api/auth/bootstrap/status`、`/api/auth/bootstrap/admin`；
- 其余 `/api/*` 返回 `403 bootstrap-admin-required`，details 只给 setup 路径，不泄露 token/policy 内部字段；
- public discovery 不需要 token，bootstrap 时只宣布 token method。
- public password login、OIDC start 与 callback 绕过 multiAuth，因此各 route 在 parse username、查 Provider、
  token exchange/identity write 前独立调用同一 `assertBootstrapComplete`；未完成统一结构化 403（callback 用
  对应 friendly HTML），零 session/user/identity 写入。
- `/ws/*` 不经过 HTTP bootstrapGate；`tryUpgrade` 对尚未完成的 daemon actor 固定 403
  `bootstrap-admin-required`，完成后 token resolve 为 null→401。upgrade 与完成事务竞态沿 RFC-212 epoch/
  revalidation 再检，不能在提交后漏开一条 admin socket。

前端 `/setup/admin` 只调用 bootstrap endpoints，不加载 AppShell、全局 overview、settings/config 或 users query，
因此 allow-list 与页面网络面能一一锁测试。

### 7.3 事务不变量与线性化点

`dbTxSync` 内统一维护：

| 转移                              | 同事务读取                         | 允许条件                                 |
| --------------------------------- | ---------------------------------- | ---------------------------------------- |
| password login true → false       | enabled Provider count             | count >= 1                               |
| enabled Provider true → false     | login policy + other enabled count | policy on 或另有 enabled Provider        |
| DELETE enabled Provider           | login policy + other enabled count | policy on 或另有 enabled Provider        |
| password login session insert     | login policy + fresh user row      | policy on、user active、hash snapshot 同 |
| bootstrap admin insert + complete | policy + username/email uniqueness | completedAt NULL；固定 active/admin      |

因此“先关 policy/后删 Provider”和“先删 Provider/后关 policy”两个顺序都只能有一个成功；失败事务不得留下
provider、identity 或 policy 部分写入。`oidcProviders.patch(enabled=false)` 与 `remove(force)` 的相关
check/update/delete 从当前异步 check-then-write 收口到同步事务；force identity cascade 与 Provider delete
同事务。

密码登录有两个检查点：

1. route 开头先读 policy；bootstrap 未完成先拒绝 setup，ready 但 password off 时再在 parse username、查
   user、Argon2 前返回稳定 403；
2. Argon2 成功后，预生成 token/id/hash，再由 `createPasswordLoginSession` 在单个 `dbTxSync` 中重读 policy
   与 user，确认 active 且 passwordHash 仍等于刚验证的 snapshot，随后一起 insert session + update
   lastLoginAt。

第二个检查点是提交线性化点：关闭先提交则该登录无 session/lastLogin 写入；登录先提交则它是关闭前已成立的
session，D5 明确不被开关追溯吊销。hash/status 中途变化按现有 invalid-credentials 语义失败，不用旧 hash
落新 session。

Bootstrap password 用现有 Argon2 在事务外计算；`completeBootstrapWithAdmin` 接受已校验、已 hash 的 prepared
input，在一个同步事务内：

1. 重读 singleton，已完成 → `409 bootstrap-already-complete`；
2. 再查 username/email uniqueness；
3. insert `role=admin,status=active,passwordHash=<prepared>` 的人类 user；
4. 同 row update `password_login_enabled=1, bootstrap_completed_at=now, updated_at=now`；
5. commit 后触发 WS revalidation，关闭所有 daemon credential connection。

任何 insert/constraint/update 失败都回滚 user 与 policy。当前 HTTP response 可以正常返回；同 token 的下一请求
才按 completedAt 401。并发两个 setup request 由事务全序化，一个完成后另一个稳定 409，不能创建两个“首位”
管理员。

本不变量只证明数据库里存在 enabled Provider。修改 Provider 端点、外部 IdP 下线或网络故障仍可能破坏登录；
设置确认要求管理员先 probe，本机 `auth password-login enable` 提供恢复，但不把瞬时网络 probe 冒充永久保证。

### 7.4 Daemon token 退役面

- `resolveActor` 的 daemon 分支在 constant-time token match 后读取 singleton；completed 非空永远 null；
- `reresolveActor(kind='daemon')` 同样读取 completedAt，确保 revalidation 能关闭旧 WS；
- `buildWsCredential` 不存 raw token，既有 daemon fingerprint 足够；完成事务 commit 后调用
  `triggerRevalidation(db, 'bootstrap-completed')`；
- `start.ts` 在 DB migration 后读取 discovery mode：bootstrap 才打印带 token 的 URL，ready 只打印裸 base URL；
- token file 不删除、不作为启用态；daemon restart、token rotate、旧浏览器 localStorage 都不能绕过 DB；
- pre-RFC-221 binary 不读取该 DB 状态，会重新接受 token file，因此完成 bootstrap 后设 security downgrade
  barrier；release/doctor 文案明确拒绝把旧 binary 当普通 rollback 路径；
- `__system__` row 继续 active/immutable，仅外部 credential mapping 关闭。内部 scheduled actor、builtin ownership、
  historical author/owner FK 不依赖 daemon token，不参与退役；
- 新 CLI `agent-workflow auth password-login <status|enable>` 直接读写同一 policy service；不提供 bootstrap
  reopen/daemon-token-enable 子命令。`enable` 只把 password on，运维再用现有 `user enable/reset-password` 恢复。
- 既有 `user create` 在 incomplete mode 检测 policy：缺 `--admin` 或 `--password` 时拒绝；满足时复用
  `completeBootstrapWithAdmin`，不能插一条普通/invited 用户却把 UI 留在未完成态。ready mode 保持原行为。

### 7.5 OIDC managed 单一 helper

新增 `packages/backend/src/services/accountAuthPolicy.ts`：

```ts
export async function isOidcManagedUser(db: DbClient, userId: string): Promise<boolean>
export async function listOidcManagedUserIds(
  db: DbClient,
  userIds?: readonly string[],
): Promise<Set<string>>
```

- 单 user 用 `SELECT ... LIMIT 1`；
- list users 用一次 userId projection + Set；
- helper 只读 userIdentities，不 import users/auth route，避免循环；
- change-password、reset-password、AdminUserView materialization 共用。

### 7.6 固定能力拒绝

| route                                | 条件                             | status/code                    | 必须零变化                     |
| ------------------------------------ | -------------------------------- | ------------------------------ | ------------------------------ |
| POST `/api/auth/pats`                | 通过 `account:self` 的任一 actor | 403 `pat-creation-disabled`    | userPats 无 insert             |
| DELETE `/api/auth/identities/:id`    | 通过 `account:self` 的任一 actor | 403 `identity-unlink-disabled` | identities 无 delete           |
| POST `/api/auth/change-password`     | target OIDC managed              | 403 `oidc-password-managed`    | passwordHash/session 无变化    |
| POST `/api/users/:id/reset-password` | target OIDC managed              | 403 `oidc-password-managed`    | password/status/session 无变化 |

另有条件拒绝：`POST /api/auth/login` 在 global policy off 时返回
`403 password-login-disabled`，session/lastLoginAt 零变化。Identity DELETE 对 own/foreign/unknown 全部返回
同 status/code，不再形成 existence oracle。Denial route 保留是为了给旧客户端明确诊断，不表示能力仍存在。

### 7.7 AdminUserView materialization

`GET /api/users`：

1. 取现有 users rows；
2. 一次取所有 identity userId；
3. materialize `hasOidcIdentity = set.has(row.id)`。

GET one/PATCH response 可单 user helper；POST create 必为 false。任何 response 都通过
AdminUserViewSchema，避免 frontend/backend 字段漂移。

### 7.8 Local password token handoff

后端 change-password 对 non-OIDC 维持现有 response。前端定向集成：

1. 旧 session token 在 store；
2. response 返回新 token；
3. 先断言 store 已替换；
4. actor key 随 token 切换并能成功 refetch；
5. response 无 token（PAT/daemon）时不清当前 token。

## 8. 异步、错误与缓存连续性

| 面             | initial               | stale error                | mutation error | success                   |
| -------------- | --------------------- | -------------------------- | -------------- | ------------------------- |
| auth discovery | Loading/Retry         | n/a                        | login 原位     | reconcile 到真实 method   |
| bootstrap      | status/form Loading   | n/a                        | form 原位      | clear token → ready auth  |
| login policy   | Loading/Retry         | 保留 server switch         | policy card    | server response 更新      |
| actor          | Loading/Retry         | 保留 account + ErrorBanner | n/a            | token 切换后新 query      |
| users          | Loading/Retry         | 保留目录 + Retry           | 当前 Dialog    | NoticeBanner + invalidate |
| sessions       | compact Loading/Retry | 保留 cached rows           | ConfirmDialog  | invalidate                |
| PAT revoke     | actor owns data       | 保留 actor data            | ConfirmDialog  | invalidate actor          |

- refetch 不清已有 rows；
- cached error 的 retry 不因 isFetching 误禁；
- Dialog unmount 后迟到 promise 不打开新状态；
- create/edit/reset error 不漂到 PageHeader；
- bootstrap success 必须先 clear daemon token 再导航；409 concurrent completion 同样清 token，不重试创建；
- denial errors 走统一 i18n code mapping，不展示 raw server English。

## 9. 可访问性与交互

- PageSectionNav 真实 Link、唯一 aria-current、compact combobox 有名称；
- ChoiceCards radiogroup + roving tabindex；
- Dialog 共享 focus trap/Esc/triggerRef/pending lock，不嵌套；
- ConfirmDialog promise pending 双击锁，danger 不只靠红色；
- StatusChip 有本地化文字；role info/neutral，status success/warn/danger；
- NoticeBanner 说明 OIDC policy，错误 ErrorBanner/alert；
- setup 表单有步骤文本、password/confirm 独立 label、错误 summary；没有跳过/返回 AppShell 的键盘路径；
- 搜索有 label，结果数 live announce；
- 列表 ul/li；“管理 Alice Chen”等唯一 accessible name；
- 关键 target >=44×44px；prefers-reduced-motion 沿用现有合同。

## 10. 样式

只新增 feature namespace：

```text
.account-center*
.user-directory*
.bootstrap-admin*
.auth-policy*
```

可删除仅这两页不再引用的：

- account DotValue、role-chip、users-row\_\_error；
- account-callout/account-form\_\_ok；
- PAT scope picker 全部 JSX/CSS/i18n（确认 settings/其他 route 无引用后）；
- account table 规则若 settings 仍用则保留，不能误删。

断点：

| 容器宽度  | Account             | Users                          |
| --------- | ------------------- | ------------------------------ |
| >=56rem   | rail + panel        | 单行 directory grid            |
| 42..56rem | compact nav + panel | identity/meta/action 两行      |
| <42rem    | 单列                | 卡片堆叠、toolbar 单列、无横滚 |

Dialog body 使用现有 max-height/scroll，footer 可见。

## 11. i18n

en-US/zh-CN 同步增加：

- account section/source/OIDC managed/local/identity read-only/session/tokens retirement 文案；
- users summary/search/filter/status/auth ownership/create modes/manage/reset/enable/disable；
- bootstrap token/首位管理员/永久退役/setup complete/CLI recovery；
- auth method/password policy/provider prerequisite；
- `pat-creation-disabled`、`oidc-password-managed`、`identity-unlink-disabled`、
  `password-login-disabled`、`password-login-requires-enabled-oidc`、
  `last-enabled-oidc-required`、`bootstrap-admin-required`、`bootstrap-already-complete` 错误映射。

删除 PAT creation key 前全仓 rg；有其他调用则保留，不做盲删。

## 12. 测试

### 12.1 Pure

- account section parser；
- AuthMethodDiscovery 判别联合拒绝 bootstrap+password/OIDC 与 ready+daemon 的非法组合；
- auth method derive：bootstrap token-only、ready password-only、OIDC-only、OIDC+password，单方法无 tabs；
- bootstrap admin serializer：role/status/confirm/隐藏字段永不上 wire，redirect sanitize；
- role/status/source/auth ownership mapping 闭包；
- user directory system 分离、counts、筛选交集、NFKC/case、null email、稳定排序、empty；
- create serializer password/sso 隐藏字段；
- dirty patch diff。

### 12.2 Frontend

- account continuity：三 section/direct link/cached actor error；OIDC 无 password form；local password payload+
  token 保存；identity read-only；PAT retirement list/revoke/empty；
- auth：fresh discovery 只有 token；token 成功只进 setup；ready/no-provider 只有 password 且无 TabBar；
  OIDC×password policy 四态；loading/error 不猜 method；disabled 403 refresh/reconcile；
- setup：admin/password 必填、confirm、本地错误、pending、deep-link 保留、success/concurrent 409 均 clear token；
- authentication settings：无 enabled Provider switch 锁 on；有 Provider 可确认关闭；server error 不乐观翻转；
  last-provider disable/delete 解释；
- PAT source guard：account production source 不得包含 POST pats、scope checkbox/create secret 文案；
- users actions：唯一 PageHeader action、semantic list、筛选、create 两模式、edit delta、local reset、
  OIDC no-reset、enable/disable、focus；
- 更新 users-self-role-lock：锁行为而非旧 table JSX；
- 更新 account-users-settings-table-shell：settings table 合同保留，account/users 改锁 responsive list；
- axe 覆盖 account 三 section、users populated/create/edit/local reset/mobile。

### 12.3 Backend

- PAT create：session/PAT actor 返回目标 403，bootstrap daemon 返回 setup gate、retired daemon 返回 401，
  三分支 DB before/after 深等；无权限 actor 仍锁原 permission denial；
- migration：password default on；fresh/legacy-no-admin → bootstrap NULL；local-password admin、enabled-OIDC
  admin、live admin session/PAT → completed；singleton/schema/journal parity；
- bootstrap：admin wire unknown-key/role/status 注入拒绝；hash 后 sync tx 插 user+policy；并发双提交一个 201/
  一个 409；insert/constraint fault 两边回滚；普通 business API gate；完成后 HTTP/query daemon 401；
- bootstrap bypass：password login、OIDC start/callback 在 credential/provider/network/identity 工作前同拒绝，
  DB 与 fake IdP 调用计数均为零；
- WebSocket：bootstrap daemon 可按 allow-list 验证但不能订阅业务 channel；completion revalidation 关闭已开
  daemon socket，之后 upgrade 401 且 retirement 后 frame 零泄漏；
- login policy：无 enabled Provider 关闭 409；关闭 vs last Provider disable/delete 两种顺序最多一成功；force
  delete identities 原子；policy off login fast denial 与 after-Argon2 recheck 都零 session/lastLogin；
- stdout/CLI：bootstrap 打印 token URL、ready 只裸 URL；restart 不复活；CLI password-login enable 生效但无
  daemon enable 命令；incomplete `user create` 仅 admin+password 并复用 complete tx；
- identity unlink：own/foreign/unknown 都相同 403，DB 无变化；
- change password：OIDC managed 403 且 passwordHash/sessions 不变；local 原链和 fresh token 保持；
- admin/CLI reset：OIDC managed 403 且 password/status/sessions 不变；local/invited 原行为保持；
- AdminUserView list/get/post/patch 的 hasOidcIdentity 正确，list query 无 N+1；
- 既有 auth IDOR/session/PAT validation 回归按新 policy 更新，不删除无关保护。

### 12.4 Browser/visual

隔离 HOME seed：

- 1280×900 / 390×844；
- fresh auth token-only、bootstrap admin setup、setup-complete password-only；
- settings authentication：无 Provider locked-on、有 Provider on/off；
- account：OIDC overview/security/tokens、local security、存量 PAT revoke；
- users：active/invited/disabled/admin/self/system/long email/OIDC+local；
- 断言 body 无横滚且关键字段/action bounding box 在 viewport；
- keyboard rail/compact nav/search/filter/ChoiceCards/Dialog close/restore；
- light/dark auth/setup/authentication settings/account overview/security/users populated/manage；
- axe 零新增 serious/critical；Linux runner 发布权威 baseline。

## 13. 改动面

```text
packages/shared/src/schemas/user.ts
packages/shared/src/schemas/auth.ts
packages/backend/db/migrations/<next>_rfc221_auth_login_policy.sql (new)
packages/backend/src/db/schema.ts
packages/backend/src/services/accountAuthPolicy.ts             (new)
packages/backend/src/services/authLoginPolicy.ts                (new)
packages/backend/src/auth/session.ts
packages/backend/src/auth/sessionStore.ts
packages/backend/src/routes/auth.ts
packages/backend/src/routes/oidc-auth.ts
packages/backend/src/routes/oidc.ts
packages/backend/src/routes/users.ts
packages/backend/src/services/oidcProviders.ts
packages/backend/src/ws/server.ts
packages/backend/src/cli/auth.ts                                (new)
packages/backend/src/cli/start.ts
packages/backend/src/main.ts
packages/frontend/src/hooks/useActor.ts
packages/frontend/src/routes/auth.tsx
packages/frontend/src/routes/setup.admin.tsx                    (new)
packages/frontend/src/routes/settings.tsx
packages/frontend/src/routes/account.tsx
packages/frontend/src/routes/users.tsx
packages/frontend/src/components/account/*                     (new)
packages/frontend/src/components/users/*                       (new)
packages/frontend/src/lib/account-navigation.ts                (new)
packages/frontend/src/lib/account-user-presentation.ts         (new)
packages/frontend/src/lib/user-directory.ts                    (new)
packages/frontend/src/i18n/en-US.ts
packages/frontend/src/i18n/zh-CN.ts
packages/frontend/src/i18n/errors.ts
packages/frontend/src/styles.css
packages/frontend/tests/account-*.test*
packages/frontend/tests/auth-*.test*
packages/frontend/tests/bootstrap-admin*.test*                  (new)
packages/frontend/tests/users-*.test*
packages/backend/tests/auth-*.test*
packages/backend/tests/rfc221-bootstrap-auth*.test*              (new)
packages/backend/tests/rfc221-login-policy*.test*                (new)
packages/backend/tests/users-*.test*
e2e/account-users-ux.spec.ts                                  (new or focused extension)
e2e/visual-regression.spec.ts
e2e/visual-regression.spec.ts-snapshots/...                   (targeted)
```

一个 singleton-table migration、无新依赖、PAT/session/identity table 结构或 role/permission 变化。新增
`auth password-login status|enable` CLI；`user reset-password` 参数不变，但 OIDC 托管账户随共享 policy 有意
收紧。daemon token 从常驻 admin bearer 改为一次性 bootstrap credential，是发布说明必须突出标记的行为变化。

## 14. 实现与评审门

- production/test code 只能在用户批准三件套后开始；
- 每个 implementation PR 同批带能使该行为失败的 test；
- 完整门：typecheck、lint、format:check、frontend/backend 全量、Playwright/axe/visual、build:binary；
- 实现门重点审：bootstrap allow-list/原子交接/WS 退役/downgrade、policy/Provider/login 全序化、denial 零
  副作用、AdminUserView N+1、local token handoff、hidden password、dirty PATCH、self/system/last-admin、
  Dialog 焦点、390px critical action；
- 提交后等精确 SHA completed/success，不以旧 branch green 代替。
