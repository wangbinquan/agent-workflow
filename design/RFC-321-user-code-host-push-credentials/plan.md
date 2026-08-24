# RFC-321 — 实施计划：用户级代码平台推送凭据与 SSH→HTTP(S) 传输解析

- 状态：Implementation Complete / Phase 2；等待 exact-SHA hosted CI/visual 终态
- 当前完成度：T1–T19 已闭合；T20 已完成 targeted E2E/visual，余精确发布与托管终态
- 交付策略：一个 RFC，按可独立验证的小批 commit 发布到共享 `main`；不建立长期兼容双轨

## 实施进度（2026-08-24）

- 用户明确要求 RFC-320 与 RFC-321 分属不同阶段、各自会话独立负责；本会话不接管 RFC-320 的
  后端问题，只把其既有 Git 提交身份卡片展示移动到 RFC-321 的“代码提交与推送”页签。
- 账号个人凭据、管理员 connection mapping/影响确认、source-control selector/lease、task/candidate/
  submodule/employee workspace publication 接线均已落候选；个人配置优先、缺失才用公共 token，选中后
  认证失败不回退。
- SSH remote 已按 provider API → 管理 mapping → SaaS 约定解析为 HTTP(S)。管理员 mapping 带 path
  prefix 时，校验使用映射后的 suffix，避免把原 SSH 前缀错误带入 HTTP base 的信任判定。
- “Git 提交身份”和“推送凭据”两张卡统一复用 `SettingsCard`、表单横向占满卡片内容区，并共享相同 spacing/
  notice/button/action 样式；缺失提交身份的任务入口直接跳到该页签。
- 个人凭据卡新增与 Settings 同源的 identity probe：既可一次性校验草稿 token，也可由服务端解封并校验
  已保存 token；成功显示 token 有效与对应平台用户，失败显示分类原因，个人记录缺失时绝不测试公共 token。
- 供给边界已用架构测试锁定为两条统一逻辑：Git publication 唯一走 source-control personal-first
  supply；MR/评论/审批/流水线与 workflow code-host call 唯一走现有 global connection，不在调用点散布适配。
- targeted shared/backend/frontend 与 RFC-317 guard-manifest 闭合测试已通过；本地浏览器实测 1280px 桌面端
  两表单同为 718px、左右边界一致且占满内容区，390px 下同为 332px 且无横向溢出。完整自动化 visual、
  精确提交/推送和 hosted exact-SHA CI 仍属于 T18/T20 待办。

## 0. 开工前置

以下条件全部满足才可把 T1 标为 In Progress：

1. ✅ 用户明确批准 `proposal.md §5 C1–C14`、`§6 I1–I8` 与追加裁决 S1；
2. ✅ proposal/design/plan 状态改为 Accepted，并同步 `STATE.md` / `design/plan.md`；
3. ✅ 用户确认 RFC-320 已推送，并要求其原会话继续独立处理剩余问题；RFC-321 不接管其后端范围；
4. `git fetch origin main` 后确认 local main 与 origin/main 可安全同步；
5. 重新读取 `CLAUDE.md`、`STATE.md`、RFC-294 proposal §1/§3 与完整 design；
6. 读取 RFC-320 最终实现/测试证据，确认 commit identity 接缝稳定且未被本 RFC 反向接管；
7. 确认 migration journal、共享 dirty paths、现有 full gate 是否正在运行；
8. 若 task-related 文件已有并发改动，先确认完整文件的共同终态，不删除任何现有 hunk。

## 1. 任务总览

| 任务        | 内容                                                                        | 依赖        | 主要 AC            |
| ----------- | --------------------------------------------------------------------------- | ----------- | ------------------ |
| RFC-321-T1  | 冻结现状 census、入口清单与禁止双轨守卫基线                                 | Phase 1 门  | AC-6, AC-12, AC-13 |
| RFC-321-T2  | shared contracts：credential summary、mapping、endpoint/error unions        | T1          | AC-1, AC-4, AC-5   |
| RFC-321-T3  | migration：connection generation、global projection、user credential tables | T2          | AC-2, AC-9, AC-10  |
| RFC-321-T4  | source-control domain 与 SQLite credential repository                       | T3          | AC-1, AC-2, AC-8   |
| RFC-321-T5  | code-host connection ↔ global push projection 原子 coordinator              | T3,T4       | AC-2, AC-9         |
| RFC-321-T6  | 本人 credential HTTP commands/queries 与 route metadata                     | T4          | AC-1, AC-8         |
| RFC-321-T7  | provider API clone endpoint exact query/adapters                            | T2,T5       | AC-4, AC-5         |
| RFC-321-T8  | endpoint resolver：API/mapping/SaaS/unknown fail-closed                     | T4,T7       | AC-4, AC-5         |
| RFC-321-T9  | exact target 一次性 credential helper/lease                                 | T4,T8       | AC-8               |
| RFC-321-T10 | source-control publication participant 与统一 transport session             | T8,T9       | AC-6, AC-8, AC-9   |
| RFC-321-T11 | task auto-push/non-FF repair 接入并删除旧 resolver 双轨                     | T10         | AC-3, AC-6, AC-10  |
| RFC-321-T12 | candidate/conflict delivery 接入统一 participant                            | T10         | AC-3, AC-6         |
| RFC-321-T13 | submodule per-remote credential isolation                                   | T10         | AC-7               |
| RFC-321-T14 | `/account` 代码推送 tab/卡片、缓存隔离与 i18n                               | T6          | AC-1, AC-11        |
| RFC-321-T15 | Settings mapping 与 rebind/delete 影响确认 UX                               | T5,T8       | AC-4, AC-9, AC-11  |
| RFC-321-T16 | system-mock provider metadata + smart HTTP Git fixture                      | T7,T9       | AC-5, AC-6, AC-8   |
| RFC-321-T17 | backend/security/migration/upgrade 测试矩阵                                 | T3–T13,T16  | AC-1–AC-10         |
| RFC-321-T18 | frontend component/E2E/visual/a11y 证据                                     | T14,T15,T16 | AC-1, AC-3, AC-11  |
| RFC-321-T19 | 架构/源码棘轮与 AC 证据索引                                                 | T11–T18     | AC-12, AC-13       |
| RFC-321-T20 | 文档、一次 full gate、精确提交/推送、exact-SHA CI/visual                    | T19         | AC-14              |

## 2. 详细任务

### RFC-321-T1 — 现状 census 与终态边界

- 枚举所有生产 `git push/fetch/ls-remote` publication call sites，至少覆盖：task auto-push、
  non-FF repair、candidate delivery、conflict repair、submodule publication、post-verify。
- 区分 clone/background refresh 与 publication；本 RFC 不误收 clone read path。
- 冻结现有 global code-host token 与 cached repo URL credential 的所有 reader/writer。
- 建立机器可读 call-site ledger 或架构测试基线，后续 T19 将其收成“全部必须过 participant”。
- 重新核对 task owner、mission creator、schedule/event/child 的实际持久化传播。

退出：入口数、文件、调用状态及 intended owner 都有 exact source evidence；没有“可能还有一条”散文项。

### RFC-321-T2 — shared/domain contracts

- 为 `RepositoryTransportMappingV1`、账号 summary、个人 identity probe、connection mutation
  confirmation、稳定错误码写 strict schema 与 round-trip tests。
- token request schema 单独存在，不复用会被 log/serialize 的通用 settings DTO。
- clone endpoint candidate 与 publication receipt 使用 exact union，拒绝 `.passthrough()`。
- shared 类型不得出现 token ciphertext/helper env/public raw credential URL。

退出：positive/negative fixtures 全绿，invalid scheme/userinfo/host/path/tie mapping 均 fail closed。

### RFC-321-T3 — schema 与 migration

- 在实施时重新分配下一空 migration 编号。
- 给现存 code-host connection 生成 `connection_generation`。
- 创建 `repository_transport_connections`、`user_repository_transport_credentials`，以及若实现选择
  持久 cache 则创建 `repository_transport_endpoints`。
- 在 SQL migration 内复制现有 global ciphertext/hint；不把 token 输出到脚本/stdout。
- 加 composite PK/FK/CHECK/index；验证 upgrade、fresh install、重复 migration、secret.key 不可读分支。
- 更新 journal/snapshot/schema，不能覆盖 RFC-320 或其他并发 migration。

退出：旧数据库升级后 global projection 行数/密文/connection generation 对拍；个人表为空；legacy
`cached_repos.url_enc` 原样保留。

### RFC-321-T4 — source-control credential domain/repository

- 落 `CredentialSource(personal/global/legacy)`、binding、revision、stale 判据与 selector pure domain。
- SQLite repository 只返回 opaque refs/summary；unseal 留 infrastructure lease 边界。
- 个人 put/replace/delete 使用 expected generation/digest CAS。
- identity-access authority 只以 opaque ref 进入；source-control 不查 session/task/mission 表。
- selector truth-table test 锁死“只有 null absence 才 fallback”。

退出：domain/application tests 对所有 precedence/stale/concurrency 分支逐项绿。

### RFC-321-T5 — connection/global projection coordinator

- 把 connection create/update/delete 装配为 bootstrap-owned exact coordinator。
- 同一事务写 integration connection 与 source-control global projection。
- token-only rotation 递增 global revision，不删个人行。
- authority/mapping/TLS trust 改动执行 impact preflight + digest confirmation + 原子删除个人行/cache。
- delete 做相同确认；事务故障注入证明无半更新。
- 既有 code-host settings API 保持 token masking/PAT deny。

退出：每个事务阶段注入失败后两表都回到旧状态；并发 CAS 只允许一个 writer 成功。

### RFC-321-T6 — 本人账号 API

- 实现 GET/PUT/POST identity probe/DELETE typed command/query 与 Hono route adapter。
- route metadata 固定 session/self + `tokenAccess:'never'`；PAT 即使带全部 permission 也拒绝。
- request token 进入 one-shot seal input 后不被 logger/error/audit 序列化。
- read response 仅本人 hint/status；全局 token 只返回策略名称，不返回 hint/login。
- probe 可测试草稿或已保存个人 token，复用 Settings identity endpoint；缺失/stale/密文损坏均不回退
  global，成功只返回合法性与 login。
- 加限流、400/409/404 稳定错误与 replace/delete idempotency。

退出：Alice/Bob/admin/PAT/daemon/anonymous matrix 与 token canary leak scan 全绿。

### RFC-321-T7 — provider endpoint discovery

- integration 实现 GitHub repo metadata `clone_url`、GitLab project `http_url_to_repo` exact query。
- project path 编码复用 provider 现有规则，不把 `.git` 当项目名。
- adapter 只返回 candidate/unavailable union；不返回 provider body/client/header/token。
- 复用 global connection TLS/redirect/redaction；跨 authority redirect 剥 Authorization。
- 对 connection generation race 做返回前二次校验或 caller CAS。

退出：system mock happy/malformed/401/403/404/500/redirect cases 全绿。

### RFC-321-T8 — endpoint resolver

- 扩展 shared parser 的纯描述器，不改变现有 canonical URL provenance。
- 落 API candidate validation、typed mapping longest-prefix、tie reject、GitHub/GitLab SaaS exact fallback。
- HTTP(S) 输入去 userinfo 后重验；file fixture bypass；未知 managed SSH fail closed。
- 实现 endpoint digest、mapping normalize、connection rebind diff classifier。
- fuzz/property tests 覆盖 host suffix、port、path traversal、percent-encoding、Unicode/punycode。

退出：任意未允许 authority/path candidate 都不能得到 usable endpoint ref。

### RFC-321-T9 — credential file lease

- 把现有 helper 移入 source-control infrastructure，文件包含 exact target descriptor + secret。
- 文件 mode 0600、env 仅 path + terminal prompt guard；argv 只有 helper config，无 token。
- 启用 empty inherited helper 与 `credential.useHttpPath=true`。
- helper 对 protocol/host/port/path mismatch 输出空；不实现持久 store。
- `finally` cleanup；启动 orphan cleanup 只处理 app-home 中符合严格 name/owner/mode/age 的文件。

退出：token canary 在 git argv/env/config/log/worktree/API 全部零命中，临时文件生命周期测试全绿。

### RFC-321-T10 — publication participant

- 新建 source-control offered participant，完整持有 transport session。
- task publication：resolve push base、excluded history gate、push、auth/network/CAS 分类、non-FF
  fetch/merge/retry、post-verify。
- candidate publication：remote head CAS、幂等 tree/parent check、push、verify。
- selection/endpoint/lease 只做一次；所有 network calls 复用。
- receipt 只含 credential source/revision 与 redacted endpoint source，绝不含 secret/hint。

退出：故障注入证明任何 branch 都执行 close/cleanup；裸 Git callback 无法绕过 lease。

### RFC-321-T11 — task auto-push 接线

- task-execution adapter 从 task owner 取得 opaque subject，调用 source-control participant。
- `commitPushRunner` 只保留 task-owned orchestration/结果映射，或按 RFC-294 终态迁入相应 module。
- 删除 `setPushCredentialResolver/leasePushCredential` publication 双轨与 `start.ts` 装配。
- non-FF fetch 不再直接调用 `g(['fetch', remote,...])`。
- 保持 local-only commit、excluded history、repair retry 与用户可见状态合同。

退出：personal/global/legacy/file、non-FF、401/403/head-race targeted tests 全绿。

### RFC-321-T12 — candidate/conflict delivery 接线

- `deliverCandidate` 使用内部 transport session；`remoteUrl` 不再作为跨 context credential-bearing
  publication contract。
- development-automation adapter 以 mission `created_by` 解析 subject。
- conflict repair、retry、idempotent reuse 全部复用 same participant。
- 保持 expected remote SHA/tree/parent 与 never-force-push 语义。

退出：mission creator 与当前操作者不同时仍选 creator 凭据；认证失败不误报 remote-head-changed。

### RFC-321-T13 — submodule 隔离

- 枚举变更 submodule remote，逐一绑定 repository ref/provider/endpoint/credential。
- 父 token 对恶意/不同 host/path submodule helper request 零响应。
- 明确并测试 partial remote success receipt 与既有 fail-all caller behavior。
- 不把 `.gitmodules` 永久改写为 HTTP(S)。

退出：同 provider 不同 project、跨 provider、unknown SSH、credentialless public submodule 全覆盖。

### RFC-321-T14 — 账号页 UX

- 新增独立 `/account?section=codePush` panel，不把远端凭据混入平台 PAT tab；按用户追加要求，把
  RFC-320 的提交身份展示卡作为独立兄弟卡移入同一页签，但不合并两者的 API/存储合同。
- 保存/替换/delete/empty/stale/connection missing/loading/error 状态。
- password input 永不回填；成功后只显示末四位；明确 precedence 与 scope 提示。
- 增加“校验 token”动作与 success/error 状态，显示 token 合法性和对应平台用户；输入变化立即清除旧结果。
- query key 包含 identity epoch，logout/login remove cache。
- 中英文、390px、键盘、a11y、light/dark。

退出：component tests + Alice→Bob browser cache isolation + visual baselines 全绿。

### RFC-321-T15 — Settings 影响确认 UX

- connection mapping editor 支持 typed SSH authority/path prefix → HTTP base；显示转换预览与冲突错误。
- rebind/delete ConfirmDialog 显示个人凭据影响 count 和不可恢复说明。
- CAS 409 刷新 count/digest 后要求重新确认，不暗中重试。
- token-only rotation 不弹 revocation dialog。

退出：admin existing create/test/update/delete compatibility 与普通用户不可见/不可调用均绿。

### RFC-321-T16 — system mocks / 真 Git HTTP

- 扩展 GitHub/GitLab mock metadata 响应字段及恶意 fault variants。
- 建立最小 smart HTTP Git receive-pack fixture，能区分 personal/global credential canary。
- 支持 remote head race、401、403、redirect、post-push mismatch、submodule multiple remotes。
- fixture 日志自身也必须 redacted；测试可通过安全 identity label 断言，不能 dump Authorization。

退出：同一旅程从 SSH 输入到真实 `git push` 成功，且 mock 证明只收到预期 credential source。

### RFC-321-T17 — backend/security 矩阵

- 汇总 T2–T13 targeted tests，补 migration/upgrade/rolling/recovery。
- 覆盖 secret.key 损坏、lease cleanup、daemon restart orphan cleanup、concurrent rotation/delete。
- 覆盖 identity probe 草稿/已保存/401、token 不回显，以及个人缺失时 global token 零调用。
- 对所有拒绝/禁用分支给正向同等级测试。
- token canary 全仓日志/API/worktree/git-config scan。

退出：AC-1–AC-10 每条至少一条可复跑测试证据，测试名/文件/断言登记到证据索引。

### RFC-321-T18 — browser/E2E/visual

- 真 session 保存个人 token、reload masking、replace/delete/fallback。
- PAT with maximal grants 调账号路由仍拒绝。
- Alice/Bob 缓存与网络副作用隔离；admin settings 兼容。
- task auto-push 与 mission candidate 各一条 SSH→HTTP real-chain。
- desktop/390px、light/dark、Chromium/WebKit（按现有 visual policy）与 axe。

退出：无 skipped happy path；视觉截图与 test journal 能归因到本 RFC candidate。

### RFC-321-T19 — 棘轮与证据闭环

- 架构守卫锁 public surface secret-free、source-control owner、禁止 legacy 新 facade。
- call-site ledger 逐字要求所有 publication Git network calls 经 participant。
- 锁定 MR/评论/审批/流水线 REST 仍只用 global connection，personal subject 只可进入 Git publication
  与账号本人显式 identity probe。
- mutation fixture 证明移除 helper target binding、允许 personal→global retry、放宽 tokenAccess、把 token
  拼 URL 任一变化会转红。
- 建立 AC-1–AC-14 → test/file/behavior evidence table；零 unmapped AC/Task。
- 若新增机器账本，必须接入 RFC-317 guard manifest/ledger baseline，不建立游离账本。

退出：守卫自证、账本完备与 AC 映射测试全绿。

### RFC-321-T20 — 收口与发布

- 更新 RFC 状态、STATE、design/plan、用户/管理员文档、灾备说明（secret.key 丢失需重录）。
- 遵循用户 2026-08-24 的明确发布裁决：不在本地运行任何 `bun` 测试、类型检查、构建、gate 或 E2E，
  最终候选只以 GitHub 上包含最终提交 SHA 的托管 CI/visual 终态验收。
- 进入短 publication critical section：fetch、确认同步、cached index 为空、精确路径 stage、审 staged diff/
  message/co-author、commit、fetch/sync、push、验证远端 ancestry。
- 以 exact SHA 等 hosted CI/visual terminal result；cancelled 不是绿色，含 successor 必须证明包含该 SHA。

退出：静态 candidate evidence、remote SHA、CI/visual terminal attribution、并发文件说明完整。

## 3. 建议提交批次

RFC 默认一个交付单元，但可用下列小 commit 降低共享 main 风险；每批都必须可独立编译/测试，不能把
不安全默认暂时留在 main：

1. `docs(rfc): RFC-321 proposal/design/plan and phase gate`（Phase 2 开工前只允许此批）
2. `feat(source-control): RFC-321 credential contracts and storage`
3. `feat(source-control): RFC-321 endpoint resolution and credential lease`
4. `feat(source-control): RFC-321 unify publication transports`
5. `feat(account): RFC-321 personal code-host push credentials`
6. `test(e2e): RFC-321 managed SSH-to-HTTPS publication`
7. `docs(rfc): RFC-321 close evidence and status`

如果共享文件同时包含其他会话的当前输出，提交完整文件时必须保留全部 hunks，并在 handoff 明示；不得
通过 restore/reset/stash/临时删除制造“纯净”提交。

## 4. 预期触及范围（实现前重新核对）

```text
design/RFC-321-user-code-host-push-credentials/**
design/plan.md
STATE.md
packages/shared/src/git-url.ts
packages/shared/src/schemas/**code-host**
packages/backend/db/migrations/**
packages/backend/src/db/schema.ts
packages/backend/src/modules/source-control/**
packages/backend/src/modules/integration/**
packages/backend/src/modules/task-execution/**
packages/backend/src/modules/development-automation/**
packages/backend/src/routes/codeHosts.ts
packages/backend/src/routes/account*.ts
packages/backend/src/cli/start.ts
packages/backend/src/services/gitCredential.ts
packages/backend/src/services/commitPushRunner.ts
packages/frontend/src/routes/account.tsx
packages/frontend/src/components/account/**
packages/frontend/src/components/settings/CodeHostsSection.tsx
packages/frontend/src/i18n/{zh-CN,en-US}.ts
packages/system-mocks/src/code-host/**
packages/**/tests/**rfc321**
e2e/**rfc321**
architecture/**
docs/**
```

这不是 staging allowlist。T1 后必须以真实 diff 生成精确 allowlist；任何意外 staged path 都阻断 commit。

## 5. AC → Task 映射

| AC    | Tasks                   |
| ----- | ----------------------- |
| AC-1  | T2,T4,T6,T14,T17,T18    |
| AC-2  | T4,T5,T17               |
| AC-3  | T4,T11,T12,T17,T18      |
| AC-4  | T2,T7,T8,T15,T17        |
| AC-5  | T7,T8,T16,T17           |
| AC-6  | T10,T11,T12,T16,T17,T18 |
| AC-7  | T13,T16,T17             |
| AC-8  | T6,T9,T10,T16,T17       |
| AC-9  | T3,T5,T10,T17           |
| AC-10 | T3,T8,T11,T17           |
| AC-11 | T14,T15,T18             |
| AC-12 | T1,T4,T10,T19           |
| AC-13 | T1,T6,T9,T11,T19        |
| AC-14 | T17,T18,T19,T20         |

反向检查：T1–T20 每项至少映射一个 AC；AC-1–AC-14 每项至少有实现、正向验证和拒绝分支证据。

## 6. 当前下一步

RFC-321 实现与既有 targeted E2E/visual 证据已闭合。保持 RFC-320 后端范围不动，直接进入共享 `main`
精确 staging、提交与推送，不运行任何本地 `bun` 验证；托管结果只按包含本提交的 exact SHA 归因，
Linux visual 缺失时按仓库基线流程从 Ubuntu artifact 人工验图后补齐。
