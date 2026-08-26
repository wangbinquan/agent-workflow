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

**承担的演进步**：§4.2 的声明式 `ToolBinding`（路径 + 请求字段 + 权限）与守卫产出的全量
「路由 ⟷ 工具」映射表，合起来是 RFC-294 W4-A operation catalog 的输入清单。**留下的债**：本 RFC 不建 catalog、不引入 `McpBinding`、
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

### 2.3 A3 —— `launch_task` 的 `ref` 解析工具

**`list_repo_refs`**：`GET /api/repos/refs` 收的是 `?path=<绝对本地路径>`
（`routes/repos.ts:41-43`，`requireKnownPath` 限定为已导入镜像）。**不把绝对路径交给模型**
——工具接 `cachedRepoId`，内部两跳：

```
dispatch GET /api/cached-repos            → 找到 id 匹配的行，取 localPath
dispatch GET /api/repos/refs?path=<该行 localPath>
```

第一跳查不到该 id → 抛业务拒绝 `cached-repo-not-found`（**不是** 500）。两跳都在工具内，
符合 `launch_task` 已有的两跳先例（`GET /api/workflows/:id` + `POST /api/tasks`）。

> **守卫必须能看见第二跳**（设计门 P1-3）。RFC-326 的 recording dispatcher 对每次 dispatch
> 固定返回 `{status:200, body:{}}` 并吞掉 handler 异常
> （`rfc326-review-tool-route-guard.test.ts:85-104`）——照抄它的话，第一跳返回 `{}`、
> 工具找不到匹配行就抛错，**第二跳永远不会发生**，守卫会把 `/api/repos/refs` 误报成
> uncovered。这正是 §4 改用**声明式 binding**的原因之一：路径集合由工具自己声明，
> 再用按工具定制的响应 fixture 验证 handler 与声明一致。

### 2.4 `find_users` 与 batch-import 两工具：**从本 RFC 删除**

v1 曾把它们列入 A3 / A4。设计门推翻：

- **`find_users`（P1-1，D11）**：`GET /api/users/search` 与 `POST /api/users/lookup` 都要
  `users:search`，而它在 `SYSTEM_DOMAIN_POINTS`（`shared/schemas/permission.ts:808`）里被
  `resolveTokenPermissions` 显式剔除（同文件 `:1293-1301`）。**任何 PAT 都不可能持有**——
  声明该权限则工具永不出现在 `tools/list`，声明空权限则每次调用恒 403。这是个必死的设计，
  补工具解决不了，真因是权限目录。
- **`get_repo_import` / `retry_repo_import_row`（P1-8，D12）**：两条 REST 路由只按 batch/row
  id 操作、**不读 actor**（`routes/cached-repos.ts:188-243`），无 owner 门。`mcp_only` PAT
  今天被 purpose 门挡着（`routes/registry.ts:188-193`），而 MCP dispatch 按 RFC-247 D2
  清除 purpose（`mcp/dispatch.ts:125-139`）——补工具等于把一个已知无门的跨用户能力
  第一次推给自动化通道。

两者都进 `plan.md §5` 的「本 RFC 不解决」，并在豁免账本里以 `deliberate` category 登记。

### 2.5 A4 —— `answer_clarify` 的状态码文案

### 2.5 A5 —— `answer_clarify` 的状态码文案

描述里的 `412` 改 `409`。**同一个错还在 shared schema 的注释里**
（`shared/schemas/clarify.ts:137-142` 写着「the server returns 412 Precondition Failed」），
同批订正——否则下一个读 schema 的人会把它再抄回工具描述（设计门 P2-5）。

断言写成**精确相等**而不是「不含 412」（后者允许描述干脆不写状态码，等于放行）：

```ts
const codes = [...answerClarifyTool.description.matchAll(/\b([45]\d\d)\b/g)].map((m) =>
  Number(m[1]),
)
expect(codes).toHaveLength(1)
expect(codes[0]).toBe(new ConflictError('x', 'y').status) // 409，两侧都从源码取
// shared schema 的注释里也不许再出现 412
expect(readFileSync(CLARIFY_SCHEMA, 'utf8')).not.toContain('412')
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

### 3.4 memory 人审发布门：**从本 RFC 删除**

v1 设计了 `promote_memory`（后拟改名 `decide_memory_candidate`，因为
`MemoryCandidatePromoteSchema` 是 approve / approve_and_supersede / reject 三态）。
设计门 P1-6 推翻，用户 D11 拍板删除：

`POST /api/memories/:id/promote` 本身 PAT 可达（`memory:update` 是矩阵点），但
**发现 candidate 需要 `resource-acl:bypass`**——`routes/memories.ts:139-143` 对非 bypass
的 actor 过滤掉全部 `status='candidate'` 行，而该点在 `SYSTEM_DOMAIN_POINTS`
（`shared/schemas/permission.ts:846`）里。于是只补 promote 会造出
「**看不到、却能对已知 id 下决定**」的形状，与 G2 承诺的「可发现、可读、可处置」直接矛盾。

真因是权限目录而非缺工具，修法是一个可授予 PAT 的窄点 + 统一 list/get/promote 判据——
跨 RFC 的面，另立。详见 `plan.md §5` 第 2 条（连同它附带的 ACL TOCTOU，设计门 P1-7）。

### 3.5 `list_pending_gates` 扩到四路

**`Promise.allSettled` 本身不够**（设计门 P1-10）：dispatcher 对 HTTP 4xx/5xx 仍然返回
**fulfilled** 的 `DispatchResult`（`mcp/dispatch.ts:109-121`），只有 `unwrap` 才会抛
`McpCallError`。所以必须**在每一路内部先 `unwrap`**，再把结果 settle：

```ts
const路 = async (path: string, query?: Record<string, string>) => {
  try {
    return { ok: true as const, data: unwrap(await ctx.dispatch({ method: 'GET', path, query })) }
  } catch (err) {
    return { ok: false as const, error: err instanceof McpCallError ? err.code : 'error' }
  }
}
const [reviews, clarify, workgroupTasks, fusions] = await Promise.all([
  路('/api/reviews'),
  路('/api/clarify'),
  路('/api/workgroup-tasks/pending'),
  路('/api/fusions', { status: 'awaiting_approval' }),
])
return { reviews, clarify, workgroupTasks, fusions, complete: [...].every((r) => r.ok) }
```

**聚合调用的审计状态必须定义**：一路失败时整个工具今天仍被记成 200
（`mcp/server.ts:83-106`）。约定：`complete:false` 的调用在审计里记为部分失败，
并带上失败的路名——否则「四路里有一路一直 500」这件事在审计里完全看不见。

**golden lock**：`reviews` / `clarify` 两键**内层 `data` 的形状**与既有返回逐字一致
（AC-10）；外层包了 `{ok,data}` 是 v2 新增的分路失败语义，属有意的 wire 变化，
在描述与 `docs/audit-backlog.md` 销账行里写明。

**每行带下一步**（设计门 P2-11）：每个门的行统一投影成
`{kind, id, state, nextTools}`——`kind` 是 `review|clarify|workgroup|fusion`，
`nextTools` 是该门可用的下一步工具名。模型先发现门，再从这里选工具，
而不是在 52 个名字里找。

**已核实**（`routes/fusions.ts:89-105`）：`?status=awaiting_approval` 有效，
`awaiting_approval` 是 `FusionStatusSchema`（`shared/schemas/fusion.ts:10-18`）的合法取值。
两个必须写进 `list_fusions` 描述的语义：

1. **未知 `status` 被当作「无过滤」而不是被拒绝**（`routes/fusions.ts:94-97`：`safeParse`
   失败即 `status = undefined`）。模型拼错值时会**拿到全量列表却以为在看待批的**，
   而这正是它接着要 approve 的东西。`list_fusions` 的入参用 `z.enum` 收口，
   **在工具层就挡掉**——路由的宽容不该传染给工具。
2. **MCP 上恒为 owner-only**（设计门 P2-4）。`routes/fusions.ts:104-106` 对非
   `hasResourceAclBypass(actor)` 者过滤成 `f.ownerUserId === actor.user.id`，而
   `resource-acl:bypass` 是系统域点、PAT 永不持有——所以**不存在能看全局的管理员 PAT**。
   描述必须直说，不得暗示相反；测试锁住这一点。

## 4. 全域「路由 ⟷ 工具」守卫（D8 / D9 / D10）

`packages/backend/tests/architecture/rfc329-mcp-surface-guard.test.ts`。

**v2 相对 v1 的三处改动**（设计门 P1-2 / P1-3 / P1-4 / P1-5，用户 D9 / D10）：
判定从一维（路径）加深到**三维**；豁免从 prefix 改**精确叶子**；权限从子集改**等价**。

### 4.1 分母：运行期路由表，不硬编码

```ts
const db = createInMemoryDb(MIGRATIONS)
createApp({ token, configPath, opencodeVersion, dbVersion, db, secretBox }) // ← secretBox 必给
const routes = allRouteMeta()
```

**`secretBox` 不能省**：省掉它，`mountApiRoutes` 里若干条件挂载的路由整批不挂
（v1 的审计脚本就是这么把分母从 470 记成 440 的）。同款做法见
`tests/contracts/harness.ts:72-89`。

断言写成「覆盖 `allRouteMeta()` 的每一条」，**不写任何具体数字**——AC-11 明确禁止硬编码，
否则路由一增一减就要改断言，而那正是账本该管的事（设计门 P1-11 / P2-10）。

### 4.2 工具侧：声明式 binding，不靠 recording dispatcher 猜

v1 打算照抄 RFC-326 的记录式调度。**它对多跳工具是坏的**（设计门 P1-3）：
recorder 对每次 dispatch 固定返回 `{status:200, body:{}}` 并吞异常
（`rfc326-review-tool-route-guard.test.ts:85-104`），于是 `list_repo_refs` 的第一跳拿到
`{}`、找不到匹配行就抛错，**第二跳永不发生**。

v2 让每个工具**自己声明**它的面：

```ts
interface ToolBinding {
  readonly paths: ReadonlyArray<string> // 'GET /api/tasks/:id/alerts'
  readonly bodyKeys?: ReadonlyArray<string> // 它能表达的请求字段
  readonly requiredPermissions: (args: Record<string, unknown>) => ReadonlyArray<Permission>
}
```

守卫三维对账：

| 维           | 判据                                                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **路径**     | 声明的 `paths` ⟷ `allRouteMeta()`；并用**按工具定制的响应 fixture** 真调 handler，验证它实际 dispatch 的路径就是声明的那些（声明与实现不许漂）                                                                                                                                         |
| **请求字段** | 对写路由：`bodyKeys` 必须覆盖该路由 body schema 的**全部** key，缺一个就红。这一维是本 RFC 的原始缺口所在——`answer_clarify` 路径一直是对的，缺的是 `defer` / `questionIds` / `resubmitQuestionIds`（设计门 P1-2）。`satisfies Partial<Record<...>>` 挡不住：`Partial` 允许遗漏任意 key |
| **权限**     | 见 §4.3                                                                                                                                                                                                                                                                                |

### 4.3 权限维：等价，不是子集

v1 的 F1 写反了（设计门 P1-5）。工具声明的权限决定它**是否出现在 `tools/list`**
（`mcp/tools.ts:52-62`、`toolsFor` `:1261-1265`），路由则要求权限数组**全部满足**
（`routes/registry.ts:71-85,195-200`）。所以：

- 工具**少**声明 → 它出现在列表里，但持该窄矩阵的模型每次调用都被路由拒（v1 的子集规则放行了这种）
- 工具**多**声明 → 明明能用的令牌看不到这个工具

判据因此是：**扣除 PAT 恒有的读权限后，工具权限与其全部 dispatch 目标路由的权限并集精确相等**。

**例外必须声明式**：`resource_write` 故意声明空权限、按 `(kind, method)` 交给路由判定
（`mcp/tools.ts:1057-1066`）。这类工具用 `requiredPermissions(args)` 表达，
守卫对每个 `(kind, method)` 组合各算一次，而不是给它开一个哑豁免。

### 4.4 豁免账本：域分组 + 组内精确叶子

```ts
interface ExemptGroup {
  readonly domain: string // '/api/code' —— 只用于分组显示
  readonly why: string // 这一组为什么没有 MCP 工具
  readonly category: 'never' | 'system-point' | 'system' | 'not-in-scope' | 'deliberate'
  readonly leaves: ReadonlyArray<string> // 'GET /api/code/missions/:id' —— 精确、逐条
}
```

**为什么不能用 prefix**（设计门 P1-4）：prefix 会自动豁免其下**任何未来新增的路由**，
而组数不变、高水位不响——G4「不会有第三次」的保证当场落空。精确叶子则相反：
新路由不在任何一条叶子里 → 落进 `uncovered` → 红 → 逼出一次有署名的决定。

五个 category：

| category       | 含义                                                              | 典型                                                                                                                                   |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `never`        | `tokenAccess:'never'`，PAT 不得开这扇门                           | `/api/auth/*`、各 `PUT .../acl`、`PUT /api/workgroup-tasks/:id/config`                                                                 |
| `system-point` | 权限点在 `SYSTEM_DOMAIN_POINTS`，PAT 结构上够不着（**不是待办**） | `/api/intent-sessions/*`、`/api/users/*`、`/api/runtimes/*`、`/api/config`、`/api/oidc/*`、`/api/backup`、`/api/memory-distill-jobs/*` |
| `system`       | 运维 / 平台面，模型不该碰（但 PAT 权限上够得着）                  | 视重算结果填                                                                                                                           |
| `not-in-scope` | 三类 / 四类，各自等后续 RFC                                       | `/api/code/*`、`/api/digital-employee*`、`/api/event-center/*`、skills 内容面、workflows validate …                                    |
| `deliberate`   | 够得着也不给，各带一句理由                                        | 四个 `pending-count`（模型要行不要数）、`POST /api/fusions`（发起非门）、`find_users` 与 batch-import 两条（见 §2.4）                  |

两条结构约束，都由守卫强制：

1. **每条叶子必须命中现存路由**——写错或已删除的叶子会永久占坑，判 `staleExemptions`。
2. **叶子不许重复**，也不许同时出现在两个组里。

### 4.5 高水位登记

`architecture/ledger-baselines.json` 追加一条，**基线是叶子总数**（不是组数）：

```json
{
  "id": "rfc329-mcp-surface-exemptions",
  "file": "packages/backend/tests/architecture/rfc329-mcp-surface-guard.test.ts",
  "symbol": "MCP_SURFACE_EXEMPTION_LEAVES",
  "baseline": 0,
  "why": "RFC-329：没有 MCP 工具的路由，逐条精确叶子。只许降——每一条都是一处 MCP 够不着的产品面。盯叶子总数而非组数：prefix/组数口径会让新路由被宽豁免静默吸收而基线纹丝不动（设计门 P1-4）。"
}
```

`baseline` 在 T4 落地时填实测值。受 `rfc317-ledger-highwater.test.ts` 的两层规则约束：
与源码逐字相等 + 相对上一 commit 只降不升（要升须写 `allowGrowth` 并点名 RFC）。
**首次登记不算「涨」**——新 id，基线即初始值。

> 清点走 `census.ts` 的 `ledgerEntryCount`（AST，按符号名）。`MCP_SURFACE_EXEMPTION_LEAVES`
> 因此要导出成一个**扁平的叶子数组**（由分组结构 `.flatMap(g => g.leaves)` 派生并导出），
> 否则清点数到的是组数而不是叶子数——账本与判据必须用同一个数。

## 5. 失败模式

| #   | 失败模式                                                                                        | 处置                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 工具权限与路由权限不一致 → 工具在 `tools/list` 里出现但每次调用被拒（或反之，能用的令牌看不到） | §4.3 的**等价**判据（v1 写成子集，方向错了——设计门 P1-5）；参数化工具用 `requiredPermissions(args)`                                                                                                                                                                       |
| F2  | 两跳工具（`list_repo_refs`）第一跳失败 → 500 而非业务拒绝                                       | 第一跳非 2xx 或查无此 id → 抛 `McpCallError`（携原 code / `cached-repo-not-found`），与单跳工具的失败形态一致                                                                                                                                                             |
| F3  | `pendingRows` 重构改变了 `pending-count` 的数字                                                 | count 由 rows 派生（单一实现）；AC-8 断言逐 actor 的 `reduce(rows) === count`；`pending-count` 既有测试保持绿（`rfc164-workgroup-room.test.ts:1047-1061`、`rfc311-workgroup-badge-acl.test.ts:97-115`）                                                                   |
| F4  | `reassign` 改 `allow` 后 PAT 越权改派                                                           | 路由的成员门 `gateMemberEntry`（`routes/taskQuestions.ts:150`）不变——它校验任务成员身份，与凭据类型无关。有非成员 PAT 拒绝用例                                                                                                                                            |
| F5  | 守卫太慢或不稳                                                                                  | 一次 boot app 取路由表；工具侧读**声明式 binding**（不再为覆盖核对装配第二套真实路由面）；handler 真调只在「验证声明与实现一致」那一步做，且用定制 fixture。**给守卫自身加显式超时并把实测耗时写进 plan 的证据表**——v1 写的「实测 < 30s」没有任何输出支撑（设计门 P2-10） |
| F6  | `list_pending_gates` 某一路失败被吞或拖垮全体                                                   | 每路**先 `unwrap` 再 settle**；返回 `{ok,data                                                                                                                                                                                                                             | error}`+`complete`；聚合审计状态按 §3.5 约定记部分失败。`Promise.allSettled` 单独用**不够**——dispatcher 对 4xx/5xx 返回 fulfilled（设计门 P1-10） |
| F7  | `list_fusions` 传错 `status` 静默退化成全量列表，模型据此 approve 错东西                        | 工具入参用 `z.enum` 收口，在 MCP 层就拒——路由的宽容（未知值 = 无过滤）不该传染给工具；描述点名合法取值                                                                                                                                                                    |
| F8  | `save_clarify_draft` 让同题草稿被静默覆盖                                                       | 服务是 later-writer-wins（`services/clarify/rounds.ts:541-545,573-600`），请求 schema 无 revision 字段（`shared/schemas/resourceAcl.ts:272-284`）。本 RFC**不改语义**，但描述必须明说「同题后写覆盖先写」，并有一条 MCP↔网页并发用例锁住现状（设计门 P2-6）               |
| F9  | 模型以为 `dispatch_task_questions` 返回 200 就等于任务已恢复                                    | 路由在落库后 resume 失败时仍返回 HTTP 200，带嵌套 `{resume:{ok:false,...}}`（`routes/taskQuestions.ts:231-269`）。描述必须区分「dispatch 已提交」与「resume 成功」，并要求调用方检查 `resume`（设计门 P2-7）                                                              |
| F10 | 声明式 binding 与 handler 实际行为漂移                                                          | 守卫的路径维不只比对声明，还用定制 fixture 真调 handler 验证实际 dispatch 集合 == 声明集合（§4.2）                                                                                                                                                                        |

## 6. 测试策略

按 CLAUDE.md §Test-with-every-change：**每条改动自带测试，bug 先红后绿**。

### 6.1 必写用例

| 类         | 文件                                            | 覆盖                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 死路径回归 | `rfc329-mcp-dead-paths.test.ts`                 | A1 删除后 `describe_resource` 不再宣称 get；A2 三步闭环走通；A3 两跳 + 第一跳缺 id 的业务拒绝；A4 状态码精确相等 + shared schema 注释无 412                                                                                                                    |
| 反问门     | `rfc329-mcp-clarify-gate.test.ts`               | `defer` 快 / 控两通道；两条互斥拒绝分支；`directive` 在两通道都生效；stop 回写节点开关后可被 `list_clarify_directives` 读回；看板六工具；`reassign` 非成员 PAT 拒绝；`save_clarify_draft` 的同题覆盖语义（F8）；`dispatch` 的 `{resume:{ok:false}}` 分支（F9） |
| 工作组门   | `rfc329-mcp-workgroup-gate.test.ts`             | 逐 actor 的 `reduce(pendingRows) === pendingCount`（owner / stranger / admin、畸形 config、一行同时有 gate 与 delivery）；七个工具；`pending-count` 返回体 golden lock                                                                                         |
| fusion 门  | `rfc329-mcp-fusion-gate.test.ts`                | 五个工具；`z.enum` 拒未知 status；**MCP 上恒 owner-only**（两个不同 owner 的 PAT 各自只看见自己的）                                                                                                                                                            |
| 聚合       | `rfc329-mcp-pending-gates.test.ts`              | 四键；前两键内层 `data` golden lock；一路 500 → 该路 `{ok:false}` 且其余三路正常 + `complete:false`；审计记部分失败                                                                                                                                            |
| 全域守卫   | `architecture/rfc329-mcp-surface-guard.test.ts` | 三维四向 + 账本叶子必须命中 / 不重复 / 不跨组 + 八条负向 fixture + 自身耗时断言                                                                                                                                                                                |

### 6.2 八条变异，**各固化为一条永久负向 fixture**

v1 写的是「实跑一次确认转红」。设计门 P2-9 指出那不会在后续 CI 里再变红——
一次性记录不是守卫。v2 全部改成**常驻的负向 fixture**（对纯比较函数喂构造输入，
断言它报出对应的那一向）：

1. 把 `repos.get` 加回 → `unroutedTools` 命中
2. 删掉任一新工具 → 其路径进 `uncovered`
3. 给一条豁免叶子加工具而不改账本 → `staleExemptions`
4. 账本叶子数变了而不改 `ledger-baselines.json` → 高水位红
5. 写一条已不存在的叶子 → `staleExemptions`
6. 工具权限与路由不等价（多声明 / 少声明各一条）→ 权限维红
7. `answer_clarify` 的 binding 去掉 `defer` → **请求字段维**红（这一条证明 v2 的加深真的抓得住本 RFC 的原始缺口）
8. `pendingRows` 去掉 `visibleTaskIdsOf` → 聚合等式在 stranger actor 上红

> CLAUDE.md 的纪律：**红→绿对里的绿不是终点**——每条修完必须再跑一次原变异确认转红
> （RFC-287 五轮门的教训：字段名笔误 + `as never` 让断言成了 no-op，同一变异照样全绿）。

### 6.3 e2e

`e2e/rfc329-mcp-gate-surface.spec.ts`：一条 PAT 全流程——
`list_pending_gates` 发现工作组任务在等人（读它返回的 `nextTools`）→ `get_workgroup_room`
→ `confirm_workgroup_step` → 任务继续；以及 clarify 控制通道
`answer_clarify(defer:true, questionIds:[...])` → `dispatch_task_questions`。
照抄 `e2e/rfc326-mcp-review-tools.spec.ts:249` 的 `toolCall(patToken, ...)` 姿势。

## 7. 迁移与兼容

- **零 DB 迁移**。
- **零前端改动**。
- **一处有意的 wire 变化**：`list_pending_gates` 的每一路从裸数据变成 `{ok, data|error}`
  包装 + 顶层 `complete`（分路失败语义，§3.5）。内层 `data` 与既有形状逐字一致。
  这是 v2 新增的（设计门 P1-10），在工具描述与 `docs/audit-backlog.md` 销账行里写明。
  其余零 breaking：`answer_clarify` 只加可选参数、`pending-count` 返回体不动。
- `reassign` 的 `tokenAccess` 由 `never` → `allow` 是**放开**，不影响任何既有调用方。
