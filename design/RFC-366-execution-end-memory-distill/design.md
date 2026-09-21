# RFC-366 技术设计 — 执行结束记忆提炼 + 任务来源准入门

## 0. 架构落位（RFC-294 对齐）

| 改动                           | bounded context  | 层                | 说明                                                                              |
| ------------------------------ | ---------------- | ----------------- | --------------------------------------------------------------------------------- |
| 准入判据（纯函数）             | `memory`         | `domain`          | 新增 `domain/distillAdmission.ts`，零 IO、零 Drizzle                              |
| 准入执行 + 去抖键 + scope 收窄 | `memory`         | `application`     | 改 `application/distill/schedule.ts`（已是 memory 的编排唯一入口）                |
| 新两类源的内容装载             | `memory`         | `application`     | 改 `application/distill/memoryDistiller.ts` 的 `loadSourceEvents`                 |
| 新两类源的读模型               | `memory`         | `ports` + `infra` | 扩 `ports/distillWorkStore.ts` + `infrastructure/memoryDistillWorkStore.ts`       |
| 蒸馏器 prompt                  | `memory`         | `domain`          | 改 `domain/distillPrompt.ts`（纯常量）                                            |
| agent 结束挂点                 | `task-execution` | `composition`     | 在节点结算点调一个 **task-execution 自有端口**，bootstrap 注入 memory 的 enqueuer |
| 任务结束挂点                   | `task-execution` | `application`     | 在 `taskLifecycleConsumers.ts` 加一个 committed-event consumer                    |
| 配置契约                       | `shared`         | —                 | `schemas/config.ts` 扩容 + 单一 resolver                                          |
| 装配                           | bootstrap        | —                 | `cli/start.ts`（两 provider）+ `cli/postgresqlDaemonApplication.ts`               |

**跨模块只走 exact public 合同**：`task-execution` 只认 `memory/public/participants.ts` 的
`MemoryDistillEnqueuer`（已存在，collaboration 已在用），不 import memory 的 application/infra。
反向 memory 不 import task-execution——准入需要的三列由 `findTaskScope` 自己 SELECT。

**本 RFC 承担的演进**：把「谁能触发记忆提炼」从四个散落调用点（两处 `cli/start.ts` 内联
consumer + clarify + feedback）收敛成 **`enqueueDistillJob` 内的单一准入闸**。新增两类源不
再多一个散点。

**偏离项**：无。不新增 facade，不新增 cross-context 内部 import，不往 `routes/` / `services/`
加跨域耦合。

---

## 1. 值域与枚举

### 1.1 源类型

DB / wire 字面值采用 kebab（对齐仓内多词枚举先例：`stale-redispatch` / `conflict-human` /
`code-round`）；config 对象键采用 camelCase（对齐 config 命名惯例）。

| 概念       | DB / wire 字面值 | config 键  | i18n key                      |
| ---------- | ---------------- | ---------- | ----------------------------- |
| 澄清答复   | `clarify`        | `clarify`  | `memory.sourceKind.clarify`   |
| 人审决定   | `review`         | `review`   | `memory.sourceKind.review`    |
| 任务留言   | `feedback`       | `feedback` | `memory.sourceKind.feedback`  |
| agent 结束 | `agent-run`      | `agentRun` | `memory.sourceKind.agent-run` |
| 任务结束   | `task-run`       | `taskRun`  | `memory.sourceKind.task-run`  |

`shared/src/schemas/memory.ts`：

```ts
export const DISTILL_SOURCE_KINDS = [
  'clarify',
  'review',
  'feedback',
  'agent-run',
  'task-run',
] as const
export const DistillSourceKindSchema = z.enum(DISTILL_SOURCE_KINDS)
export type DistillSourceKind = z.infer<typeof DistillSourceKindSchema>

/** DB 字面值 ↔ config 对象键的唯一映射（由单测逐项钉死，禁止第二处拼写）。 */
export const DISTILL_SOURCE_CONFIG_KEY = {
  clarify: 'clarify',
  review: 'review',
  feedback: 'feedback',
  'agent-run': 'agentRun',
  'task-run': 'taskRun',
} as const satisfies Record<DistillSourceKind, string>
```

- `MemoryDistillJobSchema.sourceKind`（`schemas/memory.ts:225`）由三值枚举换成
  `DistillSourceKindSchema`。
- `MemorySourceKindSchema`（`schemas/memory.ts:23`）由 `['clarify','review','feedback','manual']`
  扩成 `[...DISTILL_SOURCE_KINDS, 'manual']`。

### 1.2 数据库迁移

两张表的 `source_kind` CHECK 都要扩容，**SQLite 与 PostgreSQL 各一份**：

`packages/backend/db/migrations/0228_rfc366_distill_source_kinds.sql`
SQLite 不能 `ALTER … DROP CONSTRAINT`，按仓内既有做法整表重建（先例：
`0145_rfc278_legacy_schema_reconciliation.sql`、`0208_rfc321_repository_transport_credentials.sql`）：
`PRAGMA foreign_keys=OFF` → 建 `__new_*` → `INSERT … SELECT` → `DROP` → `RENAME` → 重建索引 →
`PRAGMA foreign_keys=ON`。注意 `memory_distill_events.distill_job_id` 对 `memory_distill_jobs.id`
有 FK（`schema.ts:4241`），重建顺序必须保证 FK 指向新表。

`packages/backend/db/postgresql-migrations/0004_rfc366_distill_source_kinds.sql`

```sql
ALTER TABLE "agent_workflow"."memory_distill_jobs" DROP CONSTRAINT "memory_distill_jobs_source_kind_enum";
ALTER TABLE "agent_workflow"."memory_distill_jobs" ADD CONSTRAINT "memory_distill_jobs_source_kind_enum"
  CHECK ("source_kind" IN ('clarify','review','feedback','agent-run','task-run'));
ALTER TABLE "agent_workflow"."memories" DROP CONSTRAINT "memories_source_kind_enum";
ALTER TABLE "agent_workflow"."memories" ADD CONSTRAINT "memories_source_kind_enum"
  CHECK ("source_kind" IN ('clarify','review','feedback','agent-run','task-run','manual'));
```

`db/schema.ts` 两处 `enum:` 与两处 `check(...)` 同步改（`schema.ts:3995-3996`、`4040-4042`、
`4186`、`4219-4222`）。存量行不回填、不改写。

---

## 2. 配置契约

### 2.1 新增键（`shared/src/schemas/config.ts`）

```ts
// --- RFC-366 execution-end distill ---
/** 允许提炼的任务来源白名单。省略 ≡ ['manual']。空数组 = 关掉所有任务相关提炼。 */
memoryDistillLaunchOrigins: z.array(TaskLaunchOriginSchema).optional(),
/** 逐源开关。省略的键 ≡ true。 */
memoryDistillSources: z.object({
  clarify: z.boolean().optional(),
  review: z.boolean().optional(),
  feedback: z.boolean().optional(),
  agentRun: z.boolean().optional(),
  taskRun: z.boolean().optional(),
}).optional(),
/** agent-run 源的去抖窗口（ms）。省略 ≡ 60000。 */
memoryDistillAgentRunDebounceMs: z.number().int().min(0).max(600_000).optional(),
```

数值型设置项走仓内单一事实源 `shared/src/settingsNumericBounds.ts`：`SETTINGS_NUMERIC_BOUNDS`
加一条 `memoryDistillAgentRunDebounceMs: { min: 0, max: 600_000, step: 1_000, unit: 'ms' }`，
patch 侧用 `boundedSettingsInteger('memoryDistillAgentRunDebounceMs')`，全量 config 侧按邻居
惯例手写 `min/max`（宽松解析存量配置）。这条约定由并行落地的 `memoryDistillTimeoutMs` 确立，
见 §11。

`memoryDistillSourceContext` **扩容为可选字段**（不能加必填——存量 config 只有两个键，
加必填会让 `loadConfig` 直接解析失败）：

```ts
memoryDistillSourceContext: z.object({
  clarifyTranscriptMaxBytes: z.number().int().min(0).max(65536),
  reviewBodyMaxBytes: z.number().int().min(0).max(65536),
  agentTranscriptMaxBytes: z.number().int().min(0).max(65536).optional(),   // 默认 16384
  agentOutputsMaxBytes: z.number().int().min(0).max(65536).optional(),      // 默认 8192
  agentInjectedMemoriesMaxBytes: z.number().int().min(0).max(65536).optional(), // 默认 4096
  taskSummaryMaxBytes: z.number().int().min(0).max(65536).optional(),       // 默认 8192
}).optional(),
```

`DEFAULT_SOURCE_CONTEXT_BUDGET` 补齐新四项；新增
`resolveSourceContextBudget(raw?): SourceContextBudget` 作为唯一补默认入口，
`SourceContextBudget` 接口的新字段是**必填**（内部类型），外部 zod 是可选，两者由 resolver 桥接。

`ConfigPatchSchema`（`config.ts` 的 `memoryDistillLang` 一带）补三个可 patch 项，沿用该 schema 的
「`null` = 删除 = 回落默认」契约：`memoryDistillLaunchOrigins` / `memoryDistillSources` 各自
`.nullable().optional()`，`memoryDistillAgentRunDebounceMs` 用
`boundedSettingsInteger(...).nullable().optional()`。

### 2.2 热读（D10）

沿 RFC-050 的 ambient provider 先例（`schedule.ts:57-68` 的 `setMemoryDistillLangProvider`），
扩成一个**策略 provider**，一次拿全：

```ts
// application/distill/schedule.ts
export interface DistillPolicy {
  readonly launchOrigins: readonly TaskLaunchOrigin[]
  readonly sources: Readonly<Record<DistillSourceKind, boolean>>
  readonly agentRunDebounceMs: number
  readonly outputLang: Language | null
}
let policyProvider: () => DistillPolicy = () => DEFAULT_DISTILL_POLICY
export function setMemoryDistillPolicyProvider(fn: () => DistillPolicy): void
export function resetMemoryDistillPolicyProviderForTest(): void
```

`cli/start.ts` 注册一个**每次调用现读磁盘**的实现（与现有 lang provider 同处注册，
`cli/start.ts:3186` 附近），把 `loadConfig(Paths.config)` 的四项映射成 `DistillPolicy`。
现有 `setMemoryDistillLangProvider` 被 `policy.outputLang` 吸收，旧导出保留为向后兼容
薄壳并在同一 PR 内删除全部调用点（面向代码最合理优于改动最小）。

`memoryDistillerEnabled` / `memoryDistillSourceContext` **保持启动快照不变**（本 RFC
不扩大改动面；用户选的是「新配置热读」而非「把旧的也改热读」）。

---

## 3. 准入判据（单一事实源）

`packages/backend/src/modules/memory/domain/distillAdmission.ts`（纯函数、零 IO）：

```ts
export type DistillRejectReason = 'source-disabled' | 'launch-origin-not-allowed' | 'internal-task'

export interface DistillTaskFacts {
  readonly launchOrigin: TaskLaunchOrigin
  readonly catalogVisibility: TaskCatalogVisibility
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
}

export function distillAdmission(input: {
  readonly sourceKind: DistillSourceKind
  readonly task: DistillTaskFacts | null
  readonly policy: Pick<DistillPolicy, 'launchOrigins' | 'sources'>
}): { readonly admitted: true } | { readonly admitted: false; readonly reason: DistillRejectReason }
```

判定顺序（顺序本身是契约，由测试钉死——它决定审计日志里记哪个 reason）：

1. `policy.sources[sourceKind] === false` → `source-disabled`
2. `task === null` → **admitted**（无任务轴可判；今天无生产调用方走这条，保留是为了不把
   schema 里的 `task_id NULL` 变成隐式拒绝）
3. `task.catalogVisibility === 'internal' || task.spaceKind === 'internal'` → `internal-task`
   （D7；两条都判，因为数字员工/动作执行写前者、融合走 `internalSource` 落后者）
4. `!policy.launchOrigins.includes(task.launchOrigin)` → `launch-origin-not-allowed`
5. 否则 admitted

**执行点只有一个**：`enqueueDistillJob`（`application/distill/schedule.ts:101`）。
五类源全部经过它，任何调用方都绕不过去。

`MemoryDistillTaskScopeRecord` 扩三列（`ports/distillWorkStore.ts:5-11`），
`findTaskScope` 的 SELECT 投影相应加三列（`infrastructure/memoryDistillWorkStore.ts:32-56`）——
**不新增查询**，准入与 scope 解析共用同一次读。

被拒时 `enqueueDistillJob` 返回 `null`（签名由 `Promise<EnqueueResult>` 变为
`Promise<EnqueueResult | null>`），并打一行 `log.debug('distill enqueue rejected', {...})`。
调用方处置：

| 调用方                                            | 处置                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `clarify/autoDispatch.ts:390-400`                 | 本就 best-effort + swallow，`null` 直接忽略                        |
| `collaborationCommittedEventConsumers.ts:96-114`  | `null` 视为该 consumer 完成（不重投）                              |
| `collaboration/application/taskFeedback.ts:45-53` | `null` → 跳过 `markDistilled`，`distillJobId` 返回 `null`（AC-15） |
| 新的 agent-run participant                        | 同 clarify，swallow                                                |
| 新的 task-run consumer                            | 同 review consumer                                                 |

---

## 4. 去抖键与 scope（D8 + D11）

### 4.1 去抖键

```ts
function buildDebounceKey(input): string {
  if (input.taskId === null) return `noTask:${input.sourceKind}:${input.sourceEventId}`
  if (input.sourceKind === 'agent-run') return `${input.taskId}:agent-run:${input.agentKey}`
  return `${input.taskId}:${input.sourceKind}`
}
```

`agentKey` = 本次结束 run 所属 agent 的 `agents.id`（可解析时），否则回落 `node:${nodeId}`。

**为什么 agent-run 的键要带 agent**：`runDistill` 只用 head job 的 `scopeResolved`
（`memoryDistiller.ts:886`），兄弟 job 的 scope 被丢弃。今天四类源的 scope 只由 `taskId` 决定，
所以 head == sibling，无 bug。D11 要把 agent-run 的 scope 收窄到「本次那个 agent」，如果键仍是
`taskId:agent-run`，agent A 与 agent B 的 job 会合并，B 的候选就只能落在 A 的 scope 上。
把 agent id 放进键，**恢复「同一去抖键 ⇒ 同一 scope」这条不变量**，无需改 `runDistill`。
该不变量单独写一条注释 + 一条单测钉住。

代价：一个任务里 N 个不同 agent 在同一窗口结束 → N 个 job（而非 1 个）。这是 D11 的必然
代价，且 loop 多轮 / fanout 多分片（同一 agent）仍然合并——AC-10 / AC-11 的省量部分保留。

### 4.2 去抖窗口

`enqueueDistillJob` 的 `debounceMs` 解析顺序：显式入参 > `sourceKind === 'agent-run'` 时取
`policy.agentRunDebounceMs`（默认 60000）> `DISTILL_DEBOUNCE_MS`（5000）。

### 4.3 scope 收窄

`computeEligibleScopes(store, taskId)` 增加可选第三参 `narrowAgentId?: string | null`：
当传入且非空时，返回的 `agentIds` **只含该 id**；`workflowId` / `repoId` / `includeGlobal`
照旧。不传或为 `null` 时行为逐字不变（四类既有源零回归）。

workgroup 任务的宿主 node_run 没有成员 agent 列（`node_runs` 无 `agent_id`，见
`memoryDistiller.ts:355-357` 的既有注释；`wg_round` 只是轮序），所以 workgroup 的
agent-run **不收窄**，沿用 `extractAgentIdsFromWorkgroupConfig` 的全量成员 scope。

---

## 5. 触发链路

### 5.1 `agent-run`（D1 / D13）

**挂点**：`modules/task-execution/composition/nodeMechanics.ts` 中 agent-single 的
每次尝试结算点——`broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)`
（≈`nodeMechanics.ts:4667`）之后。该点位于重试循环体内，天然满足 D1 的「每次重试各一次」。

**端口**（task-execution 自有，不反向依赖 memory 的实现）：

```ts
// modules/task-execution/application/ports/agentRunSettledObserver.ts
export interface AgentRunSettledObserver {
  onAgentRunSettled(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly nodeId: string
    readonly status: NodeRunStatus
  }): Promise<void>
}
```

`SchedulerState.opts` 增加可选 `agentRunSettled?: AgentRunSettledObserver`；未注入时是 no-op
（测试与旧装配路径零影响）。调用处：

```ts
if (status === 'done' || status === 'failed') {
  await state.opts.agentRunSettled?.onAgentRunSettled({...}).catch(() => { /* best-effort */ })
}
```

**终态过滤（D4）在挂点就做**——`done` / `failed` 之外一律不调用，不把「哪些状态算结束」
这件事泄露到 memory 模块。

**装配**：bootstrap（`cli/start.ts` 两处 + `postgresqlDaemonApplication.ts`）用
`memoryOperations.distillCommands.enqueue` 组一个 observer：解析 agent id（见下），
调 `enqueue({ sourceKind: 'agent-run', sourceEventId: nodeRunId, taskId, agentKey })`。

**agent id 解析**：`enqueueDistillJob` 内完成，复用既有工具——从 `findTaskScope` 拿到
`workflowSnapshot`，按 `nodeId` 找到节点，`agentRefOfNode(node)`（`services/ref/runtimeRef.ts`，
`schedule.ts:167` 已在用）取 `k === 'id'` 的 id；`QUARANTINED_SNAPSHOT_AGENT_ID` 与
name-only 节点视为不可解析。这样 `EnqueueDistillJobInput` 只多一个 `nodeId?: string`，
不让调用方承担解析责任。

### 5.2 `task-run`（D4）

在 `modules/task-execution/application/taskLifecycleConsumers.ts` 的
`createTaskLifecycleDurableConsumerDefinitions` 里加第七个 consumer，形状照抄
`task-execution-watch`（同文件 `:88-110`）：

```ts
{
  id: 'task-terminal-distill-enqueue',
  eventTypes: ['task.lifecycle-transitioned.v1'],
  deliveryClass: 'rebuildable',
  settle: 'durable-effect-recorded',
  async handle(value) {
    const event = decodeTaskLifecycleCommittedEvent(value)
    if (event.type !== 'task.lifecycle-transitioned.v1') return
    if (event.payload.status !== 'done' && event.payload.status !== 'failed') return
    if (event.payload.continuationHandoff) return          // ← 关键：多段式续跑的中转态不是结局
    await input.enqueueTaskRunDistill({ taskId: event.payload.taskId })
  },
}
```

`continuationHandoff` 的判据与既有三个 consumer 完全一致（PostgreSQL 两段式 retry 会把任务
推到一个可 resume 的终态再 CAS 回 `pending`；不跳过就会在「重试进行中」时谎报任务结束，
见同文件 `:56-75` 的长注释）。

`input` 增加 `enqueueTaskRunDistill(input: { taskId: string }): Promise<void>`，
bootstrap 注入 memory 的 enqueuer（与 `enqueueReviewDistill` 在 `cli/start.ts:660` /
`cli/start.ts:2773` 同处装配）。

`sourceEventId` = `taskId`（任务结束这件事本身就以任务为标识；去抖键
`${taskId}:task-run` 天然保证一个任务只有一个 task-run job 在队列里）。

---

## 6. 源内容装载

### 6.1 端口扩容

```ts
export interface MemoryDistillAgentRunWorkRecord {
  readonly id: string // node_run id
  readonly taskId: string
  readonly nodeId: string
  readonly status: string // 'done' | 'failed'
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly errorMessage: string | null
  readonly failureCode: string | null
  readonly promptText: string | null
  readonly promptPath: string | null
  readonly opencodeSessionId: string | null
  readonly injectedMemoriesJson: string | null
}
export interface MemoryDistillNodeRunOutputRecord {
  readonly nodeRunId: string
  readonly portName: string
  readonly content: string
  readonly kind: string | null
}
export interface MemoryDistillTaskRunWorkRecord {
  readonly id: string // task id
  readonly name: string
  readonly status: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly runningMs: number
  readonly errorSummary: string | null
  readonly errorMessage: string | null
  readonly failedNodeId: string | null
  readonly inputs: string // JSON
  readonly workflowSnapshot: string
}
export interface MemoryDistillTaskNodeStatusRecord {
  readonly taskId: string
  readonly nodeId: string
  readonly status: string
  readonly retryIndex: number
  readonly finishedAt: number | null
}
```

新增方法：`listAgentRunSources` / `listNodeRunOutputs` / `listTaskRunSources` /
`listTaskNodeStatuses` / `listTaskFinalOutputs`。全部批量（`inArray`），与既有
`listClarifySources` 同型。

### 6.2 `agent-run` 的 prompt 块（D5）

```
## agent run <nodeRunId>
task: <taskId>   node: <nodeId>   agent: <agentName>   status: done|failed
duration: <ms>   failureCode: <code|->

### prompt
<promptText / promptPath 读文件；沿用既有 readNodeRunPrompt>

### injected memories (already known to this run)
- [agent] <title> — <body 前 200 字>
- [repo]  <title> — <body 前 200 字>
   （来源：node_runs.injected_memories_json；裁至 agentInjectedMemoriesMaxBytes）

### transcript
<parseSessionTree(...) → renderSessionTreeToDistillerMd(...)，裁至 agentTranscriptMaxBytes>

### outputs
- port "<name>" (<kind>): <content>
   （裁至 agentOutputsMaxBytes；`active=false` 的行跳过）

### error
<errorMessage，仅 status=failed 时>
```

transcript 渲染**直接复用** `loadClarifyTranscripts` 里那套（`memoryDistiller.ts:311-370`）：
`store.listNodeRuns` + `store.listNodeRunEvents` + `parseSessionTree` +
`renderSessionTreeToDistillerMd` + `clipHeadTail`。抽成
`renderNodeRunTranscript(store, runIds, maxBytes)` 供 clarify 与 agent-run 共用，clarify
路径行为逐字不变（同一函数、同一预算键）。

各块预算为 0 时整块跳过，并像既有实现那样留一行 `reason` 占位（`disabled by config`），
保持 RFC-044 的降级语义。

### 6.3 `task-run` 的 prompt 块（D6）

```
## task <taskId>
name: <name>   status: done|failed   duration: <runningMs>
failedNode: <nodeId|->   errorSummary: <...>

### launch inputs
<tasks.inputs JSON，裁剪>

### node outcomes
| node | status | retry | finished |
| ---- | ------ | ----- | -------- |
（每个 nodeId 取最新一行 node_run 的终态）

### final outputs
- node "<outputNodeId>" port "<name>": <content>
（只取工作流定义里 kind='output' 的节点的输出端口）
```

**不含 transcript**——D1 已让每个 agent run 各自喂过全文，重复搬运纯属浪费 token。
整块裁至 `taskSummaryMaxBytes`。

### 6.4 `loadSourceEvents` 扩容

`memoryDistiller.ts:219-390` 的 `LoadedSourceEvents` 增加 `agentRun` / `taskRun` 两个数组，
按 `jobs.filter(j => j.sourceKind === …)` 分流（与现有三类同型）。
prompt 组装函数 `buildUserPrompt`（同文件 `:471-610` 区段）增加两个渲染分支。

---

## 7. 蒸馏器 prompt 变更（D14）

`domain/distillPrompt.ts` 的 `DISTILLER_SYSTEM_PROMPT` 三处改动：

1. 首段枚举：`… (clarify Q&A, human review decisions, task-feedback notes, finished agent
runs, or finished task executions) …`
2. `sourceRefs` 的 kind 枚举：`"kind": "clarify" | "review" | "feedback" | "agent-run" | "task-run"`
3. 新增一段 **source-specific guidance**（放在 "Cross-cutting properties" 之后、"REJECT" 之前）：

```
Source-specific guidance:
- agent-run events give you a full agent transcript. The transcript is a NARRATIVE; your job is
  to extract the RULE it revealed, never to summarize what happened. Prefer [category:anti-pattern]
  (a path the agent tried and the environment rejected), [category:convention] (a tool/command/
  layout fact the agent had to discover), [category:integration] (an external contract the agent
  hit) and [category:invariant]. Emit NOTHING for a run that simply succeeded on the first try
  with no surprise — "the agent did the task" is not a memory. The block also lists the memories
  already injected into that run: never re-emit one of those as "new"; if the run contradicts or
  refines one, use action "conflict_with" / "update_of" against its id.
- task-run events give you the outcome of a whole execution, not a transcript. Prefer
  [category:process] (ordering / dependency facts the run proved), [category:quality-bar]
  (what "done" turned out to require) and [category:architecture]. A failed task is usually the
  more valuable one: extract why the shape of the work made it fail, not the stack trace.
```

**注意这是生产代码**（`docs/dev-gotchas.md`「给模型的 prompt 就是生产代码」）：
`memory-distiller-grep-output-lang-directive.test.ts` 与 `memory-distiller.test.ts` 的
逐字断言 / 类别前缀锁必须同步更新，且更新后 `[category:xxx]` 十类前缀**一个不许少**。

---

## 8. 前端（D12）

复用既有公共组件，**不新写原生元素 / 自有 CSS**（CLAUDE.md §Frontend UI consistency）：

- **设置页** `routes/settings.tsx` 的「记忆」卡片（现有 `memoryDistillRuntime` /
  `memoryDistillLang` 所在区块，`:2200-2230`）追加：
  - 来源白名单：五选多选。用既有 `.segmented`（`styles.css`）做不到多选，改用
    `<Field>` + 五个 `<Switch>`（每个 origin 一行），与「逐源开关」同形，避免引入
    仓内不存在的 multi-select 原语。
  - 逐源开关：`<Field>` + 五个 `<Switch>`。
  - agent 去抖窗口：`<Field>` + `<NumberInput>`（秒为单位展示，写库 ms）。
- **蒸馏任务表** `components/memory/MemoryDistillJobsTable.tsx:126` 已经在渲染
  `t('memory.sourceKind.${job.sourceKind}')`，只需补两个 i18n key；筛选下拉补两个选项。
- **审批队列** `components/memory/MemoryApprovalQueue.tsx:213` 走 `sourceKindLabel`
  （`lib/memory.ts`），补两个分支。
- **留言区** `components/tasks/TaskFeedbackList.tsx:223` 的「已交付提炼」chip 已按
  `row.distilled` 条件渲染，被拒时 `distilled=false` 自然不显示——**零改动**（AC-15）。
- i18n：`en-US.ts` / `zh-CN.ts` 各补 `memory.sourceKind.agent-run` / `task-run` +
  设置页 label/hint 共约 14 个 key。

---

## 9. 失败模式

| 场景                                     | 行为                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| agent 结算时 daemon 崩溃                 | 该 run 的记忆丢失（D13 best-effort）。若 `task-run` 开着，任务结束源兜一层              |
| `findTaskScope` 读不到任务行（任务已删） | `task === null` → admitted（§3 步骤 2），scope 退化为 global-only；与既有行为一致       |
| workflowSnapshot 解析不出 agent id       | 去抖键回落 `node:${nodeId}`，scope 不收窄；不拒绝入队                                   |
| node_run 无 events（进程没起来就失败）   | transcript 块为 `no events captured`，其余块照常；不拒绝                                |
| `injected_memories_json` 非法 JSON       | 该块渲染为 `unreadable`，其余块照常                                                     |
| 配置里 `memoryDistillLaunchOrigins: []`  | 所有带 task 的源全拒；`taskId===null` 的源仍放行（今天无此类调用方）                    |
| 配置文件在两次 enqueue 之间被改          | 逐次现读，后一次按新策略；**已入队的 job 不回溯撤销**                                   |
| 同一任务 50 个 agent 在 60s 内结束       | 50 个不同 agent ⇒ 最多 50 个 job（D11 的代价，§4.1 已说明）；同 agent 的多轮/多分片合并 |

---

## 10. 测试策略

> CLAUDE.md §Test-with-every-change：新功能正向/边界/错误路径全覆盖；
> §RFC workflow 第 7 条：**每条禁用/拒绝分支必须有测试覆盖**。

### 10.1 domain 纯函数（首选可断言面）

`packages/backend/tests/rfc366-distill-admission.test.ts`

- 五类源 × `sources[kind]=false` → `source-disabled`（5 例，**禁用分支覆盖**）
- 五个 `launchOrigin` × 默认白名单 → 仅 `manual` admitted（5 例，**禁用分支覆盖**）
- `catalogVisibility='internal'` / `spaceKind='internal'` 各一例 → `internal-task`，
  且**即使 launchOrigin 在白名单里也拒**（2 例）
- 判定顺序：源关闭 + 来源不在白名单 → reason 必须是 `source-disabled`（1 例）
- `task === null` → admitted（1 例）
- `DISTILL_SOURCE_CONFIG_KEY` 五项映射逐字（1 例）

`packages/backend/tests/rfc366-distill-debounce-key.test.ts`

- agent-run 键带 agent id；同 agent 不同 run 同键；不同 agent 不同键
- **不变量锁**：同一去抖键的所有 job 必须解析出同一 scope（构造 A/B 两 agent 断言不同键）
- 其余四类键逐字不变（回归防护，锁 `${taskId}:${sourceKind}`）

### 10.2 调度/入队

`packages/backend/tests/rfc366-execution-end-enqueue.test.ts`

- AC-1 / AC-2 / AC-4：`agent-run` / `task-run` 行落库，字段逐项断言
- AC-3：非 `done|failed` 的四个 agent 终态各一例 → 无行（**禁用分支覆盖**）
- AC-5：`launchOrigin='scheduled'` 下五类源各一例 → 无行（**C1–C6 的禁用分支覆盖**）
- AC-8：internal 任务五类源各一例 → 无行（**C7 的禁用分支覆盖**）
- AC-6：provider 中途改白名单，下一次 enqueue 即生效（热读）
- AC-7：单源开关关掉只影响该源
- AC-12：scope 收窄；workgroup 任务不收窄
- AC-10 / AC-11：loop 3 轮 / fanout 5 片 → 同键，`listPendingSiblings` 合并为一次 run

### 10.3 内容装载

`packages/backend/tests/rfc366-source-context.test.ts`

- AC-13：三块齐全 + 各自预算裁剪 + `[truncated N bytes]` 标记
- AC-14：task-run 块含摘要/入参/节点表/最终输出，**不含** transcript
- 预算为 0 → 整块跳过并留 reason（与 RFC-044 同型）
- 错误路径：无 events / 非法 injected JSON / 读不到 promptPath 各一例

### 10.4 生命周期挂点

`packages/backend/tests/rfc366-task-terminal-consumer.test.ts`

- `done` / `failed` 各触发一次；`canceled` / `interrupted` 不触发
- `continuationHandoff=true` 的 `interrupted` **不触发**（PostgreSQL 两段式 retry 回归防护）

`packages/backend/tests/rfc366-agent-run-observer.test.ts`

- observer 未注入时 no-op、不抛
- observer 抛异常时节点结算流程不受影响（AC-21）
- 重试第 2 次 attempt 同样触发（D1）

### 10.5 迁移

`packages/backend/tests/migration-0228-distill-source-kinds.test.ts`

- 迁移后两张表可插入新两值、仍拒非法值
- 存量行内容与索引逐项不变（重建表的正确性）

### 10.6 回归防护（AC-19 / AC-20）

- `clarify-review-enqueue-distill.test.ts` / `memory-distill-scheduler.test.ts` /
  `memory-distiller*.test.ts` **不许改断言**，只在 fixture 里补 `launchOrigin='manual'`。
  任务 fixture 默认就是 `manual`（列默认值），预期零改动。
- `memory-distiller.test.ts` 的十类前缀 grep 锁 + prompt 哈希基线同步更新，并在文件
  顶端注明「RFC-366 扩了枚举与 source-specific guidance；十类前缀一个不许少」。

### 10.7 前端

`packages/frontend/tests/rfc366-settings-distill-policy.test.tsx`

- 三组控件渲染、改动写进草稿、保存 PATCH 体正确
- 用 `findByRole` 断言（公共组件契约），不依赖 DOM 结构

`packages/frontend/tests/rfc366-distill-source-labels.test.tsx`

- 两个新来源在蒸馏任务表与审批队列的中英文标签
- 筛选下拉包含两个新选项

### 10.8 e2e

`e2e/rfc366-execution-end-distill.spec.ts`

- 手工任务跑完 → 蒸馏任务分区出现 `agent-run` / `task-run` 行
- 设置页把 `manual` 取消勾选 → 再跑一个任务 → 无新行（**用户可见的禁用分支**）

---

## 11. 并发改动与冲突面（2026-09-21 落档时实测）

落档当刻工作树里有**另一个 session 正在并行落地 `memoryDistillTimeoutMs`**（蒸馏子进程单次
超时，默认 1 小时、上界 6 小时），它已改动的文件与本 RFC 高度重叠：

| 文件                                                        | 对方在改                                   | 本 RFC 也要改                                  |
| ----------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `packages/shared/src/schemas/config.ts`                     | `memoryDistillTimeoutMs` 全量 + patch 条目 | 三个新键 + `memoryDistillSourceContext` 扩容   |
| `packages/shared/src/settingsNumericBounds.ts`              | `memoryDistillTimeoutMs` bound             | `memoryDistillAgentRunDebounceMs` bound        |
| `.../memory/application/distill/schedule.ts`                | timeout 透传                               | 准入闸 + policy provider + 去抖键 + scope 收窄 |
| `.../memory/application/distill/memoryDistiller.ts`         | `DEFAULT_TIMEOUT_MS` + 超时接线            | 两类新源的装载与 prompt 分支                   |
| `.../memory/public/commands.ts`                             | worker options 加 `timeoutMs`              | `EnqueueResult \| null` + 新源类型             |
| `packages/frontend/src/routes/settings.tsx` / i18n / drafts | 超时输入框                                 | 白名单 + 逐源开关 + 去抖窗口                   |

处置（CLAUDE.md §Multi-person collaboration）：

1. **实现前先 `git fetch` + `git merge --ff-only origin/main`**，确认对方那批已经落到
   `main` 再开工——在对方的在制品上叠改动会把两份工作绞在一起。
2. 若开工时对方仍未提交，**按路径精确 `git add`、`git commit -- <我的路径…>`**，
   提交前 `git diff --cached --stat` 逐条确认暂存区里没有对方的文件。
3. 同一文件里两边都有改动时（`config.ts` / `schedule.ts` 几乎必然），
   `git diff HEAD -- <file>` 逐 hunk 认领，**绝不回退对方的行**。
4. 本设计里的 `file:line` 锚点取自落档当刻的 `HEAD`（`908922c4d` → 开工时 `424feffc3`）。
   对方那批合入后行号会漂移——**按符号名重新定位，不要照搬行号**。

### 11.1 与 RFC-367 的依赖（重要）

同一窗口里还并行开出了 **RFC-367「记忆蒸馏输出协议归一」**，它实测出一个**前置事实**：
蒸馏器当前**已静默失效一个多月**——`memory_distill_jobs` 里 176 个 `done` 有 76 个零候选，
有会话捕获的 10 个 **10/10 零候选**（模型把 envelope 写成 `<wflow-output>` / `<wf-output>`
或漏掉 `<port>` 包裹，完整候选 JSON 被 stdout 解析丢弃），最后一条真正落库的候选停在
2026-07-17。

对本 RFC 的含义：

- **RFC-366 不修这条链**——它只负责「把更多事件放进队列」，候选能不能落库由 RFC-367 负责。
- 因此 **RFC-366 的验收不能以「记忆库里出现候选」为准**，只能以
  「`memory_distill_jobs` 出现正确的行 + 蒸馏 user prompt 内容正确」为准。
  `proposal.md §7` 的 AC 已经是这个口径（AC-1/2/4 断言 job 行，AC-13/14 断言 prompt 块），
  **不要**在实现期把它们改成断言 `memories` 表。
- AC-16（候选 `source_kind` 落 `agent-run` / `task-run`）在 RFC-367 落地前只能靠
  **直插候选行的单测**验证，e2e 层面不可达；`e2e/rfc366-execution-end-distill.spec.ts`
  相应只断言蒸馏任务分区的行，不断言候选记忆。
- 本 RFC 若先于 RFC-367 合入，用户可见效果是「蒸馏任务多了两类、候选仍然是零」——
  这是既有故障的延续，不是 RFC-366 引入的回归。两者都合入后才有端到端价值。
