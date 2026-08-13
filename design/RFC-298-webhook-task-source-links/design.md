# RFC-298 Webhook 任务来源链接 — 技术设计

## 1. 现状与承重锚点

### 1.1 事件与冻结上下文

- `packages/shared/src/schemas/webhook.ts:58-118`：`CodeHostEvent` 已含 `provider`、
  `mrUrl`、`commentUrl`、`pipelineUrl`、`projectWebUrl` 与 `commitSha`。
- `packages/shared/src/webhookTemplate.ts:77-115`：`eventVarsOf()` 将它们映射为
  `trigger.webhook.*` 字段。
- `packages/shared/src/webhookTriggerContext.ts:8-21`：`webhookTriggerContextOf()` 生成
  RFC-292 的冻结 context。
- `packages/backend/src/services/task.ts:2316-2324`：webhook attribution 与
  `trigger_context_json` 在任务初始 INSERT 同批写入；不是发起后补写。
- `packages/shared/src/triggerContext.ts:58-91`：`parseTriggerContextJson()` 区分
  `none` / `ok` / `invalid`，并兼容 RFC-269 历史扁平 context。

### 1.2 当前读面缺口

- `packages/backend/src/services/task.ts:4773-4865` 的 `rowToTask()` 没有读取
  `triggerContextJson`，Task API 不返回来源入口。
- `packages/shared/src/schemas/task.ts:390-546` 的 `TaskSchema` 没有来源链接契约。
- `packages/frontend/src/routes/tasks.detail.tsx:534-557` 的标题区由 `PageHeader` 组成，
  `meta` 内任务 ID 与执行主体分两行；来源入口应加入 `.task-detail__id`，而不是另起
  第三个重复元数据块。

## 2. Shared 契约与单一选择器

新增 `packages/shared/src/webhookTaskSourceLink.ts`，承载类型、URL 安全判定和选择算法：

```ts
export const WEBHOOK_TASK_SOURCE_LINK_KINDS = [
  'comment',
  'merge_request',
  'pipeline',
  'commit',
  'project',
] as const

export const SafeWebhookTaskSourceUrlSchema = z
  .string()
  .refine((value) => safeWebhookTaskSourceUrl(value) !== null, 'unsafe webhook task source URL')

export const WebhookTaskSourceLinkSchema = z
  .object({
    kind: z.enum(WEBHOOK_TASK_SOURCE_LINK_KINDS),
    url: SafeWebhookTaskSourceUrlSchema,
  })
  .strict()

export type WebhookTaskSourceLink = z.infer<typeof WebhookTaskSourceLinkSchema>

export function webhookTaskSourceLinkOf(context: TriggerContext): WebhookTaskSourceLink | null
```

`TaskSchema` 新增：

```ts
webhookSourceLink: WebhookTaskSourceLinkSchema.nullable().optional()
```

字段 `optional` 保持前端读取旧 daemon 响应的兼容性；当前 backend 对每个 detail response
都显式返回对象或 `null`。`TaskSummary` / `TaskListItem` / `TaskOperationsListItem` 不扩面，
避免把详情页需求扩散到所有列表查询和 WS wire。

## 3. URL 安全判定

每个候选进入优先级选择前都通过同一个 `safeWebhookTaskSourceUrl()`：

1. 必须是非空字符串，且长度不超过 8192；
2. `new URL(value)` 必须成功；
3. `protocol` 只能是 `http:` / `https:`；
4. `hostname` 必须非空；
5. `username` 与 `password` 必须都为空；
6. 通过时保留原字符串，避免改写 comment anchor、部署子路径或必要 query；
7. 不通过返回 `null`，调用方继续尝试下一候选。

这不是通用任意外链组件：它是 webhook 任务来源的闭合判据，放 shared 使后端投影和测试
同源。wire schema 使用同一判据，前端不能再自行解析或放宽 URL。URL 只进入 anchor 的
`href`，不进入可见正文或 `title`，避免 hover 时又直接暴露原始地址。

## 4. 选择算法

### 4.1 候选与实际目标类型

选择器按顺序运行 `firstSafe()`，候选携带自己的 `kind`。返回的 `kind` 是**最终实际目标**，
不是原始事件类型；前端只按该 kind 选择文案。

| `event_type` 集合                 | 候选序列                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `note`                            | `(comment, comment_url)` → `(merge_request, mr_url)` → `(project, project_web_url)`   |
| `mr_opened/updated/merged/closed` | `(merge_request, mr_url)` → `(project, project_web_url)`                              |
| `pipeline_failed/succeeded`       | `(pipeline, pipeline_url)` → `(merge_request, mr_url)` → `(project, project_web_url)` |
| `push/tag_push`                   | `(commit, constructedCommitUrl)` → `(project, project_web_url)`                       |

闭合的 `CodeHostEventType` switch 必须穷尽 9 个成员；新增事件类型时 typecheck/测试应迫使作者
明确选择规则，不能静默落项目页。

### 4.2 提交页构造

只有 `provider`、安全的 `project_web_url` 与合法 `commit_sha` 同时存在时才构造：

- 解析项目 URL；清空其 query/hash；去掉 pathname 尾部 `/`；
- SHA 必须匹配 7–64 位十六进制，且不能全为 `0`；
- SHA 经 `encodeURIComponent` 作为单一路径段；
- `github` 追加 `/commit/<sha>`；
- `gitlab` 追加 `/-/commit/<sha>`；
- 构造结果再次经过 `safeWebhookTaskSourceUrl()`；失败则继续项目页候选。

不从 `repo_http_url` 构造页面地址：它是 clone URL，可能带 `.git`、凭据或与 Web UI 使用
不同入口，且 RFC-263 已提供权威 `project_web_url`。

## 5. Backend 读模型

只在 `getTask()` 详情读路径使用现有
`parseTriggerContextJson(row.task.triggerContextJson)`：

```ts
const parsed = parseTriggerContextJson(row.task.triggerContextJson)
const webhookSourceLink = parsed.kind === 'ok' ? webhookTaskSourceLinkOf(parsed.value) : null
return rowToTask(row.task, row.workflowName, repos, spaceNodes, webhookSourceLink)
```

`rowToTask()` 只接收已派生的 `{kind,url} | null`，自身继续不得读取
`triggerContextJson`，再把最小值写入 `Task` DTO。这样保留
`rfc292-trigger-source-locks.test.ts` 的原始上下文隔离边界；RFC-298 只对 RFC-292 的
“Task API 无 trigger 投影”作一个窄化例外，不开放 raw context。性质如下：

- **零迁移**：链接从任务自己的冻结 context 读时派生；
- **不回查**：不 join webhook triggers/fires/deliveries，不依赖它们仍存在；
- **子任务自然覆盖**：RFC-292 已让子任务继承 context，读模型不以
  `webhook_trigger_id IS NOT NULL` 限制；
- **旧数据兼容**：历史扁平 context 由现有 parser 升形后进入同一选择器；
- **损坏隔离**：`invalid` 返回 `null`，任务详情不 5xx；
- **最小披露**：API 只发 `{kind,url}`，不发完整 context、评论正文或原始 event JSON。

Task visibility middleware 与 `serializeTaskFor()` 原样保留。来源链接不是 credential；
`safeWebhookTaskSourceUrl()` 又拒绝 URL userinfo，因此不新增 token lens 分支。

## 6. Frontend 呈现

新增语义组件 `components/tasks/TaskWebhookSourceLink.tsx`：

- 输入仅为 `WebhookTaskSourceLink`；
- `kind → i18n key` 使用闭合 `Record`；
- `<a href={url} target="_blank" rel="noopener noreferrer">`；
- 可见正文只含受控文案与一个 `aria-hidden` 的外链箭头；
- 不把 URL 插入可见正文或 `title`；
- 组件不自行实现 fallback，也不接受 raw context。

`tasks.detail.tsx` 在现有 `.task-detail__id` 内按 DOM 顺序渲染：

```tsx
<span className="task-detail__id-label">...</span>
<code>{tk.id}</code>
{tk.webhookSourceLink !== null && tk.webhookSourceLink !== undefined && (
  <span className="task-detail__source">
    <span aria-hidden="true">·</span>
    <TaskWebhookSourceLink source={tk.webhookSourceLink} />
  </span>
)}
```

保留 `.task-detail__id` 现有 inline flow；`.task-detail__source` 用
`white-space: nowrap` 把分隔点和文字链接组成一个不可拆组，避免换行后留下孤立分隔点。
链接复用现有 `.data-table__link` 颜色与 hover/focus，不新造按钮、chip 或独立 chrome。
390px 宽时允许来源组整体换到下一视觉行，但 DOM/阅读顺序仍紧跟任务 ID。

新增双语键：

```text
tasks.webhookSource.comment
tasks.webhookSource.mergeRequest
tasks.webhookSource.pipeline
tasks.webhookSource.commit
tasks.webhookSource.project
```

## 7. 失败与边界行为

| 情形                                 | 结果                                              |
| ------------------------------------ | ------------------------------------------------- |
| 首选 URL 缺失/畸形/危险              | 继续下一候选                                      |
| 所有候选不可用                       | `webhookSourceLink: null`，前端不渲染分隔点/占位  |
| `trigger_context_json` 损坏          | fail-closed 为 `null`，任务详情其余字段照常返回   |
| RFC-263 之前的任务没有页面 URL       | 不回填；有项目页则退项目页，否则不显示            |
| trigger/delivery 已删除              | 无影响；只读任务冻结 context                      |
| GitHub workflow_run 没有 MR 网页 URL | 仍优先 pipeline URL；其缺失时直接退项目页         |
| 评论 URL 无效但 MR URL 有效          | 返回 `kind=merge_request`，前端显示 MR/PR 文案    |
| project URL 有 query/hash            | 直接项目回退保留；构造 commit 页时清空 query/hash |
| commit SHA 非法或全零                | 不构造提交页，继续项目页候选                      |

## 8. 测试策略

### 8.1 Shared 纯函数

新增 `packages/shared/tests/rfc298-webhook-task-source-link.test.ts`：

1. 9 个事件类型逐一覆盖，锁死事件集合与回退矩阵；
2. `note` 三层优先级及“坏首选跳到下一层”；
3. pipeline 三层优先级，含 GitHub workflow_run 无 `mr_url`；
4. GitHub/GitLab × push/tag 的提交页构造；
5. 缺失/非十六进制/全零 SHA、缺项目 URL、畸形 URL 的降级；
6. `javascript:` / `data:` / 相对 URL / userinfo / 超长 URL 拒绝；
7. comment hash 与合法 query 原样保留；
8. 返回 kind 与实际目标一致。

### 8.2 Backend 读模型/API

新增或扩展 task service/API 测试：

- canonical note context 返回 comment link；
- 历史扁平 context 走同一结果；
- 只有继承 context、没有 `webhook_trigger_id` 的子任务仍返回来源链接；
- 非 webhook、损坏 context、全候选失效返回 `null`；
- 响应不出现 `triggerContext` / `event_json` / `comment_text`；
- 更新 RFC-292 source-lock：`rowToTask()` 仍不读取 raw context，响应只允许最小链接投影；
- task ACL 既有 404/可见行为不变。

### 8.3 Frontend

组件/路由测试覆盖：

- 五种 kind 的中英文可访问文案；
- 可见文本不含 URL；
- `target` / `rel` 完整；
- DOM 顺序为 ID → separator → source link；
- `null/undefined` 时来源 anchor 与 separator 都不存在；
- fallback 已由 backend 选成 MR/项目时，文案跟随返回 kind。

### 8.4 浏览器与视觉

- 在 seeded task-detail E2E 中加入 webhook context，断言链接位于
  `.task-detail__id code` 之后，点击目标用 `href` 验证而不真的访问外网；
- 390×844 与桌面宽度截图验证 ID 行换行、操作区不挤压、外链 focus ring 不被裁切；
- 与非 webhook fixture 对照，确认普通任务标题区逐字不变。

## 9. 并发与改动边界

预计生产触点：

- `packages/shared/src/webhookTaskSourceLink.ts`（新）
- `packages/shared/src/schemas/task.ts`
- `packages/shared/src/index.ts`
- `packages/backend/src/services/task.ts`
- `packages/backend/tests/rfc292-trigger-source-locks.test.ts`
- `packages/frontend/src/components/tasks/TaskWebhookSourceLink.tsx`（新）
- `packages/frontend/src/routes/tasks.detail.tsx`
- `packages/frontend/src/styles.css`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- 对应 shared/backend/frontend/E2E 测试与必要视觉基线

当前共享树中的 `packages/backend/src/services/scheduler.ts` 并发改动与本 RFC 无交集，必须
原样保留，不暂存、不提交。实现前再次核对上述触点是否出现新的并发 WIP；若同一行冲突则
停下协调。

## 10. 数据与回滚

- 无 schema/migration、无 backfill、无持久化写入变化；
- 回滚只需撤掉读模型投影与前端条件渲染，任务数据不需恢复；
- shared 字段为 optional，前后端短暂版本错配时旧前端忽略新字段、新前端对旧后端不展示。
