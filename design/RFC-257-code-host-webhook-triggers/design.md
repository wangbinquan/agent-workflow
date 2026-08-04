# RFC-257 · 技术设计

状态：Draft（设计门 findings 已折入，见 [design-gate-2026-08-04.md](./design-gate-2026-08-04.md)）。读法：先 proposal.md（决策 D1–D24 与 AC），本篇是接口契约与数据流。所有「既有代码」断言均附 file:line；GitLab 侧行为断言以 T3 fixture 实测为准。

## 0. 总览：五步分流流水线（三段式应答）

```
GitLab (group/system/project hook, 几百仓, 一个 URL)
  │ POST /webhooks/gitlab/{urlToken}
  ▼
[同步段 · HTTP 请求内]
[1] 限流 → 端点查找(404 同形) → body 上限 → 验签(401) → JSON 解析 → 去重(UUID 唯一索引)
    → 归一化 normalize()（unsupported 在此终结）
    → 插 webhook_deliveries 行 status='received' → **立即响应 200 {deliveryId}**
[异步段 · dispatch job]
[2] 行置 processing → 遍历该 endpoint 下 enabled 触发器 × matchTrigger(event, trigger)
[3] 命中集（0..N）；0 命中 → 终态 ignored(no-trigger-matched)
[4] 逐触发器：acquire keyed-mutex (triggerId, streamKey)
    → supersede 取消旧任务 → 熔断计数检查（含重置评估）
[5] repo 解析 → owner actor 重建 + 可启动性重校验 → 模板渲染 + 全量启动校验
    → startExecution(kind, invoker:{type:'webhook',...}) → release mutex
    → fires 落结果 → delivery 终态 matched
```

三段式动机（D23 / 设计门 F-4）：supersede 内的 `cancelTask` 最多 5s 轮询（`services/task.ts:2626-2637`）、auto-register 的 clone 分钟级（`services/task.ts:645`），而 **GitLab webhook 超时约 10s 且失败不自动重试**——分发必须移出 HTTP 同步路径。

设计承重原则：

- **「收到 HTTP 请求」与「产生一次执行」分层**：deliveries（HTTP 层一投递一行，含 received/processing 中间态）与 fires（delivery × trigger 命中一行）。恢复主路径 = 平台 replay（GitLab 侧只有手工 Resend，D20）。
- **触发器绑规则不绑仓**：任务的 repo 从事件里动态解析；workflow 定义本身与仓库无关。
- **provider 信封边界**：核心只读归一化信封；平台特有字段留在 `raw`（multica `channel/doc.go` 边界规则）。
- **启动唯一收口**：fire 必须走 `startExecution`（`services/execution/executor.ts:54-77`）。RFC-243 的 source-text lock 是**硬编码调用面清单**（`tests/rfc243-executor-facade.test.ts` `CALL_FACES`），**不自动覆盖新文件**——`services/webhookDispatch.ts` 必须显式加入清单（设计门 F-7，T6 交付物）。

## 1. 数据模型（迁移 0138：五张新表 + `tasks` 两列）

### 1.1 `webhook_endpoints` — 全局接收端点（预期只有 1 行，支持多行）

| 列 | 类型 | 说明 |
|---|---|---|
| id | text PK | ULID |
| name | text NN | 显示名 |
| provider | text NN enum('gitlab') | closed enum |
| url_token | text NN UNIQUE | `aw_whk_` + base64url(32B)，铸造与 INSERT 同语句 + 冲突重试（multica 模式） |
| secret_enc | text NN | secretBox 密封（D18） |
| enabled | int bool NN default 1 | |
| preferred_clone_protocol | text NN enum('http','ssh') default 'http' | 自动注册用哪个 payload URL（D13） |
| last_delivery_at / created_at / updated_at | int | |

**删除语义（F-15）**：有 triggers 引用时 **restrict** 拒删（`CachedRepoHasReferencesError` 同款先例，`gitRepoCache.ts:956`）；触发器**不可换绑** endpoint_id（需重建）。

### 1.2 `webhook_triggers` — owner 制资源（沿 `scheduled_tasks`，D19 修订版）

**不进** `ACL_TABLES` / `ACL_RESOURCE_TYPES` / `resource_grants`——fire 以 owner 身份执行，grants 写权 = 提权通道；权限模型逐字沿 `scheduled_tasks`（owner + admin 旁路，`db/schema.ts:1091-1092` 注释明言该表有意弃用 ACL 的同一理由）。路由权限点对齐 `routes/scheduledTasks.ts` 的既有惯例（T1 落定）。

| 列 | 类型 | 说明 |
|---|---|---|
| id / name | | ULID / 显示名 |
| endpoint_id | text NN → webhook_endpoints | restrict 级联；匹配阶段只扫同 endpoint 触发器（F-15） |
| owner_user_id | text NN | fire 以此身份启动；保存/更新时**以保存者身份**校验目标资源可见性（AC-17） |
| enabled | int bool NN default 1 | |
| repo_scope | text NN | JSON：`{kind:'all'} \| {kind:'prefix', prefix} \| {kind:'exact', paths[]}`（按 `path_with_namespace`） |
| event_types | text NN | JSON string[]（§2.2 枚举） |
| branch_filter | text | glob；MR 类按**目标分支**，push/tag/无-MR-pipeline 按事件分支 |
| command_prefix | text | note 事件指令前缀 |
| ignore_usernames | text NN default '[]' | **作用域 = push/tag_push/mr_*/note 的命中过滤；pipeline 类事件不过滤**（D14）；同一名单复用于熔断重置判定（D22） |
| launch_kind | text NN enum('workflow','agent','workgroup') | 对齐 `scheduled_tasks.launch_kind`（`db/schema.ts:1102-1104`） |
| launch_ref_id | text NN | workflowId / agentId / workgroupId（单一事实源；payload 内不重复存 ref，F-3） |
| launch_payload | text NN | JSON 启动参数**模板**。校验用**新派生的触发器模板封套 schema**（F-3）：基于 StartTask/StartAgentTask/StartWorkgroupTask 派生——repo 三态 + `ref` **禁填**（fire 注入，绕开 `start-task-source-required` superRefine，`shared/schemas/task.ts:787-794`）、`name` 可省（fire 自动生成）、ref-id 外置到 `launch_ref_id`、含模板变量的值延迟格式校验（§4.2） |
| max_consecutive_fires | int NN default 3 | 熔断上限 |
| auto_register_repos | int bool NN default 1 | |
| last_fired_at / last_status('launched','failed') / last_error / last_task_id / consecutive_failures | | 镜像 `scheduled_tasks` 观测列（`db/schema.ts:1110-1113`）；`consecutive_failures` = 启动失败计数，≠ 熔断的 fire 计数 |

**删除级联**：trigger 删除 → fires/streams cascade 随删；deliveries 保留（端点级审计）。

### 1.3 `webhook_deliveries` — HTTP 投递审计

| 列 | 说明 |
|---|---|
| id, endpoint_id, received_at | |
| event_uuid | `X-Gitlab-Event-UUID`；**可空**——缺失时无去重、逐条处理（降级模式显式落测试，F-18）；重放行 NULL |
| attempt_count | int NN default 1；重复 UUID 命中占位行时 bump（F-11） |
| gitlab_event_header, object_kind | 原始判别符 |
| event_type, repo_path, stream_hint | 归一化摘要列（列表页免解析 body） |
| status | enum：`received`（已落库未分发）/ `processing`（分发中）/ `rejected` / `ignored` / `matched` / `failed`（F-4 中间态） |
| status_reason | closed enum：`invalid-token` / `missing-token` / `endpoint-disabled` / `no-trigger-matched` / `unsupported-event` / `parse-failed` / `internal-error` / `interrupted`（daemon 重启时 processing 行的终态） |
| body_json | 原始 payload ≤256KiB 截断入库（HTTP 层 body 上限 1MiB） |
| replayed_from_delivery_id | 重放行指回原行 |

**去重唯一索引**：`UNIQUE (endpoint_id, event_uuid) WHERE event_uuid IS NOT NULL AND status NOT IN ('rejected','failed')`——received/processing/matched/ignored 均占位（在途即挡重复分发）；rejected/failed 不占位（secret 修正后 Resend 能落地）。

**保留策略（F-12）**：hourly ticker（挂进 `cli/start.ts` 既有 ticker 组）——`body_json` 超 30 天置空、行超 90 天删除（常量，非 config）；fires 随其 trigger 生命周期，不单独 GC。

**daemon 重启恢复（D23）**：启动时把遗留 `processing`/`received` 行标 `failed(interrupted)`；恢复 = 手动 replay。

### 1.4 `webhook_trigger_fires`

| 列 | 说明 |
|---|---|
| id, delivery_id, trigger_id, fired_at, stream_key | |
| outcome | enum：`launched` / `launch-failed` / `skipped-circuit-open` / `skipped-repo-unregistered` / `skipped-owner-invalid` / `skipped-trigger-disabled`（统一 skipped-* 命名，F-14） |
| superseded_task_id / task_id / error | |

### 1.5 `webhook_trigger_streams` — 熔断计数

| 列 | 说明 |
|---|---|
| trigger_id + stream_key | UNIQUE；trigger 删除 cascade |
| consecutive_fires | 成功 launched 后 +1；≥ `max_consecutive_fires` ⇒ 熔断 |
| last_fire_at | 距今 > 24h（常量窗口）⇒ 惰性视为 0 |
| reset_at / reset_by | 人工重置审计 |

**重置语义（D22，F-1 修订）**：闸门评估顺序——①惰性过期检查；②**本事件 author ∉ ignoreUsernames ⇒ 清零**（「人已介入」；与命中过滤解耦：pipeline 事件不被名单挡在命中之外，但 bot 作者的 pipeline 事件**不清零**、正常累加——修到绿循环由此既能持续又有上限）；③计数 ≥ 上限 ⇒ `skipped-circuit-open`；④否则放行，launched 后 +1。人工重置 API 清零。

## 2. Provider 抽象与 GitLab adapter

### 2.1 接口（shared 类型 + backend 注册表）

```ts
interface CodeHostAdapter {
  readonly provider: 'gitlab'
  verify(headers: HeaderBag, secret: string): 'valid' | 'invalid' | 'missing'
  normalize(headers: HeaderBag, body: unknown):
    | { ok: true; event: CodeHostEvent }
    | { ok: false; reason: 'unsupported-event' | 'parse-failed'; detail: string }
}
// 出站占位（D1）：v1 仅类型定义，零实现零调用
interface CodeHostReportSink {
  postMrComment(ref: MrRef, body: string): Promise<void>
  setCommitStatus(ref: CommitRef, state: string, description: string): Promise<void>
}
```

注册表 `Record<provider, CodeHostAdapter>`；路径段 `/webhooks/:provider/:urlToken` 选 adapter，端点行 provider 与路径不一致 → 404 同形。

### 2.2 归一化信封 `CodeHostEvent`

```ts
{
  provider: 'gitlab'
  eventUuid: string | null
  eventType: 'push' | 'tag_push' | 'mr_opened' | 'mr_updated' | 'mr_merged' | 'mr_closed'
           | 'note' | 'pipeline_failed' | 'pipeline_succeeded'
  repoPath: string            // project.path_with_namespace
  repoHttpUrl: string; repoSshUrl: string
  repoKeys: string[]          // canonicalRepoKey(http) + canonicalRepoKey(ssh)（git-url.ts:297-306 不跨族折叠）
  branch?: string; targetBranch?: string
  mrIid?: string; mrTitle?: string
  commitSha?: string
  commentText?: string
  author: { username?: string; name?: string }
  pipelineStatus?: string
  raw: unknown                // 核心永不读；审计 + {{event_json}}
}
```

### 2.3 GitLab 映射表（字段路径以 T3 fixture 为准）

| object_kind + 判别 | eventType | 关键字段 |
|---|---|---|
| `push` | push | `ref`(去 `refs/heads/`)、`after`、**顶层 `user_username`**（push 无 `user{}`，待实证） |
| `tag_push` | tag_push | `ref`(去 `refs/tags/`) |
| `merge_request`，action∈{open,reopen} | mr_opened | `object_attributes.{iid,title,source_branch,target_branch,last_commit.id}`、`user.username` |
| 同上 action=update / merge / close | mr_updated / mr_merged / mr_closed | 同上 |
| `note` + noteable_type='MergeRequest' | note | `object_attributes.note`、`merge_request.{iid,source_branch,target_branch}`、`user.username` |
| `note` 其他 noteable_type | unsupported（v1 只做 MR 评论） | |
| `pipeline` status='failed' / 'success' | pipeline_failed / pipeline_succeeded | `object_attributes.{ref,sha}`、`merge_request.{iid,source_branch}`（MR 流水线）、`user.username`（**是否 = 触发流水线的 push 者：D14/D22 前提，T3 必实证**） |
| pipeline 其他 status / 其余 object_kind | unsupported → ignored(unsupported-event) | |

验签：`X-Gitlab-Token` 与 unseal 后 secret `crypto.timingSafeEqual`（GitLab 是**明文比对**非 GitHub HMAC；差异封在 adapter.verify 内）。

## 3. HTTP 端点契约

### 3.1 路由与公开性

- `POST /webhooks/:provider/:urlToken`——顶级路径，不在 `/api/*` 下 ⇒ 天然不经 `multiAuth`（`server.ts:168`），无需改 `PUBLIC_PATH_PREFIXES`（`auth/session.ts:41-49`）。
- 必须 `registerRoute` + `publicReason`（`routes/registry.ts:143-148`；gate 对零权限点 + 无 actor 放行已核实），否则 `assertRouteMetaCoverage`（`server.ts:248`）启动 throw。
- SPA 兜底为 GET-only（`server.ts:259-274`），POST 不受影响；仍以集成测试锁「未认证 POST 可达」（AC-18）。
- 给 GitLab 的完整 URL 用 `config.publicBaseUrl`（`shared/schemas/config.ts:603`）拼装，**禁止** `c.req.url` 推导（`docs/audit-backlog.md:81`；源码文本断言锁定）。

### 3.2 同步段处理顺序

1. **限流（F-16 修订）**：per-endpoint 内存滑窗 300/min → 429；per-IP 限流**只作用于未命中任何端点的请求**（防扫描）——反代部署下所有合法投递同源 IP，per-IP 阈值若覆盖合法流量会把几百仓的批量 push 风暴误伤成 429（且 GitLab 不重试 = 真丢事件）。滑窗时钟可注入（fake clock 测试，T5）。
2. `:urlToken` 查端点：`ErrNoRows → 404` 与 `DB error → 500` **严格区分**（multica `autopilot_webhook.go:362-365` 教训：塌缩 404 会静默丢投递）。
3. body 上限 1 MiB 流式截断 → 413。
4. 验签：invalid/missing → 落 `rejected` + 401。
5. JSON 解析失败 → 400 + `ignored(parse-failed)`。
6. 去重：命中占位行（含 received/processing 在途）→ bump `attempt_count`、200 + 原 deliveryId。
7. `normalize`：unsupported → 200 + `ignored(unsupported-event)`。
8. 端点 disabled → 200 + `ignored(endpoint-disabled)`（**不 4xx**：连续 4xx 会喂 GitLab auto-disable，见 §8）。
9. 插 `received` 行 → **200 + {deliveryId} 立即返回**；异步 dispatch job 入队（进程内，无持久队列——崩溃恢复靠 `interrupted` + replay，D23）。

### 3.3 状态码语义表（D20 修订版；锁进集成测试矩阵）

| 情形 | HTTP | delivery |
|---|---|---|
| token 不存在 / provider 不匹配 | 404（同形） | 不落行 |
| 验签失败 | 401 | rejected |
| 限流 | 429 | 不落行 |
| body 超限 | 413 | 不落行 |
| JSON 非法 | 400 | ignored(parse-failed) |
| 端点禁用 / 事件不支持 | 200 | ignored |
| 接收成功（分发异步） | 200 | received → 终态后写 |
| 重复 UUID | 200 | 原行 bump |
| 同步段内部错误 | 500 | failed（若行已插）/ 不落行 |

**500 的语义（F-6）**：如实报告，**不承担「让 GitLab 重投」职能**——自建 GitLab 对失败投递不自动重试（仅手工 Resend；连续失败还会 auto-disable hook）。恢复主路径 = 平台 replay。

## 4. 分流引擎（异步段）

### 4.1 纯函数面

```ts
matchTrigger(event, trigger): { hit: boolean; miss?: MissReason }
  // AND：repoScope ∧ eventType ∈ event_types
  //     ∧ branchGlob(MR 类看 targetBranch，其余看 branch)
  //     ∧ (eventType==='note' ⇒ commentText.trim() 以 command_prefix 开头)
  //     ∧ (eventType ∈ {push,tag_push,mr_*,note} ⇒ author.username ∉ ignore_usernames)
  //       —— pipeline 类事件不做作者过滤（D14；修到绿循环的生存条件）
streamKeyOf(event): string
  // F-2 修订：必含 repo 维度 —— `${repoPath}|mr:${iid}` / `${repoPath}|branch:${branch}`
  //（GitLab MR iid 是 per-project 序号，不含 repo 会跨仓互杀 + 熔断串桶）
renderLaunchTemplate(payloadTemplate, vars): { payload } | { error }
availableVarsFor(eventTypes): Set<VarName>    // 保存期静态校验（交集）
evaluateCircuit(stream, event, trigger, now): 'pass' | 'reset-then-pass' | 'open'   // §1.5 顺序
```

### 4.2 模板变量与输入 kind 感知（D16，F-10 修订）

变量集：`{{event_type}} {{repo_path}} {{repo_http_url}} {{repo_ssh_url}} {{branch}} {{target_branch}} {{mr_iid}} {{mr_title}} {{commit_sha}} {{comment_text}} {{comment_author}} {{pipeline_status}} {{event_json}}`

- `{{event_json}}` = 原始 payload JSON **截断 ≤32KiB**（`StartAgentTaskSchema.description/inputs` 值上限 65536、`StartWorkgroupTaskSchema.goal` 上限 65536——256KiB 原文塞任何注入面都必 422）。
- **保存期**：模板变量 ⊆ 所选 event_types 的交集可用集；必填 workflow 输入已覆盖；payload 禁 repoGroup/scratch/sourceTask/upload；**含模板变量的输入值跳过字面格式校验**。
- **workflow 的 packed kind 输入**（`workflowLaunchInputIssues` 对 git kind 要求 `{kind:'branch',ref}` JSON、enum 要求成员表，`services/workflowLaunchInputs.ts:150-199`）：git kind 映射为**结构化选项**「分支来自事件」——fire 时平台代包 `{"kind":"branch","ref":"<event.branch>"}`；text kind 直接模板；enum/files kind **不支持映射**（保存拒绝）。
- **运行期**：渲染后对最终 payload 跑**全量启动校验**（workflow 面 = `workflowLaunchInputIssues` + 目标 schema；agent/workgroup 面 = 对应 schema）——失败 → fire `launch-failed(payload-invalid)`。「宽松空串」只适用于可选变量缺值；`.trim().min(1)` 字段渲染为空等运行期校验兜住，AC 不再声称「理论不可达」。
- 插值白名单路径：workflow `inputs.*` 值；agent/workgroup 的 prompt/message 类字段（T4 先读 `StartAgentTaskSchema`（task.ts:1374）/`StartWorkgroupTaskSchema`（workgroup.ts:587）钉死字段名）。

### 4.3 supersede + 同流互斥（D8/D21/D24，F-5 修订）

**keyed-mutex**：per `(triggerId, streamKey)` 内存互斥（仿 `gitRepoCache.ts:60-65` `withUrlLock`），串行化「supersede 判定 → 熔断评估 → 启动 → fires 落库」全段。dispatch 全程多 await 点（DB/clone/cancel 5s 轮询），无互斥则两并发同流事件会双取消旧任务后各自启动 → 双任务存活且 fires 链出孤儿。

互斥段内：查同 `(trigger_id, stream_key)` 最近 `launched` 且 task 未终态 → `cancelExecution`（`executor.ts:80-82`；cancel 转移表原生含 awaiting_*，`shared/lifecycle.ts`，D21 零成本）→ 新 fire 记 `superseded_task_id`。取消竞态失败（已终态）不阻塞。

### 4.4 熔断

见 §1.5 顺序与 D22。`skipped-circuit-open` 仍落 fire 行（可观测）；重置 API `POST /api/webhook-triggers/:id/streams/reset`（owner / admin）。

## 5. Repo 解析与启动装配

### 5.1 repo 解析（D13/D17，F-17 加固）

1. `event.repoKeys` → `gitUrlCacheKey` → 查 `cached_repos.url_hash`（UNIQUE，`db/schema.ts:802`）。
2. **桶命中后 unseal `url_enc` 做 canonical 等值复核**——8-hex sha1 截断有碰撞风险（`git-url.ts:293-295` 自认），人工启动时人眼可见仓名，webhook 自动化下碰撞 = 静默在错误仓库跑任务并用写凭据 push；unseal 复核成本 O(1)。
3. 命中 → 注入 `cachedRepoId` + `ref`；未命中：`auto_register_repos` 开 → 注入 `repoUrl`（按端点 `preferred_clone_protocol` 选）走既有 `resolveCachedRepo` clone（`services/task.ts:610-658`）；关 → `skipped-repo-unregistered`。
4. `ref` 推导：push → 事件分支；tag_push → tag；mr_* / MR-note / MR-pipeline → `source_branch`；无 MR 的 pipeline → `object_attributes.ref`。
5. 运维指引：内外网双 host / 大小写路径别名会造成双份 auto-register，要求统一 URL 形态（T13）。

### 5.2 启动（照抄 fireSchedule 骨架，`services/scheduledTasks.ts:701-785`）

1. 重建 owner actor（`scheduledTasks.ts:760-773`）；owner 禁用/缺失 → `skipped-owner-invalid`。
2. 可启动性重校验：**采用 `assertScheduledTargetUsable`（`scheduledTasks.ts:780`）同款语义**（F-19 拍板：它就是为「以 owner 身份 fire」设计的门；`assertWorkflowLaunchable` 是 JSON POST 路由面的 gate，executor.ts:9-12 注释明言其「deliberately absent from scheduled fires」）。**每次触发评估**（AC-13）。
3. 模板渲染 + 全量启动校验（§4.2）。
4. `startExecution(db, ownerActor, { kind, refId, invoker: { type:'webhook', triggerId, deliveryId, fireId }, payload }, deps)`——`ExecutionInvoker` 联合（`services/execution/types.ts`）新增 `webhook` 成员；deps 镜像 `scheduledTaskId` 链路（`executor.ts:27-29` → `StartTaskDeps` → 落列）把来源写进 **`tasks.webhook_trigger_id` / `tasks.webhook_fire_id` 两个新列**（F-8：迁移 0138 包含，T2 交付）。
5. 结果落 fire 行 + 触发器观测列。任务名自动生成 `[触发器名] repoPath!mrIid`，截断 255（`task.ts:608`）。

## 6. 管理面 API 与权限

| 路由 | 权限 | 说明 |
|---|---|---|
| GET/POST `/api/webhook-endpoints`，GET/PUT/DELETE `/:id`，POST `/:id/rotate-secret` / `/:id/rotate-url-token` | 新权限点 `webhook-endpoints:manage`：admin+manager 基线，**不进 PAT/MCP 令牌面**（RFC-253 `scripts:author` 先例——一枚泄漏 PAT 不能改验签 secret） | secret/urlToken 全出口掩码 + PUT 保留语义（RFC-255「无关 PUT 不二次密封」回归锁同款）；删除 restrict（§1.1） |
| GET/POST `/api/webhook-triggers`，GET/PUT/DELETE `/:id` | **owner 制**（D19）：owner + admin/manager 旁路；非 owner 列表过滤、详情 404 同形；权限点对齐 `routes/scheduledTasks.ts` 既有惯例（T1 落定具体点名） | 保存期静态校验组（§4.2）；**以保存者身份**校验 launch_ref 目标可见性（与 `services/resourceRefs.ts` 新增引用校验惯例对齐） |
| GET `/api/webhook-deliveries`（分页/过滤）、GET `/:id`（含 body）、POST `/:id/replay` | `webhook-endpoints:manage`（端点级审计含全仓事件流，F-13 分层：管理员看 deliveries） | replay 三规则：rejected 不可放；新建行指回 `replayed_from_delivery_id`；`event_uuid` NULL 绕过去重 |
| GET `/api/webhook-triggers/:id/fires`、POST `/:id/streams/reset` | 触发器 owner / admin（F-13：owner 用 fires 排障自己的触发器） | 熔断可观测与重置 |

## 7. 前端（全部复用公共原语）

- **设置 → Webhook 端点卡片**：列表 + Dialog + 一次性 secret 展示/轮换 + 完整 URL 复制（`publicBaseUrl` 缺失黄条提示）。
- **触发器管理页**（`/webhook-triggers`，`.page` 骨架）：列表（StatusChip：enabled/熔断态）+ 编辑 Dialog——repo 范围（`.segmented` + prefix 输入 / exact ChipsInput）、事件类型多选、分支 glob、指令前缀、忽略名单（ChipsInput，附「pipeline 事件不受此名单过滤」说明文案）、目标三形态（Select 级联）、输入映射（kind 感知：git kind 显示「分支来自事件」选项而非自由文本）、熔断上限（NumberInput）。
- **投递历史页**：deliveries 表格（状态徽章含 received/processing/interrupted、原因、repo、attempt）+ 详情抽屉（body、fires、重放按钮——rejected 禁用 + tooltip）。
- TanStack Query 轮询（10s 页面可见时）；WS 频道留 T14 可选。i18n 双语；测试 `findByRole` 优先。

## 8. 安全与威胁模型

| 威胁 | 防线 |
|---|---|
| 伪造事件（知道 URL） | Secret 验签（401 + rejected 审计）；URL token 只是寻址 + 弱凭据 |
| 重放截获的投递 | UUID 去重；明文 token 无时间戳可查 ⇒ **传输层要求**：可信内网段或反代 TLS（T13） |
| URL token 泄露 | 不构成触发能力（还需 secret）；可轮换；请求日志 token 段脱敏（multica `request_logger.go:44-69` 姿势） |
| 恶意仓 URL 注入 | 前提是过验签 ⇒ 事件可信度 = secret 保密度；`auto_register_repos` 可关；clone 走既有凭据面无新提权 |
| url_hash 碰撞错仓 | unseal 等值复核（§5.1，F-17） |
| 评论指令滥用 | 用户拍板不限制（D10）；边界 = 触发器 owner 权限 + 忽略名单 + 熔断 |
| bot 自触发风暴 | 作用域化忽略名单（push/MR/note 过滤）+ pipeline 事件靠熔断上限（D14 修订后的双层） |
| 同流并发双任务 | keyed-mutex（D24）+ supersede；「每流 ≤1 活任务」在互斥下成立 |
| **GitLab hook auto-disable（F-6）** | 平台持续 401/5xx 会让 GitLab 自动禁用那个唯一的 group hook ⇒ 全部事件停摆。缓解：可忽略情形一律 200；500 仅真内部错误；运维指引写明监控 Recent Deliveries 与重新启用路径 |
| 触发器写权提权 | owner 制根除（D19）：无 grants 写面；admin/manager 旁路本就是全权角色 |
| 管理 API 内网暴露 / secret 落盘 | 既有 multiAuth / secretBox + 掩码 + 备份不含 key（proposal §6） |

## 9. 失败模式表

| 失败 | 落点 | 恢复 |
|---|---|---|
| secret 配错 | rejected + 401 | GitLab Recent Deliveries 标红；修 secret 后 Resend（去重索引排除 rejected，能落地） |
| 无匹配触发器 | ignored(no-trigger-matched) | 管理员投递历史排查规则 |
| repo clone 失败 | fire launch-failed（`repo-fetch-failed` 既有码，task.ts:649-658） | fires + last_error；replay |
| owner 失效 | fire skipped-owner-invalid | 换 owner（admin 编辑）后 replay |
| 渲染后校验失败 | fire launch-failed(payload-invalid) | 修模板后等下个事件或 replay |
| 熔断 | fire skipped-circuit-open | UI 重置 / 人类事件自动重置 / 24h 过期 |
| daemon 重启在途 | received/processing → failed(interrupted) | 手动 replay（无自动重投可依赖，F-6） |
| GitLab 侧 auto-disable | 事件全停 | 运维指引：GitLab UI 重新启用 + 排根因 |

## 10. 测试策略

**纯函数层**：`normalizeGitlabEvent`（9 eventType × 真实 fixture 正反例 + unsupported）；`matchTrigger`（五维矩阵，**含 pipeline 不受名单过滤正例**、malformed fail-closed）；`streamKeyOf`（**跨仓同号 MR 不同流**）；`evaluateCircuit`（bot 累加/人类重置/惰性过期/上限）；`renderLaunchTemplate`（未知变量、白名单路径、event_json 32KiB 截断、git kind 代包）；`availableVarsFor`。

**集成层**：状态码语义矩阵逐行（§3.3）；去重（含 rejected 后 Resend 成功、**UUID 缺失降级**、在途占位）；**三段式**（响应先于分发返回、interrupted 恢复）；**同流并发**（两事件并发 → mutex 下至多一活任务）；supersede 实调 cancel（含 awaiting_human、终态竞态）；owner 失效；三形态 mock `startExecution` 断言 invoker/payload/actor；管理面（掩码/二次密封锁、replay 三规则、owner 制 404 同形、保存期校验组、**保存者身份校验目标可见性**）；未认证 POST 可达 + 启动自检绿；保留策略 GC；限流 fake clock。

**回归锁**：`webhookDispatch.ts` **显式加入** `tests/rfc243-executor-facade.test.ts` `CALL_FACES`（F-7——该锁是硬编码清单，不自动覆盖新调用面）；「`/webhooks` handler 不用 `c.req.url` 拼外部 URL」源码文本断言。

**前端**：触发器编辑校验、kind 感知映射控件、掩码展示、投递历史徽章语义（role 断言）。

## 11. 与既有模块的耦合点

| 模块 | 耦合 | 改动性质 |
|---|---|---|
| `services/execution/types.ts` + `executor.ts` | `ExecutionInvoker` 新增 `webhook` 成员 + deps 透传 | 扩展 |
| `tests/rfc243-executor-facade.test.ts` | `CALL_FACES` 加 `webhookDispatch.ts` | 显式登记（F-7） |
| `db/schema.ts` + 迁移 0138 | 五新表 + **`tasks` 两列** | 新增（F-8） |
| `shared/schemas/task.ts` / `workgroup.ts` / `scheduledTask.ts` | 派生触发器模板封套 schema（repo/name/ref-id 规则不同，**不能直接引用** `scheduledPayloadSchemaFor`） | 新派生（F-3） |
| `services/scheduledTasks.ts` | fireSchedule 骨架 + `assertScheduledTargetUsable` 复用 | 模式复用/可能抽共享 |
| `auth/secretBox.ts` / `config/customProviderGate.ts` | 密封 + 掩码 + PUT 保留语义 | 模式复用 |
| `services/workflowLaunchInputs.ts` | 运行期渲染后校验消费者 | 零改动 |
| `services/gitRepoCache.ts` / `services/task.ts` | repo 解析（+unseal 复核）/ 启动入口 | 消费既有入口 |
| `cli/start.ts` ticker 组 | deliveries 保留 GC | 新 ticker（F-12） |
| `routes/registry.ts` / `auth/session.ts` | 公开路由声明 | 零改动 |
| ~~`services/resourceAcl.ts`~~ | ~~ACL 第七类~~ | **不再接入**（D19 修订） |

## 12. 后续演进（非本 RFC）

出站回写 RFC（`ReportSink` 实装 + 平台 API token 管理）；GitHub/Gitea adapter（HMAC 走同一 `verify` 接口）；polling / 出站长连接事件源（multica Lark WS connector 模式）；supersede 策略可配；持久化 dispatch 队列（替代 interrupted+replay）。
