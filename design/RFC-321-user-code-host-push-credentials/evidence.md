# RFC-321 — 验收证据索引

本表是 RFC-321 的可复跑证据入口。每个 AC 同时登记生产落点、正向行为与拒绝分支；测试名按
源码中的完整或稳定前缀记录。`rfc321-repository-publication-ratchet.test.ts` 会反向锁定 AC-1–AC-14
与 T1–T20 均恰好出现一次，防止新增任务或验收项变成游离散文。

## AC evidence

| AC    | 生产实现                                                                                                                                                                                   | 正向证据                                                                                                                                                                               | 拒绝/禁用证据                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `repositoryTransportCredentials.ts`；`accountRepositoryTransportCredentials.ts`；`AccountCodePushCredentialsPanel.tsx`                                                                     | `rfc321-repository-transport-http.test.ts` 的 session save/replace/delete 与 draft/stored identity probe；`rfc321-code-push-credentials.spec.ts` 的账号旅程                            | 同一 HTTP suite 的 PAT/daemon/anonymous/stale 与 token-canary 断言；probe 缺个人记录返回 unavailable 且 global probe 次数为零                                  |
| AC-2  | `repositoryTransportCredential.ts` 的单一 selector；`RepositoryTransportCredentials.resolveExecution()` 的单一解封入口                                                                     | `rfc321-repository-transport-credentials.test.ts` 的 personal/global/legacy/system truth table；system-mock real Git 证明 Bob 缺个人时使用 global                                      | 同 suite 的 stale/corrupt personal fail-closed；system-mock invalid personal journal 明确不出现 global retry                                                   |
| AC-3  | `commitPushRunner.ts` 从持久 task owner 构造 subject；`missionDeliveryChain.ts`/`conflictRepairDelivery.ts` 从 mission `createdBy` 构造；employee-case composition 从 `owner_user_id` 构造 | `commit-push-runner.test.ts` 断言 owner-user subject；`rfc257-webhook-e2e.test.ts`、`scheduled-tasks-run-now.test.ts` 与 child launch tests 锁 owner 传播；ratchet 锁全部 subject 落点 | credential selector 的 system subject 跳过 personal；mission helper 对 null/系统用户输出 system；当前调用会话不进入 publication contract                       |
| AC-4  | `repository-transport.ts` 的 descriptor、mapping normalizer 与 endpoint resolver                                                                                                           | `rfc321-repository-transport.test.ts` 覆盖 scp/ssh/http(s)、端口、`.git`、SaaS、mapping、provider candidate                                                                            | 同 suite 覆盖 traversal、encoded separator、tie、userinfo、未知 authority、非显式 HTTP 与 malicious candidate fail-closed                                      |
| AC-5  | `repositoryEndpointDiscovery.ts` exact GitHub/GitLab metadata adapter；publication composition 二次校验 generation/digest                                                                  | publication transport 覆盖 SSH/Web authority 不同且双连接只认唯一可信 metadata；system-mock GitLab metadata→smart HTTP                                                                 | shared candidate 拒绝 userinfo/scheme/authority/path 越界；双 provider 同时 claim 时 fail closed；adapter 禁重定向且 malformed/non-2xx 不可用                  |
| AC-6  | `RepositoryPublicationTransport.open()` 只产生一个 session；task/candidate/employee network calls 全走 `session.runNetwork()`                                                              | `rfc321-repository-publication-transport.test.ts` 锁一次 lease 复用/close；system-mock candidate 做 metadata、receive-pack 与 post verification；浏览器任务做真实 auto-push            | `commit-push-runner.test.ts` 锁个人认证失败不进入 repair；ratchet 禁止裸 publication 双轨并逐项登记 network call sites                                         |
| AC-7  | `commitPushRunner.ts` 对每个变更 submodule 读取自己的 remote 并独立 `publicationTransport.open()`；helper 绑定 exact path                                                                  | `rfc210-commitpush-subrepo.test.ts` 锁变更子仓先发布再发布父 gitlink；`rfc205-git-credential.test.ts` exact project path 正向响应                                                      | `rfc205-git-credential.test.ts` 的 sibling path/host/protocol 拒绝证明父 token 对恶意 submodule 零响应；未知 remote 的 transport resolver fail closed          |
| AC-8  | sealed DB columns；`gitCredentialLease.ts` 0600 one-shot file、空 inherited helper、terminal prompt guard 与 finally cleanup                                                               | `rfc205-git-credential.test.ts` 锁 file mode/env/argv/cleanup/orphan cleanup；publication transport test 锁 session close 后文件消失                                                   | helper protocol/host/port/path mismatch 返回空；system-mock journal 对 Authorization/private-token 只保留 `[redacted]` 且三个 canary 零命中                    |
| AC-9  | connection/projection coordinator 使用同一 SQLite transaction；endpoint digest + one-shot revocation digest CAS；session receipt 固定 revision                                             | `rfc321-repository-transport-http.test.ts` 锁 token-only rotation 保留个人行、rebind/delete 原子清除、lease revision 固定                                                              | 同 suite 的 projection trigger fault 回滚两表；两个竞争 rebind 只有首个 confirmation 成功，旧 digest 返回 stale                                                |
| AC-10 | publication composition 对 local/file 与无 managed connection 走 legacy session；既有 URL userinfo 仍用 target-bound compatibility lease                                                   | migration test 保留 `cached_repos.url_enc`；selector 两档缺失返回 legacy；现有 commit-push/file suites 继续跑真实 Git                                                                  | 有 managed connection 但 seal key/endpoint 不可用时 fail loud，不降级到 SSH/URL credential；本地 fixture 明确排除 provider 解析                                |
| AC-11 | account code-push section 使用 SettingsCard/Form/ErrorBanner/ConfirmDialog；Git identity 为独立同宽兄弟卡；Settings mapping/rebind confirmation 复用既有 primitives                        | `account-query-continuity.test.tsx`；`rfc269-code-host-settings.test.tsx`；Chromium/WebKit RFC-321 E2E；四张 light/dark、desktop/390px baseline                                        | E2E 断言 390px 零横溢、键盘 focus、axe critical/serious 为零；Alice/Bob 独立 context 不共享 hint/delete；overlay inventory 锁 destructive dialogs              |
| AC-12 | 新 domain/application/ports/infrastructure/composition 均在 `modules/source-control`；integration 只返回无 secret metadata；public contracts 无 raw token                                  | `rfc321-repository-publication-ratchet.test.ts` 的 public-contract secret-free 与 source-owned call-site ledger                                                                        | fabricated public `password` field mutation 转红；scheduler/development REST 继续解析 global code-host connection，personal subject 不进入 MR/评论/审批/流水线 |
| AC-13 | `architecture/repository-publication-call-sites.json` 已接 `ledger-baselines.json`；guard manifest 注册 RFC-321 AST corpus ratchet                                                         | ratchet 扫描 801 个 backend TypeScript 文件并锁 push/fetch/ls-remote 账本、tokenAccess、固定 session、global REST 边界                                                                 | mutation fixtures 分别伪造裸 Git network 命令、移除 helper path binding、允许 stale→global、放宽 tokenAccess、拼 token URL，均产生命名违规                     |
| AC-14 | 本索引汇总 shared/backend/frontend/system-mock/browser/visual；T20 记录唯一 full gate 与 exact-SHA 托管结果                                                                                | 候选稳定后运行一次 `bun run gate:local`；推送后按完整 SHA 等 CI 与 visual terminal success                                                                                             | queued/cancelled/不包含目标 SHA 的 successor 不记绿色；Linux baseline 缺失先从 Ubuntu artifact 人工验图再补提交                                                |

## Task closure

| Task | 关闭证据                                                                                            | AC                 |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------ |
| T1   | `architecture/repository-publication-call-sites.json` 六个 publication 入口与三个显式排除 read path | AC-6, AC-12, AC-13 |
| T2   | shared strict schemas、remote descriptor、mapping/endpoint union 与 14 个 shared 用例               | AC-1, AC-4, AC-5   |
| T3   | migration `0208_rfc321_repository_transport_credentials.sql`、schema/journal 与 upgrade tests       | AC-2, AC-9, AC-10  |
| T4   | source-control credential domain、repository、personal CRUD/selector truth table                    | AC-1, AC-2, AC-8   |
| T5   | code-host connection/global projection transaction、rebind/delete impact CAS 与 rollback fault      | AC-2, AC-9         |
| T6   | session-only account GET/PUT/POST/DELETE、rate limit、probe 与 canary leak scan                     | AC-1, AC-8         |
| T7   | integration provider metadata exact adapter、manual redirect 与 generation-bound candidate          | AC-4, AC-5         |
| T8   | API→mapping→SaaS resolver、explicit HTTP admission、longest prefix/tie/path rejection               | AC-4, AC-5         |
| T9   | exact-target credential helper、0600 one-shot lease、finally/orphan cleanup                         | AC-8               |
| T10  | bootstrap-owned publication transport session、sanitized endpoint/receipt/runner closure            | AC-6, AC-8, AC-9   |
| T11  | task auto-push/non-FF/post-verify 接统一 session；旧 global resolver 双轨灭绝                       | AC-3, AC-6, AC-10  |
| T12  | candidate、conflict 与 employee workspace read 接 mission/case owner subject 和统一 session         | AC-3, AC-6         |
| T13  | changed submodule 按自己的 remote 独立 open；exact-path helper 不继承父仓权限                       | AC-7               |
| T14  | account code-push panel、Git identity sibling card、identity-epoch query key、中英文                | AC-1, AC-11        |
| T15  | Settings typed mapping、预览、个人影响数量、rebind/delete CAS confirmation                          | AC-4, AC-9, AC-11  |
| T16  | system mock provider metadata、受保护 smart HTTP receive-pack、安全 credential identity label       | AC-5, AC-6, AC-8   |
| T17  | migration/domain/HTTP/publication/helper/security/upgrade targeted suites                           | AC-1–AC-10         |
| T18  | Alice/Bob Chromium+WebKit E2E、task SSH real push、candidate smart-HTTP test、axe 与四张视觉基线    | AC-1, AC-3, AC-11  |
| T19  | guard manifest、ledger baseline、mutation fixtures 与本 AC/Task 零遗漏索引                          | AC-12, AC-13       |
| T20  | 用户/管理员/灾备文档、唯一 full gate、精确提交推送、exact-SHA CI/visual                             | AC-14              |

## Reproducible validation ledger

最终发布前把候选验证记录在这里；完整门禁只允许一次，托管结果必须绑定最终远端 SHA。

| Scope              | Command/evidence                                                                          | Result                            |
| ------------------ | ----------------------------------------------------------------------------------------- | --------------------------------- |
| shared resolver    | `bun test ./packages/shared/tests/rfc321-repository-transport.test.ts`                    | 14 pass / 0 fail                  |
| backend smart HTTP | `bun test ./packages/backend/tests/rfc321-repository-publication-system-mock-e2e.test.ts` | 1 pass / 0 fail                   |
| browser Chromium   | RFC-321 spec，账号/PAT 拒绝/真实 task push 三条 journey                                   | 3 pass / 0 fail                   |
| browser WebKit     | RFC-321 spec，`PLAYWRIGHT_WEBKIT=1`                                                       | 3 pass / 0 fail                   |
| local visual       | RFC-321 四个场景，Chromium Darwin                                                         | 4 pass / 0 fail；四图人工检查通过 |
| full local gate    | `bun run gate:local`                                                                      | 待候选稳定后唯一一次执行          |
| hosted CI          | 最终 `origin/main` exact SHA                                                              | 待推送                            |
| hosted visual      | 最终 `origin/main` exact SHA；Ubuntu authoritative baselines                              | 待推送与 artifact 收口            |
