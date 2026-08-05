# RFC-259 · 技术设计

状态：In Progress。读法：先 proposal.md（D1–D12 与 AC），本篇是接口契约与映射表。GitHub 行为断言依据官方文档（docs.github.com webhooks 三篇 + REST workflow-runs），字段路径以 `tests/fixtures/github-webhooks/` 实测为准，不符处回改本文件与 adapter（RFC-257 T3 同款纪律）。

## 0. 总览：改动面一览

```
不动（provider 无关信封的红利，本 RFC 的回归门）：
  matching.ts（matchTrigger / streamKeyOf / evaluateCircuit）
  webhookDispatch.ts（互斥 / supersede / 熔断 / repo 解析 / 渲染 / startExecution 收口）
  webhookTemplate.ts（变量矩阵按 eventType，provider 无关）
  deliveryStore.ts（去重索引 (endpoint_id, event_uuid)，GUID 塞同一列）
  rateLimiter / webhookGc / 权限点 / CALL_FACES / 迁移（零新增）

改动：
  shared/schemas/webhook.ts   CODE_HOST_PROVIDERS += 'github'
  db/schema.ts                provider 列 TS enum 数组 +'github'（无 DB 迁移，D1）
  services/webhook/codeHostAdapter.ts   [新] 接口 + HeaderBag + 注册表（从 gitlabAdapter 迁出）
  services/webhook/gitlabAdapter.ts     实现新接口方法（行为逐字节不变）
  services/webhook/githubAdapter.ts     [新] HMAC 验签 + 归一化
  routes/webhooks.ts          HeaderBag 按 allowlist 构造；verify 传字节；摘要列走 adapter 方法
  routes/webhookDeliveries.ts replay 的 normalize 从空 HeaderBag 改为审计列重建事件头（§1.3，自查 P0）
  routes/webhookEndpoints.ts  零逻辑改动（provider 已透传；schema 扩枚举自动生效）
  frontend WebhookEndpointCard.tsx + i18n ×2   provider 选择 / 展示 / 指引
  docs/webhook-triggers.md    GitHub 接入节
```

## 1. Adapter 接口（v2，`services/webhook/codeHostAdapter.ts`）

RFC-257 把接口内联在 `gitlabAdapter.ts`（`:20-24`），且路由层残留四处 GitLab 专有知识。接口迁出到独立文件并补齐 provider 化缺口（迁出姿势对齐 RFC-257 收口时把 dispatcher 契约下沉 `dispatcherTypes.ts` 的先例——同样是为 depcheck no-services-to-routes 的边界卫生）：

```ts
export type HeaderBag = Readonly<Record<string, string | undefined>>

export interface CodeHostAdapter {
  readonly provider: CodeHostProvider            // 放宽自字面量 'gitlab'
  /** 路由层按此白名单构造 HeaderBag（全小写）；provider 头知识不出本文件族。 */
  readonly headerAllowlist: ReadonlyArray<string>
  /** 去重 id 的头名：x-gitlab-event-uuid / x-github-delivery。头缺失 → 无去重降级（F-18 沿用）。 */
  readonly deliveryIdHeader: string
  /** 原始事件头的头名（审计列 D8 语义泛化）：x-gitlab-event / x-github-event。replay 用列值重建此头。 */
  readonly eventHeader: string
  /** 摘要判别符（webhook_deliveries.object_kind 列）：gitlab=body.object_kind；github=事件头值。 */
  summaryKindOf(headers: HeaderBag, parsed: unknown): string | null
  /** 验签。rawBody 为原始请求字节（D2）——GitHub HMAC 消费；GitLab 忽略。 */
  verify(headers: HeaderBag, rawBody: Uint8Array, secret: string): 'valid' | 'invalid' | 'missing'
  normalize(headers: HeaderBag, body: unknown): NormalizeResult
}

export function replayHeaders(adapter, eventHeaderValue: string | null): HeaderBag  // replay 重建
export const CODE_HOST_ADAPTERS: Readonly<Record<string, CodeHostAdapter>>  // { gitlab, github }
```

`NormalizeResult` / `CodeHostReportSink` 原样随迁。`objectKindOf`（`routes/webhooks.ts:60-64`）移进 gitlab adapter 作其 `summaryKindOf` 实现（零 cast 姿势保留）。头提取收敛为**头名字段**（初稿是 `deliveryIdOf/eventHeaderOf` 方法——字段形式让 replay 能反向重建，见 §1.3）。

### 1.3 replay 路径的 provider 化（自查 P0，实现期折入）

`routes/webhookDeliveries.ts:145` 的 replay 用**空 HeaderBag** 调 `adapter.normalize({}, parsed)`——GitLab 无感（事件种类判别在 `body.object_kind`），但 GitHub 的判别在 `X-GitHub-Event` **头**里 ⇒ 不修则**每条 GitHub 投递的 replay 都 parse-failed**，而 replay 是 RFC-257 D20 钦定的恢复主路径。修法：`normalize(replayHeaders(adapter, row.gitlabEventHeader), parsed)`——事件头从审计列重建（该列正是 D8 泛化后的「provider 原始事件头」，入站时永远落值）。AC-14 锁定。

### 1.1 路由层改动（`routes/webhooks.ts`）

- `readBodyLimited` 返回 `{ bytes: Uint8Array; text: string }`（一次 concat，text = utf8 decode；后续 JSON.parse / 入库用 text，verify 用 bytes）。
- HeaderBag 构造：`Object.fromEntries(adapter.headerAllowlist.map(h => [h, c.req.header(h)]))`。
- `eventUuid = headers[adapter.deliveryIdHeader] ?? null`；`gitlabEventHeader = headers[adapter.eventHeader] ?? null`；`objectKind = adapter.summaryKindOf(headers, parsed)`。
- 状态码语义矩阵（RFC-257 design §3.3）逐行不变——「可忽略一律 200」对 GitHub 同样正确（GitHub 虽无 GitLab 式 auto-disable 的文档记载，但同样**不自动重试**失败投递，见 §5）。

### 1.2 GitLab adapter 的 v2 适配

`gitlabVerify(headers, rawBody, secret)` 加参忽略之；`headerAllowlist = ['x-gitlab-token','x-gitlab-event-uuid','x-gitlab-event']`；三个提取方法就地实现。**验签 / 归一化行为逐字节不变**，rfc257-gitlab-adapter.test.ts 只改调用签名不改断言。

## 2. GitHub adapter（`services/webhook/githubAdapter.ts`）

### 2.1 验签（AC-1/AC-2）

```
headerAllowlist = ['x-hub-signature-256', 'x-github-delivery', 'x-github-event']
verify: presented = headers['x-hub-signature-256']            // 'sha256=<hex 小写>'
  缺失/空 → 'missing'                                          // D11：无 secret 的 hook 不发此头
  expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  长度不等 → 同长自比较一次后 'invalid'（gitlabVerify:60-64 同款时序防御）
  timingSafeEqual(Buffer(presented), Buffer(expected)) ? 'valid' : 'invalid'
```

不做大小写规范化（GitHub 恒发小写 hex；攻击者可控输入不做宽容变换）。不支持 legacy `X-Hub-Signature`（SHA-1）。

### 2.2 归一化映射表（AC-4..8；字段路径待 fixture 实测复核）

事件种类判别 = `x-github-event` 头（缺失 → `parse-failed`）。除 `ping` 外，先解析 `repository{full_name, clone_url, ssh_url}`，缺任一 → `parse-failed`；`ping` 在 repository 解析**之前**返回 unsupported（org 级 ping 无 repository，proposal §8.4）。

| `x-github-event` + 判别 | eventType | 字段来源 |
|---|---|---|
| `push`，`ref` 前缀 `refs/heads/`，`deleted≠true` | push | branch=ref 去前缀；commitSha=`after`；author=`sender.login` |
| `push`，`ref` 前缀 `refs/tags/`，`deleted≠true` | tag_push | 同上（branch=tag 名） |
| `push`，`deleted=true` | unsupported（`branch deletion push`） | |
| `pull_request`，action ∈ {opened, reopened} | mr_opened | mrIid=`number`；mrTitle=`pull_request.title`；branch=`pull_request.head.ref`；targetBranch=`pull_request.base.ref`；commitSha=`pull_request.head.sha`；author=`sender.login` |
| `pull_request`，action ∈ {synchronize, edited, ready_for_review} | mr_updated | 同上 |
| `pull_request`，action=closed，`pull_request.merged=true` | mr_merged | 同上 |
| `pull_request`，action=closed，`merged≠true` | mr_closed | 同上 |
| `pull_request`，其余 action | unsupported | |
| `issue_comment`，action=created，`issue.pull_request` 存在 | note | commentText=`comment.body`；mrIid=`issue.number`；mrTitle=`issue.title`；**branch/targetBranch 缺省**（D7'）；author=`sender.login` |
| `issue_comment`，非 PR / action≠created | unsupported（v1: PR comments only，对齐 GitLab noteable_type 门） | |
| `pull_request_review_comment`，action=created | note | commentText=`comment.body`；mrIid=`pull_request.number`；mrTitle=`pull_request.title`；branch=`pull_request.head.ref`；targetBranch=`pull_request.base.ref`；commitSha=`pull_request.head.sha` |
| `workflow_run`，action=completed，conclusion ∈ {failure, timed_out} | pipeline_failed | branch=`workflow_run.head_branch`；commitSha=`workflow_run.head_sha`；pipelineStatus=conclusion 原值；mrIid=`workflow_run.pull_requests[0]?.number`；targetBranch=`…pull_requests[0]?.base.ref`；author=`workflow_run.actor.login ?? sender.login`（D5） |
| `workflow_run`，action=completed，conclusion=success | pipeline_succeeded | 同上 |
| `workflow_run`，action ∈ {requested, in_progress} / 其余 conclusion | unsupported | |
| `ping` | unsupported（`ping acknowledged`，200 让 GitHub UI 绿勾） | |
| 其余事件 | unsupported | |

归一化后信封 `provider:'github'`、`eventUuid = headers['x-github-delivery'] ?? null`、`raw = body`——形状同 `CodeHostEventSchema`，下游全链零改动。

### 2.3 与 GitLab 的行为差异表（文档 + UI 提示的单一来源）

| 维度 | GitLab | GitHub | 后果 |
|---|---|---|---|
| tag push | 独立 `tag_push` object_kind | `push` + `refs/tags/` 前缀 | 对用户无感（同一内部 eventType） |
| MR 更新粒度 | action=update 一种 | synchronize / edited / ready_for_review 三种归并 | 触发面等价 |
| 评论指令分支 | note 带 `merge_request.source_branch` | 普通评论**无分支**（D7'）；行内评论有 | 「跑默认分支」只对**无 git 输入映射**的目标成立（ref 不注入 → repo HEAD）；**workflow 目标带 `event-branch` git 映射时是必败**（评审门 F-2）：代包渲染成 `{"kind":"branch","ref":""}`，运行期 `validGitValue` 拒空 ref → fire `launch-failed`，且保存期彩排事件恒有分支、拦不住该组合。branchFilter 非空同样必 miss（`matching.ts:52-59` 按 `targetBranch ?? ''`）。两条都写进 docs §6.3/§6.4 |
| 流水线事件 | `pipeline` status=failed/success | `workflow_run` conclusion 六值取三（failure/timed_out/success） | timed_out 归 failed（D10）|
| 流水线事件**基数**（评审门 F-1，P1） | **每 commit 一条** pipeline 事件（多 job 仍一条） | **每条 workflow 一个** run 事件——一次 push 跑 N 条 workflow 就发 N 个 completed | 同 commit 的兄弟 workflow 失败落同一 stream：互相 supersede（后到事件取消前一条刚起的修复任务并重起——修到绿语义下可辩护但浪费一轮）、熔断计数按 push×N 增长（bot 迭代 ~⌈3/N⌉ 轮即跳闸）。v1 行为保持，运维指引写明：**多 workflow 仓建议只让一条主 CI workflow 参与修到绿**（GitHub 侧只勾 Workflow runs 不够细——按需上调 `maxConsecutiveFires`）；按 `workflow_run.name` 加过滤维度留作后续演进 |
| MR 关联的流水线 | `merge_request{}` 直挂 | `pull_requests[]`，fork PR 为空 | fork PR 的修到绿 streamKey 降级为 branch 维度（proposal §8.2）。**边界（自查）**：fork 的 `head_branch` 与 upstream 分支**撞名**（fork 侧也叫 `main`）时会与该分支自身 push 触发的 run 落进同一 `repo\|branch:main` 流——互相 supersede / 共享熔断桶。接受为已知降级并写进文档（fork PR 的 CI 失败本就不适合接修到绿：修复产出 push 不进 fork 仓）；若 fixtures 实测确认 `head_repository.full_name ≠ repository.full_name` 可稳定判别 fork，可在后续把 fork 的 workflow_run 收窄为 unsupported |
| 重投 | Resend 复用 Event-UUID | Redeliver 复用 Delivery GUID | 去重语义同形（D4）|
| 失败投递 | 不自动重试 + auto-disable hook | 不自动重试；auto-disable 无文档记载 | 「可忽略一律 200」策略统一保留 |

## 3. 管理面与前端

- **后端零逻辑改动**：`CreateWebhookEndpointSchema.provider` 本就是 `CodeHostProviderSchema.default('gitlab')`（`schemas/webhook.ts:285`），枚举扩展自动生效；`UpdateWebhookEndpointSchema` strict 无 provider 键 = 不可变语义已锁（`:292-299`）；`ingressUrlOf` 已按 `row.provider` 拼路径（`routes/webhookEndpoints.ts:59-68`）。
- **前端 `WebhookEndpointCard.tsx`**：
  - 创建 Dialog：`Segmented<'gitlab'|'github'>`（默认 gitlab），POST 携带 `provider`；
  - 列表卡：`<dd>GitLab</dd>` 硬编码（`:222`）→ 按 `row.provider` 显示（`GitLab` / `GitHub` 专名不进 i18n）；
  - provider 感知文案：密钥弹窗 `secretPasteHint`、空态 `emptyDescription`、创建 hint——GitHub 版补「Content type 选 application/json」提示。i18n 键成对新增（`…GitHub` 后缀），改 zh/en 各两段（interface + const，dev-gotchas i18n 双段陷阱）；
  - 触发器面板：结构零改动（`CODE_HOST_EVENT_TYPES` 全集多选照旧）；事件类型 label 文案把「MR」措辞中性化为「合并请求（MR / PR）」形式（仅 i18n 值层微调）。

## 4. 测试策略（design §10 惯例：首选纯函数面）

- **`rfc259-github-adapter.test.ts`**：`githubVerify`（正确签名 / 单字节错 / 缺失头 / 空串 / 中文 payload UTF-8 字节正确性 / 不等长防御）；`githubNormalize` 全矩阵（§2.2 逐行正反例，builder payload 按官方文档形态手写；ping / deleted push / fork PR 空 pull_requests / 非 PR issue_comment 反例）。
- **`rfc259-github-ingress.test.ts`**：github 端点的状态码语义矩阵（401 rejected 两态 / 404 provider 不匹配同形（AC-9）/ 200 ignored(unsupported) for ping / 去重 bump / 三段式 received + 异步分发）——镜像 `rfc257-webhook-ingress.test.ts` 形态，dispatcher 注入 stub。
- **管理面**：`rfc257-webhook-management.test.ts` 补 github 端点创建 / provider 持久化 / ingressUrl 断言（AC-10）。
- **前端**：`rfc257-webhook-endpoint-card.test.tsx` 补 provider Segmented 选择、按 provider 的指引文案断言（role 优先，AC-11）。
- **e2e（backend）**：`rfc259-webhook-github-e2e.test.ts`——HMAC 真签名投递 → 真 dispatcher → 任务落 tasks 归属两列（镜像 rfc257-webhook-e2e，AC-13）。
- **回归门**：全部 rfc257-* 既有测试不改断言全绿（AC-12；gitlab adapter 只改 verify 签名的调用形参）。
- **fixtures**：`tests/fixtures/github-webhooks/README.md` 实测清单（proposal §8 五项）+ 真实投递采集方法（GitHub → Settings → Webhooks → Recent Deliveries → Payload 原样脱敏保存）。
- **既有棘轮自查**：`route-error-code-coverage`（零新错误码，不动）；RFC-054 契约注册表（wire schema 变更仅枚举扩值，条目形状不变）;`rfc257-source-locks` / `rfc243 CALL_FACES`（不动）；i18n key-resolution（新键两 locale 齐）。

## 5. 外部行为依据（官方文档，2026-08-05 查证）

| 断言 | 来源 |
|---|---|
| 签名头 `X-Hub-Signature-256: sha256=<hex>`，HMAC-SHA256 对 payload 原始内容，UTF-8 注意，推荐 timingSafeEqual；未配 secret 时头缺失 | docs.github.com „Validating webhook deliveries" |
| 10s 响应超时；建议异步处理；`X-GitHub-Delivery` 每投递唯一且 **redelivery 复用同一值** | docs.github.com „Best practices for using webhooks" |
| **GitHub 不自动重投失败投递**；恢复 = 手动 Redeliver（UI / REST） | docs.github.com „Handling failed webhook deliveries" |
| push 的 ref 形态 `refs/heads/*` / `refs/tags/*`、`deleted` 旗标、repository.clone_url/ssh_url/full_name/default_branch、sender.login | docs.github.com „Webhook events and payloads" §push |
| pull_request action 全集（opened/synchronize/closed/reopened/edited/ready_for_review/…）、number/title/head.ref/head.sha/base.ref/merged | 同上 §pull_request |
| issue_comment 的 `issue.pull_request` 仅 URL 引用不含分支 | 同上 §issue_comment |
| workflow_run action ∈ {completed, in_progress, requested}；org webhook 可用 | 同上 §workflow_run |
| conclusion 值集（success/failure/neutral/skipped/timed_out/cancelled）；`pull_requests[]` 元素含 number/head{ref,sha}/base{ref,sha} | docs.github.com REST „Workflow runs" |

（GitLab 侧断言沿 RFC-257 design §2.3，本 RFC 不动。）
