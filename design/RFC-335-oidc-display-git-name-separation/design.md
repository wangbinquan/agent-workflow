# RFC-335 设计 — OIDC 显示用户名与 Git name 分离

配套 `proposal.md`。当前状态：In Progress；D1–D7 已批准，实现完成，等待发布与 hosted CI。

## 1. 不变量

| ID  | 不变量                                                                                        |
| --- | --------------------------------------------------------------------------------------------- |
| I1  | `users.username` 是稳定登录 handle；OIDC profile claim 永不修改它。                           |
| I2  | `users.display_name` 只服务产品内呈现，`users.git_name` 只服务 Git commit name。              |
| I3  | `GitCommitIdentity = users.git_name + users.email`；客户端、任务草稿和 route body 不得自报。  |
| I4  | 每次成功 OIDC callback 都在 session 创建前对账两个名称；任一失败则零 profile/session 副作用。 |
| I5  | 显式 selector 的 profile 值只来自与已验证 subject 绑定的 userinfo。                           |
| I6  | Provider selector fence、identity 读取和两个用户列更新处于同一个 SQLite 同步事务。            |
| I7  | task 创建后只读 `tasks.git_user_name/git_user_email` 快照；用户后续登录不修改历史任务。       |
| I8  | Git commit identity 与 push authentication 仍是两条独立链路。                                 |

## 2. RFC-294 对齐与 ownership

### 2.1 `identity-access`

唯一拥有：

- `users.display_name/users.git_name/users.email`；
- OIDC profile refresh command 与 callback/write selector fence；
- `GetUserProfile`、`UpdateOwnProfile`、`GetUserGitCommitIdentity`；
- 同步事务内的 profile 对账与审计。

本 RFC 扩展现有 `modules/identity-access` 的 application command/query、application-owned port 与
SQLite infrastructure，不在 legacy route/service 新增用户表读取。

### 2.2 inbound OIDC adapter

`routes/oidc-auth.ts` 只负责协议流、调用 claim acquisition 与 identity-access participant、映射错误，
不自行决定两个名称的合并策略。现有 `services/userIdentities.ts` bridge 只扩 exact DTO，并继续把
create/bind/link 的 adjacent writes 放进同一 transaction scope。

### 2.3 `task-execution` 与 `source-control`

`task-execution` 继续只调用 purpose-specific `GetUserGitCommitIdentity` 并冻结结果；
`source-control` 继续只消费冻结值。两者不接触 OIDC selector 或 `users` 表。

### 2.4 架构演进边界

本 RFC 不领取 RFC-294 W2/W4/W9 wave credit，也不扩大 public surface 为万能 user facade；只扩已存在的
identity-access profile/Git identity slice。legacy OIDC route/service bridge 是存量债，本 RFC 不新增第二条 bridge。

## 3. 数据模型与迁移

实施前重新读取 live journal 并占用当时下一空 migration；source pin 上候选号为
`0214_rfc335_oidc_git_name.sql`，若并发 RFC 已占用则顺延。

迁移包含：

```sql
ALTER TABLE users ADD COLUMN git_name TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE users SET git_name = display_name WHERE git_name = '';
--> statement-breakpoint
ALTER TABLE oidc_providers ADD COLUMN git_name_claim TEXT;
```

Drizzle schema：

```ts
users.gitName: text('git_name').notNull()
oidcProviders.gitNameClaim: text('git_name_claim')
```

`git_name` 的 DB 默认只为 SQLite `ALTER TABLE` 兼容；所有受管用户创建入口必须显式写入非空值，
shared/application schema 均限定 `trim().min(1).max(128)`。迁移测试锁定：

- 存量本地/OIDC/system/invited 用户均按 `display_name` 回填；
- 新 schema 能独立修改两列；
- journal/file/count 连续且 rolling upgrade 通过。

不新增 `user_identities.git_name_snapshot`。本 RFC 的名称语义是每次登录直接对账当前 IdP 值，不再需要
“IdP 是否变化”的三方合并基线。既有 `preferred_snapshot` 保留为兼容列，可继续记录最近观察到的显示名，
但不得再作为是否更新 `users.display_name` 的判据。

## 4. shared 与 API 合同

### 4.1 Provider

`OidcProviderSchema` 增：

```ts
gitNameClaim: ClaimNameListSchema.nullable().default(null)
```

create/patch 上保持 optional，以兼容旧客户端。`usernameClaim` 保持现有 wire 名和数据库列，但注释、文案和
API docs 改为“display username claim”；`gitNameClaim` 才对应 Git `user.name`。

### 4.2 用户档案

- `UserPrivateProfileSchema` 增 `gitName`；
- `UpdateOwnProfileBodySchema` 增必填 `gitName`；
- `GitCommitIdentitySchema` 形状不变，`name` 的来源改为 `gitName`；
- `UserPublicSchema/OwnerIdentitySchema` 不增加 `gitName`，列表与成员展示不会误用 Git 名。

受管新建用户未显式给 Git name 的既有入口，application 层以已验证的 `displayName` 初始化；账户页之后可独立修改。

## 5. claim acquisition

### 5.1 纯解析

沿用 `composePreferred` 的 1–8 字段顺序拼接规则，提炼为对 display/Git name 共用的纯函数。输出：

```ts
type AcquiredProfileNames = Readonly<{
  displayName: string | null
  gitName: string | null
}>
```

解析规则：

1. `usernameClaim !== null`：从该 selector 组合显示用户名；组合为空则
   `oidc-display-name-claim-invalid`。
2. `usernameClaim === null`：优先标准 `preferred_username`，再沿用现有 `name/email/既有值`
   兼容回退；不因标准可选 claim 缺失让既有 Provider 突然拒绝登录。
3. `gitNameClaim !== null`：从该 selector 组合 Git name；组合为空则
   `oidc-git-name-claim-invalid`。
4. `gitNameClaim === null`：使用本次已解析的 `displayName`，保持升级前两者相同的默认行为。
5. 两个结果 trim 后必须为 1..128；不截断冒充成功，超长返回对应稳定错误。

### 5.2 取值通道与 subject 绑定

`profileSelectorsConfigured` 扩为：

```text
usernameClaim != null || gitNameClaim != null || emailClaim != null
```

只要任一显式 selector 存在：

- 有可验签 id-token 时，先验证并固定 standard `sub`；
- 再调用 userinfo，要求 userinfo standard `sub` 与之逐字相同；
- 两个名称和邮箱全部从该 bound userinfo 解析；
- 无 userinfo、subject 不一致或任一严格 selector 无值时，callback 失败。

纯 OAuth `subjectClaim` 模式继续全量走 userinfo；`gitNameClaim` 不参与 identity key。

## 6. 每次登录同步

`SyncOidcProfileCommand` 调整为携带：

```ts
displayName: string
gitName: string
email: string | null
emailVerified: boolean
expectedSubjectClaim: string | null
expectedUsernameClaim: string | null
expectedGitNameClaim: string | null
expectedEmailClaim: string | null
```

事务顺序：

1. 重读四个 selector 并与 callback snapshot 比较；任一变化返回 `provider-config-changed`；
2. 按 `(providerId, subject)` 读取 identity 并核对 `userId`；
3. 读取 user；
4. 直接比较本次 `displayName/gitName` 与用户列，任一不同就写入新值；
5. 邮箱继续执行 RFC-320 既有规则，本 RFC 不改变；
6. identity snapshot、用户档案与 audit 在同一事务提交；
7. callback 完成后才创建登录 session。

“每次登录刷新”指每次都重新取值并执行对账，不要求值相同也写 `updated_at`。这同时覆盖：

- existing identity login；
- auto create（insert 时直接写两个值）；
- invite bind；
- manual link；
- 首次 callback 后的 task 创建。

## 7. Git identity 与账户编辑

`GetUserGitCommitIdentity` 从 identity-access snapshot 返回：

```ts
{ name: user.gitName, email: user.email }
```

现有 inactive/system/missing-email 错误不变；新增空 Git name 的读取防线
`git-identity-name-missing`，用于拒绝非规范历史/旁路数据。任务行、runner env、commit/push 代码不改字段形状。

`UpdateOwnProfile` 原子更新 `displayName/gitName/email`，账户卡使用三个独立 `<Field>/<TextInput>`。
OIDC 关联账号显示提示：“显示用户名与 Git name 会在下次 OIDC 登录时按 Provider 映射刷新”。

## 8. Provider 前端

复用现有 OIDC `SettingsCard`、`Field`、`TextInput` 与表单 dirty/revision 语义：

- state/draft/signature/body 增 `gitNameClaim`；
- display/Git name 两个 selector 并排；email/subject 保留清晰分组；
- 三个 profile selector 都在初始状态显示规则与字段级非法提示；
- Save 禁用只是防重复提交，不替代字段错误说明；
- 390px 下列布局折为单列，DOM 顺序为 display → Git name → email → subject；
- 中英文 label/hint 明确 `usernameClaim` 不再表示 Git name。

## 9. 失败模式

| 场景                                       | 结果                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| 显式 display selector 全缺/空/超长         | 400 friendly `oidc-display-name-claim-invalid`，零写入            |
| 显式 Git selector 全缺/空/超长             | 400 friendly `oidc-git-name-claim-invalid`，零写入                |
| userinfo 与 verified id-token subject 不同 | 既有 `userinfo-subject-mismatch`                                  |
| callback 期间任一 selector 改变            | `provider-config-changed`，事务回滚                               |
| `git_name` 非法/空                         | profile 更新拒绝；task admission 返回 `git-identity-name-missing` |
| Git name 修改后已有 task                   | 已有 task 不变，新 task 使用新值                                  |
| push credential                            | 完全不受影响                                                      |

## 10. 测试策略

1. **shared**：Provider create/patch/default/strict keys；private profile/update body 的三字段；Git identity shape。
2. **migration**：存量用户回填、Provider 新列、rolling upgrade、journal count。
3. **identity acquisition**：两个 selector 独立/组合/空值/超长；任一 selector 触发 bound userinfo；
   `gitNameClaim=null` 的兼容回退。
4. **identity-access**：每次登录直接对账、只变 display、只变 Git、两者都变、幂等、selector race、
   create/bind/link/existing 四路径与事务回滚。
5. **Git identity**：query 从 `gitName` 取值；任务冻结、child inherit、runner env 与 push credential 零漂移。
6. **backend route**：连续两次 callback 使用不同 claims，第二次 session 前两个列均刷新；friendly errors。
7. **frontend**：Provider draft/load/save/legacy row、可见规则/字段错误、账户三字段更新、query cache、i18n。
8. **E2E**：mock IdP 首次登录 → 修改两个 claim → 再登录 → 账户页与新任务确认页分别显示新值，旧任务仍显示旧快照。
9. **源码棘轮**：禁止 `GetUserGitCommitIdentity` 再从 `displayName` 组装 name，禁止前端把
   `usernameClaim` 标为 Git `user.name`。

## 11. 验证与发布

遵循当前仓库规则：不把本地 Bun 全量门禁当交付依据；实现与测试精确提交到共享 `main` 后，按包含
实现的完整 SHA 查询 GitHub Actions，直到相关 CI/visual/E2E 进入 terminal success。若 superseding SHA
承载结果，必须先证明实现 commit 是其祖先，并区分本 RFC 失败与无关并发失败。
