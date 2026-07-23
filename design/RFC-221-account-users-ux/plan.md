# RFC-221 账户安全中心与响应式用户目录 UX 重构 — plan

状态：Approved v5 / 本地实现完成（2026-07-22；实现门、精确 SHA CI 与剩余视觉验收仍待完成）。依赖：RFC-198（共享页面/反馈/Dialog
原语，Done）、RFC-201（PageSectionNav，Done）、RFC-214（QueryState/ErrorBanner.onRetry，Done）。

与进行中的 RFC-219 无代码耦合；不修改其 workflow picker 文件、测试或视觉基线。与 RFC-222 在
Role/AdminUserView/users UI 有合并面：后落地者必须重读已实现 schema，不覆盖 `manager` additive 角色。

## PR 拆分

### PR-1：Bootstrap 交接与登录方式策略

包含 auth policy migration/shared wire、token-only 首登、受限 daemon allow-list、`/setup/admin` 原子创建首位
admin+永久退役 token、HTTP/WS/stdout/CLI 收口、password login 开关与最后 Provider 事务保护、AuthPage/
AuthenticationTab 四态，以及同批 migration/backend/frontend tests。

### PR-2：账户安全中心与能力收紧

包含 OIDC managed helper、PAT create/identity unlink/password mutation denial、account 三分区、OIDC/local
安全呈现、存量 PAT retirement、local password token handoff，以及同批 pure/frontend/backend tests。

### PR-3：响应式用户目录与管理事务

包含 users 搜索/筛选/目录、system 分离、凭据归属、新建/编辑/local reset/启停 Dialog，以及对应
pure/component/backend tests。OIDC managed 用户不挂 reset 入口，API denial 由 PR-2 地基保证。

### PR-4：跨页验收与收尾

Auth/setup/settings/account/users 的 e2e/axe/visual、旧 CSS/i18n/测试锁清理、全量门与 RFC 交付记录。若
发现生产修复，必须与能使它失败的回归测试同批。

## 任务

- [x] **RFC-221-T1 shared/storage 地基**：AuthMethodDiscovery 判别联合、AuthLoginPolicy/BootstrapAdmin schema、
      AdminUserViewSchema；auth_login_policy migration/backfill/journal/schema；同步 policy service 与纯测试。
- [x] **RFC-221-T2 bootstrap 后端**：daemon token policy lookup、bootstrapGate allow-list、status/admin endpoint、
      prepared hash + dbTxSync user/policy 原子提交、并发/故障回滚、HTTP/query/WS retirement revalidation、
      `__system__` 内部语义不变。
- [x] **RFC-221-T3 bootstrap/auth 前端与运维面**：AuthPage bootstrap/ready 单/多方法状态机、bare
      `/setup/admin`、clear-token handoff/deep link、ready stdout 裸 URL、CLI password-login status|enable、
      incomplete `user create` 仅 admin+password 且复用 complete service。
- [x] **RFC-221-T4 password/OIDC 登录策略**：AuthenticationTab Switch；无 Provider locked-on；关闭确认；
      login fast+commit recheck；last Provider disable/delete 与 policy 同步事务；两种交错顺序测试。
- [x] **RFC-221-T5 禁用能力与 OIDC policy**：`isOidcManagedUser/listOidcManagedUserIds`；PAT create、identity
      self-unlink、OIDC managed self change-password/admin+CLI reset-password 拒绝；status/code/零副作用与 local
      positive path。
- [x] **RFC-221-T6 Account shell**：`section=overview|security|tokens`、PageSectionNav、actor
      QueryState、typed identities/PAT single owner、responsive layout。
- [x] **RFC-221-T7 Account panels**：只读 OIDC identity；OIDC policy NoticeBanner；local password+
      fresh token；sessions；存量 PAT list/details/revoke；彻底删除 create/scope/secret UX。
- [x] **RFC-221-T8 用户目录**：AdminUserView、真人/system 分离、统计、URL 搜索/状态/角色筛选、
      OIDC/local ownership、responsive ul/li、initial/filtered/stale-error。
- [x] **RFC-221-T9 用户 Dialog**：password/SSO 新建、dirty edit、仅 local reset、disable/enable、
      self/system/last-admin 后果与 single-dialog focus handoff。
- [x] **RFC-221-T10 i18n/视觉/a11y**：中英 bootstrap/policy/error/status 文案、StatusChip/NoticeBanner/
      RelativeTime、feature CSS、light/dark、44px、overflow/long content。
- [ ] **RFC-221-T11 浏览器验收**：1280/390 fresh token-only→setup→password-only、OIDC policy、account/users
      fixture、关键字段 viewport bounding box、keyboard 与 targeted visual 已完成；axe、light theme 与 Linux
      权威基线待提交后完成。
- [ ] **RFC-221-T12 收尾**：定向/全量/build、downgrade/release note、实现门、修订账/偏差、STATE/index/AC、
      精确 SHA CI。

## 依赖关系

```text
T1 → T2 → T3 → T4 ───────────────┐
 ├────────→ T5 → T6 → T7 ────────┼→ T10 → T11 → T12
 └────────→ T8 → T9 ─────────────┘
```

## 验收清单

- [x] AC-1 account 三目的地 route-backed
- [x] AC-2 390px account 无横滚，前端无 PAT create/scope/secret
- [x] AC-3 PAT create session/PAT 固定拒绝；bootstrap/retired daemon 各走更早 gate；全分支零写入
- [x] AC-4 OIDC managed self change/admin reset 前后端双拒绝
- [x] AC-5 local change-password fresh token handoff 不断线
- [x] AC-6 identity 只读，DELETE own/foreign/unknown 同拒绝且零删除
- [x] AC-7 session/PAT revoke 确认、pending、原位错误
- [x] AC-8 390px user row 五个关键信息/操作无需横滚
- [x] AC-9 搜索×状态×角色、稳定 count、system 分离
- [x] AC-10 AdminUserView 区分 OIDC/local，reset 只对 local
- [x] AC-11 password→active / email SSO→invited 序列化
- [x] AC-12 dirty PATCH 与 self/system/last-admin 保护
- [x] AC-13 local reset force/activation/session revoke；OIDC reset denial
- [x] AC-14 全本地化与 presentation mapping
- [ ] AC-15 Dialog/ChoiceCards/ConfirmDialog/focus/axe
- [ ] AC-16 1280/390 light/dark visual + overflow/touch targets
- [ ] AC-17 定向/全量/build/精确 SHA CI
- [x] AC-18 passwordLoginEnabled 持久化、默认 on、无需重启
- [x] AC-19 password off 无 DOM/API 旁路，auth discovery 无 invalid active panel
- [x] AC-20 login fast/commit 双检查且 session/lastLogin 零副作用
- [x] AC-21 policy 与 last enabled Provider 两种事务交错最多一成功
- [x] AC-22 login policy 不删除 hash/status/session，OIDC managed 更严规则不退化
- [x] AC-23 fresh `/auth` token-only，bootstrap actor 业务 API 全拒
- [x] AC-24 setup 只能创建 active admin+password，user/policy 原子且并发唯一
- [x] AC-25 user insert 提交即 token HTTP/query/WS 退役并清前端 token
- [x] AC-26 ready/no-provider password-only；enabled Provider 后才可切 password policy
- [x] AC-27 ready stdout 裸 URL、无 token UI、重启不复活
- [x] AC-28 `__system__` ownership/attribution/FK 保留且 UI 明示不可登录
- [x] AC-29 CLI 可恢复 password 登录但不能复活 daemon token；legacy backfill 安全

## 设计批准门

- [x] 用户批准 v5 `proposal.md` / `design.md` / `plan.md`
- [x] 批准前未修改 production/test code

## 本地交付记录（2026-07-22）

- 已完成 T1-T10：migration `0110_rfc221_auth_login_policy.sql`、bootstrap/password/OIDC/PAT/identity 后端策略、
  Auth/setup/account/users/settings 前端与 CLI 恢复面均已落地；本次提交交付，推送后按精确 SHA 核对 CI。
- 真实浏览器已完成 fresh token-only → `/setup/admin` → token 永久退役 → password-only 的全链；随后配置 enabled
  OIDC Provider，验证登录方式切换、390px/1280px auth/account/users、键盘切换、无横向溢出和控制台零错误。
- 登录页追加收口：两种登录方式改为满宽等分、图标化且不换行的选择器；“身份提供商”收敛为“单点登录”；
  Provider 改为名称/安全跳转说明/方向图标组成的入口卡；390px 品牌区压缩为约 72px，避免首屏大块留白。
- 发布说明：升级后 daemon token 仅用于首次交接，并在首位管理员创建事务提交后不可逆退役；PAT 停止新建但存量可
  查看/吊销；linked OIDC 账户的密码和 identity 由身份方托管；关闭密码登录前必须保留 enabled OIDC Provider。
- 隔离出的 RFC-221 精确快照已通过 frontend `646 files / 5196 tests`、shared `128 files / 1384 tests`、workspace
  format/lint/typecheck、migration check、`git diff --check` 与 `build:binary`。backend 全量除沙箱不允许本地监听/
  进程探测造成的 `43 fail / 1 error` 外为 `6521 pass / 23 skip`；对应 11 个文件在沙箱外复跑 `74 pass / 0 fail`。
- 尚未完成：axe、light theme 与 Linux 权威视觉基线；实现门与精确 SHA CI。因此 T11/T12、AC-15~17
  保持未勾选，不把本地完成误报为已发布。
