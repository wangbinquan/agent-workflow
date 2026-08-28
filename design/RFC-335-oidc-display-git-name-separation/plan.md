# RFC-335 实施计划 — OIDC 显示用户名与 Git name 分离

状态：In Progress；实现与针对性验证完成，等待精确提交、推送和 hosted CI。

## 1. 任务分解

| 任务        | 内容                                                                                                                      | 依赖   | 状态                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| RFC-335-T1  | 用户确认 proposal 裁决；实现前重新 fetch/sync shared `main`、检查并发 owner 与下一 migration 号                           | —      | Done                                         |
| RFC-335-T2  | 新增 `users.git_name`、`oidc_providers.git_name_claim` migration 与 Drizzle schema；回填存量用户并更新 rolling-upgrade 锁 | T1     | Done                                         |
| RFC-335-T3  | 扩 shared Provider/private profile/update contracts，保持 `usernameClaim` wire 兼容并新增 `gitNameClaim`                  | T2     | Done                                         |
| RFC-335-T4  | 扩 claim acquisition：双名称解析、strict error、userinfo subject binding 与 selector snapshot                             | T3     | Done                                         |
| RFC-335-T5  | 扩 identity-access port/repository/sync command；existing/create/bind/link 每次登录原子刷新双名称                         | T2–T4  | Done                                         |
| RFC-335-T6  | `GetUserGitCommitIdentity` 改读 `gitName`；更新 account API/self profile 与所有受管用户创建入口默认值                     | T3、T5 | Done                                         |
| RFC-335-T7  | Provider 表单与账户卡拆分显示/Git name，补中英文、字段级错误、cache 与窄屏/键盘回归                                       | T3、T6 | Done                                         |
| RFC-335-T8  | 补 shared/backend/frontend/migration/callback/task/E2E 与源码棘轮测试                                                     | T2–T7  | Done（targeted 153 tests；hosted E2E 归 T9） |
| RFC-335-T9  | 精确提交/推送，验证 commit paths/trailer/remote ancestry，跟踪 exact-SHA GitHub CI 到终态                                 | T8     | In Progress                                  |
| RFC-335-T10 | 回填 proposal/design/plan、`design/plan.md` 与 `STATE.md` 的实现和 CI 证据，置 Done                                       | T9     | Pending                                      |

## 2. 预计 owned paths

最终以 live diff 为准，预计涉及：

- `design/RFC-335-oidc-display-git-name-separation/**`
- `design/plan.md`、`STATE.md`
- `packages/shared/src/schemas/{user,oidcProvider}.ts` 与直接测试
- `packages/backend/db/migrations/<next>_rfc335_oidc_git_name.sql`
- `packages/backend/db/migrations/meta/_journal.json`
- `packages/backend/src/db/schema.ts`
- `packages/backend/src/auth/oidc/identity.ts`
- `packages/backend/src/routes/{oidc-auth,auth}.ts`
- `packages/backend/src/services/{oidcProviders,userIdentities}.ts`
- `packages/backend/src/modules/identity-access/**` 的 profile/Git identity slice
- `packages/backend/tests/**` 中 RFC-335 直接回归及必要 fixture
- `packages/frontend/src/routes/settings.tsx`
- `packages/frontend/src/components/account/AccountGitIdentityCard.tsx`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- `packages/frontend/tests/**` 与对应 E2E spec

并发 session 若修改同一 task-related 文件，提交前逐 hunk 对账并完整保留其输出；非本 RFC 路径不暂存。

## 3. 验收清单

- [ ] 用户明确批准 D1–D7。
- [ ] `display_name` 与 `git_name` 独立存储，迁移回填正确。
- [ ] `usernameClaim` 与 `gitNameClaim` 在 Provider CRUD/UI 独立往返。
- [ ] 每次 OIDC 登录对账双名称，existing/create/bind/link 全覆盖。
- [ ] 显式 selector 空值分别稳定失败且零 profile/session 写入。
- [ ] selector race 与 userinfo subject binding 保持成立。
- [ ] 账户页可独立编辑显示用户名/Git name/email，并解释 OIDC 下次登录覆盖。
- [ ] 新 task 使用 `gitName + email`；旧 task/child snapshot/push credential 语义不变。
- [ ] shared/backend/frontend/migration/E2E 与源码棘轮已提交。
- [ ] commit 只含精确 allowlist，包含真实 Codex co-author trailer。
- [ ] 实现 commit 已进入 `origin/main`，remote ancestry 已确认。
- [ ] 包含实现的 exact-SHA GitHub CI/相关 scheduled workflow 终态已记录。

## 4. 发布策略

单批功能提交优先；若 migration/shared/backend/frontend 之间因共享 `main` 并发必须拆批，每一批都必须是可编译、
可运行的完整纵切，不能把 required schema 与 consumer 拆成让主干短暂变红的半截。发布使用共享 index 的短临界区，
每次都在 staging/commit/push 前重新 fetch 并核对 `origin/main...main`。
