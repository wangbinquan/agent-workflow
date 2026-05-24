# RFC-061 PR-B — T10 + T11 Cutover Playbook

> **Status**: 待执行（next session）
> **Prereq**: PR-B partials 1-12 已落 main（commits `a9861b8` 至 `d63046d`，14 commits），CI 全绿。
> **Estimated effort**: 1-2 day session（unfocused work won't finish; needs uninterrupted focus）

本文档提供 T10 + T11 + T12-finish 的**精确执行清单**。所有前置脚手架（handlers / scheduler-v2 / 集成测试）已就位，next session 不需新逻辑，只做接线 + 删除 + 测试改写。

## 关键约束（不可破）

1. **单原子 commit** — T10 + T11 + T12-finish 必须在同一 commit 里完成；不可拆。理由：删 services 但不切 REST 路由 → daemon 崩；切路由但不填 ProductionRunnerAdapter → opencode 不起来。
2. **不修改 runner.ts 直接** — 改造 services/runner.ts 风险太高（1513 行、深层 nodeRunId 耦合）。改走："写新 runner-v2.ts → ProductionRunnerAdapter 调它 → 老 runner.ts 随 services 一起删"。
3. **保留 grep guards 永远生效** — 9 条 soft → hard 不要忘；这是结构性防回退。

## 执行步骤（按顺序）

### 步骤 1：写 runner-v2.ts（核心工作量）

新文件 `packages/backend/src/services/runner-v2.ts`，~600 行。职责：spawn opencode 子进程、解析 envelope、emit events（NOT node_runs writes）。

接口：

```typescript
export interface RunOpencodeAttemptOptions {
  db: DbClient
  taskId: string
  attemptId: string      // 取代 nodeRunId
  scope: Scope           // (nodeId, loopIter, shardKey, iter)
  worktreePath: string
  agent: Agent           // services/agent.ts:getAgent 结果
  skills: ResolvedSkill[]
  mcps: Mcp[]
  plugins: Plugin[]
  inputs: Record<string, string>
  overrides?: AgentOverrides
  prompt: string         // 已 composed（computeTickActions 出来的）
  templateMeta: TemplateMeta
  hasClarifyChannel?: boolean
  clarifyMode?: 'self' | 'cross'
  envelopeFollowup?: boolean   // RFC-042
  dependents?: Agent[]   // RFC-022
  log?: Logger
}

export interface RunOpencodeAttemptResult {
  /** Whether to emit attempt-finished-success / -envelope-fail / -crash / -timeout */
  outcome: 'success' | 'envelope-fail' | 'crash' | 'timeout' | 'canceled'
  exitCode: number | null
  outputs: Record<string, string>   // for attempt-output-captured events
  tokenUsage: { input: number; output: number; cacheCreate: number; cacheRead: number; total: number }
  errorMessage?: string
  sessionId?: string
  clarify?: { questions: ClarifyQuestion[]; truncationWarnings: ClarifyTruncationWarning[] }
}

export async function runOpencodeAttempt(
  opts: RunOpencodeAttemptOptions,
): Promise<RunOpencodeAttemptResult>
```

**实现要点**：
- **大量代码可从 runner.ts 直接搬**（utility 函数已 export）：`prepareSkills` / `buildInlineConfig` / `buildCommand` / `pumpLines` / `extractTextFromEvent` / `inferEventKind` / `accumulateTokens`
- **关键删除**：所有 `nodeRuns` / `nodeRunEvents` / `nodeRunOutputs` 写入
- **关键添加**：subagent telemetry 改写为 `attempt-subagent-tool-use` / `attempt-subagent-output` 事件（已在 EVENT_KINDS 闭合里），通过 writeEvents 入库
- **path**：`runRoot = join(opts.appHome, 'runs', opts.taskId, opts.attemptId)` （替换 nodeRunId）
- **memory inject + inventory plugin**：可继续用 services/runner.ts 的 helper（这些不依赖 nodeRunId），import 进来

**测试**（新文件 `tests/rfc061-runner-v2.test.ts`，~150 行）：
- 真起 opencode 子进程 fixture（参考 `runner.test.ts` 模式）
- assert outcome / outputs / tokenUsage
- assert events 写入（attempt-output-captured per port + attempt-finished-success）
- envelope-fail / crash / timeout 各一个 case

### 步骤 2：填 ProductionRunnerAdapter.spawn/cancel

修改 `packages/backend/src/scheduler-v2/runnerAdapterProduction.ts`：

```typescript
async spawn(req: SpawnRequest): Promise<void> {
  // Resolve agent + skills (lookup by SpawnRequest.agentName via existing
  // services/agent.ts:getAgent + services/skill.ts:resolveSkillsForAgent).
  const agent = await getAgent(this.opts.db, req.agentName)
  if (!agent) throw new Error(`agent ${req.agentName} not found`)
  const skills = await resolveSkillsForAgent(this.opts.db, agent)
  const mcps = await listEnabledMcps(this.opts.db)   // RFC-028
  const plugins = await listEnabledPlugins(this.opts.db)

  // Fire-and-forget: runOpencodeAttempt resolves when the subprocess exits,
  // emits attempt-finished-* event + enqueues the attempt-exit wake.
  void runOpencodeAttempt({
    db: this.opts.db,
    taskId: this.opts.taskId,
    attemptId: req.attemptId,
    scope: req.scope,
    worktreePath: this.opts.worktreePath,
    agent,
    skills,
    mcps,
    plugins,
    inputs: {},     // already baked into req.prompt by computeTickActions
    prompt: req.prompt,
    templateMeta: {
      repoPath: this.opts.worktreePath,
      baseBranch: 'main',  // TODO: thread from task
      taskId: this.opts.taskId,
      nodeId: req.scope.nodeId,
      iteration: req.scope.iter,
      ...(req.scope.shardKey ? { shardKey: req.scope.shardKey } : {}),
    },
  })
    .then(async (result) => {
      // Emit attempt-finished-* + (for success) attempt-output-captured per port.
      // The actor will pick up the attempt-exit wake from the event-applied path.
      const newEvents: NewEvent[] = []
      const ts = Date.now()
      if (result.outcome === 'success') {
        for (const [portName, content] of Object.entries(result.outputs)) {
          newEvents.push({
            taskId: this.opts.taskId,
            kind: 'attempt-output-captured',
            nodeId: req.scope.nodeId,
            loopIter: req.scope.loopIter,
            shardKey: req.scope.shardKey,
            iter: req.scope.iter,
            attemptId: req.attemptId,
            actor: 'system',
            payload: { portName, content },
          })
        }
        newEvents.push({
          taskId: this.opts.taskId,
          kind: 'attempt-finished-success',
          nodeId: req.scope.nodeId,
          loopIter: req.scope.loopIter,
          shardKey: req.scope.shardKey,
          iter: req.scope.iter,
          attemptId: req.attemptId,
          actor: 'system',
          payload: {},
        })
      } else if (result.outcome === 'envelope-fail') {
        newEvents.push({ ... kind: 'attempt-finished-envelope-fail', payload: { reason: result.errorMessage ?? '' } })
      } else if (result.outcome === 'crash') {
        newEvents.push({ ... kind: 'attempt-finished-crash', payload: { exitCode: result.exitCode, errorMessage: result.errorMessage } })
      } else if (result.outcome === 'timeout') {
        newEvents.push({ ... kind: 'attempt-finished-timeout', payload: { timeoutMs: 0 } })
      }
      const written = await writeEvents(this.opts.db, newEvents)
      // Bridge: wake the actor.
      wakeForEvents(written)
    })
}

async cancel(attemptId: string, reason: string): Promise<void> {
  // Look up pid from attempts projection.
  const row = this.opts.db.select({ pid: attempts.pid })
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .limit(1)
    .all()[0]
  if (row?.pid !== null && row?.pid !== undefined) {
    try { process.kill(row.pid, 'SIGTERM') } catch { /* already dead */ }
  }
  void reason  // logged by the actor's handleAttemptExit when canceled fires
}
```

测试 4-5 case：spawn + simulateExit 等价、cancel pid lookup、agent-not-found 错误。

### 步骤 3：services/task.ts 启动路径切换

修改 `packages/backend/src/services/task.ts` 4 处 `runTask` 调用站：

```diff
- import { runTask } from './scheduler'
+ import { runTaskActorViaProduction } from '../scheduler-v2/launcher'
```

新文件 `packages/backend/src/scheduler-v2/launcher.ts` 包装 runTaskActor + ProductionRunnerAdapter + 初始事件 seeds：

```typescript
export async function runTaskActorViaProduction(opts: {
  db: DbClient
  task: Task
  workflow: WorkflowDefinition
  inputsMap: Record<string, string>
  appHome: string
}): Promise<void> {
  // 1. Emit task-started + initial logical-run-created events for entry nodes.
  const entryEvents = buildInitialEvents(opts.task, opts.workflow, opts.inputsMap)
  await writeEvents(opts.db, entryEvents)

  // 2. Register actor + production adapter.
  const actor = taskActorRegistry.register(opts.task.id)
  const runner = new ProductionRunnerAdapter({
    db: opts.db,
    worktreePath: opts.task.worktreePath,
    appHome: opts.appHome,
    wakeProducer: actor.queue,
  })

  // 3. Run loop until terminal.
  await runTaskActor(actor, {
    db: opts.db,
    taskId: opts.task.id,
    workflow: opts.workflow,
    inputsMap: opts.inputsMap,
    repoPath: opts.task.repoPath,
    runner,
    readUpstreamPort: makeProjectionReader(opts.db),
    resolveUpstreamInputs: makeUpstreamInputsResolver(opts.db, opts.workflow),
  })

  // 4. Deregister.
  taskActorRegistry.deregister(opts.task.id, 'task-completed')
}
```

`buildInitialEvents` / `makeProjectionReader` / `makeUpstreamInputsResolver` 在同文件 / sibling file 实现 — 都是从 projection / workflow def 读数据。

### 步骤 4：REST 路由切换

```
routes/clarify.ts  →  读 suspensions WHERE signal_kind IN ('self-clarify','cross-clarify')
                       写：apply SignalKindHandler.applyResolution → writeEvents
routes/reviews.ts  →  读 suspensions WHERE signal_kind = 'review' + node_outputs（doc content）
                       写：apply review handler.applyResolution
routes/tasks.ts    →  GET /:id/node-runs → 读 logical_runs + attempts
                       cancel → writeEvent({ kind: 'task-canceled', ... })
                       retry → writeEvent({ kind: 'logical-run-iter-bumped', triggerKind: 'suspension-resolved', ... })
                       （已由 SignalKindHandler.applyResolution 内部处理）
```

每个改动配新测试：~10 routes test cases / route。

### 步骤 5：Migration 0034

`packages/backend/db/migrations/0034_rfc061_drop_legacy.sql`：

```sql
DROP TABLE IF EXISTS node_runs;
DROP TABLE IF EXISTS node_run_events;
DROP TABLE IF EXISTS node_run_outputs;
DROP TABLE IF EXISTS clarify_sessions;
DROP TABLE IF EXISTS clarify_rounds;
DROP TABLE IF EXISTS cross_clarify_sessions;
DROP TABLE IF EXISTS doc_versions;
```

drizzle schema: 移除 `nodeRuns` / `nodeRunEvents` / `nodeRunOutputs` / `clarifySessions` / `clarifyRounds` / `crossClarifySessions` / `docVersions` 表对象。

更新 `upgrade-rolling.test.ts` 的 HEAD journal count 33 → 34。

### 步骤 6：删除 6 services + 2 helper

```
rm packages/backend/src/services/scheduler.ts             (~3500 行)
rm packages/backend/src/services/clarify.ts               (~1169 行)
rm packages/backend/src/services/crossClarify.ts          (~1740 行)
rm packages/backend/src/services/clarifyRounds.ts         (~658 行)
rm packages/backend/src/services/clarifyFallback.ts       (~117 行)
rm packages/backend/src/services/review.ts                (~2003 行)
rm packages/backend/src/services/lifecycle.ts             (~180 行)   # RFC-053 P-1 退役
rm packages/backend/src/services/exitCondition.ts         (~73 行)    # wrapper-loop 内联
rm packages/backend/src/services/wrapperProgress.ts       (~93 行)    # wrapper handler 内联
rm packages/backend/src/services/runner.ts                (~1513 行)  # 被 runner-v2 取代
```

总计 ~11k 行删除。

也删 fixup scripts（不再需要，event-sourced 永不损坏）：
```
rm packages/backend/scripts/fixup-rfc052-stuck-review.ts
rm packages/backend/scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts
```

### 步骤 7：改写 ~139 个 test 文件

`grep -lE "from.*services/scheduler|from.*services/clarify|from.*services/review|from.*services/crossClarify|nodeRuns\b|node_runs\b" packages/backend/tests/*.test.ts` 给出列表。

每个 test 文件 3 种处理：
1. **行为已被 W-1..W-5 覆盖** → 删除文件（typical 30-50 个）
2. **DTO 改名**（NodeRun → LogicalRun, ClarifyRound → SuspensionRow）→ search-replace
3. **真正需要 event 模型重写** → 重写为新写法

预计：删 50 + 改名 60 + 重写 30。

### 步骤 8：翻 soft grep guards → hard

`tests/rfc061-grep-guards.test.ts` 的 9 条 soft guards 全部把 `expect(hits.length).toBeGreaterThanOrEqual(0)` 改为 `expect(hits).toEqual([])`。

### 步骤 9：CI 全绿 + STATE.md 更新

- pre-push 4 件套（typecheck + lint + format:check + test）
- push → 监控 15 job CI → 全绿
- STATE.md：T9-T12 标 Done；PR-B 整体标 Done
- design/plan.md RFC 索引：RFC-061 状态 Draft → 进行中 (PR-A/B Done, PR-C 待启)

## 风险点 + 缓解

| 风险 | 缓解 |
|---|---|
| runner-v2 envelope parsing bug | 复用 runner.ts 的 `extractTextFromEvent` / `inferEventKind` / `accumulateTokens` helpers — 已被 runner.test.ts 充分覆盖 |
| memory inject 路径变了 | injectMemoryForRun 不依赖 nodeRunId — 可直接 import 用 |
| RFC-022 dependents / RFC-028 mcps / RFC-029 inventory plugin / RFC-042 envelope follow-up | 全部从 runner.ts utility 函数搬过来 — 已 export |
| ~139 test rewrites 漏改 | tsc 编译会抓大部分（旧 nodeRuns 表对象删了）；剩余靠运行时测试 |
| 用户的某次启动卡在迁移期 | migration 0034 是单向 DROP；事先 `bun run db:export` 备份建议（虽然系统未上生产） |

## 完工标准

- 15 job CI 全绿
- `grep -r 'services/scheduler\|services/clarify\|services/review\|services/crossClarify' packages/backend/src` 0 命中
- `grep -r 'node_runs\|clarify_sessions\|doc_versions' packages/backend/src` 0 命中（migrations/ 除外）
- 9 条 soft grep guards 全部 `.toEqual([])` 通过
- e2e baseline 20 spec 全部通过（必要时 PR-C 刷 visual baseline）
- 233 个 RFC-061 测试 +（PR-B-T10/T11 新增的）测试全过
- STATE.md 上 RFC-061 状态：PR-B Done
