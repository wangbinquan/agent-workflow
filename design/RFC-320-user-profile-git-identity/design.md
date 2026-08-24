# RFC-320 设计 — 用户档案驱动的 Git 提交身份与 OIDC 邮箱刷新

配套 `proposal.md`。用户已于 2026-08-24 批准，本文终态已实现。

## 1. 不变量

| ID  | 不变量                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| I1  | 用户归属任务的 Git identity 只能来自 identity-access 返回的用户档案，不能来自 HTTP body、前端 draft 或 launch payload。 |
| I2  | Git `user.name/email` 是一对：服务端只创建完整快照；不允许半对，也不回退 daemon 默认身份。                              |
| I3  | 任务创建后 identity 不变；运行、重试、commit、push 都只读 task snapshot。                                               |
| I4  | OIDC identity key 仍由 `(provider_id, subject)` 唯一定位；profile claim 不能改变或替代 subject。                        |
| I5  | 配置的 userinfo profile selector 与已验签 id-token identity 必须由同一个标准 `sub` 绑定。                               |
| I6  | OIDC profile snapshot、用户档案更新与 Provider 配置 fence 在一个 SQLite 同步事务内完成。                                |
| I7  | commit identity 与 push credential 是两个端口；本 RFC 不让用户 profile 流入 credential resolver、remote URL 或日志。    |
| I8  | internal Git objects 继续使用 `AW_INTERNAL_GIT_IDENTITY`，不能借用户 task snapshot 冒充自然人。                         |

## 2. RFC-294 ownership

### 2.1 identity-access

拥有：

- `users.display_name` / `users.email` 的校验、读取、自助更新和 OIDC 同步；
- 邮箱唯一冲突的领域错误；
- `GetUserGitCommitIdentity` purpose-specific query；
- `UpdateOwnProfile` 与 `SyncOidcProfile` command；
- profile 的审计与事务边界。

`GetUserGitCommitIdentity` 返回 exact value object：

```ts
type GitCommitIdentity = Readonly<{
  name: string
  email: string
}>
```

查询对 system user、未知/disabled user、空邮箱分别返回封闭错误；消费者不接触 `users` 表。

### 2.2 task-execution

拥有 creator 解析、task admission 与既有 `tasks.git_user_*` 快照。它只调用
identity-access public query，不 import repository/schema。task-execution 对外 launch command 不再
暴露 Git identity 参数，而是在 authenticated operation context 中取得 creator。

### 2.3 source-control

只消费已经冻结的 `GitCommitIdentity`，负责注入 commit 过程；不回查用户、不解释 OIDC，也不
解析 push credential。现有 `commitPushRunner` / git adapter 的 identity 参数保留为内部 exact value。

### 2.4 legacy route/service

路由只做 wire validation 与 operation context 装配。不得在 `routes/**` 或 `services/task.ts` 手写
`SELECT users` 再拼 payload；legacy service 只能经 public participant 过渡，新增所有权落 module。

## 3. 数据模型与 shared contract

### 3.1 不新增用户 Git 列

继续使用：

- `users.display_name TEXT NOT NULL` → Git `user.name`；
- `users.email TEXT UNIQUE NULL` → Git `user.email`；
- `tasks.git_user_name / tasks.git_user_email` → task frozen snapshot；
- `user_identities.email` → 最近一次 IdP 邮箱快照；
- `user_identities.preferred_snapshot` → 最近一次 IdP 呈现名快照。

数据库只新增：

```text
oidc_providers.email_claim TEXT NULL
```

implementation 开始时重新读取 live journal 并取下一空 migration，文件名使用
`<next>_rfc320_oidc_email_claim.sql`；若并发 RFC 已占用则顺延，绝不复用编号。

### 3.2 shared schemas

- OIDC Provider schemas 继续暴露既有 `usernameClaim: ClaimNameListSchema.nullable()`，并增加
  `emailClaim: ClaimNameSchema.nullable()`；create/patch 维持 optional wire compatibility，
  service materialize 后两者都恒为 `string | null`。Settings 表单必须同时接线，不能只交付新列。
- 导出 `GitCommitIdentitySchema`：`name` 1..128，`email` 复用 `UserSchema.email` 的非空形态，
  `.strict()`。
- `StartTaskSchema` 及所有 kind-specific launch schemas 删除 `gitUserName/gitUserEmail`，并对
  这两个历史键作显式拒绝；不能依赖 zod 默认 strip 造成静默接受。
- `/api/auth/me` 保持 public `user` 投影不泄漏他人邮箱，另加私有：

```ts
profile: {
  displayName: string
  email: string | null
  gitCommitIdentity: GitCommitIdentity | null
}
```

`gitCommitIdentity=null` 只可能是邮箱缺失；name 因 DB NOT NULL 始终存在。

### 3.3 profile 写合同

新增严格 body：

```ts
UpdateOwnProfileBody = {
  displayName: UserSchema.shape.displayName,
  email: UserSchema.shape.email.unwrap(),
}
```

两字段同时提交，避免账号页出现半完成 Git identity。此 command 不接受 `username`、role、status、
permissions、password。管理员现有用户编辑可继续 patch 单字段，但最终走同一个 profile repository
与冲突映射。

## 4. OIDC claims acquisition

### 4.1 两个独立概念

- `subjectClaim`：身份键选择器，语义不变，决定“是谁”。
- `usernameClaim`：呈现名字段列表，写 `users.display_name`，也就是 Git `user.name`。
- `emailClaim`：邮箱字段选择器，写 `users.email`，也就是 Git `user.email`。

`emailClaim=null` 表示标准 `email`。显式配置后不回退标准字段。

Provider 配置界面的 exact 投影：

| UI 标签                     | wire/storage                       | 输入语义                                              | 留空默认             |
| --------------------------- | ---------------------------------- | ----------------------------------------------------- | -------------------- |
| 用户名字段（Git user.name） | `usernameClaim` / `username_claim` | userinfo claim 名列表，1–8 个字段以空格分隔并按序组合 | `preferred_username` |
| 邮箱字段（Git user.email）  | `emailClaim` / `email_claim`       | userinfo 单个 claim 名                                | `email`              |

两项放在 Settings → Authentication → Provider 的同一“用户信息字段”分组；create/edit 都可配置、
详情回填可见，Test connection 回执同时报告两个字段能否从当前 userinfo 解析。界面不得把
`usernameClaim` 继续只描述成与 Git 身份无关的内部“呈现名字段”。

### 4.2 profile userinfo 强制路径

```text
profileSelectorsConfigured = usernameClaim != null || emailClaim != null
```

1. `subjectClaim != null`：与 RFC-220 一致，以 userinfo 作为完整 identity source；从同一对象提取
   subject、presented name 与 email。
2. `subjectClaim == null` 且可验签 id_token：先验签取得 canonical `sub`；若
   `profileSelectorsConfigured`，再读 userinfo，要求其标准 string `sub` 与 canonical `sub` 完全相等，
   然后只从这份绑定后的 userinfo 提取配置 profile fields。
3. 未配置 profile selectors：identity source 选择保持现状；但 callback 仍把获得的标准
   `claims.email` 送入 profile sync，修复已有账号不回写邮箱的洞。
4. userinfo 没有标准 `sub`、类型错误或与 id token 不同：`userinfo-subject-mismatch`，不允许只凭
   access token 的未绑定 profile 覆盖某个已验签账号。

### 4.3 email 提取

```text
key = provider.emailClaim ?? "email"
raw = own-property string reader(userinfo, key)
normalized = raw.trim()
validate with UserSchema email, max 254
```

- 显式 `emailClaim`：missing / non-string / empty / invalid 均抛 `oidc-email-claim-invalid`。
- 未配置：标准 email 缺失仍为 `null`，保持登录兼容；非法非空值以
  `oidc-email-claim-invalid` 拒绝，避免把不能 materialize 的值写库。
- `applyEmailTrust` 继续只决定 `email_verified`，不改变 email 字符串。
- invite/allowlist 继续要求 normalized email + verified；查找与 conflict 检测沿用既有规则，
  不因 Git 用途放宽认证安全。

### 4.4 Provider 配置 fence

claims acquisition 记录：

```ts
expectedProfileSelectors = {
  usernameClaim: provider.usernameClaim,
  emailClaim: provider.emailClaim,
  subjectClaim: provider.subjectClaim,
}
```

所有 identity create/bind/sync 事务在写入前重读 Provider 并 exact compare。任何字段在 callback
期间被管理员修改，返回 `provider-config-changed`，整笔 user/identity/profile 写回滚，用户重登。

## 5. 每次登录的 profile sync

现有 `syncPreferredSnapshot` 扩成 identity-access 拥有的 `SyncOidcProfile`，覆盖四条 callback 分支：

| 分支                    | 行为                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| existing identity login | 更新 identity email/verified/presented snapshots，按下表同步 user；签 session 前完成。 |
| auto create             | 创建 user 时使用当次 displayName/email，identity snapshot 与 user 同事务。             |
| invited bind            | 保留 invited 用户的权限/username；按同一 snapshot 规则补 profile 并激活。              |
| account link            | 绑定后按同一规则同步当前 user；入口未来接通也不能绕过。                                |

### 5.1 呈现名

保持 RFC-220 D7：

- 未配 `usernameClaim` 不跟随；
- snapshot 相同不覆盖站内修改；
- IdP 值变化且新值非空时更新 displayName；
- legacy null snapshot 首见只记快照，不覆盖已有 displayName；
- IdP 值消失不清空非空 displayName。

### 5.2 邮箱

`user_identities.email` 作为 IdP 快照，不另加列：

| old identity.email    | users.email | new claim                   | 结果                                       |
| --------------------- | ----------- | --------------------------- | ------------------------------------------ |
| 任意                  | `NULL`      | 合法非空                    | **立即补齐** user email，并更新 snapshot。 |
| 与 new 相同           | 任意非空    | 相同                        | 只同步 verified；保留站内修改。            |
| 非 NULL 且与 new 不同 | 任意非空    | 合法非空                    | IdP 发生变化，更新 user email + snapshot。 |
| NULL（legacy）        | 非空        | 合法非空                    | 首见只记录 snapshot，保护既有站内邮箱。    |
| 任意                  | 任意        | 标准字段缺失且未配 selector | 不清 user email；identity snapshot 不改。  |

更新 email 前在同一事务做唯一冲突检查；冲突抛 `oidc-email-conflict` 并整笔回滚。SQLite unique
constraint 仍作为最后一道 race fence，约束错误映射为同一领域码，不能冒泡 500。

## 6. 用户档案 API 与界面

### 6.1 后端

- `GET /api/auth/me` 增加私有 profile 投影。
- `PATCH /api/auth/me/profile` 仅接受完整 displayName/email pair；session-only，PAT 不可用。
- identity-access command 校验 actor 只能改自己、账号 active、邮箱唯一；写 audit。
- OIDC 用户允许站内修改，但 UI 明示：当 IdP 对应值后来变化时会跟随刷新。

### 6.2 前端

- `/account` Overview 新增“提交身份”卡：呈现名、邮箱、保存；复用 Field/TextInput/ErrorBanner。
- username handle 只读显示，避免把登录名误认为 Git `user.name`。
- task wizard Advanced 删除两个 TextInput、pairing/email validation 与 state。
- Confirm 显示 `profile.gitCommitIdentity`；为空时显示修复链接并禁用所有 launch submit。
- draft vNext 不含 identity；读取旧 draft 时丢弃这两个 UI-only 键并立即按新版本重写。
- Query cache key 绑定认证代次，退出/切换用户后不能展示前一用户邮箱。

### 6.3 OIDC Provider 配置

- 既有 `usernameClaim` 输入保留并改为用户可理解的“用户名字段（Git user.name）”；hint 明示可
  空格分隔多个 userinfo claim 并按序组合。
- 同组新增 `emailClaim` 输入“邮箱字段（Git user.email）”；hint 明示只接受一个 claim 名。
- 两项留空分别显示 `preferred_username` / `email` placeholder，并说明这是标准默认字段。
- create、edit、cancel/reopen、redacted materialize、Test connection 都必须双字段回填一致。
- 表单提交继续统一 `blankToNull`；非法字段名的服务端错误落到对应 Field，不塌成通用 toast。

## 7. Task admission 与 snapshot

### 7.1 creator 规则

| 创建入口                     | Git identity 来源                                                             |
| ---------------------------- | ----------------------------------------------------------------------------- |
| session / PAT 直接启动       | authenticated actor user 当前 profile                                         |
| workflow / agent / workgroup | 同上；collaborators 不改变 creator                                            |
| scheduled task 触发          | schedule owner 在**触发创建 task 时**的当前 profile                           |
| event automation rule 触发   | rule owner / launch authority 当前 profile                                    |
| relaunch 为新 task           | 发起 relaunch 的当前 actor profile，不复用旧 launch payload                   |
| 同一 task 的 retry/resume    | 原 task snapshot                                                              |
| 父 task 派生 child task      | 父 task snapshot，避免内部 system actor 改变自然人归属                        |
| 无自然人 owner 的纯内部 task | 明确 internal identity 分支，不伪装用户；不得调用用户 task launch API 绕过 I2 |

### 7.2 原子性

task-execution 在 task insert 的同一 application command 中先取得 exact identity。用户 profile 在读取后
发生变化允许按“读取线性化点”冻结旧值；不能出现 name/email 分两次查询形成混搭。repository query 一次
select 两列，并返回一个 value object。

task insert 把 pair 写入既有列。任何后续 launch payload materialization、repo checkout 或 runner 都不能
再次读用户档案。

### 7.3 旧 wire 与持久 payload

- public schema 对旧 keys 返回 `task-git-identity-client-owned`。
- migration inventory 并重写所有 DB JSON launch payload，删除两个 keys；不把旧值迁移到用户档案，避免
  任意历史 task 输入污染账号 identity。
- 已存在 task rows 保留原 snapshot，确保运行中任务与历史详情可解释。
- relaunch/editScheduled decoder 不再把旧值映射回 UI；下一次保存只写终态 payload。

## 8. Git runtime

`commitPushRunner` 的内部输入仍接收 exact `GitCommitIdentity`，并统一写：

```text
GIT_AUTHOR_NAME
GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME
GIT_COMMITTER_EMAIL
```

所有 broad staging / auto-commit 入口必须经过同一 runner 或同一 identity injector；源码棘轮 inventory
覆盖 `commitPushRunner`、git adapter、wrapper Git、任务结束 auto commit 等现有入口。

明确不改：

- `GIT_SSH_COMMAND`、daemon SSH key；
- HTTPS credential lease / askpass；
- remote URL；
- internal snapshot/merge commit identity；
- 日志脱敏规则。

## 9. 失败合同

| code                             | HTTP/阶段              | 含义                                             |
| -------------------------------- | ---------------------- | ------------------------------------------------ |
| `git-identity-email-missing`     | 409 task admission     | creator profile 没有邮箱。                       |
| `task-git-identity-client-owned` | 422 launch validation  | 客户端仍发送已退役 task identity keys。          |
| `oidc-email-claim-invalid`       | 400 OIDC callback      | 配置字段缺失/类型或邮箱格式非法。                |
| `userinfo-subject-mismatch`      | 400 OIDC callback      | userinfo 与 verified id-token 不是同一 subject。 |
| `oidc-email-conflict`            | 409/friendly OIDC page | 新邮箱已归属另一账号。                           |
| `profile-email-conflict`         | 409 self/admin profile | 手工邮箱已归属另一账号。                         |
| `provider-config-changed`        | 400 OIDC callback      | callback 期间 selectors 变化，要求重登。         |

错误响应和日志不得包含 access token、client secret、完整 userinfo 或他人邮箱。

## 10. 测试矩阵

### 10.1 OIDC

- verified id token × selectors configured/unconfigured × userinfo available/missing；
- subjectClaim mode；standard/custom email field；post_json/get_bearer；
- userinfo sub match/mismatch/missing；configured email missing/non-string/invalid；
- existing/create/invite-bind/link；empty user email first fill；same value；IdP changed；manual changed；
- email conflict；Provider PATCH race in both serialization orders；transaction rollback and no session issuance；
- `trustEmailVerified` on/off and invite/allowlist behavior.
- Provider create/edit/test 对 `usernameClaim` 与 `emailClaim` 的双字段 round-trip、blank default、
  单字段非法定位与 configured selector 的实际 userinfo 取值。

### 10.2 identity-access/profile

- self-only authorization、PAT rejection、field exactness、email conflict、audit；
- `GetUserGitCommitIdentity` unknown/system/disabled/null-email/success；
- admin update compatibility and public response no email leak.

### 10.3 task/runtime

- every creator row in §7.1；single-read pair；task snapshot immutability；parent-child inheritance；
- legacy wire fail closed and persisted payload migration；
- author+committer env exact values；push credential resolver input/output unchanged；
- source inventory proves no task builder/request owns the two fields and no user lookup exists in source-control.

### 10.4 frontend

- account profile save/error；auth-generation cache isolation；
- wizard editable fields extinct；read-only identity summary；missing email blocking/link；
- draft/schedule/relaunch old payload convergence；zh/en copy；ordinary user and admin browser paths。

### 10.5 validation order

先跑 changed-area unit/component tests，再跑 OIDC route full-chain 与 task launch integration；候选内容稳定后按共享
main 规则只启动一次 `bun run gate:local`。同步进来的无关提交不自动触发第二次 full gate，最终以 hosted exact-SHA
CI/visual 归因。

## 11. 终态证据

- `5a6b36c572d9286a122c048f504e52c4e9fb3a41`：RFC-320 生产代码、迁移、合同、前端与测试主实现。
- `09a46912e10a0dc4513587e477a39f27efd8bcec`：共享 E2E 管理员补齐提交身份；其 visual run
  `32697952937` 成功。
- `1884294cea7016bc6377cbc0aec3c812f7f9f6e6`：git-protocol workflow 覆盖共享 harness；run
  `32698452846` 成功。
- `82f4bad38b14a4dd7a8cd2e82552c2cf49a604fa`：其余任务创建者夹具补齐 email；四个受影响 Playwright
  文件本地 17/17 通过。精确 SHA CI `32699593415` 的 31 个 jobs 中 29 个成功；两格失败仅为 RFC-250
  camera 点击遮挡与 macOS RFC-199 wizard mismatch，和本 RFC 的 identity/OIDC/task/runtime 路径无关。

上述最后一笔提交包含主实现；发布时已验证 `origin/main` 祖先关系与 trailer。完整本地 gate 的非任务阻断按
proposal §9 如实保留，不据此声称全仓本地门禁全绿。
