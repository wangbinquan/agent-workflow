# RFC-269 · 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。

## 1. 架构位置

```
webhook 入站（RFC-257/259）          本 RFC（出站）
GitLab ──HTTP──▶ /webhooks/:p/:t     daemon ──HTTP──▶ GitLab/GitHub API
                      │                  ▲
                 触发器匹配               │
                      │              runCodeHostCallNode
                 startExecution           │
                      │              scheduler.runOneNode
                   任务运行 ─────────────┘
```

关键结构判断：**请求由 daemon 进程自己用 `fetch` 发出，不 spawn 任何子进程**。因此

- 不进入 containment 准入面（RFC-205/227/233）—— 没有子进程就没有可容纳的东西。这条要**加源码层锁**
  （§13 T-lock-1），否则未来某次重构把它改成 `curl` 子进程会静默绕过所有边界论证。
- 不受 `SAFE_FORWARD_ENV` / PATH 白名单影响 —— 那是 agent 进程的环境，与 daemon 无关。
- token 的生命周期完全在 daemon 内存里：unseal → 组装 header → 发请求 → 丢弃。不写进任何子进程环境、
  不落任何日志。

节点在 `scheduler.runOneNode` 的分发链里新增一条分支，位置与 RFC-253 完全对称
（`packages/backend/src/services/scheduler.ts:4917-4921` 的 `if (node.kind === 'script')` 之后）：

```ts
// RFC-269 — code-host call: one outbound HTTP request, no model, no subprocess.
if (node.kind === 'code-host-call') {
  return await runCodeHostCallNode(state, args)
}
```

**D1**：节点是 process kind。`NODE_KIND_BEHAVIORS`（`packages/shared/src/node-kind-behavior.ts`）新增行
与 `script` 逐字段相同：`retryCascade: 'mint-placeholder'`（有真实副作用，重试要级联下游）、
`isProcess: true`（写自己的 `node_runs` 行、占并发池名额）、`isAgent: false`（无 session / 无 inventory /
无 memory 注入 / 不参与 clarify）、`settlesWithoutRow: false`。

## 2. 凭据存储

**D2**：凭据落 **DB + `secretBox`**，不进 `~/.agent-workflow/config.json`。

理由：`config.json` 是明文文件（`packages/backend/src/config/index.ts` 直接 `writeFileSync`），而
`GET /api/config` 会把整份配置回传给前端。仓内既有的三处凭据全部走 DB + `secretBox`：
`webhook_endpoints.secret_enc`（`db/schema.ts:1158`）、`oidc_providers.client_secret_enc`
（`db/schema.ts:2240` 附近）、`cached_repos.url_enc`（`db/schema.ts:807`）。本 RFC 沿用同一条路径，
不为一个新凭据发明第二套存储姿势。

新表（迁移 §14）：

```ts
export const codeHostConnections = sqliteTable('code_host_connections', {
  provider: text('provider', { enum: ['gitlab', 'github'] }).primaryKey(), // 每家至多一行（Q2）
  baseUrl: text('base_url').notNull(),        // 归一化后的 API 根，无尾斜杠
  tokenEnc: text('token_enc').notNull(),      // secretBox.seal(token)
  tokenHint: text('token_hint').notNull(),    // 尾 4 位，读路径唯一可见的部分
  lastTestJson: text('last_test_json'),       // {ok, at, login?, code?} —— 展示用，不是准入依据
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by'),              // users.id（审计）
})
```

**D3 base URL 归一化**：入库前剥尾斜杠并按 provider 校验形态 —— GitLab 期望以 `/api/v4` 结尾
（自建子路径部署 `https://host/gitlab/api/v4` 同样合法），GitHub 期望 `https://api.github.com` 或
GHES 的 `https://host/api/v3`。**写错不猜**：形态不匹配时保存直接 422 并给出期望形态，与 RFC-263
`api_base_url` 推导「推不出就渲染空串，不猜」是同一条纪律。这里比那里更严，因为这次是管理员手填、
有机会立刻纠正。

**D4 三形态 token**（照搬 RFC-255 / RFC-257 的既有姿势）：写入接受明文；存储密封；读路径只回
`tokenHint`。PUT 语义为**保留**：不传 token 字段 = 保持原值（管理员改 base URL 不用重录 token）。

**实现期勘误**：初稿写「传空串 = 显式清除整行凭据」。改为**空串直接被 schema 拒绝，清除走
`DELETE /api/code-hosts/:provider`** —— 一个手滑清空的输入框不该等于删除凭据。另外，base URL 或
token 一旦变更就作废 `last_test_json`：旧的绿勾盖在新配置上比没有勾更误导。

**D5 缺 `secretBox` 时的行为**：`server.ts` 的 deps 里 `secretBox` 是可选的（OIDC 与 webhook 管理面
在缺它时自我跳过挂载）。本 RFC 照做：路由自我跳过；节点执行返回明确失败 `code-host-not-configured`。
生产上 `cli/start.ts:480` 恒创建，故这只是测试面与降级面的一致性要求。

**D6 备份 / 恢复**：`secret.key` 丢失后所有密封值不可读。这与 webhook secret 完全同构，
`docs/` 的灾备说明（RFC-213）追加一行「代码平台 token 需重录」即可，不新建机制。

### 2.1 测试连接

`POST /api/code-hosts/:provider/test`，权限 `settings:write`（admin）。用**当前请求体里的**
base URL + token（未保存也能测），或在 token 缺省时用已存的密封值。实现 = 调各家的身份端点：

| provider | 探活端点 | 成功回显 |
|---|---|---|
| gitlab | `GET {base}/user` | `username` |
| github | `GET {base}/user` | `login` |

**D7**：失败必须**可区分**，否则「测试连接」只是个安慰按钮。四类分别给出不同文案与错误码：
`unauthorized`（401/403，token 错或 scope 不足）、`not-found`（404，base URL 指向了非 API 根）、
`unreachable`（DNS / 连接失败 / 超时，含原始 errno）、`bad-response`（2xx 但响应体不含期望字段，通常
是 base URL 指到了反代的登录页）。响应中**永不回显 token**。

## 3. 节点 schema

新 `NodeKind`：`'code-host-call'`，加入 `NODE_KIND`（`packages/shared/src/schemas/workflow.ts`）。

**实现期勘误**：初稿写「`WORKFLOW_SCHEMA_VERSION` 4 → 5」。实读发现**近例不 bump** ——
RFC-243（`call-workflow` / `call-workgroup`）与 RFC-253（`script`）都新增了 NodeKind 而版本停在
RFC-056 的 4。理由成立：bump 是纯元数据（老文档不可能含新 kind），却要改判一批断言。本 RFC 跟随
近例**不 bump**。旧二进制读到新 kind 时在闭合枚举上 fail closed（`unknown-node-kind`），这正是
一个有外部副作用的节点该有的结果。

```ts
export const CODE_HOST_PROVIDERS = ['gitlab', 'github'] as const   // 与 webhook 的 provider 同源

export const CodeHostCallNodeSchema = WorkflowNodeSchema.extend({
  kind: z.literal('code-host-call'),
  provider: CodeHostProviderSchema,
  /** 动作 key，含 'custom'（逃生舱）。 */
  action: CodeHostActionSchema,
  /** 定型表单字段值。全部是**模板字符串**，运行期渲染。 */
  params: z.record(z.string(), z.string().max(PARAM_MAX)).default({}),
  /** action === 'custom' 时必填。 */
  request: CodeHostCustomRequestSchema.optional(),
  /** DELETE 的显式闸（Q9）。缺省 = false。 */
  allowDestructive: z.boolean().optional(),
  /** 单次请求总超时；缺省取 config 默认。 */
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
}).passthrough()

export const CodeHostCustomRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** **相对** path，模板。以 '/' 开头，拼在 base URL 之后。 */
  path: z.string().min(1).max(2048),
  /** 可选 query（值是模板）。 */
  query: z.record(z.string(), z.string().max(PARAM_MAX)).optional(),
  /** 可选 JSON body 模板（骨架必须是合法 JSON —— §5.2）。 */
  body: z.string().max(BODY_MAX).optional(),
}).strict()
```

**D8**：`params` 一律是 `string`。像 commit status 的 `state` 这种枚举字段，UI 给下拉但值仍是字符串，
因为用户故事 2 需要它来自上游端口（`{{verdict}}`）。枚举的合法性因此在**运行期**判定（非法值 → 节点
失败，错误信息列出合法取值），保存期只在**字面量**（不含 `{{`）时校验。

## 4. 动作注册表（本 RFC 的核心资产）

**D9**：一张表，前后端共用，`satisfies Record<CodeHostAction, CodeHostActionDef>` —— 新增动作或新增
provider 时漏填即 typecheck 红。表放 `packages/shared/src/codeHost/actions.ts`。

```ts
interface CodeHostActionDef {
  group: 'comment' | 'mr' | 'pipeline' | 'read' | 'custom'   // UI 分组（Q5）
  labelKey: string; descKey: string
  /** 每家的映射；null = 该家不支持，UI 置灰并显示 reasonKey。 */
  bindings: Record<CodeHostProvider, CodeHostBinding | { unsupported: true; reasonKey: string }>
  /** 定型表单字段（provider 无关的并集；每个字段声明它在哪家必填）。 */
  fields: readonly CodeHostFieldDef[]
}
interface CodeHostBinding {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  /** path 模板，只允许引用 fields 里的字段名与 __project__。 */
  path: string
  /** 放进 query / JSON body 的字段映射（各家参数名不同）。 */
  query?: Record<string, string>
  body?: Record<string, string>
  /** 该 binding 的特殊语义开关（目前只有 followRedirectStripAuth，见 §7.5）。 */
  quirks?: readonly CodeHostQuirk[]
}
```

### 4.1 完整映射表

`{P}` = 解析后的 project 定位段（GitLab：URL-encode 的 `namespace/path` 或数字 id；
GitHub：`{owner}/{repo}`，见 §5.4）。所有 `{...}` 值都经 §5.2 的编码规则处理。

**评论类（`comment`）**

| 动作 | GitLab | GitHub |
|---|---|---|
| `comment.reply-thread` 回复到同一线程 | `POST /projects/{P}/merge_requests/{mr}/discussions/{thread}/notes` body `{body}` | 首选 `POST /repos/{P}/pulls/{mr}/comments/{thread}/replies` body `{body}`；404/405 时兼容 `POST /repos/{P}/pulls/{mr}/comments` body `{body, in_reply_to: thread}` |
| `comment.create` 在 MR/PR 上新开一条 | `POST /projects/{P}/merge_requests/{mr}/notes` body `{body}` | `POST /repos/{P}/issues/{mr}/comments` body `{body}` |
| `comment.create-inline` 在 diff 行新建线程 | `POST /projects/{P}/merge_requests/{mr}/discussions` body `{body, position}` | `POST /repos/{P}/pulls/{mr}/comments` body `{body, ...position}` |
| `comment.update` 编辑自己发的评论 | `PUT /projects/{P}/merge_requests/{mr}/notes/{comment}` body `{body}` | `PATCH /repos/{P}/pulls/comments/{comment}`（行内）/ `PATCH /repos/{P}/issues/comments/{comment}`（普通）—— 由 `comment_scope` 字段选择，缺省 `inline` |
| `thread.resolve` resolve 线程 | `PUT /projects/{P}/merge_requests/{mr}/discussions/{thread}` body `{resolved: true}` | **不支持** —— REST 无此端点，`resolveReviewThread` 只在 GraphQL，且线程的 `PRRT_` node id 在 REST 面根本拿不到 |

`comment.create-inline` 的 `position` 字段直接吃 RFC-263 的 `{{trigger.comment_position_json}}`：
该变量本就是**按各自建评论 API 的参数名打包、原样可回传**的（GitLab 保留 null 因其有语义、GitHub 省略
null 因传 null 必 422）。GitLab 放进 `position` 键下，GitHub 展开到 body 顶层 —— 差异吸收在 binding 里，
用户两家都只填一个 `position` 字段。

**MR 状态类（`mr`）**

| 动作 | GitLab | GitHub |
|---|---|---|
| `commit-status.set` 设 commit status | `POST /projects/{P}/statuses/{sha}` query `{state, name, description, target_url}` | `POST /repos/{P}/statuses/{sha}` body `{state, context, description, target_url}` |
| `label.add` 打 label | `PUT /projects/{P}/merge_requests/{mr}` body `{add_labels}`（逗号分隔） | `POST /repos/{P}/issues/{mr}/labels` body `{labels}`（数组） |
| `assignee.set` 指派 | `PUT /projects/{P}/merge_requests/{mr}` body `{assignee_ids}`（数字 id） | `POST /repos/{P}/issues/{mr}/assignees` body `{assignees}`（login） |
| `mr.approve` 批准 | `POST /projects/{P}/merge_requests/{mr}/approve` | `POST /repos/{P}/pulls/{mr}/reviews` body `{event:'APPROVE', body}` |
| `mr.merge` 合并 | `PUT /projects/{P}/merge_requests/{mr}/merge` body `{squash, merge_commit_message}` | `PUT /repos/{P}/pulls/{mr}/merge` body `{merge_method, commit_title}` |
| `mr.create` 创建 MR/PR | `POST /projects/{P}/merge_requests` body `{source_branch, target_branch, title, description}` | `POST /repos/{P}/pulls` body `{head, base, title, body}` |

**D10 `state` 三档归一**：`commit-status.set` 的 `state` 字段对外只有 `pending | success | failed`，
binding 各自映射（GitLab `failed` / GitHub `failure`）。两家的其余取值（GitLab `running`/`canceled`、
GitHub `error`）不进产品面 —— 三档覆盖「审计中 / 通过 / 不通过」的全部用例，多出来的档只会制造
provider 特有知识。`label.add` / `assignee.set` 的字段值统一填**逗号分隔字符串**，binding 负责在
GitHub 侧转成数组。两家语义差异（GitLab 要数字 user id、GitHub 要 login）写进字段 hint，不强行归一
—— 它们是不同的东西，假装一样会让人填错。

**Pipeline 类（`pipeline`）**

| 动作 | GitLab | GitHub |
|---|---|---|
| `pipeline.trigger` 触发流水线 | `POST /projects/{P}/pipeline` query `{ref}` | `POST /repos/{P}/actions/workflows/{workflow}/dispatches` body `{ref, inputs}` —— **多一个必填字段** `workflow`（工作流文件名或 id），GitLab 侧该字段隐藏 |
| `pipeline.retry` 重跑 | `POST /projects/{P}/pipelines/{pipeline}/retry` | `POST /repos/{P}/actions/runs/{pipeline}/rerun-failed-jobs` |
| `pipeline.cancel` 取消 | `POST /projects/{P}/pipelines/{pipeline}/cancel` | `POST /repos/{P}/actions/runs/{pipeline}/cancel` |
| `job.list` 列 job | `GET /projects/{P}/pipelines/{pipeline}/jobs` query `{scope}` | `GET /repos/{P}/actions/runs/{pipeline}/jobs` query `{filter}` |
| `job.log` 拉 job 日志 | `GET /projects/{P}/jobs/{job}/trace`（直接返回纯文本） | `GET /repos/{P}/actions/jobs/{job}/logs` —— **302 到跨主机签名 URL**，quirk `followRedirectStripAuth`（§7.5） |

**读取类（`read`）**

| 动作 | GitLab | GitHub |
|---|---|---|
| `mr.diff` 拉 MR diff | 首选 `GET /projects/{P}/merge_requests/{mr}/diffs`；404/405 时兼容旧部署的 `/changes`（后者自 15.7 弃用、v5 移除） | `GET /repos/{P}/pulls/{mr}/files` |
| `mr.list` 列 MR | `GET /projects/{P}/merge_requests` query `{state, per_page}` | `GET /repos/{P}/pulls` query `{state, per_page}` |
| `file.read` 读仓库文件 | `GET /projects/{P}/repository/files/{path}/raw` query `{ref}` | `GET /repos/{P}/contents/{path}` query `{ref}`，header `Accept: application/vnd.github.raw` |

**自定义（`custom`）** —— `request` 字段生效，§5.3 的安全规则全部适用。

**部署版本兼容补充（2026-08-12）**：binding 可以声明完整的候选请求（method/path/query/body），
执行器按新到旧尝试。只有 404/405 代表“当前路由不存在”并进入下一候选；403、422、429、5xx、网络
错误与重定向失败保持原失败，不得借回退掩盖。每个候选独立复用 D18 重试、D19 重定向剥凭据及
RFC-277 TLS 约束。若所有候选都不存在，主错误保留首选路径，并列出实际尝试的候选。输出仍遵守
AC-8：返回实际命中接口的响应体原文，不做跨版本外形改写。

### 4.2 外部依据

2026-08-12 复核：GitHub 官方无 REST 的 resolve review thread 端点（`resolveReviewThread` 为 GraphQL
mutation，线程 `PRRT_` node id 亦仅 GraphQL 可得）；GitLab `GET /projects/:id/merge_requests/:iid/changes`
自 15.7 弃用、指向 list merge request diffs，但旧部署/兼容实现可能只提供前者；GitHub review comment
回复同时有专用 `/comments/{comment_id}/replies` 与 create-review-comment 的 `in_reply_to` 写法；GitHub
`GET /repos/{o}/{r}/actions/jobs/{job_id}/logs`
返回 302 + `Location` 指向有效期约 1 分钟的签名 URL（`pipelines.actions.githubusercontent.com`）。
其余端点按官方文档形态实现，proposal §8 列了七项待实测项。

## 5. 参数解析与请求构造

### 5.1 模板变量

两个命名空间，共用 `{{ }}` 语法：

- `{{port_name}}` —— 上游端口值。与 agent 节点 prompt 模板同一套解析（`packages/shared/src/prompt.ts`），
  可达端口集由 `nodePorts.ts` 的既有推导给出。
- `{{trigger.<var>}}` —— 触发事件上下文，`<var>` ∈ **`TRIGGER_CONTEXT_VARS`**（§6）。

**D11**：两个命名空间不重叠 —— `trigger.` 前缀在端口名里非法（端口名语法不含 `.`），所以解析无歧义。
`{{__repo_path__}}` 等既有内置变量**不进**本节点（它是宿主文件系统路径，对一次 HTTP 调用没有意义，
给了只会诱导把本机路径发到外部服务）。

### 5.2 编码规则（安全承重）

**D12**：渲染值**永不做字符串拼接**。每个变量值先渲染为字符串，再按它所处的**位置类型**编码：

| 位置 | 编码 | 理由 |
|---|---|---|
| path 段 | `encodeURIComponent`（含 `/`），**整个字段值**而不只是其中的模板变量 | 值是 id / iid / 文件路径。GitLab 的 `file.read` 正需要整路径 percent-encode；顺带堵死用变量值往 path 里塞 `../` 或新段。**实现期修正**：初稿只对模板变量编码，于是字面量 `src/a b.ts` 的斜杠原样进 URL，被 GitLab 当成多个路径段而 404 —— 编码必须作用在字段值整体上。唯一例外是 `{__project__}`：推导值自带编码，显式值走 `encodeProjectLocator`（GitLab 只把 `/` 换成 `%2F`，这样 `grp/repo`、`grp%2Frepo`、数字 id 三种写法都对；GitHub 的 `owner/repo` 本来就是两段，原样保留） |
| query 值 | `URLSearchParams` | 同上，且天然处理 `&` `=` |
| JSON body 字符串字面量内 | JSON 字符串转义 | 评论正文里的引号 / 换行 / 反斜杠不会破坏 body 结构 |
| JSON body 的其它位置 | **保存期拒绝** | 见 D13 |

**D13**：自定义 body 里变量**只能出现在 JSON 字符串字面量内部**。保存期把每个 `{{...}}` 替换成唯一
sentinel 后 `JSON.parse`，并检查每个 sentinel 落点是否为字符串值；落在数字 / 布尔 / 键名 / 结构位
（`{"n": {{x}}}`）一律 422，提示「把它写进字符串里」。这条规则让**上游值绝不可能改变请求的结构**，
与 RFC-253 D5（不把上游输出拼进代码正文）同源：一个能改 JSON 结构的上游值，等价于让上游 agent 替你
决定调用什么。

### 5.3 path 安全（自定义请求）

保存期规则，全部是可判定的纯函数（`packages/shared/src/codeHost/path.ts`）：

- 必须以 `/` 开头；不得以 `//` 开头（协议相对 URL）。
- 不得含 scheme（`^[a-z][a-z0-9+.-]*:`）—— 堵 `https://evil.example`、`file:`、`javascript:`。
- 不得含 `..` 段（`.` 段允许，`%2e%2e` 归一化后同样拒绝）。
- 不得含空白与控制符；不得含 `?` / `#`（query 走独立字段）。

**实现期勘误（2026-08-07 实证，Bun 的 WHATWG URL）**，初稿两条判断被推翻：

- **`@` 那条删除**。`base + '/x@evil.example/y'` 的 origin 不变 —— `@` 在 path 段里无害，而
  GitLab 的 `@scope` 包端点**需要**它，判负是误伤。反斜杠同理无害。
- **兜底从「origin 复核」升级为「origin + base pathname 前缀**双复核**」**。只查 origin 拦不住
  `base + '/../../admin'` → `https://gitlab.corp.example/admin`：origin 一字未变，却已经从 API 根
  跳到了 GitLab 的**管理界面**。`%2e%2e` 会被 URL 类解码归一，所以判据必须先把 `%2e` 还原成点。

职责因此按环境切分：**保存期**判据是纯字符串操作，留在 shared（`codeHost/path.ts`）；**运行期**的
最终 URL 构造与双复核在 backend（`services/codeHost/url.ts`）—— 它要的是 `..` 与 percent 编码被
**归一化之后**的结果，而 shared 是零环境依赖层（`lib: ["ES2022"]` + `types: []`），根本拿不到
`URL`（`git-url.ts` 同样自己手写解析）。

### 5.4 project 定位（Q11）

`params.project` 留空时按下列顺序解析，任一步失败即**节点失败**并给出可读原因（不猜、不回退）：

1. 任务是**多仓**任务（RFC-066，`task_repos` 多行）⇒ **保存期**就拒绝（校验规则 R7），因为「当前
   任务的仓库」在多仓下无定义。
2. 取任务仓库的 URL（`tasks.repo_url` 已 redact，凭据从 `cached_repos.url_enc` unseal 后解析），
   用既有 `packages/shared/src/git-url.ts` 解析出 host + path。
3. 校验 host 与所配 base URL 的 host **相等**；不等 ⇒ 失败 `code-host-project-foreign`，文案明确
   「任务仓库 `git.other.example` 不属于所配置的 GitLab 实例 `gitlab.corp.example`」。

   **实现期勘误**：公有 GitHub 的 API 主机与仓库主机**本来就不同**（`api.github.com` vs
   `github.com`），所以「相等」这条判据在 github.com 上恒假 —— 初稿会让每个 GitHub 任务都报
   foreign。判据改为「repo host 等于该 base URL 的**期望仓库主机**」：`api.github.com` ⇒
   `github.com`（含 `www.` 变体），GHES 与 GitLab 没有这种分裂，仍是同主机比较。
4. GitLab ⇒ `encodeURIComponent(namespace/path)`；GitHub ⇒ `owner/repo`。

显式填写时直接用该值（仍按 D12 编码），支持数字 id 与 `{{trigger.project_id}}`。

## 6. 触发上下文快照（Q6）

**D14**：`tasks` 新增一列 `trigger_context_json TEXT`（NULL = 非 webhook 启动）。写入点在 webhook 的
启动路径（`packages/backend/src/services/webhook/webhookDispatch.ts`，`buildStartTaskDeps` →
`startExecution` 之间），与 fire 记账同一事务。

存的是**变量投影**而非原始 payload：

```ts
export const TRIGGER_CONTEXT_VARS = WEBHOOK_TEMPLATE_VARS.filter(v => v !== 'event_json')
// ⇒ 29 项，与 RFC-263 的变量表同源（单一事实源，不新建命名空间）
```

**D15 为什么不含 `event_json`**：它是 32 KiB 截断的完整 payload，塞进一次外部 API 调用没有实际用例，
却会把外部原始数据的保留期从「投递表 90 天 GC」拉长到「与任务同寿」，并显著放大 C3/C4 的面。需要
原始 payload 的场景继续走触发器模板 → agent（RFC-263 的既有路径）。

**D16 可见面收窄**（Q10）：`{{trigger.*}}` 的解析**只**发生在 `code-host-call` 节点的参数渲染里。
agent 的 prompt 模板、workgroup 目标、脚本节点 env 一律不解析该命名空间 —— 它们看到的是字面量
`{{trigger.x}}`。这条要加**双层锁**：解析器只在本节点的渲染入口被调用（源码层锁），以及一条断言
「agent prompt 渲染后仍含字面 `{{trigger.` 」的行为测试。理由见 proposal N4：不新开「外部文本 →
模型上下文」的直达通道。

## 7. 请求执行器

`packages/backend/src/services/codeHost/call.ts`，对称于 `services/scriptRun.ts`。

### 7.1 头部

| provider | 认证头 | 其它 |
|---|---|---|
| gitlab | `PRIVATE-TOKEN: <token>` | `Content-Type: application/json`（有 body 时） |
| github | `Authorization: Bearer <token>` | `Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28` |

**D17**：header 集合完全由平台决定，节点**不能**增删改任何 header（自定义请求也不行）。可覆盖 header
等于把 token 送到任意 `Host:`／伪造 `X-Forwarded-*`，收益为零。

### 7.2 超时

单请求总超时默认 30s（config `codeHostRequestTimeoutMs`），节点可覆盖（1s–300s）。用 `AbortSignal`
实现，超时归入「网络错误」类（§7.3）。

### 7.3 重试与幂等（关键）

**D18**：重试策略按 method 分档，因为一次 POST 评论重发就是一条重复评论：

| 情形 | GET / PUT / PATCH / DELETE（幂等） | POST |
|---|---|---|
| 429 | 重试（尊重 `Retry-After`，上限 2 次） | **重试**（429 表示请求未被执行） |
| 5xx | 重试（指数退避，上限 2 次） | **不重试**（无法确定是否已生效） |
| 网络错误 / 超时 | 重试（上限 2 次） | **不重试**（同上） |
| 4xx（非 429） | 不重试 | 不重试 |

节点级失败后仍可由用户手动重试（RFC-052 的既有单节点重试语义），那是人工判断，与自动重试不同档。

**没有节点级自动重试**（实现期明确）：脚本节点有 `defaultNodeRetries` 的重试循环，本节点**没有**。
HTTP 层已经在能分辨「安全重试」与「不安全重试」的地方做了退避；在它之上再套一层节点级重试，等于把
刚刚特意不重发的 POST 又重发一遍。

### 7.4 响应处理

- `status` 端口 = 三位状态码字符串。
- `response` 端口 = 响应体原文（不解析、不重排 —— 下游要什么由下游决定）。
- 上限 **256 KiB**（config `codeHostResponseMaxBytes`）。超出即截断，并在尾部追加显式标记
  `\n[truncated: N bytes omitted by agent-workflow]`。截断**不**算失败（job 日志天然超限，若因此失败
  则该动作不可用）。截断标记是必需的：一段静默截断的 JSON 会让下游 agent 在半截数据上下结论。
- 2xx 以外一律节点失败（Q7），`summary` 含 method + path + 状态码，`message` 含响应体前 2 KiB 摘要。
  两者都过 §7.6 的脱敏。

### 7.5 重定向

**D19**：默认 `redirect: 'manual'`，任何 3xx 视为失败（`code-host-redirect-refused`）。

唯一例外是带 `followRedirectStripAuth` quirk 的 binding（当前仅 GitHub `job.log`）：允许跟随**一次**
重定向，且

- 目标必须是 `https:`；
- **剥掉 `Authorization` 头**再请求目标 —— GitHub 的签名 URL 自带凭据、不需要也不该收到我们的 token；
  带着 token 跟随跨主机重定向是教科书式的凭据外泄；
- 目标响应不再允许二次重定向。

### 7.6 脱敏

token 绝不出现在：节点 `summary` / `message`、`node_run_events`、daemon 日志、`response` 端口、
API 响应、YAML 导出、intent dump、诊断输出。实现两层：

1. **结构上不放**：token 只进 header 组装，从不进任何被记录的字符串。
2. **最后一道网**：所有对外字符串过一次 redactor（`redactToken`，把已知 token 值替换为
   `‹redacted›`）。即便对方 API 把 token 原样回显（真实存在的坏行为），它也进不了错误信息 ——
   有专门的变异测试锁这条。

   **实现期勘误**：初稿要求把该 token 登记进 `intentSecretSlots.ts` 的闭合载体表。实读
   `services/intent/dumpBuilder.ts` 后取消 —— intent dump 只读 agents / mcps / plugins / skills /
   workflows / workgroups，**不读系统配置**，所以该登记没有任何消费者，属于 RFC-146 明令禁止的
   「假 SSOT」。改为一条源码层锁：`dumpBuilder` 不得 import `codeHostConnections`。

### 7.7 并发

**D20**：`NodePoolKind`（`packages/backend/src/services/processNodeConcurrency.ts:32`）新增
`'code-host'`，config 新增 `maxConcurrentCodeHostCalls`（默认 8），`resizeAllNodePools` 同步扩到三池，
`PUT /api/config` 的热生效点（RFC-266）一并 resize。

理由与 RFC-266 给脚本节点独立池完全一致：一次 HTTP 调用是秒级的，让它和分钟级的 agent 抢同一把闸，
等于让回帖排在审计后面。**注意 RFC-243 的教训**：`buildChildDeps` 必须搬运新键，否则子任务启动会把
管理员配置静默改回默认值并影响整个 daemon（RFC-266 实现期踩过，已加源码锚点锁 —— 本 RFC 同样要加）。

## 8. 权限

**D21**：新权限点 `code-host-calls:author`，三处登记与 RFC-253 的 `scripts:author` 逐字对称
（`packages/shared/src/schemas/permission.ts:193 / 239 / 390`）：

- 进 `PERMISSIONS`（系统域，非资源域 —— 它不是某类资源的 CRUD 动词，而是一种能力）；
- 进 `SYSTEM_DOMAIN_POINTS` ⇒ **永不上令牌**，一枚勾满矩阵的 PAT 也拿不到它；
- 进 `MANAGER_EXTRA` ⇒ 角色基线 admin + manager（Q3）。系统域约束的是**令牌面**不是角色面，
  `account:self` / `intent:*` 同为系统域却在 user 基线里 —— 这条既有注释本身就是先例。

判定方式照搬 `services/scriptAuthorGate.ts`：按节点的**敏感投影哈希**判断是否需要该权限 —— 移动位置、
改标题、改连线不要点；改 provider / action / params / request / allowDestructive 才要点。覆盖四条
入口：工作流保存（新建 + 更新）、YAML 导入、复制、intent changeset 应用。

凭据配置面（`GET/PUT /api/code-hosts/*`、测试连接）走 `settings:read` / `settings:write`，与设置页
其余项一致 ⇒ admin only。

## 9. 端口与失败语义

**D22**：固定两个输出端口（Q8）：`response`（kind 默认纯文本）、`status`。二者都可不连。节点无输入
端口 —— 上游值通过模板引用，而不是通过端口连线传入（与 agent 节点的 prompt 模板一致）；连线仍然决定
**执行顺序**与可引用端口集。

失败语义（Q7）：非 2xx / 网络错误 / 重定向被拒 / 参数解析失败 ⇒ 节点 `failed`，两个端口都不产生值。
下游按既有 DAG 语义不执行。用户可单节点重试（RFC-052 级联规则照常）。

**D23 重试的副作用不回滚**：与 RFC-253 的脚本节点同款告知 —— 平台能回滚工作区文件（git stash 快照），
**回滚不了已经发出去的评论**。UI 在重试确认处显式提示这一点。

## 10. 前端

- **Palette**：新分区 `integrations`（`PaletteSectionKey` 新成员），一行「代码平台调用」。
  `PALETTE_DESCRIPTORS`（`packages/frontend/src/components/canvas/nodePalette.ts:70+`）新增行，
  `satisfies Record<NodeKind, …>` 保证漏填即编译红。glyph 用 `⇄`。
- **Inspector**：provider 用既有 `.segmented`（两档互斥，CLAUDE.md 指定形态）；动作用公共
  `<Select>` —— 它**已支持** `group` 字段做分组表头（`packages/frontend/src/components/Select.tsx:35-44`，
  ModelSelect 的 provider 分组即先例），因此 Q5 的「分类呈现」零组件改动即可满足；定型表单用
  `<Field>` / `<TextInput>` / `<TextArea>` / `<Switch>`；变量提示复用 RFC-263 的 `<TemplateVarChips>`
  （已支持 `groups`），两组：上游端口 / 触发上下文。
- **不支持的动作**：`<Select>` 的选项禁用 + 分组内保留（不隐藏），hover / 描述位给出原因，避免用户
  以为「GitHub 没这个功能」而去自定义请求里瞎试。
- **设置页**：`/settings` 新分区 `code-hosts`，归入既有 `access` 分组（与 Network / Authentication
  同组，`packages/frontend/src/routes/settings.tsx:298-312`）。每家一个卡片：base URL + token（密码型，
  显示 `••••1234` 掩码）+ 「测试连接」按钮 + 上次测试结果。非 admin 不渲染该分区。
- **i18n**：双语齐全。注意 RFC-211 守卫 —— hint 文案里**不得**出现字面 markdown（`**`），
  RFC-266 因此推红过一次。

## 11. 校验规则（`services/workflow.validator.ts`）

| 规则 | 判据 | 错误码 |
|---|---|---|
| R1 | provider ∈ 枚举 | `code-host-provider-invalid` |
| R2 | action ∈ 该 provider 支持集 | `code-host-action-unsupported` |
| R3 | 动作声明的必填字段非空 | `code-host-param-missing` |
| R4 | custom：method 合法；DELETE ⇒ `allowDestructive === true` | `code-host-method-forbidden` |
| R5 | custom：path 过 §5.3 全部判据 | `code-host-path-invalid` |
| R6 | custom：body sentinel 替换后是合法 JSON，且变量只落字符串字面量（D13） | `code-host-body-invalid` |
| ~~R7~~ | **实现期删除**：多仓是**启动参数**（RFC-066 的 `task_repos`），不是工作流定义的属性，保存期无从判定。改为运行期由 `resolveProjectFallback` 报 `code-host-project-unresolved` 并说明「本任务跨多个仓库，请显式填写 project」。 | — |
| R8 | 模板变量：端口名 ∈ 上游可达端口；trigger 变量 ∈ `TRIGGER_CONTEXT_VARS` | `code-host-var-unknown` |
| R9 | 枚举型字段的**字面量**取值合法（含 `{{` 时跳过，运行期判） | `code-host-param-invalid` |

**D24**：**不**校验「该工作流是否真有 webhook 触发器」。触发器是独立资源、可随后创建/删除，保存期
校验会在「先建工作流再建触发器」这个自然顺序上产生假红。运行期若 `trigger_context_json` 为 NULL 而
必填定位参数渲染为空，则节点失败并明确提示「该任务不是由 webhook 触发，`{{trigger.*}}` 无值」。

## 12. 失败模式

| 失败码 | 触发条件 | 用户可见文案要点 |
|---|---|---|
| `code-host-not-configured` | 该 provider 无凭据行 | 去设置页配置，附直达链接 |
| `code-host-project-foreign` | 任务仓库 host ≠ base URL host | 两个 host 都列出来 |
| `code-host-project-unresolved` | 仓库 URL 解析不出 namespace/path | 建议显式填 project |
| `code-host-http-error` | 非 2xx | method + path + 状态码 + 响应摘要（脱敏后） |
| `code-host-redirect-refused` | 非白名单 3xx | 说明平台不跟随跨主机重定向 |
| `code-host-network-error` | DNS / 连接 / 超时 | 含 errno，提示检查内网连通性 |
| `code-host-param-invalid` | 运行期枚举值非法 / 必填渲染为空 | 列出合法取值或空值来源 |
| `code-host-response-unreadable` | 响应体非 UTF-8 | 说明只支持文本响应 |

## 13. 测试策略

按 CLAUDE.md「测试随每次改动」，正向 / 边界 / 错误路径同批交付。

**shared**
- 动作注册表穷尽性（`satisfies`）+ 每个 binding 的 path 模板只引用已声明字段（纯函数遍历断言）。
- 模板渲染 × 三种编码位置（path / query / JSON 字符串），含引号、换行、反斜杠、中文、emoji。
- D13 落点判定：变量在字符串内 ✅ / 在数字位 ❌ / 在键名 ❌ / 在数组元素字符串内 ✅。
- path 安全判定：绝对 URL / 协议相对 / `..` / `%2e%2e` / `@` / 合法相对路径。
- `TRIGGER_CONTEXT_VARS` = `WEBHOOK_TEMPLATE_VARS` \ `{event_json}`（锁住单一事实源，RFC-263 加变量
  时本表自动跟随）。

**backend**（`fetch` 注入 mock，不打真网）
- 每个动作 × 每家 provider 的请求快照（method / URL / header / body 逐字节）—— 19 × 2 减去 unsupported。
- 401 / 404 / 422 ⇒ 节点 failed，token 不出现在任何输出（**变异测试**：故意把 token 塞进 summary
  的分支必须被 redactor 抹掉）。
- 429 重试尊重 `Retry-After`；5xx 对 PUT 重试、对 POST **不**重试（D18 两条独立断言）。
- 跨主机 302 被拒；`job.log` 的 302 跟随一次且第二跳**无 `Authorization` 头**（断言 header 缺失）。
- 响应 300 KiB ⇒ 截断 + 尾部标记 + 节点仍 done。
- project 留空：单仓推导成功 / host 不匹配失败 / 多仓保存期拒绝。
- 权限门四入口 × 三角色 × PAT（AC-21 专项：勾满矩阵的 PAT 拿不到该点）。
- trigger 快照：webhook 启动写入且不含 `event_json`；手动启动为 NULL。
- **D16 双层锁**：agent prompt 渲染后仍含字面 `{{trigger.`。
- **T-lock-1 源码层锁**：`services/codeHost/**` 不出现 `Bun.spawn` / `containedSpawn`（RFC-253 的
  spawn 站点登记表已有同类先例，追加一条即可）。
- 并发池：三池独立；`buildChildDeps` 搬运新键（RFC-243/266 踩过的漏接线，加锚点锁）。
- 路由：凭据 PUT 保留语义 / 清除语义 / 读路径掩码 / 非 admin 403 / 测试连接四类错误可区分。

**frontend**
- Inspector：provider 切换后表单字段随动；unsupported 动作禁用且给原因；动作按四组带表头渲染
  （`getByRole('option')` + 分组表头存在性）。
- 设置页：掩码显示、保存不回传明文、非 admin 不渲染分区、测试连接三态。
- 权限：`user` 角色下节点表单只读、palette 不出该行。

**e2e**
- 一条完整链：假 code host server（本地 HTTP）→ webhook 投递 → 任务启动 → agent 产出 → 调用节点回帖 →
  断言假 server 收到的请求体与线程 id 正确。

## 14. 迁移

单个迁移文件：

1. `CREATE TABLE code_host_connections`（§2）。
2. `ALTER TABLE tasks ADD COLUMN trigger_context_json TEXT`（可空，无默认）。

**零回填**：存量任务该列为 NULL（= 无触发上下文，与「不是 webhook 启动」同义，语义正确）。
`WORKFLOW_SCHEMA_VERSION` 4→5 是纯元数据 bump，存量工作流文档不含新 kind，透明升级。

**旧二进制读新数据**：`WorkflowNodeSchema` 是 `.passthrough()`，但 `NODE_KIND` 枚举是闭合的 ——
旧二进制遇到 `code-host-call` 节点会在校验期报 `unknown-node-kind`（fail closed，与 RFC-060 处置
`agent-multi` 历史夹具同款）。这是正确行为：宁可拒绝，也不能把一个它不认识的、会产生外部副作用的
节点静默跳过。

## 15. 与既有 RFC 的交集

- **RFC-257/259/263**：只读消费它们的信封与变量表；入站路径零改动。唯一新增是 §6 的快照写入点。
- **RFC-253**：结构对称（节点 kind / 权限门 / 独立池 / 执行器模块布局），但**无交集** —— 脚本节点跑
  子进程受 containment 约束，本节点不跑子进程、不进准入面。
- **RFC-266**：直接扩展它的双池为三池，热生效点复用。
- **RFC-224/251/227/233**：**零交集**。不动 `SAFE_FORWARD_ENV`、不动受控 config、不动 containment。
  这正是本方案相对 RFC-265 的核心优势。
- **RFC-200**：`response` 端口进入下游 prompt 时继续走既有注入围栏，不新开旁路。
- **RFC-234**：新凭据登记进 `intentSecretSlots.ts` 闭合载体表（§7.6）。
