# RFC-321 — 用户级代码平台推送凭据与 SSH→HTTP(S) 传输解析

- 状态：Done（2026-08-25；用户于 2026-08-24 批准 C1–C14、I1–I8 与 S1；包含最终发布批次的
  `089015b1a` 上 hosted CI 31/31、visual 1/1 全绿）
- 发起：用户，2026-08-24
- 批准：用户，2026-08-24
- 前置：RFC-204 / RFC-205（仓库凭据密封与一次性 helper）、RFC-269（全局代码平台连接）、
  RFC-294（source-control / integration / identity-access 边界）、RFC-310（数字员工候选交付）、
  RFC-320（Phase 1：Git commit identity；必须先完成，本 RFC 不改变其 author/committer 裁决）

## 阶段关系（追加裁决 S1）

用户于 2026-08-24 明确裁决 RFC-320 与 RFC-321 分属两个顺序阶段：

1. **Phase 1 / RFC-320**：先完成用户档案、任务 identity 快照与 commit author/committer；在该 RFC
   范围内 push credential 必须保持不变。
2. **Phase 2 / RFC-321**：RFC-320 推送后，增加个人/公共 push credential 与 HTTP(S) transport；
   它消费稳定的工作归属用户，不修改 RFC-320 的档案或提交署名模型。用户已确认该阶段门满足，并要求
   RFC-321 会话不接手 RFC-320 的剩余问题。

因此 RFC-320 的 C8“push 认证不在本 RFC 范围”是第一阶段的范围闸，不是永久禁止后继 RFC 修改
push transport。两者功能所有权正交；`schema.ts`、账号路由/页面、i18n、migration journal 等物理文件
存在重叠，所以生产实现必须串行。RFC-321 只在用户明确开放 Phase 2 后修改自身链路；账号页把既有
Git 提交身份卡片移到“代码提交与推送”页签属于展示归位，RFC-320 的 profile/identity 后端合同保持不变。

## 0. 终态一句话

**平台拥有的每一次 Git 发布，都按该工作的归属用户选择“个人代码平台 token → 平台公共 token”，
并把受管 SSH remote 解析成无凭据的 HTTP(S) endpoint 后，以一次性、目标绑定的 credential lease 完成整笔发布。**

```text
工作归属用户 + 仓库 remote
        │
        ├─ 个人 token 已配置 ───────────────┐
        └─ 未配置 → 平台公共 token ─────────┤
                                             ▼
SSH remote ── provider API / 管理映射 / SaaS 约定 ──> HTTP(S) endpoint
                                             │
                                             ▼
                     ls-remote / fetch / push / post-verify
                     （同一 endpoint、同一 credential lease）
```

Git 协议本身不提供“SSH clone URL → HTTP clone URL”的发现能力。`git ls-remote` 只列远端 refs；
`--get-url` 也只展开本机 `url.<base>.insteadOf`。GitHub Repository API 返回 `clone_url`，GitLab
Projects API 返回 `http_url_to_repo`，因此受管平台采用“平台 API 优先、显式映射次之、已知 SaaS
约定兜底、未知平台不猜”的确定性规则。

## 1. 现状与问题

### 1.1 “代码平台 token”与“Git push 凭据”目前是两条链

- Settings → 代码平台保存 GitLab/GitHub 各一份全局 `baseUrl + token`。token 经 secretBox
  密封，只供平台发起 MR/PR、评论、流水线等 REST API 调用，读路径只返回末四位。
- 私有仓库目前主要靠用户在仓库 URL 中携带 userinfo。原始 URL 只密封在
  `cached_repos.url_enc`；自动 push 临时解封后使用一次性 credential helper。
- 因此“已配置全局代码平台 token”并不等于“Git push 会使用该 token”，账号页也没有个人
  Git push token。

用户期望的是一个明确的覆盖模型：本人配置了代码平台 token，就让归属于本人的平台发布使用它；
本人没有配置时，才使用管理员配置的公共 token。

### 1.2 平台存在不止一条发布链，凭据语义不一致

- task 自动提交路径在最终 push 上租用仓库 URL 凭据，但 non-fast-forward 修复中的 `fetch`
  没有复用同一 lease。
- 数字员工候选交付的 `ls-remote → fetch → push → post-verify` 直接使用 remote URL，尚未接入
  统一凭据选择。
- submodule 有自己的 remote；把父仓 token 按 host 粗放复用会造成跨项目泄露风险。

如果只修改一处 `git push`，用户会遇到“第一次探测 401、repair fetch 仍走 SSH、候选交付不生效”
等半接线状态。本 RFC 把“一笔发布的全部网络动作”作为原子能力治理。

### 1.3 SSH 地址不能普遍靠字符串替换

`git@github.com:org/repo.git → https://github.com/org/repo.git` 对 GitHub.com 成立，但不能外推到
所有部署：

- Git SSH hostname 与 Web/API hostname 可能不同；
- SSH 端口不是 HTTP 端口；
- GitLab/GitHub Enterprise 可能位于反向代理子路径；
- 自定义 Git server 可能重写 namespace/path；
- HTTP endpoint 可能只允许 HTTPS，或由管理员明确允许内网 HTTP/自签证书。

错误猜测不仅会推送失败，还可能把 token 送向错误 authority，因此未知映射必须 fail closed。

### 1.4 Git 提交身份与远端认证身份必须继续分离

RFC-320 已裁决 commit `author/committer` 来自用户档案并冻结到 task。远端平台记录“谁执行了
push”则由本 RFC 选择的 token 决定。两者可以是同一自然人，也可以不同，不能互相覆盖。

## 2. 目标

1. 在每个用户的 `/account` 增加“代码推送凭据”，按已配置的 GitLab/GitHub 连接保存、替换、
   删除本人的 token，并可显式校验草稿/已保存 token，显示是否合法及对应代码平台账号。
2. 平台 Git 发布按归属用户确定性选择凭据：个人已配置则使用个人；个人不存在才使用管理员
   配置的公共代码平台 token。
3. “个人 token 已配置但无权、过期或失效”时明确失败，不静默改用公共 token 以改变发布身份。
4. 对受管 SSH remote 解析出权威、无 userinfo 的 HTTP(S) clone endpoint；未知平台或不可信映射
   不猜测、不发送 token。
5. 同一发布尝试的 remote 探测、竞争修复、push 和事后确认使用同一 endpoint 与 credential
   revision；成功/失败均可审计且绝不记录 token。
6. 覆盖 task 自动 push、数字员工候选交付、冲突修复以及 submodule 发布，不保留第二套绕过链。
7. token 永不进入 agent/model prompt、agent 子进程环境、Git remote 配置、命令行、日志或 API 响应。
8. 新增代码按 RFC-294 落入 `source-control` 的 repository transport vertical slice；
   `identity-access` 只提供当前账号/授权主体，`integration` 只提供代码平台 API 元数据解析。

## 3. 非目标

- 不改变 RFC-320 的 `user.name/user.email`、任务 Git identity 快照或历史 commit。
- 不让个人 token 接管 MR/PR 评论、审批、merge、流水线等代码平台 REST 动作；这些仍使用全局
  connection token。
- 不把 token 提供给 agent 自己执行的任意 shell / MCP / runtime，也不让 agent 手工 `git push`
  获得平台凭据。
- 不新增 SSH 私钥、SSH agent、deploy key、Git credential manager 或 OAuth 授权流程。
- 不承诺任意 Git server 的 SSH→HTTP 自动转换；第一期受管 provider 仍为 GitLab/GitHub。
- 不把明文 token 填入 HTTP URL，也不永久改写 clone mirror/worktree 的 `origin`。
- 不做 token scope 自动扩权、自动轮换、跨用户共享个人 token或管理员读取个人 token。
- 不改变 clone/background refresh 的既有 transport；本 RFC 只接管平台拥有的发布事务，以及
  为该事务服务的 remote read/fetch。

## 4. 用户可感知行为

1. `/account` 新增独立的“代码推送凭据”区域，不与 agent-workflow 自身 Personal Access Tokens
   混在一起。每个已配置代码平台显示 provider、服务地址、配置状态、末四位和更新时间。
2. 保存成功后永远不能读回明文；再次输入表示替换，删除表示下一次发布回退到公共 token。
3. 校验只调用该 provider 的身份端点：草稿 token 一次性使用，已保存 token 在服务端解封；成功显示
   token 有效与对应账号，失败显示分类原因。未配置个人 token 时绝不拿公共 token 冒充校验结果。
4. 页面明确显示：“个人凭据优先；未配置时使用管理员配置的公共凭据”。它只描述选择规则，
   不泄露公共 token 的末四位、账号或权限范围。
5. 以该用户为 owner/creator 的工作发布时，若有个人 token，远端平台按个人 token 身份记录 push；
   否则按公共 token 身份记录。
6. 个人 token 存在但认证失败时，任务/mission 显示稳定错误并引导用户替换或删除个人凭据；
   平台不会在后台再尝试公共 token。
7. 输入 `git@github.com:org/repo.git`、`ssh://git@host/group/repo.git` 等 SSH remote 后，平台在
   发布时临时解析 HTTP(S) endpoint；UI 保存和仓库 `origin` 仍展示原始、已脱敏地址。
8. 私有化平台优先采用 provider API 返回的 clone URL；API 不可用时仅使用管理员明确配置的
   transport mapping。GitHub.com/GitLab.com 可使用内置 HTTPS 约定兜底。
9. 未知 SSH server 无可靠映射时：若没有选择任何受管 token，保持原 SSH 行为；一旦选择了个人/
   公共 token，则以 `repository-http-endpoint-unresolved` 失败，绝不偷偷改回 SSH 身份。
10. 管理员变更代码平台 authority/path mapping 或删除连接时，受影响的个人凭据被撤销并清除；
    token-only 轮换不影响个人凭据。
11. commit 的 author/committer 仍由 RFC-320 的任务身份决定。账号页在两个卡片中分别写明
    “提交署名”与“远端推送认证”，避免把 Git 邮箱误认为平台账号。

## 5. 待用户确认的裁决

用户已于 2026-08-24 批准下列裁决；如任何一项需调整，应先修改 RFC，再进入实现。

| 编号 | 裁决                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1   | 个人凭据按“用户 × 已配置代码平台连接”保存。当前一 provider 只有一条连接，因此 wire 仍以 `gitlab/github` 标识；持久化同时绑定不可伪造的 connection generation 与 endpoint digest。                                              |
| C2   | 需求中的“公共 token”解释为 Settings → 代码平台现有的全局 connection token。对用户仍是一份管理员输入；后端为 source-control 同步一份用途受限的密封投影，使其可用于 Git HTTP(S) push。管理员需保证它具有 repository write 权限。 |
| C3   | 凭据优先级固定为：有效个人配置 → 公共 connection token → 仅在两者都不存在时沿用 legacy URL/SSH transport。任何“已选择凭据后的认证/授权失败”都不触发下一档重试。                                                                |
| C4   | “这个用户”取工作持久化的归属主体：task 使用 `owner_user_id`，development mission 使用 `created_by`；schedule/event/child 工作沿既有 owner/creator 传播。无用户的 system/legacy 工作跳过个人层。绝不取 push 当下的登录会话。    |
| C5   | 凭据在每次发布尝试开始时按当前配置选择，而不是把 token 快照进 task。一次 lease 建立后整笔发布固定同一 revision；用户删除/轮换影响下一次尝试，不打断已经开始的数秒级事务。                                                      |
| C6   | SSH→HTTP(S) 顺序固定为：provider API 已验证 clone URL → 管理员 transport mapping → GitHub.com/GitLab.com HTTPS 约定；未知结果 fail closed。不存在通用 Git 协议兜底，也不采用任意 host/path 字符串替换。                        |
| C7   | 个人 token 只授权平台拥有的 Git transport publication，以及账号本人主动发起的只读身份校验；MR/PR/API 业务动作继续使用公共 token，agent 手工 shell/MCP 继续拿不到个人或公共 token。                                             |
| C8   | 转换仅作用于本次 Git 命令，永不改写 `origin`/`.gitmodules`/缓存仓库 URL；token 通过一次性 helper 注入，URL/argv/env/config/log/API 均无 token。                                                                                |
| C9   | 一笔发布的 `ls-remote/fetch/push/post-verify` 以及 non-fast-forward repair 必须共用同一 transport lease；只接最终 `push` 不算完成。                                                                                            |
| C10  | submodule 按自己的 remote 独立解析 provider、endpoint 与凭据，不继承父仓 token；任何子模块无法安全解析时只阻断该发布，不把父凭据发给它。                                                                                       |
| C11  | 个人凭据管理只允许登录会话操作本人，PAT/daemon token/跨用户管理员读路径都不能取得明文；列表只返回 `configured/tokenHint/updatedAt/stale`。管理员可通过删除代码平台连接整体撤销，但不能查看或替换某个用户的个人 token。         |
| C12  | connection 的 authority/path mapping 变化或连接删除属于 trust-boundary 变化：后端原子清除该 generation 下全部个人 token，并在管理员确认框显示受影响数量；只轮换公共 token 不清除个人配置。                                     |
| C13  | 自动转换默认使用 HTTPS。明文 HTTP 只在管理员 mapping 明确声明时允许；自签 HTTPS 只沿用既有 GitLab connection 的 `rejectUnauthorized=false` 受控例外。credential helper 同时绑定 scheme、host、port、path prefix。              |
| C14  | push 认证身份与 commit author/committer 完全分离；本 RFC 不修改 RFC-320，也不根据 token 登录名反写用户档案或任务 Git identity。                                                                                                |

追加裁决 **S1**：RFC-321 是 RFC-320 之后的 Phase 2；RFC-320 未完成稳定前不得并行修改 RFC-321
生产代码。S1 与 C14 一起锁定两阶段的职责边界。

## 6. 能力影响清单

本 RFC 会改变既有发布 transport，以下影响作为 breaking/behavior change 逐项呈请确认：

| 影响编号 | 既有能力/部署                                                                            | 新行为与影响                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1       | 已配置代码平台 connection、仓库 remote 为 SSH、当前依赖 daemon SSH key/deploy key 的部署 | 若工作命中个人或公共 token，平台发布改走 HTTP(S)，不再使用 SSH key。若希望继续 SSH，必须不为该 provider 启用受管 push credential，或后续另立显式 per-repo transport policy。 |
| I2       | 全局代码平台 token 目前只承担 REST API                                                   | 它会新增 Git push 用途，必须具备 repository write 权限；权限不足会 fail loud，不回退 URL token/SSH key。                                                                     |
| I3       | 个人 token 失效但公共 token 可用                                                         | 发布仍失败，避免无提示切换为公共身份；用户必须替换或删除个人 token 后重试。                                                                                                  |
| I4       | 私有化 GitLab/GitHub 的 SSH/Web 地址不对称                                               | API 或管理员 mapping 缺失时不再猜地址；选择受管 token 的发布会被拒。未选择受管 token 的 legacy SSH 不受影响。                                                                |
| I5       | parent/submodule 共用一个 SSH agent 的仓库                                               | 改为逐 remote 凭据选择；父仓 token 不再隐式覆盖子模块。子模块若无匹配凭据可能从“碰巧成功”变为明确失败。                                                                      |
| I6       | 管理员删除/改址代码平台连接                                                              | 该连接下个人 token 被清除且不可恢复，用户需在新连接上重新录入；管理员 UI 必须显示影响数量并二次确认。                                                                        |
| I7       | 依赖 URL 内嵌 token 的现有 HTTPS 仓库                                                    | 只有在个人与公共受管凭据都不存在时继续沿用；一旦受管凭据存在，不再在认证失败后回退到 URL userinfo。                                                                          |
| I8       | agent/runtime 自己执行任意 `git push`                                                    | 继续不获得平台 token；新增能力仅属于平台 publication action，不扩大 agent 权限。                                                                                             |

## 7. 关键用户故事

### US-1：个人身份发布

Alice 在账号页给公司 GitLab 连接保存个人 token。Alice 创建的任务完成提交后，平台把
`git@gitlab.company.com:team/app.git` 解析为连接返回的 HTTP(S) clone URL，用 Alice token 完成
探测、必要 fetch、push 和确认。commit author 仍是 RFC-320 冻结的 Alice 档案。

### US-2：没有个人配置时用公共身份

Bob 没有配置个人 token。Bob 的任务发布到同一 GitLab 时，source-control 只在确认个人记录
“不存在”后选择公共 connection token，并在审计记录 `credentialSource=global`。响应不暴露公共
账号、token hint 或 credential revision 的可枚举细节。

### US-3：个人 token 失效

Alice 的 token 被平台撤销。下一次发布收到认证失败，任务落稳定、脱敏错误并提示 Alice 前往
账号页。即使公共 token 能写仓库，也不自动重试。Alice 删除个人配置后主动重试，新的发布尝试
才会选择公共 token。

### US-4：自托管 SSH/Web 地址不同

仓库输入为 `git@ssh.company.net:platform/app.git`，GitLab API 返回
`https://code.company.net/git/platform/app.git`。平台采用 API 返回值并验证其 authority 位于该
connection 的允许集合；若 API 不可用，则只接受管理员配置的等价 mapping，不把 SSH hostname
直接替换成 HTTPS。

### US-5：数字员工候选交付

某 development mission 的 `created_by=alice`。候选交付在 CAS 前的 `ls-remote`、幂等身份检查
所需 fetch、真正 push 和 post-push verification 都使用同一个 Alice transport lease；远端在
窗口内推进时仍按既有 CAS 语义返回 `remote-head-changed`，不能把认证失败误判成 head race。

## 8. 验收标准

- **AC-1 账号管理**：登录用户可列出、保存、替换、删除并校验本人的 GitLab/GitHub push
  credential；校验草稿/已保存 token 后显示合法性和对应账号，未配置个人 token 时不回退公共 token；
  PAT/匿名/他人会话 fail closed，任何 GET/错误/日志都不含明文 token。
- **AC-2 选择器**：个人存在、个人缺失、公共存在、两者缺失、个人 stale、个人认证失败、公共认证
  失败均有独立测试；只有“记录不存在”允许进入下一档。
- **AC-3 主体归属**：task owner、schedule/event owner、mission creator、child/system/legacy 分支均有
  明确测试，push 当下调用者不能改变 credential subject。
- **AC-4 endpoint 解析**：两种 SSH 形状、HTTP(S)、`.git` 后缀、自定义端口、GitHub/GitLab SaaS、
  self-hosted API、管理员 mapping、跨 authority 恶意结果与未知 provider 全覆盖。
- **AC-5 provider API**：GitHub 只接受合法 `clone_url`，GitLab 只接受合法 `http_url_to_repo`；返回
  userinfo、file/ssh/未知 scheme、越界 host/path 或重定向到未授权 authority 时拒绝。
- **AC-6 transport 原子性**：task publish、non-FF repair、candidate delivery、conflict repair、
  post-verify 的全部 Git network command 共用同一 endpoint/credential revision；不得出现裸 fetch。
- **AC-7 submodule 隔离**：每个 submodule 独立选凭据并按 scheme+authority+path 约束；恶意
  `.gitmodules` 不能取得父仓 token。
- **AC-8 secret posture**：token 只存在于密封 DB 列和 `0600` 一次性文件；helper 不响应不匹配的
  protocol/host/port/path，请求结束 `finally` 清理；worktree、remote config、argv/env/log/API 无 token。
- **AC-9 并发与轮换**：一次 publication lease 固定 revision；并发替换/删除只影响下一次尝试；
  authority/mapping 变化原子清除个人记录，失败事务不留下 integration/source-control 半更新。
- **AC-10 兼容**：未配置受管个人/公共凭据的仓库保持现有 URL credential、SSH 与 file fixture
  行为；本地测试 bare/file remotes 不被强制转换。
- **AC-11 UX**：账号页与 Settings 使用现有 Card/Form/ErrorBanner/ConfirmDialog，桌面与 390px、
  light/dark、键盘、loading/error/empty/stale 状态齐全；中英文明确区分提交署名与推送认证。
- **AC-12 架构**：新增生产代码位于 `modules/source-control` vertical slice；跨 context 只传
  `AuthorizationSubjectRef`、opaque refs、无凭据 endpoint metadata/receipt，不新增 legacy `services/`
  credential facade，不把 raw token 放进 public contract。
- **AC-13 棘轮**：源码守卫锁住“不把 token 拼 URL”“所有 publication network calls 必须通过
  transport participant”“个人失败不回退”“账号 token 路由 tokenAccess=never”。
- **AC-14 验证**：targeted backend/shared/frontend/system-mock/E2E 全绿；候选内容稳定后只运行一次
  `bun run gate:local`，发布后再以 exact SHA hosted CI 与 visual regression 归因。

## 9. 外部协议依据

- Git `ls-remote`：<https://git-scm.com/docs/git-ls-remote>
- GitHub “Get a repository”（响应含 `ssh_url` / `clone_url`）：
  <https://docs.github.com/en/rest/repos/repos#get-a-repository>
- GitLab Projects API（响应含 `ssh_url_to_repo` / `http_url_to_repo`）：
  <https://docs.gitlab.com/api/projects/>
- GitHub PAT over HTTPS（username 必须非空但不参与认证，token 作为 password）：
  <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#using-a-personal-access-token-on-the-command-line>
- GitLab access token over HTTPS（username 可为任意非空字符串，token 作为 password）：
  <https://docs.gitlab.com/user/profile/personal_access_tokens/#use-a-personal-access-token-with-git>

## 10. 开工门

用户已明确批准 C1–C14、I1–I8 与追加裁决 S1，RFC 状态为 Accepted。但生产开工还必须同时满足：

1. RFC-320 在 proposal/plan/STATE 中均已收口为 Done，生产候选已提交并与 `origin/main` 同步；
2. RFC-320 不再写入本 RFC 的重叠文件，且其完整/目标验证证据可追溯；
3. 开工时重新 fetch/sync、核对 migration journal、共享 dirty paths 与 RFC-294 目标边界。

用户已确认 RFC-320 已推送，并明确要求两个会话继续各管各的阶段。RFC-321 已于 2026-08-25
**Done / Phase 2**：实现仅接管 repository push credential 与 transport；RFC-320 的后端 profile、
task identity snapshot、author/committer 裁决仍由其原会话负责。最终发布批次 `cde92d4c6`、
`3a0e237c9` 均为托管验收 SHA `089015b1a` 的祖先；该 SHA 的 CI run `32806211369` 31/31 全绿，
visual-regression run `32806211353` 1/1 全绿。
