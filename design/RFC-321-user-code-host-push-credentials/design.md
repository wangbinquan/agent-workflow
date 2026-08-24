# RFC-321 — 技术设计：用户级代码平台推送凭据与 SSH→HTTP(S) 传输解析

- 状态：Implemented / Phase 2；等待 exact-SHA hosted CI/visual 终态
- 实施边界：只接管 repository push credential/transport；RFC-320 后端合同不由本会话修改
- 产品裁决：以 `proposal.md §5 C1–C14`、`§6 I1–I8` 与追加裁决 S1 为准

## 0. 设计不变量

| 编号 | 不变量                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| I-1  | credential subject 来自持久化工作归属，不来自 push 时的 HTTP session、当前操作者或 agent。                                       |
| I-2  | 只有“个人记录不存在”才能选择公共凭据；认证失败、授权失败、stale、endpoint 不可信都不能触发身份回退。                             |
| I-3  | token 不进入 Git URL、argv、普通 env、Git config、agent 进程、prompt、日志、WebSocket、API response。                            |
| I-4  | 一笔 publication 的全部网络命令固定同一 endpoint、credential source 与 credential revision。                                     |
| I-5  | helper 只响应 exact protocol + host + port + path-prefix，submodule 不能继承父 remote 的凭据。                                   |
| I-6  | SSH→HTTP(S) 没有通用推导；只有 provider API、管理员 mapping、内置 SaaS 约定三类有证据来源。                                      |
| I-7  | source-control 独占 Git transport/credential 使用；integration 独占 provider REST API；identity-access 独占请求/用户 authority。 |
| I-8  | public contracts 只传 opaque refs、安全 endpoint candidate 与 receipt；不传 token/header/env/helper callback/vendor client。     |
| I-9  | 原始 remote 是 provenance，不因发布转换被覆盖；每次 HTTP(S) endpoint 都是临时 publication target。                               |
| I-10 | commit identity 与 push authentication 正交；任何 token 元数据都不得回写任务 Git identity。                                      |

## 0A. 与 RFC-320 的阶段边界

```text
Phase 1 / RFC-320
users profile ──task create snapshot──> Git author/committer
                 │
                 └─ 完成并稳定后开放 Phase 2
                                      │
Phase 2 / RFC-321                     ▼
task/mission owner ──credential selector──> Git remote authentication + transport
```

- RFC-320 owns：`users.display_name/email`、OIDC profile refresh、task Git identity snapshot、
  author/committer 注入。
- RFC-321 owns：user/global repository transport credential、SSH→HTTP(S) endpoint、platform-owned
  publication transaction。
- RFC-321 只读取工作归属 user ref；不读取/修改 RFC-320 的 display name/email，不把 token login
  反写 profile。
- 两者会在 DB schema、migration journal、account route/UI、i18n 与 task publication 接缝出现物理文件
  重叠。S1 要求串行，不以“逻辑正交”为理由并行写这些文件。
- RFC-320 C8 在 Phase 1 内继续成立；Phase 2 的变更只在 RFC-321 自己的 AC/测试下生效。

## 1. 现状调用链与必须一并收口的缺口

### 1.1 URL 与 provider 识别

- `packages/shared/src/git-url.ts#parseGitUrl` 已解析 `ssh://user@host[:port]/path`、
  SCP-like `user@host:path`、HTTP(S) 与 file URL；当前没有 SSH→HTTP 转换。
- `modules/integration/composition/codeHostEffects.ts#matchRepoProvider` 已能用 connection 的
  repository prefixes、base URL host、GitHub.com/GitLab.com 兜底，把 SSH/HTTP remote 识别成
  `{ provider, project }`。它只做绑定，不返回 clone endpoint。
- canonical Git URL 有意保留 transport 差异，因此不能修改 canonical key 让 SSH/HTTPS 假装成同一
  原始来源；publication endpoint 必须是独立投影。

### 1.2 当前全局代码平台凭据

`code_host_connections` 每 provider 一行，保存 normalized API base URL、GitLab repository prefixes、
TLS 策略、密封 token、末四位与测试结果。`services/codeHost/connections.ts#resolve` 会在 REST 调用边界
短暂解封 token；路由为 settings admin + `tokenAccess:'never'`。

本 RFC 不让 source-control 直接查询 integration-owned 表。管理员保存 connection 时，由 bootstrap
唯一装配的跨 context coordinator 在同一事务写：

1. integration-owned `code_host_connections`；
2. source-control-owned、仅用于 Git transport 的 global credential projection。

两边是同一用户输入的两个用途投影，不产生第二个 UI token 字段；轮换/删除必须原子成功或原子回滚。

### 1.3 当前 task 自动 push

启动装配中的 `setPushCredentialResolver` 通过 `task.cached_repo_id` 解封
`cached_repos.url_enc`。`commitPushRunner.ts` 只在 publication participant 的 push 上调用
`leasePushCredential(taskId)`；non-fast-forward 分支随后执行的裸 `fetch` 没有 lease。

终态删除“按 taskId 返回 URL”的 resolver 和 legacy service-level credential facade。task execution
通过 required port 调用 source-control offered publication participant；credential 选择、HTTP endpoint、
repair fetch 与 push 都留在 source-control 内部。

### 1.4 当前数字员工 candidate delivery

`modules/source-control/application/deliverCandidate.ts#pushCandidate` 当前依次执行：

1. `ls-remote` 读取 remote head；
2. 幂等重放时 fetch remote SHA 并对拍 tree/parent；
3. push candidate；
4. 再 `ls-remote` 确认。

四步都直接使用 `remoteUrl`，没有 credential lease。该文件已在 source-control application，本 RFC
把它迁到新的内部 transport session，而不是另给 development-automation 添加凭据参数。

### 1.5 submodule 与 conflict repair

父仓与每个 submodule 都有独立 remote。终态 publication planner 先产生 target 列表，再逐 target
创建独立 transport session。conflict repair、candidate retry、task non-FF repair 只能调用同一内部
session API；架构守卫禁止在这些路径直接拼 `git fetch/push/ls-remote <url>`。

## 2. RFC-294 落位

### 2.1 bounded context 所有权

| Context                  | 本 RFC 所有权                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `identity-access`        | 提供 `AuthorizationSubjectRef`、登录会话的 self-service authority；不保存代码平台 token，不决定 remote。                                |
| `integration`            | 管理 code-host connection、用全局 token 调 provider API 获取 repository clone metadata；只返回无 userinfo 的 endpoint candidate。       |
| `source-control`         | 保存个人/global Git transport credential projection、验证 endpoint、执行凭据选择、创建 helper、完成 Git publication、产出脱敏 receipt。 |
| `task-execution`         | 给 source-control adapter 提供 task owner subject、workspace/repository opaque ref、branch/expected head；不接触 token/URL/helper。     |
| `development-automation` | 给 `RepositoryDeliveryPort` 提供 mission creator subject 与 candidate delivery intent；不接触 token/URL/helper。                        |
| bootstrap composition    | 唯一装配跨 context adapter；原子协调 connection 与 global credential projection；不新增横向 `services/` facade。                        |

### 2.2 模块目录

新增/迁移代码目标形状：

```text
packages/backend/src/modules/source-control/
├── domain/
│   ├── repositoryTransportCredential.ts
│   ├── repositoryTransportEndpoint.ts
│   └── publicationReceipt.ts
├── application/
│   ├── commands/
│   │   ├── putOwnCodeHostPushCredential.ts
│   │   ├── deleteOwnCodeHostPushCredential.ts
│   │   └── syncGlobalCodeHostPushCredential.ts
│   ├── queries/getOwnCodeHostPushCredentialSummaries.ts
│   ├── repositoryTransportSession.ts
│   ├── publishTaskCommit.ts
│   └── deliverCandidate.ts
├── ports/
│   ├── repositoryTransportCredentialRepository.ts
│   ├── repositoryEndpointDiscovery.ts
│   ├── repositoryGitTransport.ts
│   └── credentialFileLease.ts
├── infrastructure/
│   ├── sqliteRepositoryTransportCredentialRepository.ts
│   ├── gitCredentialFileLease.ts
│   └── gitRepositoryTransport.ts
└── public/
    ├── commands.ts
    ├── queries.ts
    ├── participants.ts
    └── types.ts
```

实际文件可按仓内命名规范微调，但不得重新落回 `services/gitCredential.ts`、
`services/commitPushRunner.ts` 的第二套新逻辑。旧入口在同一 RFC 内收成 adapter 或删除。

### 2.3 public surface

source-control 对外只暴露：

- self-service 的 typed command/query；
- task/development-automation 所需的 purpose-specific publication participant；
- opaque `RepositoryRef / RepositoryTransportCredentialRef / RepositoryPublicationRef`；
- 脱敏 receipt 与稳定失败 code。

不暴露：token、ciphertext、token hint（publication caller 也不需要）、HTTP Authorization header、
credential helper argv/env、absolute credential file path、raw DB row、vendor client。

本 RFC 无 RFC-294 架构偏离。唯一跨域写事务由 bootstrap coordinator 装配两个 exact participant；
业务模块不互相 import internal/application/infrastructure。

## 3. 数据模型

迁移编号在实现临界区按最新 `_journal.json` 重新分配；本文不抢占并发 RFC 的 migration number。

### 3.1 connection generation

给 `code_host_connections` 增加：

```text
connection_generation TEXT NOT NULL
```

- 现存行 migration 生成一次 ULID；
- token-only update 保持 generation；
- authority/base URL/repository transport mapping/TLS trust boundary 更新保持逻辑 connection，但会
  产生新的 endpoint digest；
- delete + recreate 必须生成新 generation。

`endpoint_binding_digest` 不直接存为 integration 真源，可由下列 canonical JSON 计算 SHA-256：

```json
{
  "version": 1,
  "provider": "gitlab",
  "connectionGeneration": "...",
  "apiBaseUrl": "https://gitlab.example/api/v4",
  "rejectUnauthorized": true,
  "transportMappings": [
    {
      "sshAuthority": "ssh.example:22",
      "sshPathPrefix": "team",
      "httpBaseUrl": "https://gitlab.example/git/team"
    }
  ]
}
```

数组先按最长 path prefix、authority、base URL 排序后再 canonicalize；digest 不能包含 token、hint、
updatedBy 或 timestamp。

### 3.2 source-control global projection

新增 `repository_transport_connections`（source-control owner）：

| 列                        | 约束/用途                                                               |
| ------------------------- | ----------------------------------------------------------------------- |
| `provider`                | `gitlab/github` primary key；当前 connection cardinality 与既有设置一致 |
| `connection_generation`   | 与 integration connection 同事务同步                                    |
| `endpoint_binding_digest` | trust-boundary CAS                                                      |
| `transport_mappings_json` | normalized、无 secret 的 source-control projection                      |
| `global_token_enc`        | secretBox sealed；只由 source-control infrastructure 解封               |
| `global_token_hint`       | 设置页可用；账号页/publication caller 不返回                            |
| `credential_revision`     | 单调整数；token-only rotation 递增                                      |
| `updated_at/updated_by`   | 审计                                                                    |

现存 `code_host_connections.token_enc/token_hint` 在 migration 内复制为 projection 初值；因为两列都用
同一个 secretBox 格式，不需要在 migration 中暴露明文。实现后每次 admin create/update/delete 都由
coordinator 同事务维护两份投影。

### 3.3 用户凭据

新增 `user_repository_transport_credentials`：

| 列                        | 约束/用途                                      |
| ------------------------- | ---------------------------------------------- |
| `user_id`                 | FK `users.id` ON DELETE CASCADE                |
| `provider`                | `gitlab/github`                                |
| `connection_generation`   | 保存时冻结，必须等于当前 connection            |
| `endpoint_binding_digest` | 保存时冻结，使用时必须等于当前 projection      |
| `token_enc`               | secretBox sealed                               |
| `token_hint`              | 末四位；仅本人账号 summary 返回                |
| `credential_revision`     | 从 1 单调递增；replace 递增，不复用旧 revision |
| `created_at/updated_at`   | UI/审计                                        |

主键 `(user_id, provider)`。token 长度采用宽而有限的合同（建议 8–4096 bytes），不按前缀猜 token
类型，也不在保存时声称已验证 repository write 权限。

保存事务必须同时验证：

1. user 仍 active 且 command authority 是本人；
2. connection 存在；
3. 请求携带的 generation/digest 与当前值一致；
4. token input 只被 seal sink 消费一次；
5. response 只有 summary。

### 3.4 endpoint cache（可选持久投影，不是授权事实）

provider API 成功返回 clone URL 后可写 `repository_transport_endpoints`：

| 列                                                               | 用途                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `repository_key`                                                 | source-control canonical opaque key/hash，不存 credential-bearing URL |
| `provider` / `connection_generation` / `endpoint_binding_digest` | 绑定来源                                                              |
| `http_url_redacted`                                              | 已验证、无 userinfo 的 HTTP(S) URL                                    |
| `source`                                                         | `provider-api/admin-mapping/saas-convention`                          |
| `resolved_at`                                                    | 缓存诊断                                                              |

缓存命中仍须重验 scheme/authority/path 和当前 digest；缓存失效不影响 mapping/SaaS fallback。该表不是
credential admission 输入，也不能让旧 generation endpoint 复活。

### 3.5 删除/改址语义

- token-only admin update：同事务更新 integration token 与 global projection revision；不删个人行。
- authority/base URL/mapping/TLS trust 改动：若存在个人行，第一次 update 返回
  `code-host-transport-rebind-confirmation-required`，含 count 与一次性 impact digest；确认请求在同一
  事务更新 connection/projection、删除个人行、失效 endpoint cache。
- delete connection：使用同样确认合同，删除 integration row、global projection、个人行与 endpoint
  cache。明文 token 不可恢复。
- 并发时 impact digest 或 expected generation 不一致返回 409，UI 必须刷新并重新确认。

## 4. HTTP API 合同

### 4.1 本人账号凭据

建议路由：

```text
GET    /api/account/code-host-push-credentials
PUT    /api/account/code-host-push-credentials/:provider
POST   /api/account/code-host-push-credentials/:provider/test
DELETE /api/account/code-host-push-credentials/:provider
```

四条路由要求登录 session、`account:self`，且 registry metadata 固定 `tokenAccess:'never'`；PAT、daemon
token、匿名均不能调用。PUT body：

```ts
interface PutOwnCodeHostPushCredentialRequest {
  token: string
  connectionGeneration: string
  endpointBindingDigest: string
}
```

route adapter 在 schema 校验后立刻构造 one-shot seal input；不得把 request body 交给通用 logger、
error serializer 或 audit payload。

POST identity probe body：

```ts
interface TestOwnCodeHostPushCredentialRequest {
  token?: string // 有值时只用于本次探测；省略时测试已保存的个人 token
  connectionGeneration: string
  endpointBindingDigest: string
}
```

它复用 Settings 连接测试的 provider identity endpoint 与分类结果，成功仅返回
`{ ok:true, at, login }`，失败返回 `{ ok:false, at, code, message }`。省略 token 且个人记录不存在时返回
`code-host-push-credential-unavailable`，绝不改测 global projection；草稿 token 不保存，任何响应不回显
token。该显式本人探测是 C7 的唯一个人-token REST 例外，不进入 MR/评论/审批/流水线业务调用。

GET/PUT wire：

```ts
interface OwnCodeHostPushCredentialSummary {
  provider: 'gitlab' | 'github'
  displayBaseUrl: string
  connectionGeneration: string
  endpointBindingDigest: string
  configured: boolean
  tokenHint: string | null
  updatedAt: number | null
  stale: boolean
  fallback: 'platform-global' | 'legacy-transport-unmanaged'
}
```

`fallback` 是策略描述，不证明公共 token 可写某个具体仓库。summary 响应不返回 global token
hint/login、个人 token login、scope 或密文；只有本人显式 identity probe 返回该次探测对应的 login。

### 4.2 管理员 connection API 扩展

现有 code-host PUT/DELETE 增加可选：

```ts
interface CodeHostConnectionMutationConfirmation {
  expectedConnectionGeneration?: string
  confirmCredentialRevocationDigest?: string
}
```

安全 read model 可增加 `personalPushCredentialCount`，用于确认影响；不返回用户列表或 hints。token-only
update 不需要确认。连接测试仍是 REST connectivity test，不冒充 Git push 权限测试。

### 4.3 稳定错误码

| code                                               | HTTP/业务语义                                          |
| -------------------------------------------------- | ------------------------------------------------------ |
| `code-host-push-credential-invalid`                | 400；token 输入不满足基本合同                          |
| `code-host-push-credential-connection-missing`     | 409；provider 尚无连接                                 |
| `code-host-push-credential-stale`                  | 409；保存/使用时 generation 或 digest 已变化           |
| `code-host-transport-rebind-confirmation-required` | 409；管理员改址/删除需确认影响                         |
| `repository-http-endpoint-unresolved`              | publication failed；受管 token 无可信 HTTP(S) endpoint |
| `repository-http-endpoint-untrusted`               | publication failed；API/mapping 返回越界 endpoint      |
| `repository-push-authentication-failed`            | publication failed；401/credential rejection，不回退   |
| `repository-push-authorization-failed`             | publication failed；403/无 write permission，不回退    |
| `repository-push-remote-changed`                   | 既有 CAS/head race，不与 auth 混淆                     |

所有 detail 先经过现有 `redactSensitiveString`/Git URL redaction，provider body 只留有限状态摘要。

## 5. endpoint 解析

### 5.1 输入规范化

复用并扩展 shared `parseGitUrl`，输出不可变 descriptor：

```ts
type RepositoryRemoteDescriptor =
  | { transport: 'ssh'; host: string; port: number | null; path: string }
  | { transport: 'http'; scheme: 'http' | 'https'; host: string; port: number | null; path: string }
  | { transport: 'file'; pathRef: OpaqueLocalFixtureRef }
```

规范化只做：host lowercase、default port folding、首尾 slash、单个 `.git` suffix。不得 decode 后重编码
改变 namespace 语义，也不得把 HTTP/SSH canonical provenance 合并。

### 5.2 provider API candidate

source-control 定义窄 `RepositoryEndpointDiscoveryPort`，bootstrap adapter 调 integration 的 provider
query。输入只有 provider/project/connection generation；integration 内部使用全局 API token：

- GitHub：`GET /repos/{owner}/{repo}`，取 `clone_url`；
- GitLab：`GET /projects/{urlEncodedPath}`，取 `http_url_to_repo`。

返回：

```ts
interface RepositoryEndpointCandidate {
  provider: 'gitlab' | 'github'
  project: string
  connectionGeneration: string
  url: string // provider response，必须尚未信任
  source: 'provider-api'
}
```

adapter 不返回 API token/header/vendor client/response body。source-control 必须独立验证 candidate；
integration 的“请求成功”不是 authority 证明。

### 5.3 source-control 验证

candidate 只有同时满足下列条件才可使用：

1. scheme 为 `https`；仅管理员 mapping 显式允许时接受 `http`；
2. URL 无 userinfo、fragment、query；
3. normalized project path 与输入 remote 的 project 身份一致；
4. authority 位于 connection projection 的 allowlist；
5. connection generation/digest 仍为当前值；
6. custom port 与 mapping/API 返回的 HTTP authority 一致，绝不复用 SSH port；
7. redirect 后若 authority/path 越界，credential helper 拒绝应答并归类 endpoint untrusted/auth failure。

### 5.4 管理员 mapping

把既有 GitLab-only `repositoryUrlPrefixes` 升级为两 provider 可用的 typed mapping，同时保留旧 wire
兼容读取并迁移为等价条目：

```ts
interface RepositoryTransportMappingV1 {
  sshHost: string
  sshPort?: number
  sshPathPrefix?: string
  httpBaseUrl: string
}
```

匹配按 `ssh authority exact + longest path prefix`；同长度多命中为配置错误，不按数组顺序暗选。
拼接后再走 §5.3 验证。管理员 UI 显示示例转换预览。

### 5.5 SaaS fallback

只有两个内置规则：

```text
git@github.com:<path>[.git] → https://github.com/<path>.git
git@gitlab.com:<path>[.git] → https://gitlab.com/<path>.git
```

`ssh://` 的自定义 port 不影响 SaaS HTTPS 443，但 host 必须 exact；`www.`、相似后缀、Unicode/punycode
混淆域名都不命中。其他 host 没有字符串替换 fallback。

### 5.6 已是 HTTP(S) remote

- 若选择受管 token：去掉任何 userinfo，验证 exact connection mapping 后作为临时 endpoint；
- 若未选择受管 token：保持现有 legacy URL credential lease；
- file/bare fixture：永远走 local adapter，不进入 provider/token 选择。

## 6. credential subject 与选择算法

### 6.1 subject

调用侧只能传 identity-access 颁发的 opaque subject：

| 工作                                            | subject 来源                                             |
| ----------------------------------------------- | -------------------------------------------------------- |
| task 自动 commit/push                           | `tasks.owner_user_id` 对应的 `AuthorizationSubjectRef`   |
| scheduled/event launch task                     | schedule/rule owner 创建 task 后仍取 task owner          |
| child task                                      | 既有 owner 传播后的 child task owner；不取 system worker |
| development mission candidate/conflict delivery | `development_missions.created_by`                        |
| null/system legacy                              | `SystemPublicationSubjectRef`，跳过个人层                |

source-control 不自己查 task/mission 表。task-execution/development-automation infrastructure adapter 在各自
域内解析 owner，再传 opaque subject。无效/disabled subject 按既有 work admission/authorization 规则失败。

### 6.2 选择伪代码

```ts
function selectCredential(subject, binding): Selection {
  if (subject.kind === 'user') {
    const personal = personalRepo.find(subject.userRef, binding.provider)
    if (personal !== null) {
      assertSameGenerationAndDigest(personal, binding) // stale => fail，非 absent
      return { source: 'personal', ref: personal.ref, revision: personal.revision }
    }
  }

  const global = globalProjection.find(binding.provider)
  if (global !== null) {
    assertSameGenerationAndDigest(global, binding)
    return { source: 'global', ref: global.ref, revision: global.revision }
  }

  return { source: 'legacy' }
}
```

只有 DB 查询得到 `null` 才是 absence。unseal 失败、row stale、helper refusal、HTTP 401/403、provider 404、
network error 都是已选分支失败，不能继续运行 selector。

### 6.3 选择时点与并发

publication attempt 开始时在一个短事务读取 connection binding、personal/global revision，并生成不可
序列化的 internal selection ref。事务关闭后才做网络 I/O。infrastructure 随后解封并创建 lease；
replace/delete 的并发更新不会改变已创建 lease，下一次 attempt 会读取新 revision。

审计 receipt 记录：provider、credential source、subject ref 的安全审计 ID、credential revision、endpoint
source、redacted authority、结果、耗时。receipt 不记录 hint/token/path query/HTTP body。

### 6.4 唯一供给入口与 REST 边界

- 所有平台拥有的 Git publication 只通过 source-control composition 的
  `RepositoryTransportCredentials.resolveExecution(subject, provider)` 完成 personal/global 选择与解封；
  task/candidate/conflict/submodule 等调用点只传 subject，不得各自读取 token。
- MR/评论/审批/流水线与 workflow `code-host-call` 继续只通过既有
  `CodeHostConnectionsService.resolve(provider)` 读取平台公共 connection；这些端口不携带
  `RepositoryCredentialSubject`，防止个人 token 越过 C7。
- 账号页校验只通过同一 source-control service 的 `resolvePersonalForTest` 取得草稿或已保存个人 token；
  缺失、stale、密文损坏均 fail closed，不调用 global resolver。
- 架构棘轮同时锁定上述正向入口与禁止边界，避免新增调用点靠散布式适配悄悄漏接或越权。

## 7. 一次性 credential lease

### 7.1 文件内容与权限

现有 helper 从 `0600` 文件读取 username/password。本 RFC 把约束 descriptor 也放入同一临时文件，
普通 env 仅保留文件路径与 `GIT_TERMINAL_PROMPT=0`：

```json
{
  "version": 1,
  "protocol": "https",
  "host": "gitlab.example",
  "port": 443,
  "pathPrefix": "group/project.git",
  "username": "oauth2",
  "password": "<token>"
}
```

GitHub username 使用固定 `x-access-token`，GitLab 使用固定 `oauth2`；两者只作为 HTTP Basic 的非空
用户名，授权事实是 password token。若后续 provider 引入必须指定 username 的 credential 类型，另立 RFC
扩展合同，不从 token 内容猜测。

helper 只实现 `get`，且仅当 Git 提供的 protocol/host/port/path 位于 exact binding 时输出 credential。
启用：

```text
-c credential.helper=
-c credential.helper=<agent-workflow helper>
-c credential.useHttpPath=true
```

不得继承系统 credential manager；不得 `store/approve/reject` 回写 token。`cleanup()` 在所有成功、失败、
throw、cancel 分支的 `finally` 调用。

### 7.2 transport session

`RepositoryTransportSession` 是 source-control application 内部、仅内存对象：

```ts
interface RepositoryTransportSession {
  readonly publicationRef: RepositoryPublicationRef
  lsRemote(branch: string): Promise<RemoteHeadResult>
  fetch(ref: string): Promise<FetchResult>
  push(spec: CasPushSpec): Promise<PushResult>
  verify(branch: string, expectedSha: string): Promise<VerifyResult>
  close(): Promise<void>
}
```

它不出现在 `public/`。对外 offered participant 接收完整 publication intent 并在内部 `try/finally`
创建/关闭 session，从结构上保证调用者无法“漏传 lease”。

### 7.3 publication participant

对 task-execution：

```ts
interface RepositoryTaskPublicationParticipant {
  publishTaskCommit(input: {
    workspaceRef: WorkspaceRef
    repositoryRef: RepositoryRef
    subjectRef: AuthorizationSubjectRef | SystemPublicationSubjectRef
    branch: string
    baseSha: string
    tipSha: string
    maxRepairRetries: number
  }): Promise<TaskPublicationReceipt>
}
```

对 development-automation 的 adapter 继续实现其 required `RepositoryDeliveryPort`，内部调用
source-control candidate participant；不把 remote URL/token 加回 development-automation contract。

本 RFC 将 non-FF fetch/merge/re-push、candidate CAS、post-verify 一并移入 source-control application。
认证失败与 remote head race 使用不同结果 union，不能靠 stderr 模糊正则把 401 判成 CAS 竞争。

### 7.4 submodule

publication planner 对每个变更 submodule 产生：

```ts
{
  ;(repositoryRef, observedRemoteDescriptor, targetCommit, subjectRef)
}
```

随后各自执行 §5/§6/§7。父 session 只协调顺序和整体 receipt，不共享 credential file。若任一子仓
失败，保持既有 fail-all publication 语义；已经推送的远端不能伪装成回滚，receipt 必须列出成功/失败
target 的脱敏 refs 供恢复。

## 8. integration provider lookup

### 8.1 exact query

integration public query建议：

```ts
interface ResolveCodeHostRepositoryCloneEndpoint {
  execute(input: {
    provider: 'gitlab' | 'github'
    project: string
    connectionGeneration: string
  }): Promise<
    | { kind: 'resolved'; candidate: RepositoryEndpointCandidate }
    | { kind: 'unavailable'; reason: 'not-found' | 'forbidden' | 'network' | 'invalid-response' }
  >
}
```

该 query 使用 integration 自己的 global API credential，不使用个人 push token。`unavailable` 不是
publication 失败本身；source-control 仍可尝试管理员 mapping/SaaS fallback。provider 响应体不跨 context。

### 8.2 防 token 越界

- lookup 只访问 connection base URL；沿用现有 TLS/rejectUnauthorized 策略；
- redirects 复用现有 code-host outbound allowlist，跨 authority 剥离 Authorization；
- clone URL candidate 即便来自可信 API也按 §5.3 重验；
- 个人 token 永不用于 repository metadata/API lookup；仅账号本人主动的 identity probe 访问 `/user`，
  因此 `write_repository`/Contents write 的最小权限 token 只需同时允许读取自身身份。

## 9. UI 设计

### 9.1 账号页

`/account` 新增独立 tab（建议 route value `code-push`，中文“代码推送”，英文“Code push”），组件独立为
`AccountCodeHostPushCredentialsPanel`，不把字段塞进 RFC-320 正在改动的
`AccountOverviewPanel`。

每 connection 一张 Card：

- provider icon/name、安全 display base URL；
- `未配置 / 已配置 ·•••1234 / 连接已变化需重新配置`；
- password input（永不回填明文）、保存/替换、删除；
- “校验 token”可测试草稿或服务端已保存值，并显示 token 合法性与对应代码平台用户；
- “个人优先；未配置时使用平台公共凭据”；
- scope 提示：GitLab repository write / GitHub Contents write；
- 明确说明不影响 commit author，也不用于 MR/PR API。

连接不存在时显示 EmptyState 与“请联系管理员配置代码平台”，不允许为未知 authority 先存一个游离 token。

### 9.2 Settings 连接影响确认

管理员修改 authority/mapping 或删除时，ConfirmDialog 展示：

- 会撤销的个人凭据数量；
- 不可恢复、用户需重新录入；
- token-only rotation 不触发该提示。

提交后若 CAS 409，dialog 保持打开并刷新 count/digest，不自动用旧确认重试。

### 9.3 缓存隔离

账号 credential query key 必须含 current user identity epoch；logout/login 切用户时 remove，而不是仅
invalidate。optimistic update 只能写当前用户 key，错误回滚不能把上一个用户 hint 恢复进来。

## 10. 安全与失败模式

| 失败                             | 处理                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| secret.key 更换/密文损坏         | 选中行 fail `credential-unavailable`；不退下一档；UI只显示需替换，不返回解密错误。 |
| 个人 token 401                   | `repository-push-authentication-failed`；不试 global。                             |
| 个人/global 403                  | `repository-push-authorization-failed`；提示 repository write scope；不回退。      |
| provider API 404/403/network     | 尝试 mapping/SaaS；仍无可信 endpoint 才 unresolved。                               |
| API 返回 credential-bearing URL  | untrusted；不落缓存、不执行 Git。                                                  |
| mapping 多重同优先级命中         | 配置错误；fail closed。                                                            |
| helper 收到另一 host/path 请求   | 输出空 credential + terminal prompt disabled，Git 失败并记录 endpoint mismatch。   |
| non-FF fetch 失败                | 保持 local commit/candidate receipt；错误按 auth/network/CAS 分类，不继续 merge。  |
| token 在 publication 中轮换      | 当前 lease 完成/失败；下一 attempt 使用新 revision。                               |
| daemon crash 留临时文件          | 启动时只清理符合 app-home 命名、owner/mode/age 全部满足的遗留文件；不扫宽目录。    |
| connection rebind 与个人保存并发 | generation/digest CAS 使一方 409；不能把旧 token 绑定到新 endpoint。               |

## 11. 迁移与兼容

1. 实现前重新读取最新 migration journal；分配下一空号。
2. 给现存 connection 生成 generation。
3. 创建 source-control projection/user credential tables；复制 global token ciphertext/hint。
4. 既有 `cached_repos.url_enc` 不改、不解密批处理；仅在 selector 走 legacy 时继续使用。
5. 既有 task/mission 不回填 credential ref；下一次 publication 按其持久化 owner/creator 与当前配置选择。
6. file/bare 测试 remote、未知 Git server、未配置 connection 的 SSH/URL 行为保持。
7. 同 RFC 把 `setPushCredentialResolver/leasePushCredential` 与裸 publication network calls 收口；不保留
   “新 participant + 旧 resolver”长期双轨。
8. migration rollback 只定义 schema/data 回退，不承诺恢复管理员已确认清除的个人 token。

## 12. 测试策略

### 12.1 shared/domain

- SSH URI/SCP-like/HTTP(S)/file descriptor；default/custom port；`.git` suffix；Unicode/混淆 host；
- mapping longest-prefix、tie reject、SaaS exact host；
- candidate URL scheme/userinfo/query/fragment/authority/path validation；
- selector truth table，尤其“absent 才 fallback”。

### 12.2 backend application/infrastructure

- personal CRUD/identity probe self-only、PAT denied、masking、seal failure、CAS；
- probe 覆盖草稿、已保存、401/403/network/bad response、缺失个人记录不回退 global；
- connection create/update/token-rotate/rebind/delete 的双投影原子性与 impact confirmation；
- helper exact protocol/host/port/path 与 0600/cleanup；
- task/candidate/non-FF/conflict/submodule 全链同 revision；
- error classifier 区分 auth/authorization/network/head race；
- daemon crash orphan cleanup 的窄目标测试。

### 12.3 provider/system mocks

- GitHub `clone_url`、GitLab `http_url_to_repo` happy path；
- API 401/403/404/500、malformed/cross-host/userinfo clone URL；
- API unavailable → mapping → SaaS fallback；
- smart HTTP Git fixture 真实执行 credential challenge、receive-pack、remote advance 与 post-verify；
- 断言个人失败后 mock 没有收到第二个 global credential 请求。

### 12.4 frontend/E2E

- 账号 tab desktop/390px、light/dark、键盘/axe；
- 保存后只显示末四位，reload 不回明文；替换、删除、stale、connection missing；
- Alice→logout→Bob 无 hint/cache 泄漏；
- PAT 调三条账号路由全拒；session 只能改本人；
- 管理员 rebind/delete count + digest confirmation；
- 从 SSH 输入启动真实 task/mission，system mock 证明最终 receive-pack 采用个人/公共身份。

### 12.5 架构与源码棘轮

- `modules/source-control` public types 不含 token/password/header/env/callback/client；
- publication 路径不得直接调用裸 `git push/fetch/ls-remote` 绕过 transport session；
- credential helper 配置必须包含 `credential.helper=` 清空与 `credential.useHttpPath=true`；
- account routes metadata `tokenAccess:'never'`；
- MR/评论/审批/流水线 REST 端口不得出现 personal credential subject，仍由 global connection 统一供给；
- 个人认证失败分支不得调用 global resolver；
- raw token/credential-bearing URL 不进入 logs/serialized errors/remote config。

## 13. 观测与审计

新增低基数指标：

```text
repository_publication_total{provider,credential_source,result}
repository_endpoint_resolution_total{provider,source,result}
repository_credential_lease_total{provider,source,result}
```

不得把 user id、repo path、token hint、host 作为 metrics label。结构化 audit 可保存安全 subject/ref 与
redacted authority，但用户响应只看到面向修复的稳定错误，不看到“公共 token 是否存在”等可枚举细节。

## 14. 实现退出门

1. proposal C1–C14、I1–I8 与 S1 已获用户明确批准；
2. RFC-320 已 Done、生产候选已提交并同步，且不再写重叠文件；
3. `plan.md` 所有任务映射到 AC，零“设计写了但计划没接”的条目；
4. targeted 与一次完整 local gate 全绿；
5. 普通用户浏览器真行为、PAT 拒绝、缓存隔离、管理员兼容有证据；
6. exact-SHA hosted CI/visual terminal-green；
7. shared `main` 只精确提交本 RFC 路径和确属本 RFC 的共享文件，保留所有并发输出。
