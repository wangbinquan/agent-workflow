# RFC-320 实施计划 — 用户档案驱动的 Git 提交身份与 OIDC 邮箱刷新

- 状态：Accepted / implementation complete；用户于 2026-08-24 批准 proposal C1–C8，T0–T12 完成，T13 待发布验证
- 约束：只实现已批准终态；新增能力影响仍须重新确认

## 1. 任务分解

| ID  | 状态 | 工作                                                                                                                                                                       | 验收锚点                 |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| T0  | ✅   | 现状审计：任务 identity wire、runner、users/OIDC schema、callback/snapshot、账号页、RFC-294 ownership。                                                                    | proposal §1；design §1–2 |
| T1  | ✅   | 用户于 2026-08-24 确认 proposal C1–C8，RFC 状态 Draft → Accepted。                                                                                                         | proposal §5/§8           |
| T2  | ✅   | shared contracts：保留 `usernameClaim` 并新增 `emailClaim`、私有 profile、`GitCommitIdentity`、launch 旧键显式拒绝。                                                       | AC-1/2/3                 |
| T3  | ✅   | 下一空 migration：`oidc_providers.email_claim`；inventory 并清理持久化 launch payload 旧键；升级棘轮。                                                                     | AC-8                     |
| T4  | ✅   | identity-access：profile repository/commands/query、self update、email conflict、audit。                                                                                   | design §2/§3/§6          |
| T5  | ✅   | OIDC claims：两个自定义 selector 强制 userinfo、sub binding、email extraction、Provider CRUD/probe/fence。                                                                 | AC-3/4                   |
| T6  | ✅   | OIDC callback：existing/create/invite/link 四分支统一 profile snapshot sync，空邮箱首填和冲突友好页。                                                                      | AC-5                     |
| T7  | ✅   | task-execution：所有 launch creator 规则、单次 profile resolve、task snapshot、child inheritance。                                                                         | AC-6                     |
| T8  | ✅   | runtime：审计并统一所有用户 task commit 入口；锁定 push credential 与 internal identity 不变。                                                                             | AC-9                     |
| T9  | ✅   | frontend account：私有 profile query、提交身份卡、自助保存、cache/auth-generation 隔离。                                                                                   | AC-2/7                   |
| T10 | ✅   | frontend：Provider 表单并列配置 username/email userinfo 字段；task surfaces 删除输入/state/draft/builders/validation，确认页只读展示与缺失邮箱修复入口。                   | AC-1/3/7                 |
| T11 | ✅   | 测试：OIDC 矩阵、identity-access、task launch/runtime、migration、component/E2E、源码不复辟棘轮。                                                                          | AC-10；design §10        |
| T12 | ✅   | candidate-content targeted validation 全绿；full local gate 执行一次，本 RFC 暴露问题均已修复并定向复验，整体仍被并发 RFC-318 格式问题与门禁 `test-results` 产物污染阻断。 | AC-10                    |
| T13 | ⏳   | 按 shared-main publication critical section 精确 staging/commit/push，验证 trailer、remote ancestry、exact-SHA CI/visual。                                                 | 仓库 AGENTS.md           |

## 2. 实现批次

### Batch A — contracts + storage + identity-access

T2–T4。先建立唯一 owner 与 purpose-specific query，后续 OIDC/task 不得直读 users 表。

### Batch B — OIDC profile completion

T5–T6。先锁 claims/source/sub binding，再接 transaction sync；每个失败分支做“零 user/identity/session 写入”断言。

### Batch C — task ownership + runtime

T7–T8。先集中 creator resolution，再删旧 request ownership；逐入口 inventory，不以单一路由测试代替全入口证明。

### Batch D — product UI + compatibility cleanup

T9–T10。账号页先提供修复入口，再移除任务页输入；旧 draft/持久 payload 收敛到终态。

### Batch E — gates + publication

T11–T13。共享 main 上只验证本任务 candidate；出版前重新 fetch/同步并检查共享 index。

## 3. 必须逐项对账的入口

- StartWorkflowTask / StartAgentTask / StartWorkgroupTask；
- PAT 与 session actor；
- schedule create/edit/fire；
- event automation launch；
- relaunch / retry / resume；
- task-derived child/fanout/call；
- task completion auto commit/push、wrapper Git、git adapter；
- OIDC existing/create/invite/link；
- `/auth/me`、account self profile、admin user edit；
- Provider create/patch/materialize/test/settings form。

## 4. 开放项

当前没有实现开放项；C1–C8 均为开工前能力裁决。仅剩 T13 发布与 hosted 验证。若用户改变其中任一项，
先更新 proposal/design/plan，再次获得确认后才扩展能力。
