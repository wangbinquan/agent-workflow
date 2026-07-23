# RFC-221 账户安全中心与响应式用户目录 UX 重构 — proposal

状态：Approved v5（2026-07-22；用户已批准，production/test 本地实现完成；实现门、精确 SHA CI 与剩余视觉验收仍待完成）。

## 1. 背景与现场证据

本 RFC 以用户点名的 `/account`、`/users` 与 `/auth` 为 UX 主面，并覆盖首次 `/setup/admin` 与
“设置 → 认证”所需的登录生命周期。问题不只是配色“旧”，而是信息架构、操作风险和移动端可用性同时退化。

### 1.1 我的账户

当前 `packages/frontend/src/routes/account.tsx` 把资料、修改密码、PAT、外部身份、会话五个等权
`Card` 纵向堆在一个 760px 列中。390×844 现场走查测得五块高度约为：

| 区块                  |       高度 |
| --------------------- | ---------: |
| 资料                  |      196px |
| 修改密码              |      320px |
| Personal Access Token | **2043px** |
| 外部身份              |      126px |
| 活跃会话              |      191px |

PAT 创建器默认把最多 17 项权限全部铺开，单块超过两屏；真正高风险的会话与登录身份被压到页面底部。
角色/状态还混用账户页私有 `DotValue` 与共享 `StatusChip`，成功反馈使用无 live-region 的
`account-callout` / `account-form__ok`。

修改密码还有一条范围内的真实断链：接口会吊销全部旧 Web 会话并给 session actor 返回新的
`sessionToken`，当前前端未保存它，页面所称“当前窗口自动续会话”与行为不符，下一次请求可能直接 401。

### 1.2 管理用户

当前 `packages/frontend/src/routes/users.tsx` 是一张桌面表格。390px 走查时表格
`scrollWidth=720`、可视宽度 `clientWidth=366`；首屏只能看到用户名、显示名和半个角色控件，
状态与操作必须横向滚动后才出现。

列表 API 已返回 email、forcePasswordChange、创建时间与 lastLoginAt，页面却只展示用户名、显示名、
角色、裸英文状态。已有 PATCH/重置密码/启停能力也没有形成完整管理流：

- 角色修改直接塞进每一行，容易误触，错误只能挤在单元格里；
- 没有修改显示名、邮箱或重置密码入口；
- 新建用户靠“密码留空”暗示 invited，没有明确区分“本地密码账户”和“等待 OIDC”；
- `__system__` 是不可登录的系统主体，却与真人账户混在同一张表中；
- 管理端不知道用户是否已绑定 OIDC，也就无法正确隐藏不适用的本地密码操作。

## 2. 用户已拍板的产品规则

以下不是实现细节，而是本 RFC 的硬合同。

### D1 — 全局关闭个人访问令牌生成

- 前端删除 PAT 新建入口、scope 选择器和一次性密钥流程；
- 后端 `POST /api/auth/pats` 对所有能到达该 route 且通过现有 `account:self` 权限门的 session/PAT actor
  固定拒绝 `403 pat-creation-disabled`，不能通过脚本绕过 UI；bootstrap daemon actor 被 D6 allow-list 更早
  拒绝，retired daemon token 为 401，三条路径都不可能创建；
- 不自动吊销存量 PAT，避免未经确认打断现有自动化；存量 PAT 仍可查看和主动吊销；
- PAT 认证、格式、权限解析和 `GET/DELETE /api/auth/pats` 保持，形成清晰的“只退不进”路径。

### D2 — OIDC 托管账户的确定性定义

普通 Web session 不记录“本次是密码还是 OIDC 登录”，因此不能按当前 session 猜。统一定义：

> 账户只要存在至少一条 linked OIDC identity，就视为 OIDC 托管账户。

这个规则对自助页和管理员页一致；混合账户即使历史上已有本地密码，也按 OIDC 托管处理。

### D3 — OIDC 托管账户不得修改或重置本地密码

- 账户页不渲染修改密码表单，改为信息 NoticeBanner，引导去身份提供方管理凭据；
- `POST /api/auth/change-password` 在服务端复核 linked identity，固定拒绝
  `403 oidc-password-managed`；
- 管理用户页对 OIDC 托管账户不显示“重置密码”；`POST /api/users/:id/reset-password` 同样在
  服务端拒绝 `oidc-password-managed`，避免管理员重新开出本地密码通道；
- `agent-workflow user reset-password` 复用同一 service，也不能作为 CLI 绕过；
- 无 linked identity 的本地账户继续允许自助改密和管理员重置。

### D4 — OIDC identity 只读，不允许自助解绑

- 账户概览继续展示 provider、邮箱、关联时间与技术标识，但没有“取消关联”操作；
- `DELETE /api/auth/identities/:id` 固定拒绝 `403 identity-unlink-disabled`，不能绕过 UI；
- 本 RFC 不新增管理员解绑入口。需要解除身份时由运维/后续专门治理流程处理。

### D5 — 管理员可全局关闭用户名密码登录

- “设置 → 认证”增加“允许用户名和密码登录”开关，存量安装默认开启，修改后即时生效且无需重启；
- 关闭后登录页不渲染用户名、密码、密码登录 tab 或 form；`POST /api/auth/login` 在后端固定拒绝
  `403 password-login-disabled`，不能通过旧页面或脚本绕过；
- OIDC 登录不受影响；daemon token 只在 D6 的 bootstrap 阶段可用，且不计入关闭前的正常登录方式安全检查；
- 为避免明显锁死，关闭开关时必须至少有一个 enabled OIDC Provider；关闭期间不得停用或删除最后一个
  enabled Provider。开关与 Provider 约束保存在 SQLite 并在同一类同步事务中裁决，封死并发交错；
- 关闭不删除 password hash、不撤销已登录 session、不改变用户 status，也不禁止管理员为本地账户预置或
  重置密码；重新开启后原有本地凭据恢复可用。OIDC 托管账户仍受 D3 的更严格禁改/禁 reset 规则约束；
- “enabled”只能提供数据库内的结构性防锁死，不能保证外部 IdP 永久在线。关闭确认会明确要求先运行
  “测试连接”，并说明本机 CLI 恢复路径，但本 RFC 不虚构持续可用性保证。

### D6 — 首个人类管理员接管后自动退役 system 外部认证

首次安装使用一个强制、不可跳过的交接流，而不是让 token actor 先进入完整后台：

```text
首次 /auth：仅 daemon token
        ↓ token 验证成功
/setup/admin：创建首位管理员（admin + active + password 必填）
        ↓ 单一事务：insert admin + bootstrap_completed_at
/auth：daemon token 永久消失；无三方认证时仅用户名密码登录
        ↓ 后续配置 enabled OIDC Provider
设置 → 认证：才允许决定是否关闭用户名密码登录
```

- `bootstrap_completed_at IS NULL` 时，公共登录 discovery 只返回 bootstrap token 方法；即使数据库里预置了
  Provider，也不提前显示 OIDC/密码入口；
- bootstrap 未完成时，public `POST /api/auth/login`、OIDC login start/callback 也在服务端拒绝
  `bootstrap-admin-required`，不能靠旧客户端或脚本绕过“首次只能 token”；
- token 验证成功后只进入 `/setup/admin`。bootstrap daemon actor 在服务端仅可访问 whoami/bootstrap
  status/创建管理员 allow-list，其他业务 API 固定拒绝 `403 bootstrap-admin-required`，不能绕过向导先使用
  `__system__` 管理整套系统；
- 向导要求 username、displayName、password、confirm，email 可选；role 固定 admin、status 固定 active，
  不提供普通用户/invited/OIDC 模式；
- 专用 `POST /api/auth/bootstrap/admin` 在 hash 完成后，以一个 `dbTxSync` 重读未完成状态、插入首位管理员、
  强制 `password_login_enabled=1` 并写 `bootstrap_completed_at`。并发提交最多一个成功，失败方零插入；
- 接口不返回 admin session。成功响应到达后前端清除 daemon token，跳转 `/auth?setup=complete`，用户用刚创建
  的用户名密码完成首次正常登录；token 的失效点就是管理员创建事务提交点，不再等待下一次登录；
- 从该提交点起，HTTP 与 WebSocket 的 daemon token 都返回统一 401；已建立的 daemon-token WebSocket 通过
  现有 revalidation 基础设施主动关闭，不能继续收到管理员帧；
- 登录页只在 bootstrap 未完成时显示 daemon token 方法；完成后不再显示，daemon 启动输出也只打印
  裸 URL，不再打印 `?token=...`；
- `__system__` 数据行不删除、不改成人类 disabled 账户。它仍是内置资源 ownership、后台调度审计与历史 FK
  的技术主体，但在用户目录只显示“内部主体 · 不可登录 · bootstrap token 已退役”；
- token 文件可以保留为无认证权的本地秘密，认证是否有效只看数据库完成态；删除文件不能作为事实源，否则
  重启时重新生成 token 会意外复活权限；
- 退役是 one-way，不提供 Web UI 重新开启。失去所有人类登录方式时，拥有主机权限的运维使用
  `agent-workflow auth password-login enable`，并按需配合现有 `user enable/reset-password` 恢复；该 CLI 不会
  复活 daemon token；
- 迁移已有安装时：若已有可接管的人类 active admin（本地 password、enabled Provider 的 linked identity，或
  未失效 session/PAT），直接回填完成态；
  若只有普通/invited/disabled 用户而没有可用 admin，则保留 token，但同样只允许进入“创建接管管理员”向导，
  成功后完成交接，避免升级锁死。

## 3. 目标

1. 把“我的账户”从长表单改成可直达的账户中心，让资料、登录安全、存量访问令牌各自有清晰边界。
2. 彻底删除 PAT 生成 UX 与可调用能力，同时给存量令牌提供安全退出路径。
3. 对 OIDC 托管账户统一实施“凭据归 IdP、自助 identity 只读”，前后端结论一致。
4. 把用户管理从横向表格改成响应式目录；手机无需横向滚动即可看见身份、角色、状态和管理入口。
5. 补齐用户资料编辑、启停、邀请式创建；本地账户补齐重置密码，OIDC 账户明确不可用。
6. 统一状态、时间、反馈、确认、表单和页面导航原语；light/dark、键盘、触屏与读屏使用同一合同。
7. 修复本地账户改密后的 session token 切换断链。
8. 在认证管理界面提供可恢复、后端强制且有防锁死约束的用户名密码登录开关。
9. 让 daemon token 只承担“创建首位管理员”的首次引导，在该用户写入后自动、永久退出外部认证面，同时保留内部
   `__system__` 技术主体。

## 4. 非目标

- 不做头像上传、个人主题、通知偏好、组织/用户组、批量导入或批量权限管理。
- 不自动吊销存量 PAT，不删除 PAT 表、token 认证或已有自动化兼容。
- 不允许任何 UI 解绑 OIDC，也不在本 RFC 设计运维解绑/身份转移流程。
- 当全局用户名密码登录开关开启时，不额外禁止 OIDC 托管账户使用历史上已存在的本地密码登录；D3 只禁止
  新增、修改或重置该密码。全局开关关闭时，所有账户的用户名密码登录统一不可用。
- 不因关闭登录入口清空 password hash、停用本地用户或撤销已有 session；本地账户密码的创建/重置仍可
  作为重新开启前的预置动作，但 UI 必须说明当前不能用于登录。
- 不删除 `__system__` 数据行或迁移其资源 ownership；D6 只关闭 daemon token 到该主体的外部认证映射。
- 不把 daemon token 保留成接管后的常驻 break-glass；接管后的恢复边界是本机 CLI，而不是可远程重放的
  长期静态 bearer token。
- 不承诺外部 IdP 持续可达；防锁死合同只保证数据库内至少保留一个 enabled Provider。
- 不改变角色/permission 模型、会话生命周期或 OIDC provisioning 策略。
- 不发送邮件；`CreateUserBodySchema.sendInvite` 不被 UI 伪装成“已发送邀请”。
- 不加入服务端分页、虚拟列表或用户 PATCH revision/OCC。

## 5. 产品方案

### 5.1 我的账户：三个路由化分区

`/account` 增加 `section=overview|security|tokens`，默认 overview。复用
`PageSectionNav`：宽屏左 rail，窄屏 compact Select；每个目的地都有真实 URL。

#### A. 账户概览

- 顶部身份摘要：首字母头像、显示名、`@@username`、已本地化角色和账户状态；
- 认证来源使用普通元数据 chip；linked identity 存在时增加“OIDC 托管”分类 chip；
- “登录身份”卡只读展示 provider、邮箱、关联时间；没有解绑按钮；
- 无 linked identity 时显示“本地账户”说明，不提供虚构的绑定入口。

本轮不提供自助改名/改邮箱，因为现有自助 API 没有该权限。

#### B. 登录与安全

- OIDC 托管：用 info NoticeBanner 说明“密码由身份提供方管理”，不挂密码 input/form；
- 本地账户：显示修改密码 Card；成功后若响应含新 `sessionToken`，先写入本地 store，再刷新
  actor/session 查询，确保当前窗口不断线；
- 活跃会话改为响应式列表，展示 user-agent、最近使用时间和到期时间；
- 吊销会话使用 ConfirmDialog，明确“若这是当前会话，下次请求会退出登录”。

#### C. 存量访问令牌

- 不显示“新建令牌”、scope picker 或生成说明；
- 只列出已有 PAT 的名称、状态、创建/最近使用时间、权限摘要；
- 每行可展开完整 scope code，并可通过 danger ConfirmDialog 吊销；
- 空态明确“个人访问令牌生成已关闭；当前没有存量令牌”，不提供 action；
- 页面不再包含任何可把用户带到生成流程的按钮、快捷键或隐藏 Dialog。

### 5.2 用户管理：人类账户目录

页头保留唯一主操作“新建用户”。正文：

1. **紧凑概览**：真人账户总数、管理员、待首次登录、已停用；
2. **查找与筛选**：搜索显示名/用户名/邮箱；状态 segment；角色 Select；状态写入 URL；
3. **响应式目录**：语义 `ul/li` + Card shell，每行固定包含身份、角色、状态、最近登录、
   OIDC/本地凭据归属和“管理”按钮。

`__system__` 不计入统计/筛选，放在底部只读“系统主体”说明块。

### 5.3 用户管理事务

点击“管理”打开编辑 Dialog：

- 编辑显示名、邮箱；
- User/Admin ChoiceCards，带权限解释；
- 只 PATCH dirty 字段；
- 自己/system 的角色保护和 last-active-admin 服务端保护不变；
- OIDC 托管账户显示“凭据由 IdP 管理”，没有重置密码入口；
- 本地账户显示独立“重置密码”入口；重置会激活用户并吊销全部 Web 会话。

路由层任一时刻只挂一个 Dialog；edit → reset 先关闭编辑态再开重置态，关闭后焦点回原“管理”按钮。

#### 新建用户

用 ChoiceCards 显式区分：

- **本地密码账户**：password 必填（8..256），创建后 active；
- **等待 OIDC**：email 必填、不提交 password，创建后 invited；明确系统不会发邮件，用户需通过已配置
  IdP 的已验证同邮箱完成首次登录。

角色同样使用带描述的 ChoiceCards；隐藏字段绝不偷偷提交。

#### 启用与停用

- active/invited 停用前走 danger ConfirmDialog；
- disabled 可重新启用；启用只恢复已有登录方式，不设置密码、不发送邮件；
- 管理员本人不显示停用入口，角色卡只读并解释；
- self-disable、self-role、last-active-admin、system immutable 继续由后端最终拒绝。

### 5.4 认证管理：登录方式策略

“设置 → 认证”在 Provider 列表前增加独立“登录方式”卡，不混入全局 config draft：

- Switch 标签为“允许用户名和密码登录”，旁边直接显示“已开启/已关闭”与影响范围；
- 关闭走 warning ConfirmDialog，列出当前 enabled Provider，说明本地账户将不能新登录、现有 session 不会
  被踢下线、接管后需通过本机 CLI 恢复，并引导先对 Provider 执行“测试连接”；
- 无 enabled Provider 时关闭动作禁用并给出可操作原因；服务端仍以
  `409 password-login-requires-enabled-oidc` 最终拒绝；
- 关闭期间，最后一个 enabled Provider 的停用/删除动作由服务端拒绝
  `409 last-enabled-oidc-required`，界面在对应操作旁预先解释；
- 重新开启不需要确认，成功后登录页下一次 discovery 即恢复用户名密码入口；失败留在卡内，不乐观翻转；
- Auth 登录页读取 bootstrap/ready 判别式 discovery：bootstrap 只构造 token；ready 才按 enabled Provider 与
  passwordLoginEnabled 构造 OIDC/用户名密码。loading/error 期间不猜测任何方法；单一方法不显示冗余 tab。

用户目录读取同一策略只做解释：开关关闭时，本地账户创建/重置密码仍允许，但 Dialog 显示“需重新开启
用户名密码登录后才可使用”的 NoticeBanner；这不是另一个安全门，也不改变 D3 对 OIDC 托管账户的拒绝。

### 5.5 Bootstrap 管理员接管

新增 bare-shell `/setup/admin`，与 RFC-211 的产品学习页 `/onboarding` 完全分离。页面只有一张短表单和清楚的
三步说明：设置管理员 → token 永久失效 → 用新账户登录。

- token form 验证 `/api/whoami` 返回 `source=daemon` 且 bootstrap required 后，replace 到 setup；保留原 deep-link
  redirect，管理员首次密码登录后再回原目的地；
- setup route 的 beforeLoad 与服务端 status 双检；未持 token 回 `/auth`，已完成 setup 回正常 `/auth`；
- 表单 password/confirm 使用 `new-password` autocomplete，前端校验一致性，后端仍只接受 password；
- 提交 pending 锁、错误原位；`bootstrap-already-complete` 说明另一窗口已完成并清 token；
- 成功后先清本地 token，再 replace `/auth?setup=complete&redirect=...`；登录页显示一次成功 NoticeBanner，且
  无 Provider 时直接呈现唯一 username/password form，不显示多余 tab；
- setup 模式不允许从普通 `/api/users` 创建首用户，避免 role/status/password 被通用 payload 绕开。
- 本机 CLI 也不制造另一套首用户语义：bootstrap 未完成时，`user create` 只有显式
  `--admin --password <pw>` 才可走同一 complete service；普通/invited 创建拒绝并指向 setup。完成后恢复现有
  通用 create 行为。

## 6. 响应式与视觉方向

- 继续使用现有 panel、border、radius、shadow 与语义 token，不另起“账户主题”；
- 桌面账户页约为 220px rail + minmax panel，窄屏单列；
- 用户目录桌面 grid、手机堆叠卡；身份在上、角色/状态/凭据归属/时间在中、管理按钮始终可见且至少
  44px 触控高度；
- 两页正文、Dialog 和目录不得让 body 横向滚动；长邮箱、subject、user-agent、scope anywhere 或省略；
- 颜色不是角色、状态、OIDC 归属或危险动作的唯一信息。

## 7. 验收标准

- **AC-1**：account 三分区 route-backed；overview 默认，security/tokens 一次导航可达。
- **AC-2**：390px account 无横向溢出；代码与 DOM 均不存在 PAT 生成按钮、scope picker、secret Dialog。
- **AC-3**：`POST /api/auth/pats` 对具备 `account:self` 的 session/PAT actor 无副作用拒绝
  `pat-creation-disabled`；bootstrap daemon 被 allow-list 拒绝、retired daemon 为 401；存量 PAT 可列出、可
  吊销、不会自动失效。
- **AC-4**：linked identity 数量大于零时，账户页不挂改密 form；自助改密与管理员 reset API 均拒绝
  `oidc-password-managed`。
- **AC-5**：无 linked identity 的本地账户仍可改密；session actor 保存新 token 后下一请求不 401。
- **AC-6**：identity 列表只读且无解绑控件；DELETE API 无副作用拒绝
  `identity-unlink-disabled`。
- **AC-7**：会话与 PAT 吊销有后果文案、pending 双击锁和原位失败。
- **AC-8**：390px user row 无横滚即可看到显示名、用户名、角色、状态和“管理”入口。
- **AC-9**：搜索覆盖显示名/用户名/邮箱，状态与角色可组合；统计/结果排除 `__system__`。
- **AC-10**：管理员目录能区分 linked OIDC 与本地账户；OIDC 行没有 reset，本地行有 reset。
- **AC-11**：新建明确区分 password→active 与 email+no-password→invited；不声称发送邮件。
- **AC-12**：编辑只 PATCH dirty 字段；self/system/last-admin 保护不退化。
- **AC-13**：本地账户 reset 的 force/activation/session-revoke 后果有测试；OIDC reset 被前后端双拒绝。
- **AC-14**：所有角色/状态/认证来源/OIDC 归属/空态/时间本地化，无裸 enum。
- **AC-15**：Dialog/ChoiceCards/ConfirmDialog 焦点、键盘、回焦、axe 合同通过。
- **AC-16**：1280/390 light/dark 定向视觉基线无 overflow、遮挡或小于 44px 的关键触控目标。
- **AC-17**：前后端定向与全量门、build、Playwright/axe/visual、精确 SHA CI 全绿。
- **AC-18**：“设置 → 认证”可读写 `passwordLoginEnabled`；迁移后存量安装默认为 true，切换即时生效且
  无需 daemon restart。
- **AC-19**：ready 模式关闭开关时，登录页 DOM 不存在 password tab/username/password form，只保留 enabled
  OIDC Provider；daemon token 永不复活。discovery loading/error 不猜测开启状态，也不会留下 active tab 指向
  未挂 panel。
- **AC-20**：关闭后 `POST /api/auth/login` 对任意 payload 均返回
  `403 password-login-disabled`，不读取用户名差异、不新增 session、不更新 lastLoginAt；已通过密码校验但尚未
  落 session 的并发请求在事务提交点再次受策略约束。
- **AC-21**：关闭动作要求至少一个 enabled Provider；关闭与最后 Provider disable/delete 的两种事务顺序
  均最多成功一个，失败方得到稳定 409 且 policy/provider/identity 零部分写入。
- **AC-22**：关闭/重开不改 password hash、用户 status 或已有 session；本地密码创建/重置只显示当前不可
  登录提示，OIDC managed 的 D3 拒绝不退化。
- **AC-23**：fresh install 登录页只显示 daemon token；token actor 除 bootstrap allow-list 外访问任一业务 API，
  以及 public password/OIDC login 链，均拒绝 `bootstrap-admin-required`，前端/旧客户端不可跳过
  `/setup/admin`。
- **AC-24**：bootstrap admin payload 只能得到 active admin + 必填本地 password；insert user、强制 password
  login on 与 `bootstrap_completed_at` 同事务，并发双提交最多一个成功且零半状态。
- **AC-25**：管理员创建成功响应后立即清 token 并回登录页；无需等待该 admin 登录，旧 daemon token 的 HTTP、
  query token 与新 WS upgrade 均统一 401，既有 daemon WS 被主动关闭。
- **AC-26**：setup 完成且无 enabled Provider 时，登录页只有 username/password form；增加 enabled Provider 后
  才出现 OIDC，并允许管理员关闭/重开用户名密码登录。
- **AC-27**：退役后 daemon stdout 不再打印带 token URL，登录页没有 token tab/panel，重启不会复活；public
  discovery 只暴露 mode/可用方法，不泄露 token 或完成时间。
- **AC-28**：`__system__` 行、内置资源 ownership、后台 attribution 与 FK 完整保留；用户统计继续排除它，
  只读系统主体块明确“不可登录/已退役”。
- **AC-29**：本机 `auth password-login enable` + `user enable/reset-password` 可恢复人类登录但绝不重开
  daemon token；迁移对已接管与 legacy 未接管数据库的 backfill/接管向导判定有测试。

## 8. 兼容与发布

需要一个小型 DB migration，无新依赖：

- `/account` 等价于 `/account?section=overview`；
- `/users` 无筛选参数时显示全部真人用户；
- 新增 `auth_login_policy` 单例行，包含 `password_login_enabled NOT NULL DEFAULT 1` 与
  nullable `bootstrap_completed_at`；password 登录对存量默认开启，bootstrap 完成态按是否已有可用人类 admin
  回填；legacy 无可用 admin 保留受限 token setup，不直接锁死；
- 新增 admin-only `GET/PUT /api/oidc/login-policy`（`oidc:read` / `oidc:configure`）；公共
  `GET /api/auth/oidc/providers` 升级为 bootstrap/ready 判别合同；bootstrap 分支只允许 token，ready 分支返回
  `providers` 与 `passwordLoginEnabled`；
- 新增 token-only `GET /api/auth/bootstrap/status` 与 `POST /api/auth/bootstrap/admin`；普通 users create API
  不承担首次交接；
- CLI `user create` 在 bootstrap 未完成时改为必须 admin+password 并完成同一交接，这是有意的 bootstrap
  compatibility tightening；
- `GET /api/users` 与详情/写操作响应增加 additive `hasOidcIdentity`，供管理 UI 判定；
- 三个禁用动作保留原 route 但固定返回结构化 403，便于旧客户端得到可诊断结果；
- 存量 PAT 继续有效，发布不会突然打断 CI；新 PAT 从发布时起无法生成；
- 本地账户改密/重置兼容；OIDC 托管账户的密码修改、密码重置和自助解绑是有意收紧；
- CLI reset-password 无参数变化，但对 OIDC 托管账户同样执行该收紧；
- 关闭用户名密码登录后旧客户端调用 login 会收到结构化 403；现有 session 与 OIDC callback wire 不变；
- daemon token retirement 是有意 breaking change：依赖长期 daemon bearer 的旧自动化在真实管理员接管后
  得到 401；存量未吊销 PAT 仍按 D1 可用，但新安装不再提供新的长期自动化 token；
- 前端可单独回退；**不得降级到不认识 `bootstrap_completed_at` 的 pre-RFC-221 后端**，因为旧二进制会忽略
  完成态并重新接受 token 文件。发布说明把它列为 security downgrade barrier；需要回退时只能使用仍识别该
  表/退役语义的后续兼容版本。
