# RFC-329 技术设计 —— MCP 人工门完整面、死路径修复与全域守卫

配套：`proposal.md`（背景 / 审计总账 / 决策 D1–D8 / 验收标准）· `plan.md`（任务分解）

## 1. 落位与 RFC-294 对齐

| 面           | 文件                                                                   | 层                                      |
| ------------ | ---------------------------------------------------------------------- | --------------------------------------- |
| MCP 工具表   | `packages/backend/src/mcp/tools.ts`                                    | inbound transport（与 REST 路由表同层） |
| REST 新端点  | `packages/backend/src/routes/workgroupTasks.ts`                        | inbound transport                       |
| 候选集重构   | `packages/backend/src/services/workgroup/room.ts`                      | application                             |
| 全域守卫     | `packages/backend/tests/architecture/rfc329-mcp-surface-guard.test.ts` | 守卫声明                                |
| 豁免账本基线 | `architecture/ledger-baselines.json`                                   | 账本                                    |

**零业务逻辑下沉**：27 个新工具的 handler 全部是一次（`list_repo_refs` 两次）
`ctx.dispatch`，与既有 26 个具名工具形状逐字一致。`mcp/dispatch.ts:1-23` 的裁决
——「工具不碰 `services/*`，每条授权规则只有一处实现」——原样保持。

**承担的演进步**：守卫产出的全量「路由 ⟷ 工具」映射表是 RFC-294 W4-A operation
catalog 的输入清单。**留下的债**：本 RFC 不建 catalog、不引入 `McpBinding`、
不合并两侧 handler。详见 `proposal.md §6`。

## 2. 一类：死路径修复

### 2.1 A1 —— 删 `RESOURCE_ROUTES.repos.get`（D4）

```ts
repos: {
  list: { method: 'GET', path: '/api/cached-repos' },
  // get 删除：GET /api/cached-repos/:id 从未注册（routes/cached-repos.ts 只有
  // list / :id/refresh / :id(DELETE) / batch-import / imports），此前每次调用恒 404。
  create: { method: 'POST', path: '/api/cached-repos/batch-import' },
  delete: { method: 'DELETE', path: '/api/cached-repos/:id' },
  note:
    'Repos are imported in batches: `create` takes a batch payload, not one repo. There is no ' +
    'update — a mirror is refreshed, not edited. There is also no single-repo read: list and ' +
    'pick the row. `delete` needs that row’s `urlRedacted` as `confirm`.',
}
```

`describe_resource(kind:'repos')` 由 `RESOURCE_ROUTES` 派生，自动跟随。

**AC-1 的变异实证**：把 `get` 加回去 → 守卫的 `unroutedTools` 命中 → 红。

### 2.2 A2 —— alerts 闭环

新工具 `list_task_alerts`：

```ts
{
  name: 'list_task_alerts',
  title: 'List the alerts a task raised',
  description:
    'Lifecycle alerts currently open on a task (invariant violations and stuck-run findings). ' +
    'This is the ONLY way to obtain an `alertId`: get_task does not carry alerts. ' +
    'Feed the id to list_repair_options, then to repair_alert.',
  permissions: [],                       // 读面，与 GET /api/tasks/:id/alerts 的 tasks:read 对齐
  inputSchema: { id: taskId },
  audit: (args) => ({ kind: 'task-alerts', id: String(args.id) }),
  handler: async (args, ctx) =>
    unwrap(await ctx.dispatch({ method: 'GET', path: `/api/tasks/${enc(args.id)}/alerts` })),
}
```

同批修 `repair_alert` 的描述：`'Call get_task first to read the alert and its options.'`
→ `'Call list_task_alerts for the alertId, then list_repair_options for the optionId.'`

### 2.3 A3 —— `launch_task` 两个入参的解析工具

**`list_repo_refs`**：`GET /api/repos/refs` 收的是 `?path=<绝对本地路径>`
（`routes/repos.ts:41-43`，`requireKnownPath` 限定为已导入镜像）。**不把绝对路径交给模型**
——工具接 `cachedRepoId`，内部两跳：

```
dispatch GET /api/cached-repos            → 找到 id 匹配的行，取 localPath
dispatch GET /api/repos/refs?path=<该行 localPath>
```

第一跳的 404 语义：id 不在 list 里 → 抛 `McpCallError`-同形的业务拒绝
`cached-repo-not-found`（**不是** 500）。两跳都在工具内，符合 `launch_task` 已有的两跳先例
（`GET /api/workflows/:id` + `POST /api/tasks`）。

**`find_users`**：一个工具打两条路由（`method` 二选一）：

| 入参                       | dispatch                      |
| -------------------------- | ----------------------------- |
| `{ query: 'ali' }`         | `GET /api/users/search?q=ali` |
| `{ ids: ['01J…','01J…'] }` | `POST /api/users/lookup`      |

两者都只返回公开字段（路由自身保证，工具不加工）。描述里写明用途：
「`launch_task` 的 `collaboratorUserIds` 需要 id，这是拿到它的唯一途径」。

### 2.4 A4 —— 批量导入进度与重试

- `get_repo_import` → `GET /api/cached-repos/imports/:batchId`
- `retry_repo_import_row` → `POST /api/cached-repos/imports/:batchId/rows/:rowId/retry`

`docs/audit-backlog.md:88` 记着这两条 REST 端点今天是 token-only、任何持凭据者
可读 / 可重试他人批次，收紧属能力收缩需另行拍板。**本 RFC 不改它们的门**——
只是把已经对令牌开放的能力如实暴露为工具。这一点在 `plan.md` 的验收清单里显式登记，
避免被误读为「RFC-329 认可了这个门」。

### 2.5 A5 —— `answer_clarify` 的状态码文案

描述里的 `412` 改 `409`，并加一条**源码级断言**防止再漂移：

```ts
// tests: 描述中出现的三位状态码，必须与 ConflictError 的真实 status 一致
const codes = [...answerClarifyTool.description.matchAll(/\b(4\d\d|5\d\d)\b/g)].map(Number)
expect(codes).not.toContain(412)
expect(new ConflictError('x', 'y').status).toBe(409)
```

## 3. 二类：人工门完整面

### 3.1 反问门

#### 3.1.1 `answer_clarify` 扩三个参数（D6）

```ts
inputSchema: {
  nodeRunId: z.string().min(1),
  answers: z.array(z.record(z.string(), z.unknown())),
  ifMatchIteration: z.number().int().nonnegative().optional(),
  directive: z.enum(['continue', 'stop']).optional(),
  // —— 以下 RFC-329 新增，控制通道 ——
  defer: z.boolean().optional().describe(
    'false / omitted = QUICK channel: answer the whole round, seal it and let the task continue. ' +
    'true = CONTROL channel: seal only the answered questions into the dispatch board WITHOUT ' +
    'advancing the task — send them later with dispatch_task_questions.',
  ),
  questionIds: z.array(z.string()).optional().describe(
    'Control channel only: seal exactly these question ids and leave the siblings for someone else. ' +
    'Sending it without defer:true is refused (clarify-question-ids-requires-defer), not silently ignored.',
  ),
  resubmitQuestionIds: z.array(z.string()).optional().describe(
    'Control channel only: the sealed questions you are deliberately OVERWRITING. Without this ' +
    'declaration a sealed question keeps its exactly-once refusal even on the control channel.',
  ),
} satisfies Partial<Record<keyof z.input<typeof SubmitClarifyAnswersSchema> | 'nodeRunId', z.ZodTypeAny>>
```

`satisfies` 绑定键集，照抄 `LAUNCH_TASK_INPUT_SCHEMA`（`mcp/tools.ts:133-194`，末行的 `satisfies`）的防漂移手法
——发明一个 `SubmitClarifyAnswersSchema` 里不存在的字段名即编译期红。

handler 原样把四个新旧字段透传进 body。**两条互斥校验在路由侧
（`routes/clarify.ts:240-257`）原样生效**，工具不重复实现（AC-6 有专测覆盖两条拒绝分支）。

#### 3.1.2 问题看板六个工具

| 工具                          | 路由                                                         | 权限            | 推进任务？                          |
| ----------------------------- | ------------------------------------------------------------ | --------------- | ----------------------------------- |
| `list_task_questions`         | `GET /api/tasks/:id/questions`（`?sourceNodeId` / `?phase`） | —               | 否                                  |
| `raise_task_question`         | `POST /api/tasks/:id/questions/manual`                       | `tasks:execute` | 否（`targetNodeId` 给了即落待下发） |
| `confirm_task_question`       | `POST .../questions/:entryId/confirm`                        | `tasks:execute` | 否                                  |
| `reassign_task_question`      | `POST .../questions/:entryId/reassign`                       | `tasks:update`  | 否                                  |
| `stage_task_question`         | `POST .../questions/:entryId/stage`                          | `tasks:execute` | 否                                  |
| **`dispatch_task_questions`** | `POST /api/tasks/:id/questions/dispatch`                     | `tasks:execute` | **是**                              |

**每个描述必须写明「这一步会不会推进任务」**（`proposal.md §10` 风险项）：
`dispatch_task_questions` 是唯一会推进的，描述里写 _"This is the step that resumes the run."_

**`reassign_task_question` 依赖一处 REST 改动**：`routes/taskQuestions.ts:162` 的
`tokenAccess: 'never'` → `'allow'`（D3），并补一条注释说明为什么它不属于 RFC-247 D5 的
四种 URL 形状（改 `targetNodeId`，不碰 owner / grants / visibility）。

#### 3.1.3 节点级继续-停止开关与协作草稿

| 工具                      | 路由                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_clarify_directives` | `GET /api/tasks/:id/clarify-directives`                                                                                                            |
| `set_clarify_directive`   | `POST /api/tasks/:id/nodes/:nodeId/clarify-directive`（body `{directive}`）                                                                        |
| `save_clarify_draft`      | `PUT /api/clarify/:nodeRunId/draft`（body `{roundId, questionId, selectedOptionIndices, customText}`，见 `shared/schemas/resourceAcl.ts:278-284`） |

`set_clarify_directive` 与 `answer_clarify(directive:'stop')` 是 RFC-123 的**同一事实源**
（答 stop 会回写节点开关）。两个工具的描述互相点名，说明区别：前者是**不答题只改开关**，
后者是**答题顺带改**。AC-7 用一条用例从 MCP 侧证明写入后能被 `list_clarify_directives` 读到。

### 3.2 工作组任务门

#### 3.2.1 REST 新端点 `GET /api/workgroup-tasks/pending`（D5）

**重构而非复制**：`services/workgroup/room.ts:340-400` 的 `pendingCount` 内部已经算出了
完整候选行（`isNotNull(workgroupId)` + `CANCELABLE_TASK_STATUSES` → `gateStatus` 批读 →
`visibleTaskIdsOf` 可见性过滤 → dispatched cards 分组）。抽出 `pendingRows(actor)`：

```
pendingRows(actor): Promise<WorkgroupPendingRow[]>   // 新，唯一实现
pendingCount(actor) = 由 pendingRows 派生计数        // 既有返回体逐字不变
```

新路由：

```ts
{ method: 'GET', path: '/api/workgroup-tasks/pending',
  permissions: ['tasks:read'], tokenAccess: 'allow',
  summary: 'List workgroup tasks awaiting input' }
```

返回 `{ items: WorkgroupPendingRow[] }`，每行至少 `{taskId, name, status, gateStatus,
pendingDeliveries}`。**`pending-count` 的返回体一字不改**（前端 15s badge 轮询在用）。

**为什么这是必要的**：`list_pending_gates` 要与 `/api/reviews`、`/api/clarify` 三路对称，
而工作组域今天只有计数与单任务房间。AC-9 用两个不同 actor 断言两个端点看见的行集合相同
——因为它们现在是同一个函数。

#### 3.2.2 七个工具

| 工具                                 | 路由                                    | 推进任务？                                                                             |
| ------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `get_workgroup_room`                 | `GET /api/workgroup-tasks/:taskId/room` | 否                                                                                     |
| `post_workgroup_message`             | `POST .../messages`                     | **是**（无 @提及的消息落黑板并唤醒 leader-idle 任务，`routes/workgroupTasks.ts:9-14`） |
| `confirm_workgroup_step`             | `POST .../confirm`                      | **是**                                                                                 |
| `confirm_workgroup_dynamic_workflow` | `POST .../dw-confirm`                   | **是**                                                                                 |
| `save_workgroup_dynamic_workflow`    | `POST .../dw-save-as-workflow`          | 否（建资源，`tasks:execute` + `workflows:create`）                                     |
| `deliver_workgroup_assignment`       | `POST .../assignments/:id/deliver`      | **是**                                                                                 |
| `cancel_workgroup_assignment`        | `POST .../assignments/:id/cancel`       | 否（204）                                                                              |

入参 schema **逐字镜像** `services/workgroup/taskActions.ts` 的
`PostMessageSchema` / `DeliverSchema` / `ConfirmSchema` 与 `dwActions.ts` 的
`SaveAsWorkflowSchema`；实现时用 `satisfies` 绑定键集。

`PUT .../config` **不做工具**：`tokenAccess:'never'` 保持（RFC-247 D5，其 `addMembers`
写 `task_collaborators`）。它进豁免账本，带这条理由。

### 3.3 fusion 审批门

| 工具             | 路由                            | 权限                              | body                                                        |
| ---------------- | ------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `list_fusions`   | `GET /api/fusions`              | —                                 | —                                                           |
| `get_fusion`     | `GET /api/fusions/:id`          | —                                 | —                                                           |
| `approve_fusion` | `POST /api/fusions/:id/approve` | `skills:update` + `memory:update` | —                                                           |
| `reject_fusion`  | `POST /api/fusions/:id/reject`  | `tasks:execute`                   | `{feedback}`（1–4000 字，`shared/schemas/fusion.ts:68-70`） |
| `cancel_fusion`  | `POST /api/fusions/:id/cancel`  | `tasks:execute`                   | —                                                           |

`approve_fusion` 的描述必须写明**不可逆副作用**：bump 技能版本 + 融合记忆。

**`POST /api/fusions`（发起融合）不做工具**：它是**发起**不是**门**，与 `launch_task` 同类，
归三类（资源域运维面）。进豁免账本并写明这条边界。

### 3.4 memory 人审发布门

`promote_memory` → `POST /api/memories/:id/promote`，权限 `memory:update`。
body 是 `MemoryCandidatePromoteSchema`（`shared/schemas/memory.ts:112-125`）——
**discriminatedUnion 三态**，不是单纯"发布"：

```ts
inputSchema: {
  id: z.string().min(1),
  action: z.enum(['approve', 'approve_and_supersede', 'reject']),
  supersedeIds: z.array(z.string()).min(1).max(8).optional()
    .describe('Required for approve_and_supersede: the approved memories this one replaces'),
  tagsOverride: z.array(z.string()).max(16).optional(),
}
```

描述写明 RFC-285 Q4 的语义：candidate 只有资源管理员看得见，approve 后才回到全员面。

### 3.5 `list_pending_gates` 扩到四路

```ts
handler: async (_args, ctx) => {
  const [reviews, clarify, workgroupTasks, fusions] = await Promise.all([
    ctx.dispatch({ method: 'GET', path: '/api/reviews' }),
    ctx.dispatch({ method: 'GET', path: '/api/clarify' }),
    ctx.dispatch({ method: 'GET', path: '/api/workgroup-tasks/pending' }),
    ctx.dispatch({ method: 'GET', path: '/api/fusions', query: { status: 'awaiting_approval' } }),
  ])
  return {
    reviews: unwrap(reviews),
    clarify: unwrap(clarify),
    workgroupTasks: unwrap(workgroupTasks),
    fusions: unwrap(fusions),
  }
}
```

**golden lock**：`reviews` / `clarify` 两键的形状逐字不变（AC-11）。
四路并发，不串行——四次 dispatch 的成本与两次同量级。

**已核实**（`routes/fusions.ts:89-105`）：`?status=awaiting_approval` 有效，
`awaiting_approval` 是 `FusionStatusSchema`（`shared/schemas/fusion.ts:10-18`）的合法取值。
两个必须写进 `list_fusions` 描述的语义：

1. **未知 `status` 被当作「无过滤」而不是被拒绝**（`routes/fusions.ts:94-97`：
   `safeParse` 失败即 `status = undefined`）。模型拼错值时会**拿到全量列表却以为在看待批的**，
   而这正是它接着要 approve 的东西。描述里必须点名合法取值；`list_fusions` 的入参用
   `z.enum` 收口，**在工具层就挡掉**拼错值——路由的宽容不该传染给工具。
2. **非资源管理员只看得见自己 owner 的融合**（`routes/fusions.ts:104-106`：
   `hasResourceAclBypass(actor)` 旁路，否则 `f.ownerUserId === actor.user.id`）。
   `list_pending_gates` 的 fusions 那一路因此是**按调用令牌的身份收窄的**，
   与 reviews / clarify 两路「按任务成员收窄」是同类但不同判据，描述里写明。

## 4. 全域「路由 ⟷ 工具」守卫（D8）

`packages/backend/tests/architecture/rfc329-mcp-surface-guard.test.ts`。

### 4.1 两侧各自的推导

| 侧   | 来源                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 路由 | `createApp(...)` 后的 `allRouteMeta()`，规范化成 `METHOD /api/x/:id/y`                                                         |
| 工具 | 逐个真调 `tool.handler`，对接 recording dispatcher；收敛工具遍历 `MCP_RESOURCE_KINDS × {list,get,facets,create,update,delete}` |

技术照抄 `rfc326-review-tool-route-guard.test.ts:66-105`（pre-aborted signal + 250ms race，
让 `watch_task` 这类长轮询工具立即让路），扫描面从 `/api/reviews*` 放开到全部。

### 4.2 三向判定

```ts
uncovered       = 路由有、工具无、账本无            → 补工具或入账本
staleExemptions = 账本有、但工具已覆盖 / 路由已不存在 → 清理账本
unroutedTools   = 工具打向的路径不在路由表           → A1 那类死路径
```

**A1 必须能被第三向抓到**——负向 fixture 显式构造一次（AC-12）。

### 4.3 豁免账本结构

`MCP_SURFACE_EXEMPTIONS`，**按域前缀分组**（`proposal.md §10` 的风险处置），
不是 280 条各写一句：

```ts
interface ExemptGroup {
  readonly prefix: string // 'GET /api/code/' 这类前缀，或精确的一条路由
  readonly why: string // 为什么这一组没有 MCP 工具
  readonly category: 'never' | 'system' | 'not-in-scope' | 'deliberate'
}
```

四个 category：

| category       | 含义                                  | 典型                                                                                                                          |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `never`        | `tokenAccess:'never'`，PAT 天然不可达 | `/api/auth/*`、各 `PUT .../acl`、`PUT /api/workgroup-tasks/:id/config`                                                        |
| `system`       | 运维 / 平台面，模型不该碰             | `/api/backup`、`/api/restore`、`/api/maintenance/*`、`/api/users`(写)、`/api/runtimes`(写)                                    |
| `not-in-scope` | 三类 / 四类，各自等后续 RFC           | `/api/code/*`、`/api/intent-sessions/*`、`/api/digital-employee*`、`/api/event-center/*`、skills 内容面、workflows validate … |
| `deliberate`   | 有工具但**故意不给**，各带一句理由    | 四个 `pending-count`（模型要行不要数）、`POST /api/fusions`（发起非门）                                                       |

**分组不能变成挡箭牌**：`prefix` 只允许匹配**已存在**的路由；一个 prefix 若匹配 0 条路由
即 `staleExemptions` → 红。这挡住了「写个宽前缀把未来的路由一起豁免掉」。

### 4.4 高水位登记

`architecture/ledger-baselines.json` 追加一条：

```json
{
  "id": "rfc329-mcp-surface-exemptions",
  "file": "packages/backend/tests/architecture/rfc329-mcp-surface-guard.test.ts",
  "symbol": "MCP_SURFACE_EXEMPTIONS",
  "baseline": <落地时的实际组数>,
  "why": "RFC-329：没有 MCP 工具的路由分组豁免账本。条目数只许降——每一组都是一块 MCP 够不着的产品面。新域长出来而 MCP 没跟时，守卫会先红在 uncovered 上，逼出一次有署名的决定。"
}
```

受 `rfc317-ledger-highwater.test.ts` 的两层规则约束：与源码逐字相等 +
相对上一 commit 只降不升（要升须写 `allowGrowth` 并点名 RFC）。

**首次登记不算"涨"**——它是一条新 id，基线即初始值。

## 5. 失败模式

| #   | 失败模式                                                                        | 处置                                                                                                                                           |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 新工具的权限点与其路由声明不一致 → 工具在 `tools/list` 里出现但每次调用被路由拒 | 守卫加**第四向**：每个工具声明的 `permissions` 必须是其 dispatch 目标路由 `permissions` 的**子集或相等**（工具不得比路由更宽也不得更窄到误导） |
| F2  | 两跳工具（`list_repo_refs`）第一跳失败 → 500 而非业务拒绝                       | 第一跳非 2xx 时抛 `McpCallError`（携带原 code），与单跳工具的失败形态一致                                                                      |
| F3  | `pendingRows` 重构改变了 `pending-count` 的数字                                 | AC-9 的双 actor 一致性用例 + `pending-count` 既有测试保持绿（golden lock）                                                                     |
| F4  | `reassign` 改 `allow` 后，PAT 可越权改派                                        | 路由的成员门 `gateMemberEntry`（`routes/taskQuestions.ts:150`）不变——它校验的是任务成员身份，与凭据类型无关。加一条用例：非成员 PAT 调用 → 拒  |
| F5  | 守卫太慢（440 路由 × 56 工具 × 67 变体）                                        | 变体只对三个收敛工具展开，具名工具各调一次；实测本机全量 < 30s。若超时，按工具名分片                                                           |
| F6  | `list_pending_gates` 四路里某一路 500 → 整个工具挂                              | `Promise.all` 改 `Promise.allSettled`，失败的一路返回 `{error: code}` 而非拖垮另外三路。**这是既有 2 路时就存在的脆弱性，本 RFC 顺带修**       |
| F7  | `list_fusions` 传错 `status` 静默退化成全量列表，模型据此 approve 错东西        | 工具入参用 `z.enum` 收口，在 MCP 层就拒——路由的宽容（未知值 = 无过滤）不该传染给工具；描述点名合法取值                                         |

## 6. 测试策略

按 CLAUDE.md §Test-with-every-change：**每条改动自带测试，bug 先红后绿**。

### 6.1 必写用例

| 类                 | 文件                                            | 覆盖                                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 死路径回归         | `rfc329-mcp-dead-paths.test.ts`                 | A1 删除后 `describe_resource` 不再宣称 get；A2 三步闭环走通；A3 两个解析工具；A4 导入进度+重试；A5 状态码断言                                                                                                                                      |
| 反问门             | `rfc329-mcp-clarify-gate.test.ts`               | `defer` 快 / 控两通道；两条互斥拒绝分支（`clarify-question-ids-requires-defer` / `clarify-resubmit-requires-defer`）；`directive` 在两通道都生效；stop 回写节点开关后可被 `list_clarify_directives` 读到；六个看板工具；`reassign` 非成员 PAT 拒绝 |
| 工作组门           | `rfc329-mcp-workgroup-gate.test.ts`             | 新端点双 actor 一致性；七个工具；`pending-count` golden lock                                                                                                                                                                                       |
| fusion + memory 门 | `rfc329-mcp-approval-gates.test.ts`             | 五个 fusion 工具；`promote_memory` 三态；candidate 可见性不被工具放宽                                                                                                                                                                              |
| 聚合               | `rfc329-mcp-pending-gates.test.ts`              | 四键返回；前两键 golden lock；一路失败不拖垮其余（F6）                                                                                                                                                                                             |
| 全域守卫           | `architecture/rfc329-mcp-surface-guard.test.ts` | 四向判定 + 负向 fixture + 账本 prefix 必须命中                                                                                                                                                                                                     |

### 6.2 变异实证（每条必须实跑并确认转红）

1. 把 `repos.get` 加回 `RESOURCE_ROUTES` → `unroutedTools` 红
2. 删掉任意一个新工具 → 其路由进 `uncovered` 红
3. 给一条豁免路由加工具而不改账本 → `staleExemptions` 红
4. 账本加一组而不改 `ledger-baselines.json` → 高水位守卫红
5. 写一个匹配 0 条路由的 prefix → `staleExemptions` 红
6. 把某工具的 `permissions` 改得比路由宽 → F1 那向红
7. 把 `answer_clarify` 的 `defer` 参数删掉 → 控制通道用例红
8. `pendingRows` 里去掉 `visibleTaskIdsOf` → 双 actor 一致性用例红

> CLAUDE.md 的纪律：**红→绿对里的绿不是终点**——每条修完必须再跑一次原变异确认转红
> （RFC-287 五轮门的教训：字段名笔误 + `as never` 让断言成了 no-op，同一变异照样全绿）。

### 6.3 e2e

`e2e/rfc329-mcp-gate-surface.spec.ts`：一条 PAT 全流程——
`list_pending_gates` 发现工作组任务在等人 → `get_workgroup_room` → `confirm_workgroup_step`
→ 任务继续；以及 clarify 控制通道 `answer_clarify(defer)` → `dispatch_task_questions`。
照抄 `e2e/rfc326-mcp-review-tools.spec.ts:249` 的 `toolCall(patToken, ...)` 姿势。

## 7. 迁移与兼容

- **零 DB 迁移**。
- **零前端改动**。
- **零 wire breaking**：`list_pending_gates` 加键、`answer_clarify` 加可选参数、
  `pending-count` 不动。
- `reassign` 的 `tokenAccess` 由 `never` → `allow` 是**放开**，不影响任何既有调用方。
