# RFC-335 实施计划 — OIDC 显示用户名与 Git name 分离

状态：Done（2026-08-28 实现落地、hosted CI 验绿；2026-09-21 收口补记）。

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
| RFC-335-T9  | 精确提交/推送，验证 commit paths/trailer/remote ancestry，跟踪 exact-SHA GitHub CI 到终态                                 | T8     | Done（`2f66dce8f` 含真实 Codex co-author trailer 已入 `origin/main`；自身 run 33134790825 红（visual baseline 未刷新等），当日上午补 `e8d8861d9`（account E2E 覆盖 gitName + macOS baseline）与 `e64352273`（Ubuntu baseline），按共享 main 归因规则取 containing SHA `8e58eb05f` 的 CI run 33142147682 35/35 success，visual run 33136500610 success） |
| RFC-335-T10 | 回填 proposal/design/plan、`design/plan.md` 与 `STATE.md` 的实现和 CI 证据，置 Done                                       | T9     | Done（2026-09-21 收口补记：三件套状态、`design/plan.md` 索引与 `STATE.md` 均已置 Done 并附 CI 证据；实现与 rfc335 回归在当前 main 46/46 绿中） |

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

- [x] 用户明确批准 D1–D7（proposal §5，2026-08-28）。
- [x] `display_name` 与 `git_name` 独立存储，迁移回填正确（migration `0214_rfc335_oidc_git_name.sql` + `rfc335-oidc-git-name-migration.test.ts`）。
- [x] `usernameClaim` 与 `gitNameClaim` 在 Provider CRUD/UI 独立往返（`rfc220-oauth2-provider-schema-service.test.ts` / `rfc220-oidc-provider-form.test.tsx`）。
- [x] 每次 OIDC 登录对账双名称，existing/create/bind/link 全覆盖（`syncOidcProfile` + `rfc220-presented-name-sync.test.ts`）。
- [x] 显式 selector 空值分别稳定失败且零 profile/session 写入（`rfc220-identity-acquisition.test.ts`）。
- [x] selector race 与 userinfo subject binding 保持成立（同上）。
- [x] 账户页可独立编辑显示用户名/Git name/email，并解释 OIDC 下次登录覆盖（`AccountGitIdentityCard.tsx` + `account-query-continuity.test.tsx` + `e2e/account-profile.spec.ts`）。
- [x] 新 task 使用 `gitName + email`；旧 task/child snapshot/push credential 语义不变（`task-start-git-identity.test.ts`）。
- [x] shared/backend/frontend/migration/E2E 与源码棘轮已提交（E2E 与双 OS visual baseline 随 `e8d8861d9` / `e64352273` 补齐）。
- [x] commit 只含精确 allowlist，包含真实 Codex co-author trailer（`2f66dce8f`，`Co-Authored-By: Codex <noreply@openai.com>`）。
- [x] 实现 commit 已进入 `origin/main`，remote ancestry 已确认（`2f66dce8f` 为 `8e58eb05f` 祖先）。
- [x] 包含实现的 exact-SHA GitHub CI/相关 scheduled workflow 终态已记录（共享 main 并发取消下取 containing SHA `8e58eb05f` 的 run `33142147682` 35/35 success；visual run `33136500610` success）。

## 4. 发布策略

单批功能提交优先；若 migration/shared/backend/frontend 之间因共享 `main` 并发必须拆批，每一批都必须是可编译、
可运行的完整纵切，不能把 required schema 与 consumer 拆成让主干短暂变红的半截。发布使用共享 index 的短临界区，
每次都在 staging/commit/push 前重新 fetch 并核对 `origin/main...main`。
