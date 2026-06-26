# RFC-109 技术设计 — 任务工作流热同步

> 读法：先 `proposal.md`，再本文，最后 `plan.md`。本文所有「现状」断言都带 file:line，便于复核。

## 1. 现状回源（证据）

### 1.1 任务持有的是冻结快照，调度器只读它

- `tasks.workflow_snapshot text NOT NULL` —— `schema.ts:411`，注释 "JSON: workflow definition at start time" / 表注释 "Holds workflow snapshot for replay safety"。
- `tasks.workflow_id` 外键指向实时 `workflows`，`workflows.version` 每次 PUT 自增 —— `schema.ts:408-410, 319`。
- 启动时写入：`workflowSnapshot: JSON.stringify(workflow.definition)` —— `task.ts:748`（`workflow` 是实时行）。**当前不写版本号**。
- 调度器每次 `runTask()` 入口**无条件重解析**：`const raw = JSON.parse(task.workflowSnapshot); definition = WorkflowDefinitionSchema.parse(raw)` —— `scheduler.ts:301-302`。解析结果缓存在单次 `runTask` 的 `SchedulerState.definition`（`scheduler.ts:~399`），但**下一次 `runTask` 重读**——所以「换快照 + 重新 runTask」即可让新定义生效。
- `retryNode` 也重读 `task.workflowSnapshot`（`task.ts:1272`）——证实今天的重试**带不进**实时工作流的修复。

### 1.2 引擎对拓扑变化的容忍度（本 RFC 的地基）

- **新增节点**：`isDispatchable(row=undefined,...) → true` —— `dispatchFrontier.ts:303`。上游 `areTransitiveUpstreamsCompleted` 通过即派发（`freshness.ts:92`）。
- **删除节点**：派发前 `if (!scopeIds.has(r.nodeId)) continue` 静默跳过孤儿 node_run —— `scheduler.ts:1209`；`scopeIds` 来自解析后的 `definition.nodes`（`scheduler.ts:686`）。无异常。
- **边/拓扑**：上游依赖与端口接线均实时从 `definition.edges` 读（`buildScopeUpstreams` `scheduler.ts:4856`；`resolveUpstreamInputs` `scheduler.ts:~4485`）。
- **端口接线**：下游输入取上游 node_run 的 `node_run_outputs`，缺端口 `port?.content ?? ''` —— `scheduler.ts:~4516`。**端口改名 → 下游静默读到空串**（本 RFC 的预览警告对象，非阻断）。
- **已完成节点**：`isDispatchable` 对 `done` 行返回 `!isNodeRunFresh(...)`——上游未推进时为 false，即**不自动重跑**（D2 保留语义天然成立）。
- **终态收敛**：`decideScopeOutcome`（`dispatchFrontier.ts:396`）按 awaiting_human > awaiting_review > failure > exhausted > allSettled→ok > stalled 收敛。`done` 任务重新 runTask 后若无新增可派发节点则即刻回 `done`（无副作用 no-op）。

### 1.3 resume 的结构（被抽取复用的核心）

`resumeTask(db, id, deps)` —— `task.ts:1053-1185`：
1. `getTask` + `isTaskActive(id)` 入口拒（`task.ts:1061`，调度器已持有则 409 `task-not-resumable`）。
2. 状态闸：仅 `failed/interrupted/awaiting_review/awaiting_human`（`task.ts:1067-1077`）。
3. **CAS 所有权锁**：`setTaskStatus({to:'pending', allowedFrom:[...], allowTerminal:true, extra:{清错误四元组}, reason:'resumeTask'})` —— `task.ts:1085-1093`；移到任何 git 副作用**之前**，并发输者零副作用。
4. 回滚：`selectResumeRollbackTargets(runs)`（top-level 且 failed/interrupted、按 id 序 freshest）→ 逐个 `killStaleRunProcessTree` + `rollbackNodeRunForResume` + `escalateSnapshotLost`（`task.ts:1111-1143`）。
5. 拉起：`new AbortController()` → `activeTasks.set(id, controller)` → `void runTask({...runtimeConfigOpts(deps), signal})` → `.finally` 身份比对清理 —— `task.ts:1150-1183`。

### 1.4 task 级 CAS 与 `extra` 白名单

- `setTaskStatus`（`lifecycle.ts:231-271`）：读当前 `from` → 终态须 `allowTerminal` → `from` 须在 `allowedFrom` → `UPDATE ... SET status, ...extra WHERE id AND status=from`（`lifecycle.ts:262-266`，CAS 原子）→ 0 行变更抛 `ConcurrentTaskTransition`。
- `TaskStatusUpdateExtra = Partial<Pick<tasks.$inferInsert, 'finishedAt'|'errorSummary'|'errorMessage'|'failedNodeId'>>` —— `lifecycle.ts:209-211`。**本 RFC 在此 Pick 追加 `'workflowSnapshot'|'workflowVersion'`**。
- `allowTerminal` 注释「恰 4 个持有者：resumeTask/retryNode/repair CR-1/T3」—— `lifecycle.ts:225-226`。**本 RFC 追加 syncTaskWorkflow 为第 5 个**。
- s14 守卫：`status` 直写仅 lifecycle.ts 一处——本 RFC 不绕过它（仍走 `setTaskStatus`）。

### 1.5 启动期静态校验（sync 复用）

`validateWorkflowDef(workflow.definition, {agents: await listAgents(db), skills: await listSkills(db)})` —— `task.ts:491-494`；`!ok` 时按 error-severity 抛 `ValidationError('workflow-invalid', ..., {issues})`（`task.ts:495-502`）。sync **原样复用**（校验不过的工作流不许同步进任务，正如不许启动）。

### 1.6 路由与 ACL

- 任务子路由统一过 `visibilityCheck` 中间件（`routes/tasks.ts:218-230`，RFC-036/099 成员可见性）。
- resume/retry 路由额外 `assertTaskWorkflowNotBuiltin(deps, taskId)`（`routes/tasks.ts:417,489,619`，RFC-104）。
- 资源可见性：`canViewResource`（`resourceAcl.ts:106`）/ `requireResourceView`（`:133`，不可见抛）/ `requireResourceOwner`（`:154`）。actor 经 `actor.user.id`（`routes/tasks.ts:293` 等）。
- resume 路由形态（`routes/tasks.ts:416-428`）：`POST /api/tasks/:id/resume` → `resumeTask(deps.db, id, {db, opencodeCmd?, subagentLiveCapture?, ...resolveLaunchRuntimeConfig(configPath)})` → `c.json(task)`。

### 1.7 前端

- `tasks.detail.tsx`：`resume` mutation（`POST /api/tasks/:id/resume`，成功后 `setQueryData(['tasks',id])` + 失效 `['tasks',id,'node-runs']` + `['tasks']`）；`resumability = resumeStatus(status, worktreePath)` 仅 `failed/interrupted` 且 `worktreePath!==''` 显示「恢复」。
- 横幅范式 `StuckTaskBanner`（query 驱动、severity 配色、`.task-error-banner[--warning]`、按钮开 Dialog）。
- 可复用：`Dialog`（footer 槽）、`DiffViewer`/`DiffFileBody`、`StatusChip`、`ConfirmButton`、`.btn .btn--sm .btn--primary`、i18n `en-US.ts`/`zh-CN.ts` `tasks.*`。
- `tk.workflowId` / `tk.workflowName` / `tk.workflowSnapshot` 已在 Task 响应中。

## 2. 接口契约

### 2.1 新端点

**`GET /api/tasks/:id/workflow-sync-preview`**（只读，驱动横幅 + 弹窗）

中间件：`visibilityCheck`（任务成员）。处理：加载 task + 关联 workflow；不可见工作流 → 返回 `{ syncable:false, reason:'workflow-not-visible' }`（横幅不出现）；工作流已删 → `{ syncable:false, reason:'workflow-deleted' }`。否则返回：

```ts
type WorkflowSyncPreview = {
  syncable: boolean                 // 任务处于可同步状态 ∧ 工作流可见 ∧ 未删
  reason?: 'workflow-deleted' | 'workflow-not-visible' | 'task-active' | 'worktree-missing'
  workflowId: string
  workflowName: string | null
  currentVersion: number | null     // task.workflow_version（legacy NULL）
  latestVersion: number             // 实时 workflows.version
  differs: boolean                  // 规范化定义内容比较（非仅版本号）
  invalid: boolean                  // 当前 workflows.definition 静态校验有 error
  invalidIssues?: ValidationIssue[]
  diff: WorkflowSyncDiff            // 见 2.3（differs=false 时各列表为空）
}
```

**`POST /api/tasks/:id/sync-workflow`**（应用同步 + 续跑）

Body：`{ expectedVersion: number }`（preview 返回的 `latestVersion`，防 TOCTOU，§9 F5）。中间件：`visibilityCheck`。处理：`assertTaskWorkflowNotBuiltin`（RFC-104）→ `requireResourceView(db, actor, 'workflow', task.workflowId)`（RFC-099 D7，**不可见=404 防探测** §9 F8）→ `syncTaskWorkflow(deps.db, id, { expectedVersion, db, opencodeCmd?, subagentLiveCapture?, ...resolveLaunchRuntimeConfig(configPath) })` → `c.json(task)`。错误码：`task-not-syncable`(409) / `workflow-deleted`(409→404，与不可见同形) / `workflow-invalid`(422) / `workflow-sync-preview-stale`(409，§9 F5) / `workflow-sync-noop`(409，定义未变，§9 F7) / `wrapper-structure-changed-with-live-state`(409，§9 F3) / `concurrent-task-transition`(409) / `worktree-missing`(409)。

### 2.2 服务层

```ts
// services/task.ts
export async function syncTaskWorkflow(
  db: DbClient, id: string, deps: StartTaskDeps & { expectedVersion: number },
): Promise<Task>
```

步骤：
1. `task = getTask(id)`；null → `NotFoundError('task-not-found')`。
2. `workflow = getWorkflow(task.workflowId)`；null → `ConflictError('workflow-deleted')`。
3. **版本 TOCTOU 闸**（§9 F5）：`workflow.version !== deps.expectedVersion` → `ConflictError('workflow-sync-preview-stale')`。
4. `validateWorkflowDef(workflow.definition, {agents, skills})`；有 error → `ValidationError('workflow-invalid', ..., {issues})`。
5. **同定义短路**（§9 F7）：`canonical(parseSnapshot(task.workflowSnapshot)) === canonical(workflow.definition)` → `ConflictError('workflow-sync-noop')`（不翻状态、不 churn）。
6. **wrapper 结构变更闸**（§9 F3）：`diffWorkflowForSync` 报 `wrapper-structure-changed-with-live-state`（结构变 ∧ 有 live 行）→ `ConflictError('wrapper-structure-changed-with-live-state')`。
7. `newSnapshot = JSON.stringify(workflow.definition)`；`newVersion = workflow.version`。
8. `return resumeKick(db, id, deps, { event: { kind: 'sync-workflow' }, extra: { workflowSnapshot: newSnapshot, workflowVersion: newVersion }, rollbackStatuses: SYNC_ROLLBACK_STATUSES, reason: 'syncTaskWorkflow', conflictCode: 'task-not-syncable' })`。

ACL 与 built-in 守卫留在路由层（与 resume 一致，服务层 actor-agnostic、便于测试）。`sync-workflow` 事件的 allowed-from（= 全部 6 非活跃态）由 shared 转移表 `allowedFromForTaskEvent({kind:'sync-workflow'})` 定义（§9 F6），不再 hand-copy。

**抽取共用核心**（D5，改走事件式 §9 F6）：把 `resumeTask` 的 active 检查 + 状态闸 + CAS + 回滚 + 拉起抽成内部

```ts
async function resumeKick(db, id, deps, opts: {
  event: TaskTransitionEvent          // resume 传 {kind:'resume'}；sync 传 {kind:'sync-workflow'}
  extra?: TaskStatusUpdateExtra       // sync 传 {workflowSnapshot,workflowVersion}；resume 传 undefined
  rollbackStatuses: readonly NodeRunStatus[]  // resume: [failed,interrupted]；sync: +canceled（写节点，§9 F4）
  reason: string
  conflictCode: string                // 'task-not-resumable' | 'task-not-syncable'
}): Promise<Task>
```

- CAS 经 `transitionTaskStatusByEvent({ db, taskId, event: opts.event, allowTerminal: true, extra: { finishedAt:null, errorSummary:null, errorMessage:null, failedNodeId:null, ...opts.extra }, reason })`（§9 F6；done/canceled 终态源故 `allowTerminal:true`）。
- 回滚目标经 `selectSyncRollbackTargets(runs, opts.rollbackStatuses)`：top-level、freshest-per-node、status ∈ rollbackStatuses、排除 RFC-095 wrapper-canceled 复活行（§9 F4）。`resumeTask` 传 `[failed,interrupted]` 时与既有 `selectResumeRollbackTargets` 字节等价（回归网）。
- 拉起 `runTask` 段逐字搬移，对 resume 零回归（既有 resume 测试为回归网）。

`resumeTask` = `resumeKick({ event:{kind:'resume'}, extra:undefined, rollbackStatuses:['failed','interrupted'], reason:'resumeTask', conflictCode:'task-not-resumable' })`。

> worktree 缺失：`resumeKick` 在 CAS 之前对 `task.worktreePath === ''` 早退 `conflictCode`（AC-10）。这是对 resume 也成立的既有缺口的小补强，与 RFC-108 AR-15 邻接但不依赖。

### 2.3 纯函数 diff（可断言面）

```ts
// shared/src/workflow-sync-diff.ts（或 services/ 下，纯函数）
export interface WorkflowSyncNodeChange { nodeId: string; label: string; kind: string }
export interface WorkflowSyncModified extends WorkflowSyncNodeChange { completed: boolean; changed: string[] /* 'prompt'|'agent'|'overrides'|'ports'|... */ }
export type WorkflowSyncWarningCode =
  | 'removed-node-feeds-downstream'        // 删了有产出的节点、其产出仍被新图下游引用
  | 'dangling-input-port'                  // to-run 节点入边 source 端口 ∉ 保留上游 run 实际产出（§9 F2）
  | 'new-upstream-into-completed-node'     // 新增上游边指向已完成节点、将被静默保留（§9 F1）
export interface WorkflowSyncWarning { code: WorkflowSyncWarningCode; nodeId: string; detail: string }
// blocker：结构性变更且有 live 行 → 阻断同步（§9 F3）
export interface WorkflowSyncBlocker { code: 'wrapper-structure-changed-with-live-state'; nodeId: string; detail: string }
export interface WorkflowSyncDiff {
  differs: boolean
  added: WorkflowSyncNodeChange[]
  removed: (WorkflowSyncNodeChange & { hadCompletedRun: boolean })[]
  modified: WorkflowSyncModified[]
  warnings: WorkflowSyncWarning[]
  blockers: WorkflowSyncBlocker[]          // 非空 → POST 拒（preview 弹窗禁用「同步」）
}
// runSummary：按 nodeId 的已完成态 + 该节点保留 run 的实际产出端口名集（来自 node_run_outputs，§9 F2）
//            + 该 wrapper/fanout 是否有 live 行（parked progress / child shard，§9 F3）
export interface NodeRunSyncSummary { hasCompletedRun: boolean; producedPorts: ReadonlySet<string>; hasLiveWrapperState: boolean }
export function diffWorkflowForSync(
  oldDef: WorkflowDefinition,
  newDef: WorkflowDefinition,
  runSummary: ReadonlyMap<string, NodeRunSyncSummary>, // 按 nodeId
): WorkflowSyncDiff
```

判定：
- `differs` = 规范化（稳定 key 序）后 `oldDef` 与 `newDef` 的 JSON 不等。
- `added` = 在 `newDef.nodes` 而不在 `oldDef.nodes`（按 id）。
- `removed` = 在 `oldDef.nodes` 而不在 `newDef.nodes`；`hadCompletedRun` 来自 runSummary。
- `modified` = 两边都有但节点对象内容变了；`changed` 列出变化维度（prompt/agent/overrides/ports）；`completed` 来自 runSummary。
- 警告（warnings，提示风险、不阻断）：
  - `removed-node-feeds-downstream`：被删节点有已完成 run，且 `newDef` 仍存在的某节点在 `oldDef` 里以它为上游（下游将失去该输入）。
  - `dangling-input-port`（§9 F2）：`newDef` 中一条边 target 是**尚未完成**的节点，其 `source.portName` **不在 source 节点保留 run 的实际产出端口集 `producedPorts`** 内（运行时 `port?.content ?? ''` 取空）。基于实际产出而非声明——避免与校验器 `edge-source-port-missing` 重复、且抓住「端口改名、旧 run 没有新名产出」的真实丢数据。
  - `new-upstream-into-completed-node`（§9 F1）：`newDef` 给某**已完成**节点新增了 `oldDef` 没有的入边——该节点 consumed 不含此上游，将静默保留旧产出、不纳入新上游。
- 阻断（blockers，非空则 POST 拒）：
  - `wrapper-structure-changed-with-live-state`（§9 F3）：wrapper/loop/fanout 的**结构**（内节点集 / boundary / sourcePort / maxIterations / exit）在新旧定义间变化，且该 wrapper 有 live 行（`hasLiveWrapperState`：parked `wrapper_progress_json` 或 child shard）。仅改 wrapper 内某节点 prompt（结构不变）不触发。

> 校验（`invalid`/`invalidIssues`）不进纯函数——它依赖实时 agents/skills 列表，由 preview 路由附加。`producedPorts` / `hasLiveWrapperState` 由 preview 路由查 `node_run_outputs` / `node_runs` 后填入 runSummary。

## 3. 数据流

```
任务页加载 → GET workflow-sync-preview
  → syncable && differs ? 显示「工作流有更新 (vN→vM)」横幅 : 不显示
点击横幅 → WorkflowSyncDialog（展示 diff.added/removed/modified + warnings + 版本号 + invalid 阻断）
确认 → POST sync-workflow
  → 路由：assertNotBuiltin → requireResourceView(workflow)
  → syncTaskWorkflow：load workflow → validateWorkflowDef → resumeKick(extra={snapshot,version})
      → setTaskStatus CAS (status→pending, snapshot/version 同事务原子写)
      → 回滚 failed/interrupted runs → runTask()
  → 返回 Task；前端 setQueryData(['tasks',id]) + 失效 node-runs / tasks / 本 preview
调度器 runTask → 重读新快照 → 新增节点派发 / 已完成保留 / failed 用新定义重跑 → 收敛
```

## 4. 数据模型变更

migration `0050_rfc109_task_workflow_version.sql`：

```sql
ALTER TABLE tasks ADD COLUMN workflow_version INTEGER;
```

- nullable，legacy 行 NULL（无法重建历史快照对应版本；UI 显示「未知 → vM」）。
- `schema.ts` `tasks` 加 `workflowVersion: integer('workflow_version')`（nullable）。
- `startTask` 落库追加 `workflowVersion: workflow.version`（`task.ts:757` `workflowSnapshot` 邻接——RFC-108 后行号已漂，以 `workflowSnapshot:` 字段为锚）。
- shared `TaskSchema`（`packages/shared/src/schemas/task.ts`）加 `workflowVersion: z.number().nullable()`（§9 附；原无版本字段）。
- `db/migrations/meta/_journal.json` 加一档；`upgrade-rolling.test.ts` journal 断言加一行。
- 手写迁移（本仓 0013 起停用 drizzle generate，见 RFC-104）。binary smoke 须嵌入 0050、无模块环。
- Task 序列化追加 `workflowVersion`（便于前端无需额外请求即可显示当前版本；preview 仍是权威比较来源）。

> **行号注**：本 §1 引用的 file:line 为 RFC-108 落地前位置；HEAD `57a6fb6`（RFC-108 PR-B）已把 `task.ts` 下移 ~12 行（resumeTask 现 :1065、startTask INSERT :752、workflowSnapshot :757），mechanism 不变。实现时以**函数名/字段名**为锚复核，不依赖具体行号。

## 5. 与现有模块的耦合点 / 邻接

- **shared/lifecycle.ts（RFC-108 T1/T2，已落 HEAD）**：在 `TaskTransitionEvent` ADT 加 `{ kind: 'sync-workflow' }`，`targetForTaskEvent`→`pending`、`nextTaskStatus` allowed-from = 全部 6 非活跃态（`never` 穷举强制补全两个 switch）。这是本 RFC 与 RFC-108 的**主要集成点**：按其 SSOT 表扩展、而非绕开（§9 F6）。
- **backend/lifecycle.ts（RFC-097/108）**：扩 `TaskStatusUpdateExtra` 白名单（+`workflowSnapshot`/`workflowVersion`）；不改 CAS、不削弱 s14。CAS 走既有事件式 wrapper `transitionTaskStatusByEvent`（`lifecycle.ts:322`，新 caller 应走路径），不 hand-copy allowedFrom。
- **task.ts resume（RFC-014/096/097/098）**：抽 `resumeKick`（事件式 + `rollbackStatuses` 参数），`resumeTask` 改薄壳。回滚（`selectSyncRollbackTargets` 在 resume 参数下与既有 `selectResumeRollbackTargets` 字节等价）/拉起逐字搬移，既有 resume 测试为回归网。
- **RFC-104 built-in 只读**：sync 路由复用 `assertTaskWorkflowNotBuiltin`。
- **RFC-099 ACL**：sync 路由 `requireResourceView(workflow)`（不可见 404，§9 F8）；preview 据 `canViewResource` 决定 `syncable`。
- **RFC-095 canceled 可复活**：`canceled` 任务同步续跑时其 canceled 写节点行经 `selectSyncRollbackTargets` **先回滚到 pre_snapshot 再复活**（§9 F4，补 RFC-095 全任务路径缺的回滚）；wrapper-canceled 复活行排除在回滚外（保持 RFC-095 in-place 复活语义）。
- **RFC-074 freshness**：D2「保留」实为「保留 done∧fresh」（§9 F1）；diff 的 `dangling-input-port` 与「新上游静默保留」均围绕消费溯源语义。
- **RFC-108 后续 PR（仍在落 main）**：RFC-108 后续会改写 resumeTask 体（boot auto-resume / AR-15 worktree 前检 / AR-17 跨行回滚）。本 RFC 的 `resumeKick` 抽取与其同区，**合流约定**：谁先合并、后者在抽取后的 `resumeKick` 上加自己的逻辑（auto-resume 复用 `{kind:'resume'}` 事件，sync 复用 `{kind:'sync-workflow'}`）。本 RFC 改动最小且加性（一个新事件 + 两个 extra 字段 + 一个 rollbackStatuses 参数），降低碰撞面。
- **多仓（RFC-066）**：同步只换工作流快照，不碰仓库/worktree；回滚已多仓安全（`rollbackNodeRunForResume`）。正交。

## 6. 失败模式

| 场景 | 行为 |
|---|---|
| 任务 running/pending | `task-not-syncable` 409，零副作用（CAS allowedFrom 不含） |
| 并发 sync×2 / sync+resume | CAS 恰一胜，输者 `concurrent-task-transition` 409，快照不被双写 |
| 工作流已删 | `workflow-deleted` 409（preview 标 `syncable:false`，横幅不出现） |
| 当前工作流静态校验不过 | `workflow-invalid` 422（preview 标 `invalid:true`，弹窗禁用「同步」按钮并列 issues） |
| 工作流不可见（非 owner 且未授权） | 路由 403；preview `syncable:false reason:'workflow-not-visible'` |
| built-in 工作流 | 403（RFC-104） |
| worktree 已被 GC（`worktreePath===''`） | `worktree-missing` 409；前端入口隐藏 |
| 端口改名 → 下游读空串 | 不阻断；预览 `dangling-input-port` 警告 |
| 删节点 → 下游失输入 | 不阻断；预览 `removed-node-feeds-downstream` 警告；孤儿 node_run 引擎静默跳过 |
| done 任务、新图无新增节点 | 同步后 runTask 即 allSettled→done（无副作用 no-op，仅版本号更新） |
| 同步后 failed 节点 pre_snapshot 被 GC | 既有 `escalateSnapshotLost` 把任务翻 failed + `snapshot-lost`（与 resume 同径） |

## 7. 测试策略（先红后绿）

**shared 纯函数**（`workflow-sync-diff.test.ts`）：added/removed/modified 分类；`differs=false` 当字节等价；`removed-node-feeds-downstream` 与 `dangling-input-port` 警告正反例；端口改名命中 dangling；modified.completed 随 runSummary。

**backend service**（`rfc109-sync-task-workflow.test.ts`）：
- 原子换快照 + 版本（CAS 内）；CAS 失败时快照未改（注入并发翻态）。
- 六种可同步状态各放行；running/pending 拒 `task-not-syncable`。
- 新增下游节点 → 同步后被派发（mock runner，断言新 node_run 出现）。
- failed 节点 + 改过的 prompt → 重跑用新定义（断言 promptText 含新内容 / 走新 agent）。
- D2 保留：modified 的已完成节点不被重跑（无新 node_run）。
- 工作流删 / invalid / 并发 各错误码。
- canceled 任务复活续跑（RFC-095 交叉）。

**backend route**（`rfc109-sync-route.test.ts` 或并入既有 tasks 路由测试）：preview 形态（syncable/differs/invalid/reason 各分支）；sync 端点 built-in 403、不可见工作流 403、成功 200 + 状态翻 pending。

**lifecycle 白名单**（扩 `rfc097-task-status-cas` 或新 case）：`workflow_snapshot`/`workflow_version` 可经 extra 写；`status` 仍不可走私（s14 不被削弱，源码层断言）。

**migration**：`upgrade-rolling` journal +1；新列 nullable、legacy NULL 解析正常。

**frontend**（vitest）：`WorkflowSyncBanner` 在 syncable+differs 显示、active/identical/worktree-missing/不可见 隐藏（`findByRole`）；`WorkflowSyncDialog` 渲染 added/removed/modified + 警告 + 版本号，invalid 时禁用确认；sync mutation 成功失效 query。源码层兜底：断言不出现原生 modal chrome（复用 `Dialog`）。

**回归守卫**：既有 resume 全套（`resumeKick` 抽取零回归）、RFC-104 built-in、RFC-099 ACL、RFC-097 CAS 全绿。

## 8. 已知限制（v1）

- 被改动的**已完成**节点不自动重跑（D2）；需手动「重试」该节点。
- 端口改名 / 删节点导致的下游空输入只**警告**不**阻断 / 自动迁移**（端口迁移推 v2）。
- 只能同步到**当前最新**定义，无历史版本选择（工作流无版本快照表）。
- 被改动的**已完成**节点不自动重跑（D2）；需手动「重试」该节点。新图给已完成节点**新增上游边**时该节点静默保留旧产出（不纳入新上游）——预览给 `new-upstream-into-completed-node` 警告（§9 F1）。
- 端口接线类静默丢数据基于「保留 run 的实际产出端口集」检测并**警告**（§9 F2），不做自动端口迁移（推 v2）。
- 只能同步到**当前最新**定义，无历史版本选择（工作流无版本快照表）。
- wrapper/loop/fanout **结构**变更（内节点集 / maxIterations / exit / sourcePort / boundary）且该 wrapper 有 live 行（parked progress 或 child shard）时**阻断**同步（§9 F3），非警告。仅改 wrapper 内某节点 prompt（结构不变）不阻断——杀手用例不受影响。
- legacy 任务（`workflow_version` NULL）预览显示「未知 → vM」；不影响同步本身。

## 9. Codex 设计 gate fold（设计阶段，2026-06-26）

落档后对三件套跑 Codex 设计 gate（read-only，核读 `scheduler.ts`/`freshness.ts`/`dispatchFrontier.ts`/`lifecycle.ts` 等源码验证承重断言），8 条 findings 全部采纳。结果（含对设计的修订）：

- **F1（P1）D2 精度——「保留已完成」实为「保留 done∧fresh」**：引擎对 `done` 行的派发判定是 `!isNodeRunFresh`（`dispatchFrontier.ts:310`），freshness 基于**消费溯源** `consumed_upstream_runs_json`（`freshness.ts:58`）。所以：① 已完成下游若其**消费过**的上游重跑 → 自动级联重跑（正确，非违例）；② 新图给已完成节点**新增**上游边 → 旧 run 的 consumed 不含该上游 → 仍判 fresh → **静默保留**（不纳入新上游）。**修订**：D2 措辞改为「保留 fresh 的已完成产出，stale 的随上游重跑级联重跑」；新增预览警告 `new-upstream-into-completed-node`；测试加「stale 下游级联重跑」「新上游静默保留」两例。
- **F2（P1）端口警告须基于「保留 run 的实际产出」而非新定义声明**：原 `dangling-input-port`（查 newDef 是否声明 source 端口）与校验器 `edge-source-port-missing`（`workflow.validator.ts:388`，sync 已阻断无效工作流）**重复**，且漏掉真实丢数据场景——保留的旧 `node_run` 缺**新命名**的产出端口时 `port?.content ?? ''` 取空（`scheduler.ts:4508`）。**修订**：`diffWorkflowForSync` 改吃**每节点的实际产出端口名集**（来自 `node_run_outputs`，由 preview 路由查好传入）；`dangling-input-port` 改为「某 to-run 节点的入边 source 端口 ∉ 其保留上游 run 的实际产出端口集」。
- **F3（P1）wrapper/fanout 须阻断、非「信息性警告」**：parked wrapper 从旧 `wrapper_progress_json` 续跑（`scheduler.ts:2803`）而新定义给出不同 nodeIds/maxIterations/exit/edges；fanout shard 跨代按 `(nodeId,iteration,shardKey)`+valueHash 复用、无视内节点 prompt/agent 变更（`scheduler.ts:3500`）。**修订**：新定义改了 wrapper/loop/fanout **结构**（内节点集 / boundary / sourcePort / maxIterations / exit）**且**该 wrapper 有 live 行（parked progress 或 child shard）时**阻断**同步（preview blocker `wrapper-structure-changed-with-live-state`），让用户改用新任务；仅改 wrapper 内节点 prompt（结构不变）不阻断。「失效并重跑」推 v2。
- **F4（P2）canceled 须先回滚再复活**：resume 回滚目标仅 failed/interrupted（`task.ts:414`），但 canceled 行可派发（RFC-095，`dispatchFrontier.ts:315`）——同步 canceled 任务会在**半成品 worktree 写**之上重跑 canceled 写节点。retryNode 复活前会回滚（`task.ts:1319`），sync 全任务路径原设计没有。**修订**：新增 `selectSyncRollbackTargets`（resume 目标 ∪ canceled 顶层**写**节点的 freshest，排除 RFC-095 wrapper-canceled 复活行）；同步在 kick 前对其逐个 `rollbackNodeRunForResume`。测试加「canceled 写节点半成品 → 同步前回滚到 pre_snapshot」。
- **F5（P2）preview→apply 的版本 TOCTOU**：preview 给 v3→v7 后工作流可能再被改成 v8（PUT 自增 `version` `workflow.ts:82`），用户确认 v7 却应用 v8。**修订**：`POST /sync-workflow` body 带 `expectedVersion`（preview 返回的 `latestVersion`）；服务层若 `workflow.version !== expectedVersion` → 409 `workflow-sync-preview-stale`；前端透传所预览的版本、收 409 后刷新预览重提示。
- **F6（P2）RFC-108 转移表已落 HEAD——应扩展而非绕开**：`shared/lifecycle.ts:186` 已有 task 级 `nextTaskStatus` 事件转移表（RFC-108 T1/T2），`resume`（failed/interrupted/awaiting_*→pending）/`retry`（done/failed/canceled/interrupted→pending）是其中事件，`switch` 用 `never` 穷举；backend 有事件式 wrapper `transitionTaskStatusByEvent`（`lifecycle.ts:322`，从 oracle 派生 to+allowedFrom、保留 CAS+allowTerminal+extra）。**修订**（替代原 §5「不引入转移表」）：在 shared ADT 加 `{ kind: 'sync-workflow' }` 事件（`targetForTaskEvent`→`pending`；`nextTaskStatus` allowed-from = `['failed','interrupted','done','canceled','awaiting_review','awaiting_human']` = resume∪retry，`never` 穷举强制补全两个 switch）；`syncTaskWorkflow`/`resumeKick` 改用 `transitionTaskStatusByEvent({ event:{kind:'sync-workflow'}, allowTerminal:true, extra:{workflowSnapshot,workflowVersion,清错误} })`。`resumeKick` 同步走事件式（resume 传 `{kind:'resume'}`），与表对齐、零 hand-copy allowedFrom。新增 `allowedFromForTaskEvent({kind:'sync-workflow'})` 的源码穷举测试。**这把与 RFC-108 的耦合从「碰撞」变成「按其 SSOT 扩展」**。
- **F7（P3）「done+无变更=no-op」在任务级不成立**：会 churn `done→pending→running→done`、重写 `finishedAt`、再发一次 `task.done` 广播（不重跑节点、不 auto-commit——commit/push 只在节点完成后触发 `scheduler.ts:832`）。**修订**：服务层对 `differs===false`（规范化定义字节相等）短路——409 `workflow-sync-noop`、不翻状态。preview 本就 `differs:false` 时隐藏横幅，双保险。
- **F8（P3）ACL 是 404 非 403**：`requireResourceView` 不可见返回 not-found/404（RFC-099 防探测，`resourceAcl.ts:133`），非 403。**修订**：design 错误码改 404；preview `reason:'workflow-not-visible'`。
- **附（sound 项 + 提醒）**：task-row 快照交换经 `setTaskStatus` extra 确为单 CAS `UPDATE` 原子（`lifecycle.ts:272`，sound）；nullable `workflow_version` 迁移形态安全，但**须同步给 shared `TaskSchema` 加 `workflowVersion` 字段**（`shared/src/schemas/task.ts`，原无版本字段）——并入 T1。

## 10. Codex 实现 gate fold（实现阶段，2026-06-26）

代码完成后对实现跑 Codex 实现 gate + 两轮复审（核读 `task.ts`/`lifecycle`/`scheduler`/diff/routes/前端）。

**实现 gate（5 findings，全 fold）**：
- **F1（P1）wrapper 阻断漏 boundary/删除/kind**：原只比 wrapper 节点对象，漏了 boundary 边/wrapper 删除/kind 变更。→ 新 `wrapperFingerprint`（节点〔去 position/title〕+ incident 边）+ 遍历 old∪new wrapper id。
- **F2（P2）canceled 豁免用 old∪new**：→ 改用 **old def** wrapper id（行产于旧图；kind 变更+live 已由 F1 阻断）。
- **F3（P2）版本 TOCTOU 仅查一次**：→ CAS 前加 `workflows.version` 复查（见下「F3 残留」）。
- **F4（P2）preview 给 built-in 亮 CTA 但 POST 403**：→ `computeWorkflowSyncPreview` 对 `workflow.builtin` 返回 `syncable:false reason:'builtin-workflow'`（新枚举值），前端 `!syncable` 隐藏横幅。
- **F5（P3）横幅易过期**：→ 加 `refetchInterval: 30_000`。

**复审第二轮（F1/P2 再 fold）**：
- **F1 残留**：指纹漏 wrapper **内部子图边**（两端都在 `nodeIds` 内）。→ `wrapperFingerprint` 再纳入 internal 边（`edgeKey` 复用）。inner prompt-only 改动仍不阻断（杀手用例）。
- **新 P2（真问题）terminal wrapper breadcrumb 误判 live**：`wrapper_progress_json` 在终态后是 debug breadcrumb、调度器不再读（`scheduler.ts:2736`），`buildSyncRunSummary` 原把任何非空 progress 当 live → **误阻断已完成任务同步**。→ 精确镜像 `findResumableWrapperRun`（`scheduler.ts:2630` 对 `{done,failed,exhausted}` 返回 null，RFC-095 保 canceled/interrupted 可复活）：`WRAPPER_BREADCRUMB_TERMINAL={done,failed,exhausted}`，progress 仅在状态 ∉ 该集时算 live；child 仅在非终态时令 parent live。

**F3 残留（已知限制，有意不修）**：CAS 前 `workflows.version` 复查关掉了「preview→POST」秒级真实窗口；剩下「复查→CAS」亚毫秒窗（无外部变更 await）属**良性**——sync 永远只写用户已校验+确认的版本（`expectedVersion`），即便 PUT 恰落该窗，任务拿到的也是已确认版本、下次预览显示新 delta（横幅重现、无数据损坏）。把 resume 热路径（worktree reset + 进程 spawn）包进 DB 事务以求完全原子**不成比例**，故记为已知限制，不引入。
