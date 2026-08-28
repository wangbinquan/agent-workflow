# RFC-335 — OIDC 显示用户名与 Git name 分离

- 状态：In Progress（D1–D7 已批准，实现完成，等待发布与 hosted CI）
- 发起：用户，2026-08-28
- source pin：`234cfb2307602ced40bfb3279843843d6818997a`
- 前置：RFC-036（OIDC）、RFC-220（userinfo 映射与登录同步）、RFC-320（用户档案驱动 Git identity）、RFC-294（后台目标架构）

## 0. 终态一句话

OIDC Provider 分别配置“显示用户名字段”和“Git name 字段”；登录时分别解析并刷新
`users.display_name` 与新的 `users.git_name`，新任务只把 `git_name + email` 冻结为 Git 提交身份。

```text
OIDC usernameClaim ──每次登录解析──> users.display_name ──> 产品内显示
OIDC gitNameClaim  ──每次登录解析──> users.git_name    ──> Git user.name
OIDC emailClaim    ──既有规则同步──> users.email       ──> Git user.email

users.git_name + users.email ──任务创建时冻结──> tasks.git_user_name / git_user_email
```

## 1. 当前实现与问题

当前 `usernameClaim` 实际先写入 `users.display_name`，而 RFC-320 的
`GetUserGitCommitIdentity` 又直接返回 `{ name: users.display_name, email: users.email }`。
Settings 因而把该输入标成“用户名字段（Git user.name）”，账户页也用同一个 `displayName`
同时表示产品内显示名和 Git 提交名。

这会产生两个问题：

1. IdP 中用于产品展示的姓名/昵称与 Git commit 的 `user.name` 无法选择不同字段；
2. 修改其中一个语义必然连带修改另一个语义，任务创建时也无法区分两者。

现有 OIDC callback 已覆盖 existing login、auto create、invite bind 与 manual link，并有
Provider selector 的 callback/write fence；本 RFC 在同一条链上扩展，不建立第二套登录流程。

## 2. 目标

1. 为用户档案增加独立的 `gitName`，产品内 `displayName` 不再兼任 Git `user.name`。
2. OIDC Provider 界面并列提供：
   - “显示用户名字段”——沿用 wire 字段 `usernameClaim`，写入 `users.display_name`；
   - “Git name 字段”——新增 wire 字段 `gitNameClaim`，写入 `users.git_name`。
3. 每次成功 OIDC 登录都重新解析这两项，并在同一事务中把用户档案对账到本次 IdP 值；
   值未变化时可以不发无意义 UPDATE，但不能因为站内曾修改过而跳过 IdP 刷新。
4. 任务创建、定时触发、事件触发、重跑与子任务继续使用既有冻结模型，但 Git name 改从
   `users.git_name` 读取。
5. 账户概览把显示用户名、Git name、Git email 分开编辑和展示；新任务使用编辑后的 Git identity。
6. 存量用户无损升级：初始 `git_name = display_name`；存量 Provider 行为在管理员未配置
   `gitNameClaim` 时保持与当前一致。

## 3. 非目标

- 不修改稳定登录 handle `users.username`，也不允许 OIDC 登录刷新它。
- 不修改 Git push 的平台账号、token、SSH key 或 RFC-321 publication credential。
- 不改写历史 task snapshot、历史 commit 或已经运行中的任务。
- 不拆分 Git email；`users.email` 仍同时是账号邮箱与 Git `user.email`。
- 不新增任务级 Git identity 输入，不恢复 RFC-320 已退役的客户端所有权。
- 不借本 RFC 改 OIDC provisioning、role、permission、session 或登录策略。

## 4. 用户可感知行为

1. Settings → Authentication → OIDC Provider 中，“用户名字段（Git user.name）”改为
   “显示用户名字段”，旁边新增“Git name 字段”。两项都支持 1–8 个 claim 名按顺序拼接。
2. `usernameClaim` 留空时继续使用标准 `preferred_username` 与既有显示名回退链；
   `gitNameClaim` 留空时使用本次解析出的显示用户名，确保升级后默认行为不变。
3. 显式配置任一 selector 后，该 selector 是严格合同：本次 userinfo 中所有配置字段都缺失、
   组合结果为空或结果不合法时，本次登录失败，并指出是显示用户名还是 Git name 配置错误。
4. 任一 selector 显式配置时，标准 OIDC 的已验签 id-token 仍只负责确认 subject；两个名称值
   都从 subject 已绑定的 userinfo 读取，与现有 `emailClaim` 规则一致。
5. existing login、首次自动建号、邀请绑定与手工关联都在创建 session 前同步两个名称。
6. 对 OIDC 账号在站内手工修改显示用户名或 Git name 后，下一次 OIDC 登录会再次以 IdP
   映射值覆盖；账户页明确提示这一点。
7. 新任务显示并冻结 `gitName <email>`；产品列表、头像、成员选择器等仍显示 `displayName`。
8. 已创建任务继续保留原 `tasks.git_user_name/git_user_email`，不会随登录或档案修改变化。

## 5. 待用户确认的裁决

批准本 RFC 即确认：

| ID  | 裁决                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------- |
| D1  | `displayName` 与 `gitName` 成为两个独立用户档案字段；`users.username` 完全不变。                                              |
| D2  | 为兼容现有 API/数据库，`usernameClaim` 不改 wire 名，但语义和界面明确为“显示用户名字段”；新增 `gitNameClaim`。                |
| D3  | `gitNameClaim = null` 时回退到本次解析出的显示用户名，存量 Provider 不会在升级后突然改变 Git name。                           |
| D4  | 显式 selector 每次登录都具有 IdP 权威性；站内手工修改只保留到下一次 OIDC 登录，不再使用“IdP 值没变就保留站内覆盖”的三方合并。 |
| D5  | 显式 selector 的组合结果为空时拒绝登录，不静默保留旧值，以免配置看似生效但实际没有刷新。                                      |
| D6  | 任务冻结与 push credential 边界保持不变：只有新任务的 `GitCommitIdentity.name` 改读 `users.git_name`。                        |
| D7  | 存量用户迁移时以当前 `display_name` 回填 `git_name`；不修改任何历史 task/commit。                                             |

## 6. 验收标准

- **AC-1 独立存储**：`users.git_name` 与 `users.display_name` 独立存在，迁移后所有存量用户
  `git_name = display_name`；用户档案读写合同同时携带 `displayName/gitName/email`。
- **AC-2 独立 Provider 合同**：OIDC create/patch/read、服务 materialize、callback fence 与 Settings
  表单同时支持 `usernameClaim/gitNameClaim/emailClaim`，旧客户端不发送新字段仍可工作。
- **AC-3 每次登录刷新**：existing/create/bind/link 四条 callback 分支都解析并同步 display/Git name；
  连续两次登录且 IdP 两个字段分别变化时，两个用户列分别变为第二次值，再创建 session。
- **AC-4 subject 绑定**：任一名称 selector 配置时，userinfo 必须与已验签 id-token 的标准 `sub`
  一致；配置中途变化导致整次写入回滚并返回 `provider-config-changed`。
- **AC-5 严格失败**：显式显示用户名/Git name selector 缺失或结果为空时分别返回稳定错误，
  不更新 user/identity、不创建 session。
- **AC-6 Git identity**：`GetUserGitCommitIdentity`、`/api/auth/me`、账户页与任务确认页均使用
  `gitName + email`；产品内 owner/user 展示仍使用 `displayName`。
- **AC-7 冻结兼容**：根任务读取当前 `gitName`，子任务继承父快照，已存在 task rows 原样可读；
  push credential 解析与 source-control transport 零变化。
- **AC-8 前端**：Provider 与账户表单都把显示用户名和 Git name 分开展示，初始规则、字段级
  错误、键盘/焦点、窄屏布局和中英文文案有测试覆盖。
- **AC-9 CI**：shared/backend/frontend、迁移、OIDC callback、task identity 与 E2E 回归进入
  GitHub Actions；以包含实现的 exact SHA hosted CI 终态为交付依据。

## 7. 开工门

用户已于 2026-08-28 明确批准 §5 D1–D7，并授权实现、提交和推送远端。

## 8. 实现证据（发布前）

- migration `0214_rfc335_oidc_git_name.sql` 增加并回填 `users.git_name`，Provider 增加
  `git_name_claim`；rolling-upgrade head 更新为 214。
- shared、identity-access、OIDC acquisition/callback、Provider CRUD、账户档案和 task admission
  已切换为独立 `displayName/gitName` 合同。
- 针对性验证：shared 31 tests、backend 104 tests、frontend 18 tests 全绿；shared/backend/frontend
  typecheck 全绿。最终以推送后 exact-SHA GitHub Actions 为准。
