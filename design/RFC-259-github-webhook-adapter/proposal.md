# RFC-259 · GitHub Webhook Adapter（代码平台 Webhook 触发器的 GitHub 支持）

- 状态：In Progress（用户预批准——2026-08-05 指示「写好 RFC 直接开始扩展」；设计门照跑并折入）
- 日期：2026-08-05
- 作者：Claude
- 关联：RFC-257（webhook 触发器基座，本 RFC 是其 design §12 预告的「GitHub adapter（HMAC 走同一 `verify` 接口）」的落地）；RFC-257 proposal §3 非目标明言「GitHub / Gitea adapter：抽象层预留，实现后续按需加」

## 1. 背景

RFC-257 交付了完整的入站 webhook 触发器链路（端点 / 验签 / 去重 / 三段式分发 / 触发器匹配 / supersede / 熔断 / 管理面），但 provider 枚举只有 `gitlab`（`packages/shared/src/schemas/webhook.ts:14`）。用户需要在 GitHub 仓库上实测 webhook 触发功能——当前无法配置 GitHub 端点。

RFC-257 的抽象为此预留了位置：

- 归一化信封 `CodeHostEvent` 平台无关，匹配 / streamKey / 熔断 / supersede / 模板 / repo 解析 / 启动装配**只读信封**，全部零改动即可服务 GitHub 事件；
- 路径本就是 `POST /webhooks/:provider/:urlToken`，adapter 注册表按 provider 段选取（`services/webhook/gitlabAdapter.ts:279-281`）;
- Secret 存储当时特意统一 secretBox 密封存明文而非哈希，理由之一即「未来 GitHub HMAC 需明文」（RFC-257 proposal D18）。

本 RFC 把 GitHub 从「预留」变为第二个受支持的 provider。

## 2. 目标

1. **GitHub adapter**：`X-Hub-Signature-256` HMAC-SHA256 验签（对原始请求字节计算、常量时间比较）+ GitHub 事件归一化到既有 9 类内部事件（push / tag_push / mr_* / note / pipeline_*），事件类型枚举**不扩**。
2. **adapter 接口的 provider 化收口**：RFC-257 的入站路由残留了四处 GitLab 专有知识（手挑 `x-gitlab-*` 头、`X-Gitlab-Event-UUID` 提取、`x-gitlab-event` 摘要、`object_kind` 摘要——`routes/webhooks.ts:123-128,60-64`）。全部下沉进 adapter 接口，路由层零 provider 分支。
3. **管理面与前端**：创建端点时可选 provider（GitLab / GitHub 二选一，不可变语义不变）；列表 / 指引文案 provider 感知（现为硬编码 `<dd>GitLab</dd>`，`WebhookEndpointCard.tsx:222`）。
4. **文档**：`docs/webhook-triggers.md` 增加 GitHub 接入节（repo/org webhook、content type、公网可达 / 隧道转发、评论指令的分支限制）。

## 3. 非目标

- **出站回写**（PR 评论、commit status、check run）：沿 RFC-257 D1，`ReportSink` 仍是类型占位。
- **GitHub REST API 调用**（含只读）：沿 RFC-257 D7 零平台 API——不配 token、不拉 PR diff / CI 日志。由此派生一条**显式接受的功能限制**（D7'，见 §5）：PR 普通评论事件拿不到源分支。
- **GitHub App / installation**：只支持 repo / org / enterprise 级普通 webhook（自管 secret）。App 形态的 JWT / installation token 是另一个鉴权宇宙，且违反零平台 API。
- **`application/x-www-form-urlencoded` payload**：GitHub webhook 创建时 content type 必须选 `application/json`（默认是 form）；form 形态不支持，文档写明。
- **Gitea / 其他 provider**：不做。
- **GitLab 行为变更**：GitLab adapter 的验签 / 归一化 / 状态码语义逐字节不动（既有 rfc257 测试套件全绿是本 RFC 的回归门）。
- **push deleted / GitLab 侧的等价处理**：GitHub 侧删分支 push 显式 unsupported；GitLab adapter 对删分支 push 的现状（照常解析、任务在已删分支上失败）不在本 RFC 修——如需处理另立议题。

## 4. 用户故事

**S1（管理员，一次性）**：设置 → Webhook → 端点 → 新建，provider 选 **GitHub**，得到 URL 与 Secret。到 GitHub 仓库（或 org）Settings → Webhooks → Add webhook：Payload URL 粘贴、**Content type 选 `application/json`**、Secret 粘贴、事件勾选（Pushes / Pull requests / Issue comments / Pull request review comments / Workflow runs）。保存后 GitHub 发 `ping`，平台投递历史出现一条 `ignored(unsupported-event)`（200，GitHub UI 绿勾）。
**S2（PR 审计）**：触发器「PR 审计」= repo 范围 exact `owner/repo` × 事件 `mr_opened, mr_updated` × 目标分支 `main` → 工作流「Audit」。PR opened / 新 commit push（synchronize）自动起审计任务。
**S3（修到绿）**：GitHub Actions run 失败（`workflow_run` completed + conclusion failure）→ 命中「修到绿」触发器 → supersede 同 PR 旧任务 → 修复 agent 在 worktree 重跑构建、push 回 PR 源分支 → Actions 自动重跑；熔断上限兜底。bot 的 push 事件被忽略名单过滤，bot 引发的 workflow_run 失败照常触发（RFC-257 D14 语义对 GitHub 原样成立）。
**S4（评论指令）**：PR 里评论 `/fix 处理这个空指针` → `issue_comment` 命中指令触发器 → 起修复任务。**限制（D7'）**：普通 PR 评论的 payload 不含分支（`issue.pull_request` 只有 API URL），任务跑在仓库默认分支；要让指令带上 PR 源分支上下文，用 **diff 行内评论**（`pull_request_review_comment`，payload 带完整 `pull_request` 对象）。
**S5（排障）**：投递历史看 `rejected(invalid-token)`（HMAC 不符——GitHub 侧 secret 贴错）/ `ignored(no-trigger-matched)`；GitHub 侧 Recent Deliveries 可手动 Redeliver（复用同一 GUID，平台按去重 bump 不重复分发；真正的恢复主路径仍是平台 replay，与 GitLab 相同——GitHub 同样**不自动重试**失败投递）。

## 5. 决策记录

| # | 决策 | 内容与理由 |
|---|---|---|
| D1 | provider 枚举扩展，零迁移 | `CODE_HOST_PROVIDERS` += `'github'`。DB 的 `webhook_endpoints.provider` 列是裸 `text NOT NULL`（迁移 `0138_rfc257_webhook_triggers.sql:9` 无 CHECK 约束；drizzle 的 `{enum:[...]}` 只是 TS 类型层）⇒ **不需要新迁移**，也不触碰 upgrade-rolling journal 锁与并发迁移号 |
| D2 | verify 接口扩原始字节 | `CodeHostAdapter.verify(headers, rawBody: Uint8Array, secret)`。GitHub HMAC 必须对**原始请求字节**计算（官方文档明示 UTF-8 payload 注意事项）；入站路由已在验签前读完 body（`routes/webhooks.ts:120`），改为字节 + 文本双持有。GitLab 实现忽略 rawBody，行为逐字节不变 |
| D3 | 事件映射表 | GitHub 事件 → 既有 9 类内部事件（design §2），事件类型枚举与 `WEBHOOK_EVENT_VAR_MATRIX` 均不扩。要点：push 按 `ref` 前缀分流 branch/tag、`deleted=true` unsupported；`pull_request` 的 opened/reopened→mr_opened、synchronize/edited/ready_for_review→mr_updated、closed 按 `merged` 分 mr_merged/mr_closed；`issue_comment`（PR 上、created）与 `pull_request_review_comment`（created）都归 note；`workflow_run`（completed）conclusion failure/timed_out→pipeline_failed、success→pipeline_succeeded；`ping`→unsupported（200，GitHub UI 显绿） |
| D4 | 去重 = `X-GitHub-Delivery` | GitHub 官方文档：每投递唯一 GUID，**Redeliver 复用同一 GUID**——与 GitLab Resend 同语义，RFC-257 的部分唯一索引 + bump attempt_count 机制**原样成立**（AC-3 平移）。header 缺失时降级为无去重逐条处理（同 F-18） |
| D5 | author 口径 | 统一 `sender.login`（GitHub 全事件都带 sender = 触发该事件的平台用户，忽略名单语义要的正是平台 username，不是 `pusher.name` 的 git identity）。`workflow_run` 例外用 `workflow_run.actor.login ?? sender.login`——熔断重置判定（RFC-257 D22）需要「引发这次流水线的人」，actor 是 initially-triggering user；是否 = push 者列入 fixtures 实测清单 |
| D6 | repo 定位 | `repoPath = repository.full_name`（`owner/repo`，天然前缀匹配 org）；`repoHttpUrl = repository.clone_url`、`repoSshUrl = repository.ssh_url`。GHES 兼容（host 无关，双 URL 进既有 `canonicalRepoKey` 双族解析） |
| D7' | PR 普通评论无分支（显式接受的限制） | `issue_comment` 的 `issue.pull_request` 只含 API URL 不含分支（官方 payload 文档），零平台 API（D7）下无从获取 ⇒ note 事件 `branch`/`targetBranch` 缺省 → fire 的 `ref` 不注入 → **无 git 输入映射的目标**跑在 repo 默认分支（`renderWebhookLaunch` 既有语义，`webhookDispatch.ts:234,254`）；**workflow 目标带 `event-branch` git 映射时该组合必败**（评审门 F-2：代包渲染 `{"kind":"branch","ref":""}`，运行期 `validGitValue` 拒空 → `launch-failed`，保存期彩排恒有分支拦不住）。**行内评论**（`pull_request_review_comment`）payload 带完整 `pull_request`，branch 齐全。两条都归 note；限制与必败组合写进文档（docs §6.3/§6.4）。派生行为差异：branchFilter 非空的触发器对 GitHub 普通评论按 `targetBranch ?? ''` 匹配（`matching.ts:52-59`）必 miss——评论指令触发器要罩 GitHub 普通评论就把分支过滤留空 |
| D8 | 摘要列语义泛化，不改名 | `webhook_deliveries.gitlab_event_header` 列与 wire 字段名**保留**，语义泛化为「provider 原始事件头」（GitLab: `X-Gitlab-Event`；GitHub: `X-GitHub-Event`）；`object_kind` 摘要列对 GitHub 存事件头值（`push` / `pull_request` / …）。rename 迁移 + wire 破坏（前端 `DeliveriesPanel.tsx:25`、契约注册表、e2e）的 churn 大于纯命名收益，且列语义注释就地更新——这是有意的命名妥协，不是过渡态 |
| D9 | header 知识收进 adapter | 路由层现状手挑 `x-gitlab-*` 三个头（`routes/webhooks.ts:123-128`）。接口新增 `headerAllowlist` / `deliveryIdHeader` / `eventHeader` 头名字段 + `summaryKindOf` 方法，路由层按 allowlist 构造 HeaderBag、按头名取值，**零 provider 分支**（RFC-257 的边界规则「平台特有知识全部封在 adapter 文件」补完；字段形式让 replay 能反向重建事件头，design §1.3） |
| D10 | timed_out 归 pipeline_failed | GitLab 把流水线超时判为 `status=failed`（无独立超时态），GitHub 单列 `conclusion=timed_out`——归并进 pipeline_failed 才是对参考语义的忠实还原，且修到绿场景超时（卡死测试）恰是高价值触发源。cancelled/skipped/neutral/action_required/stale/startup_failure 一律 unsupported（与 GitLab 侧「非 failed/success 一律 unsupported」对称） |
| D11 | 无签名投递必拒 | 平台端点必有 secret（铸造即生成），GitHub 侧未配 secret 时签名头整个缺失（官方文档）→ `missing` → 401 + `rejected(missing-token)`。不存在「无 secret 白名单」模式 |
| D12 | 端点创建时选 provider | 创建 Dialog 加 GitLab / GitHub 二选一（`Segmented`，默认 gitlab——`CreateWebhookEndpointSchema.provider` 的既有 default 不变）；provider 不可变语义不变（换 provider = 重建端点）。列表 / 密钥弹窗 / 空态指引文案 provider 感知 |

## 6. 部署与能力影响清单

纯新增能力，无既有能力收缩（不触发 CLAUDE.md 第 7 条附加门槛）。部署影响两条如实呈报：

1. **github.com → daemon 的网络可达性**：SaaS GitHub 的出站 webhook 要求 daemon 有公网可达地址（或经隧道转发如 smee.io / `cloudflared`，转发需保留原始 header 与 body 字节——HMAC 对字节校验）。这是 RFC-257 已呈报的 `bindHost`/`publicBaseUrl` 暴露面的同类延伸，GHES 内网部署则与 GitLab 场景同形。文档写明。
2. **修复场景的 git 写凭据**：push 回 PR 源分支要求 daemon 宿主机 git 凭据对 GitHub 仓库有写权限（PAT / deploy key），与 RFC-257 §6.3 同款——凭据仍由宿主机管理，平台不托管。

## 7. 验收标准（可证伪；oracle 独立于实现）

**验签（HMAC）**
- AC-1 正确 HMAC-SHA256 签名（`X-Hub-Signature-256: sha256=<hex>`）→ 接收；错误签名 → 401 + `rejected(invalid-token)`；签名头缺失 → 401 + `rejected(missing-token)`。
- AC-2 签名对**原始字节**计算：含多字节 UTF-8（中文）payload 的正确签名通过验签；签名值与 body 单字节不符即 invalid。比较为常量时间（与 gitlabVerify 同款不等长防御）。

**去重与恢复**
- AC-3 同 `X-GitHub-Delivery` 二次投递（对应 GitHub Redeliver）→ 200、原行 bump `attempt_count`、不产生第二次分发；曾 `rejected` 的 GUID 修正 secret 后重投能成功；header 缺失 → 无去重逐条处理。

**归一化矩阵（fixture 驱动）**
- AC-4 push：`refs/heads/*` → push（branch / after sha / sender.login）；`refs/tags/*` → tag_push；`deleted=true` → 200 + `ignored(unsupported-event)`。
- AC-5 pull_request：opened / reopened → mr_opened；synchronize / edited / ready_for_review → mr_updated；closed + `merged=true` → mr_merged；closed + `merged=false` → mr_closed；assigned / labeled 等其余 action → unsupported。字段：`number`→mrIid、`title`→mrTitle、`head.ref`→branch、`base.ref`→targetBranch、`head.sha`→commitSha。
- AC-6 note 双源：`issue_comment`（created + `issue.pull_request` 存在）→ note，branch / targetBranch 缺省、`mrIid = issue.number`（streamKey 仍落 `repo|mr:N` 维度，supersede / 熔断正确）；非 PR 的 issue_comment / action ≠ created → unsupported；`pull_request_review_comment`（created）→ note 且 branch = `pull_request.head.ref`。
- AC-7 workflow_run：completed + failure → pipeline_failed；completed + success → pipeline_succeeded；completed + timed_out → pipeline_failed；requested / in_progress / 其余 conclusion → unsupported；`pull_requests[]` 空（fork PR 形态）→ mrIid 缺省、streamKey 落 `repo|branch:<head_branch>` 维度。
- AC-8 ping → 200 + `ignored(unsupported-event)`（不落 fire、GitHub UI 得到 2xx）。

**路由与管理面**
- AC-9 `POST /webhooks/github/:token`：对 provider=gitlab 的端点 404 同形（RFC-257 AC-2 的 provider 不匹配分支现在有了真实第二 provider 的正例）；github 端点走通完整三段式（received → 异步分发）。
- AC-10 管理面创建 `provider:'github'` 端点 → 持久化、`ingressUrl` 含 `/webhooks/github/`；PUT 不含 provider 字段（不可变既有语义，strict schema 拒绝）。
- AC-11 前端：创建 Dialog 可选 provider（默认 GitLab）；列表卡按行 provider 显示「GitLab」/「GitHub」；github 端点的密钥弹窗 / 空态显示 GitHub 粘贴指引（含 content type application/json 提示）；role/testid 断言，中英双语。
- AC-12 GitLab 零回归：既有 rfc257-* 测试套件（adapter / matching / ingress / dispatch / management / e2e / error-codes / source-locks）不改断言全绿。**显式例外一处**：`rfc257-gitlab-adapter.test.ts:204` 原断言 `CODE_HOST_ADAPTERS['github']` 为 undefined——该断言锁的主题（「注册表只有 gitlab」）正是本 RFC 推翻的前提，翻转为断言 github adapter 存在。
- AC-13 全链路 e2e（backend）：github 端点 + HMAC 签名投递 → 触发器命中 → `startExecution` 收口启动、tasks 归属两列落值（镜像 `rfc257-webhook-e2e.test.ts`）。
- AC-14 **GitHub 投递可 replay**（实现期自查 P0 的回归锁）：github 投递落库后 replay → 归一化成功（事件头从 `gitlab_event_header` 审计列重建）、新行指回原行、分发发生；GitLab replay 行为不变。

## 8. 开放问题（fixtures 实测清单，`tests/fixtures/github-webhooks/README.md`）

1. `workflow_run.actor` 是否 = 引发 run 的 push 者（D5 / 熔断重置语义前提；候选 `triggering_actor` 差异一并核）。
2. fork PR 的 `workflow_run.pull_requests` 为空数组（文档未明言，社区周知行为）——空时 streamKey 落 branch 维度的降级是否够用。
3. Redeliver 复用同一 `X-GitHub-Delivery`（文档已载，实测复核）。
4. org 级 webhook 的 `ping` payload 无 `repository` 对象的形态（adapter 对 ping 在 repository 解析**之前**返回 unsupported，须实测确认不触发 parse-failed 噪音）。
5. `pull_request_review_comment` 的 `comment.commit_id` 是否适合作 commitSha（现取 `pull_request.head.sha`）。
6. **极端大 push 的 payload 尺寸**：GitHub push 的 `commits` 数组上限远大于 GitLab（GitLab 文档限 20 条，GitHub 可达千级），批量 push 可能超出平台 1 MiB body 上限 → 413 丢事件（GitHub 不重试）。实测典型尺寸；若确认常超限，后续考虑 per-provider body 上限或提高全局上限（本期不动，文档写明症状）。

## 9. 已知误配形态（文档排障表素材）

- **Content type 忘改 `application/json`**（GitHub 默认 form-urlencoded）：body 为 `payload=<urlencoded>` —— HMAC 验签**通过**（GitHub 对 form body 同样签名、平台对原始字节校验），随后 JSON 解析失败 → 400 + `ignored(parse-failed)`，GitHub Recent Deliveries 显红。排障表写明「投递历史见 parse-failed → 检查 content type」。
