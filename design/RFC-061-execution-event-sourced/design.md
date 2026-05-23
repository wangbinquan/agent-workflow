# RFC-061 — node 执行模型事件溯源化（技术设计）

> 配套 [proposal.md](./proposal.md) + [plan.md](./plan.md)。
> 当前状态：**Draft**，等用户批准 + RFC-060 完工后进入 PR-A。

## 0. 前置 + 设计自由度

**前置**：RFC-060 全部 6 PR 必须先合并落 main。本 RFC 在 RFC-060 完成的 NodeKind 集合 + parametric kind 系统上重写执行模型。

**自由度**：系统未上生产、无历史数据负担、无字节级 UI 守恒义务——本 RFC 全程**不做 dual-write、不做 backward compat、不做 byte-for-byte UI 守恒**，只追求最优终态。所有断代在 PR-B（backend）/ PR-C（frontend）一次性硬切。

## 1. 状态模型：4 个不可破原语

```
╔═══════════════════════════════════════════════════════════════╗
║  P1. events 是唯一真值源                                       ║
║      • 所有状态变化 = 不可变 append-only 事件                  ║
║      • 所有 "现在是什么" 的表 = events 的投影                  ║
║      • events 永不删除（归档到冷表也保留行）                   ║
║                                                                ║
║  P2. Logical Run + Attempts                                    ║
║      • Logical Run = (taskId, nodeId, loopIter, shardKey,iter) ║
║        每次 "逻辑进入" 都是一行；iter 在 scope 内 monotonic    ║
║      • Attempt = 一次 opencode 子进程；归属于一个 logical_run  ║
║      • "当前 run" = WHERE scope=? ORDER BY iter DESC LIMIT 1   ║
║                                                                ║
║  P3. Suspension / Resolution                                   ║
║      • Suspension { signalKind, payload, awaitsActor }         ║
║      • Resolution { resolutionId, payload }                    ║
║      • 6 类闭合 SignalKind；scheduler 不感知具体 kind          ║
║                                                                ║
║  P4. 双层 KindHandler                                          ║
║      • NodeKindHandler  → 节点 dispatch / readyCondition /     ║
║                            buildPromptFromEvents /             ║
║                            onAttemptFinished                   ║
║      • SignalKindHandler → onSuspend / validateResolution /    ║
║                             applyResolution / autoResolve /    ║
║                             effectOnLogicalRun /               ║
║                             renderPromptSection                ║
║      • 编译期 exhaustiveness 强制完整                          ║
╚═══════════════════════════════════════════════════════════════╝
```

## 2. Schema（6 张表）

### 2.1 `events`（唯一真值源，append-only）

```sql
CREATE TABLE events (
  id                TEXT PRIMARY KEY,         -- ULID
  task_id           TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  kind              TEXT NOT NULL,            -- 见 §3 Event Taxonomy
  -- Scope (nullable on task-level events)
  node_id           TEXT,
  loop_iter         INTEGER,
  shard_key         TEXT,
  iter              INTEGER,
  -- Optional links
  attempt_id        TEXT,                     -- FK attempts.id NULL on non-attempt events
  parent_event_id   TEXT,                     -- FK events.id NULL on top-level
                                              -- 用于 subagent / nested 引用父事件
  actor             TEXT NOT NULL,            -- 'system' | 'user:{userId}'
                                              -- 'agent:{nodeId}' | 'opencode:{sessionId}'
  resolution_id     TEXT,                     -- 仅 suspension-resolved 事件；幂等天然键
  payload           TEXT NOT NULL DEFAULT '{}',-- JSON
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE UNIQUE INDEX uq_events_resolution ON events (resolution_id) WHERE resolution_id IS NOT NULL;
CREATE INDEX ix_events_task_ts ON events (task_id, ts);
CREATE INDEX ix_events_scope ON events (task_id, node_id, loop_iter, shard_key, iter);
CREATE INDEX ix_events_kind ON events (task_id, kind);
CREATE INDEX ix_events_parent ON events (parent_event_id);
```

**禁止 UPDATE / DELETE**——由 grep guard + sqlite trigger 双重锁。

### 2.2 `logical_runs`（projection：每次 node 逻辑进入）

```sql
CREATE TABLE logical_runs (
  id                TEXT PRIMARY KEY,         -- ULID
  task_id           TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  loop_iter         INTEGER NOT NULL DEFAULT 0,
  shard_key         TEXT,                     -- NULL on non-fanout
  iter              INTEGER NOT NULL,
  status            TEXT NOT NULL,            -- pending|running|suspended|done|failed|canceled
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_event_id     TEXT NOT NULL,
  -- INV-4 enforced by UNIQUE:
  UNIQUE (task_id, node_id, loop_iter, shard_key, iter),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX ix_logical_runs_status ON logical_runs (task_id, status);
CREATE INDEX ix_logical_runs_scope ON logical_runs (task_id, node_id, loop_iter, shard_key);
```

### 2.3 `attempts`（projection：每次 opencode 子进程）

```sql
CREATE TABLE attempts (
  id                  TEXT PRIMARY KEY,
  logical_run_id      TEXT NOT NULL,
  attempt_seq         INTEGER NOT NULL,       -- 0, 1, 2, ... within logical_run
  pid                 INTEGER,
  opencode_session_id TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  outcome             TEXT,                   -- success|envelope-fail|crash|timeout|canceled
  exit_code           INTEGER,
  error_message       TEXT,
  pre_snapshot        TEXT,                   -- git stash hash
  FOREIGN KEY (logical_run_id) REFERENCES logical_runs(id)
);

CREATE UNIQUE INDEX uq_attempts_seq ON attempts (logical_run_id, attempt_seq);
```

### 2.4 `node_outputs`（projection：下游消费用）

```sql
CREATE TABLE node_outputs (
  task_id          TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  loop_iter        INTEGER NOT NULL,
  shard_key        TEXT,
  iter             INTEGER NOT NULL,
  port_name        TEXT NOT NULL,
  content          TEXT NOT NULL,
  captured_at      INTEGER NOT NULL,
  source_event_id  TEXT NOT NULL,            -- 反查触发的 attempt-output-captured event
  PRIMARY KEY (task_id, node_id, loop_iter, shard_key, iter, port_name),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

### 2.5 `suspensions`（projection：所有 Suspension，open + resolved 都留）

```sql
CREATE TABLE suspensions (
  id                    TEXT PRIMARY KEY,
  logical_run_id        TEXT NOT NULL,
  signal_kind           TEXT NOT NULL,
  awaits_actor          TEXT NOT NULL,        -- 'user' | 'system' | 'node:{id}'
  payload               TEXT NOT NULL,        -- JSON
  created_at            INTEGER NOT NULL,
  resolved_at           INTEGER,              -- NULL = open
  resolved_by_event_id  TEXT,
  FOREIGN KEY (logical_run_id) REFERENCES logical_runs(id)
);

-- INV-3 enforced by partial unique:
CREATE UNIQUE INDEX uq_suspensions_open ON suspensions (logical_run_id) WHERE resolved_at IS NULL;
CREATE INDEX ix_suspensions_kind ON suspensions (signal_kind, resolved_at);
CREATE INDEX ix_suspensions_open ON suspensions (resolved_at) WHERE resolved_at IS NULL;
```

### 2.6 `lifecycle_alerts`（保留 RFC-053 P-3，角色降级为 anomaly 探测）

不变；仍记录 R1/R2/C1/T1/T2/T3/U1/CR-1/S1/S2/S3/S4 alert。**新架构下大部分 invariant 由 schema 强制为不可能违反**，但保留扫描器作为 belt-and-suspenders。

### 2.7 `tasks`（保留今日 schema）

`tasks.status` 字段保留，但更新走 `task-*` 事件 + event-applier 写入；不再有 ad-hoc `UPDATE tasks SET status=...`。

### 2.8 `projection_meta`（单行表，rebuild cursor）

```sql
CREATE TABLE projection_meta (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  last_processed_event_id  TEXT,
  rebuilt_at               INTEGER NOT NULL
);
```

启动期增量 apply 从这个 cursor 续；全量 rebuild 把这行重置为 NULL。

## 3. Event Taxonomy（闭合 19 类）

```typescript
type EventKind =
  // task-level
  | 'task-created'
  | 'task-started'
  | 'task-paused'
  | 'task-canceled'
  | 'task-completed'
  | 'task-failed'
  | 'task-resumed-after-daemon-restart'

  // logical-run-level
  | 'logical-run-created'         // scope, iter 首次出现
  | 'logical-run-iter-bumped'     // resolution 触发 next iter
  | 'logical-run-completed'
  | 'logical-run-canceled'

  // attempt-level
  | 'attempt-started'             // opencode spawn
  | 'attempt-finished-success'
  | 'attempt-finished-envelope-fail'
  | 'attempt-finished-crash'
  | 'attempt-finished-timeout'
  | 'attempt-canceled'
  | 'attempt-output-captured'     // 单个 port，多 port = 多 events；§10 aging baseline 信号
  | 'attempt-subagent-tool-use'   // 子 session 子事件；parent_event_id 指 attempt-started
  | 'attempt-subagent-output'

  // suspension-level
  | 'suspension-created'
  | 'suspension-resolved'         // 携 resolution_id UNIQUE
  | 'suspension-terminated'       // task cancel / 替代 resolution 收尾

  // invariant
  | 'invariant-alert-detected'
  | 'invariant-alert-resolved'
```

每个 event kind 对应一个 payload schema（`shared/events.ts` 集中定义 Zod，编译期检查）。

## 4. SignalKind 闭合表（v1 六类）

| signalKind | 谁 emit | 谁 resolve | effectOnLogicalRun | autoResolve | 备注 |
|---|---|---|---|---|---|
| `self-clarify` | agent NodeKind | user | bump-iter | ✗ | 即原 RFC-023 |
| `cross-clarify` | cross-clarify NodeKind | user | bump-iter (designer + cascade questioner) | ✗ | 即原 RFC-056 + RFC-059 per-question scope |
| `review` | review NodeKind | user | bump-iter (仅 iterate/reject; approve 不 bump) | ✗ | 即原 RFC-005 |
| `retry-pending-auto` | scheduler 在 attempt-finished-(fail/crash/timeout) 时 | scheduler 自身（budget>0） | bump-iter | ✅ | RFC-042 envelope-followup 归这里（autoResolve 同 session） |
| `retry-pending-human` | scheduler（auto budget=0） | user | bump-iter | ✗ | retry budget 耗尽后人工决策 |
| `await-external-data` | (预留 v1 不实现) | user / external | bump-iter | ✗ | 未来：文件上传 / API / 外部数据 |

新增 SignalKind = 加 union 一行 → 编译器在 `SIGNAL_KIND_HANDLERS` Record 上报缺；必须实现 6 method 才能编译。

## 5. Handler 接口

```typescript
// shared/handlers.ts

/* ============================================================
 * NodeKindHandler — 每种 NodeKind 一个
 * RFC-060 完工后 NodeKind 集合: input / output / agent / review /
 *   clarify / clarify-cross-agent / wrapper-git / wrapper-loop /
 *   wrapper-fanout = 9 种
 * ============================================================ */
export interface NodeKindHandler<K extends NodeKind> {
  kind: K

  /**
   * 是否就绪 dispatch；默认 = all upstream done AND my.iter < max(upstream.iter)
   * wrapper-fanout / clarify 等可定制。
   */
  readyCondition?(ctx: ReadyContext): boolean

  /**
   * 派发动作。返回值告诉 scheduler 下一步走什么。
   */
  dispatch(ctx: DispatchContext<K>): Promise<DispatchResult>

  /**
   * 从事件流构造 prompt 上下文。纯函数，无 IO。
   * aging 谓词内置（§10）。
   */
  buildPromptFromEvents(
    events: ReadonlyArray<Event>,
    scope: Scope,
  ): PromptContext

  /**
   * attempt 结束后回调；决定下一步走 done / fail / suspend。
   */
  onAttemptFinished(
    ctx: AttemptContext,
    result: AttemptResult,
  ): Promise<NodeDecision>
}

export type DispatchResult =
  | { kind: 'spawn-attempt'; prompt: string; preSnapshot?: string }
  | { kind: 'virtual-done'; outputs: Record<string, string> }       // input/output/clarify pass-through
  | { kind: 'enter-inner-scope'; scope: Scope }                     // wrapper-*

export type NodeDecision =
  | { kind: 'done'; outputs: Record<string, string> }
  | { kind: 'fail'; errorMessage: string }
  | { kind: 'suspend'; signalKind: SignalKind; payload: unknown; awaitsActor: ActorRef }

/* ============================================================
 * SignalKindHandler — 每种 SignalKind 一个
 * ============================================================ */
export interface SignalKindHandler<K extends SignalKind> {
  kind: K

  /**
   * NodeKindHandler 返回 'suspend' 时调用。写 suspension-created 事件 +
   * 任何 side-effect events（如 cross-clarify 还要去触发 questioner 节点）。
   */
  onSuspend(ctx: SuspendContext<K>, payload: SignalPayload<K>): Promise<SuspensionId>

  /**
   * 验证 resolution payload schema 合法。
   */
  validateResolution(payload: ResolutionPayload<K>): ValidationResult

  /**
   * 把 Resolution 翻译成一组 events 写入 events 表。
   * 典型：1 条 suspension-resolved + 0..N 条 side-effect events
   *   （review iterate 还要给 upstream node 写 logical-run-iter-bumped 让 cascade 触发）。
   */
  applyResolution(
    ctx: ResolveContext<K>,
    payload: ResolutionPayload<K>,
  ): Promise<Event[]>

  /**
   * 自动 resolve 策略；retry-pending-auto: budget>0 立即返回 payload；其它返回 null。
   */
  autoResolve?(suspension: Suspension): Promise<ResolutionPayload<K> | null>

  /**
   * 是否 bump 源节点的 iter。
   */
  effectOnLogicalRun(): 'bump-iter' | 'no-bump'

  /**
   * 渲染本类型 resolution 在 prompt 中的展示段。
   * 由 buildPromptFromEvents 调用；老化（aging）已在外层过滤过。
   */
  renderPromptSection(
    resolutions: ReadonlyArray<SuspensionResolvedEvent>,
  ): string
}

/* ============================================================
 * 全局 registry — exhaustiveness-checked
 * ============================================================ */
export const NODE_KIND_HANDLERS: {
  [K in NodeKind]: NodeKindHandler<K>
} satisfies Record<NodeKind, NodeKindHandler<NodeKind>> = { /* ... */ }

export const SIGNAL_KIND_HANDLERS: {
  [K in SignalKind]: SignalKindHandler<K>
} satisfies Record<SignalKind, SignalKindHandler<SignalKind>> = { /* ... */ }
```

## 6. Scheduler 主循环（单 actor per task，目标 < 200 行）

```typescript
// backend/scheduler/taskActor.ts

interface WakeEvent {
  taskId: string
  reason:
    | { kind: 'event-applied'; eventId: string }    // 任意状态变化都触发
    | { kind: 'attempt-exit'; attemptId: string; outcome: AttemptOutcome }
    | { kind: 'timer'; purpose: 'retry-backoff' | 'invariant-scan' }
    | { kind: 'cancel' }
}

export async function runTaskActor(taskId: string, signal: AbortSignal) {
  const queue = wakeQueueFor(taskId)
  for await (const wake of queue) {
    if (signal.aborted) break

    // 1. 同步 projections (从 last_processed_event_id 增量)
    await applyEventsToProjections(taskId)

    // 2. 处理 attempt exit
    if (wake.reason.kind === 'attempt-exit') {
      const decision = await invokeOnAttemptFinished(wake.reason.attemptId, wake.reason.outcome)
      await writeEventsFromDecision(decision)
      continue
    }

    // 3. 扫 ready 节点（§7 SQL）
    const ready = await scanReadyLogicalRuns(taskId)
    for (const { node, scope } of ready) {
      const h = NODE_KIND_HANDLERS[node.kind]
      if (h.readyCondition && !h.readyCondition(ctx(node, scope))) continue
      const result = await h.dispatch(ctx(node, scope))
      switch (result.kind) {
        case 'spawn-attempt': {
          const events = await spawnAttempt(node, scope, result.prompt, result.preSnapshot)
          await writeEvents(events)
          break
        }
        case 'virtual-done': {
          await writeEvents([
            { kind: 'logical-run-completed', /* ... */ },
            ...Object.entries(result.outputs).map(([port, content]) =>
              ({ kind: 'attempt-output-captured', port, content, /* ... */ })),
          ])
          break
        }
        case 'enter-inner-scope': {
          await writeEvents([{ kind: 'logical-run-created', scope: result.scope, /* ... */ }])
          break
        }
      }
    }

    // 4. 终态判定
    if (await isTaskComplete(taskId)) { await writeEvent({ kind: 'task-completed', taskId }); break }
    if (await isTaskStalled(taskId)) { await writeEvent({ kind: 'task-failed', reason: 'stalled' }); break }
  }
}
```

**关键性质**：
- task 内顺序消费 wake；无 `Promise.all` + writeSem race；无 rescan band-aid
- 所有写入由 `writeEvents` 统一走 events 表 + event-applier 更新 projection
- `attempt` 子进程异步运行；它们的 exit 直接写 `attempt-finished-*` event + 入队 `attempt-exit` wake，不直接动 projection

## 7. Ready Check 算法（lazy cascade，纯 SQL）

```sql
-- 判定 node X 在 scope (loopIter, shardKey) 是否需要新 iter
WITH my_latest AS (
  SELECT IFNULL(MAX(iter), -1) AS my_iter
  FROM logical_runs
  WHERE task_id = :tid AND node_id = :node
    AND loop_iter = :li AND (shard_key IS :sk OR shard_key = :sk)
),
upstream_aggregated AS (
  SELECT e.upstream_node_id,
         MAX(lr.iter) AS max_iter,
         MIN(CASE WHEN lr.status = 'done' THEN 1 ELSE 0 END) AS all_done
  FROM workflow_edges e
  LEFT JOIN logical_runs lr
    ON lr.task_id = :tid AND lr.node_id = e.upstream_node_id
   AND lr.loop_iter = :li AND (lr.shard_key IS :sk OR lr.shard_key = :sk)
  WHERE e.downstream_node_id = :node
  GROUP BY e.upstream_node_id
)
SELECT
  CASE
    WHEN MIN(all_done) = 1
     AND (my_latest.my_iter < MAX(max_iter) OR my_latest.my_iter = -1)
    THEN 1 ELSE 0
  END AS should_dispatch
FROM upstream_aggregated, my_latest;
```

下游下次 wake 时**自动**发现 "我的 iter 落后于上游" → mint 新 logical_run(iter=max+1) → dispatch。**今天 RFC-056 五份补丁治的 cascade 完整性问题，结构性归零**。

## 8. Daemon 重启序列（4 步、纯事件）

```
1. 启动: cursor = SELECT last_processed_event_id FROM projection_meta
   增量 fold events → projections (启动 ms 级)

2. SELECT * FROM attempts WHERE finished_at IS NULL
   for each:
     writeEvent({ kind: 'attempt-finished-crash', attemptId, ... })
     event-applier 自动调 onAttemptFinished → suspend(retry-pending-auto)
     SIGNAL_KIND_HANDLERS['retry-pending-auto'].autoResolve(budget>0)
       → applyResolution 写 suspension-resolved + logical-run-iter-bumped
       → 下一轮 wake 触发 dispatch

3. for each task with non-terminal status:
     writeEvent({ kind: 'task-resumed-after-daemon-restart', taskId, ... })
     enqueue WakeEvent into taskActor queue

4. taskActors 起来按 §6 主循环跑
```

**用户视角**：task 几秒后继续，零 fixup 脚本。

## 9. Cancel 传播（一条事件、连锁反应）

```
user POST /api/tasks/:id/cancel
  → writeEvent({ kind: 'task-canceled', taskId, actor: 'user:{uid}' })
  → event-applier:
      • UPDATE tasks SET status='canceled' WHERE id=:tid
      • For each open suspension (WHERE resolved_at IS NULL AND task_id=:tid):
          writeEvent({ kind: 'suspension-terminated', reason: 'task-canceled', ... })
      • For each in-flight attempt (started_at NOT NULL AND finished_at IS NULL):
          SIGTERM the pid (best-effort)
          attempt's exit handler will write attempt-canceled event
  → WS broadcaster: 1 推送 'task-canceled' 含完整状态变更
```

## 10. Aging（buildPromptFromEvents，纯函数 < 30 行）

```typescript
// shared/promptFromEvents.ts

export function buildPromptFromEvents(
  events: ReadonlyArray<Event>,
  scope: Scope,
): PromptContext {
  // 1. baseline = 该节点在此 scope 下最近一次产出有效输出的 iter
  //    attempt-output-captured 只在 RFC-049 端口验证全过后写入
  const baselineIter = Math.max(
    -1,
    ...events
      .filter(e => e.kind === 'attempt-output-captured' && sameScope(e, scope))
      .map(e => e.iter!),
  )

  // 2. 取 baseline 之后的 resolution 事件
  const relevant = events.filter(e =>
    e.kind === 'suspension-resolved'
    && sameScope(e.target, scope)
    && e.target.fromIter >= baselineIter  // baseline=-1 时全部纳入
  )

  // 3. 按 SignalKind 分桶，委托各自 handler 渲染
  return {
    selfClarifyQA: SIGNAL_KIND_HANDLERS['self-clarify'].renderPromptSection(
      relevant.filter(r => r.payload.signalKind === 'self-clarify'),
    ),
    externalFeedback: SIGNAL_KIND_HANDLERS['cross-clarify'].renderPromptSection(
      relevant.filter(r => r.payload.signalKind === 'cross-clarify'),
    ),
    reviewComments: SIGNAL_KIND_HANDLERS['review'].renderPromptSection(
      relevant.filter(r =>
        r.payload.signalKind === 'review' && r.payload.decision !== 'approve',
      ),
    ),
    // retry-pending-* 不进 prompt（控制信号、非反馈）
  }
}
```

**单一谓词 `fromIter >= baselineIter`** 替代今日跨 4 文件、3 consumerKind 分支、2 个 iterationField 的 `computeHistoryCutoff`。

## 11. Wrapper 形态（wrapper-* 都是 NodeKindHandler）

RFC-060 完工后，wrapper-* NodeKind 集合已定型；本 RFC 只是把 wrapper 的执行模型从今日 scheduler.ts 内联递归 `runScope` 改为 NodeKindHandler 接口实现。

### 11.1 wrapper-git

```typescript
const wrapperGitHandler: NodeKindHandler<'wrapper-git'> = {
  kind: 'wrapper-git',
  async dispatch(ctx) {
    return { kind: 'enter-inner-scope', scope: ctx.innerScope }
  },
  async onInnerScopeCompleted(ctx) {
    const beforeSha = ctx.preSnapshot
    const afterDiff = await computeDiffSinceSnapshot(ctx.worktree, beforeSha)
    // RFC-060 已经把 git_diff port kind 升级为 list<path>
    return { kind: 'done', outputs: { git_diff: serializeAsListOfPath(afterDiff) } }
  },
  // ...
}
```

### 11.2 wrapper-loop

```typescript
const wrapperLoopHandler: NodeKindHandler<'wrapper-loop'> = {
  kind: 'wrapper-loop',
  async dispatch(ctx) {
    const currentLoopIter = ctx.iter   // wrapper 自己的 iter 用作 loopIter 给 inner
    return { kind: 'enter-inner-scope', scope: { ...ctx.scope, loopIter: currentLoopIter } }
  },
  async onInnerScopeCompleted(ctx) {
    if (await shouldContinueLoop(ctx)) {
      return { kind: 'done-with-bump' }   // event-applier 写 iter-bumped
    }
    return { kind: 'done', outputs: ctx.exitOutputs }
  },
}
```

### 11.3 wrapper-fanout

```typescript
const wrapperFanoutHandler: NodeKindHandler<'wrapper-fanout'> = {
  kind: 'wrapper-fanout',
  async dispatch(ctx) {
    const shards = await splitShards(ctx.upstreamListPortValue)   // RFC-060 list<T> 输入
    for (const shardKey of shards) {
      await writeEvent({ kind: 'logical-run-created', scope: { ...ctx.innerScope, shardKey } })
    }
    return { kind: 'enter-inner-scope-multi', count: shards.length }
  },
  async onAllShardsCompleted(ctx) {
    // RFC-060 aggregator agent 通过 prompt 模板拿全 shard 输出
    return { kind: 'done', outputs: ctx.aggregatorOutputs }
  },
}
```

## 12. 断代清单（一次性删除）

**PR-B 一次性删除的文件**：

```
packages/backend/src/services/scheduler.ts                  (~3160 行)
packages/backend/src/services/clarify.ts                    
packages/backend/src/services/crossClarify.ts               
packages/backend/src/services/clarifyRounds.ts              
packages/backend/src/services/clarifyFallback.ts            
packages/backend/src/services/review.ts                     
packages/backend/src/services/lifecycle.ts                  (RFC-053 P-1 退役)
packages/backend/src/services/exitCondition.ts              (wrapper-loop 内联)
packages/backend/src/services/wrapperProgress.ts            (wrapper handler 内联)
```

**PR-B 一次性 DROP 的表**（migration 0034）：

```sql
DROP TABLE node_runs;
DROP TABLE node_run_events;
DROP TABLE node_run_outputs;
DROP TABLE clarify_sessions;
DROP TABLE clarify_rounds;
DROP TABLE cross_clarify_sessions;
DROP TABLE doc_versions;
```

**PR-B 一次性删除的代码模式**（grep guard 守门）：

```
isFresherNodeRun
cascadeDownstreamFromDesigner
applyCrossClarifyFreshnessInvariant
rescanScopeForNewPendingRows
computeHistoryCutoff
transitionNodeRunStatus
setNodeRunStatus
dispatchReviewNode
```

**PR-D 一次性删除的 scripts**：

```
packages/backend/scripts/fixup-rfc052-stuck-review.ts
packages/backend/scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts
```

断代后 fixup 结构性不再需要（events 是 append-only，永不损坏）。

## 13. 不变量（5 条铁律，schema 守护）

```
INV-1: events 永远不可改、不可删。
       由 events 表无 UPDATE / DELETE 路径 + sqlite trigger 强制。

INV-2: 所有 projection 必须可从 events 完全重建。
       由 rebuilder + 启动期一致性校验 + property test 强制。

INV-3: 同一 logical_run 任意时刻最多 1 个 open suspension。
       由 uq_suspensions_open partial unique index 强制：
         CREATE UNIQUE INDEX uq_suspensions_open
           ON suspensions (logical_run_id) WHERE resolved_at IS NULL

INV-4: 同一 (task_id, node_id, loop_iter, shard_key, iter) 唯一。
       由 logical_runs UNIQUE 约束强制。

INV-5: 每条 suspension-resolved 事件携 resolution_id UNIQUE。
       由 uq_events_resolution unique index 强制。
```

这 5 条由 schema CHECK / UNIQUE / FK + grep guard 守护，**不需要测试覆盖每条**——schema 拒绝非法写入。Property test 验证它们在任意事件序列下永真即可。

## 14. 测试策略

### 14.1 三层防线

```
Layer 1: Schema-enforced invariants
  • INV-3 (partial unique) / INV-4 (full unique) / INV-5 (unique) 由 DB 直接拒
  • Property test 验证 schema 不可能被违反

Layer 2: Property-based suites (≥ 100 new cases)
  • P1: events → projection rebuild 幂等
        for any event sequence, rebuild N 次结果字节一致
  • P2: aging cutoff 在任意事件交错下保持
        for any interleaving of attempt-* / suspension-* events,
        baselineIter 单调不减; 老化结果不依赖 ts 之外的顺序
  • P3: suspension single-concurrency
        for any concurrent suspension-created attempts on same logical_run,
        恰好一条 INSERT 成功、其余 fail 走 idempotent path
  • P4: cancel 全局传播原子
        for any task with N open suspensions + M in-flight attempts,
        cancel 写一条 task-canceled event 后, applyEventsToProjections
        一次完成所有 suspension-terminated + attempt-canceled
  • P5: daemon restart 自动续命
        crash any task at any moment, after restart 验证状态恢复
        到 crash 前的最近一致点 + 自动 retry-pending-auto

Layer 3: e2e baseline (≥ 20 spec)
  • PR-A 阶段提前锁今日所有 user-visible flow
  • 后续 PR 必须保持全绿；UX 变更（events timeline）属新增、不破坏旧 spec
```

### 14.2 baseline 锁

PR-A 开始之前先把今日所有 user-visible flow 打成 e2e baseline（≥ 20 spec），每个 PR 必须保持全绿。**不再要求字节级 UI 守恒**——visual baseline 在 PR-C 可刷新以适应新 UX。

### 14.3 grep guard 永久守门

```
guard 1: 禁 db.update(logical_runs).set({ status:   (event-applier 内除外)
guard 2: 禁 db.insert(events)   (writeEvents helper 内除外)
guard 3: 禁 isFresherNodeRun                       (完全退役)
guard 4: 禁 cascadeDownstreamFromDesigner          (完全退役)
guard 5: 禁 rescanScopeForNewPendingRows           (完全退役)
guard 6: 禁 applyCrossClarifyFreshnessInvariant    (完全退役)
guard 7: 禁 computeHistoryCutoff                   (完全退役)
guard 8: 禁 transitionNodeRunStatus / setNodeRunStatus  (RFC-053 P-1 退役)
guard 9: 禁 src/ 出现老表名: node_runs / node_run_events / node_run_outputs /
            clarify_sessions / clarify_rounds / cross_clarify_sessions / doc_versions
guard 10: 强制每个 SignalKind / NodeKind union 在对应 HANDLERS Record 有 entry
            (TS exhaustiveness 编译期)
```

## 15. 性能讨论

### 15.1 events 表增长

按今天数据估算：一个典型 task ~50 个 node × 平均 3 个 attempt × 平均 20 event/attempt ≈ 3000 events/task。每条 event payload ~500 bytes，每 task ~1.5 MB events。

按 1 day 50 tasks 计算：每月 ~ 2 GB events 行。SQLite WAL 模式可承受。

### 15.2 归档策略

`tasks.status` ∈ {done, failed, canceled} 且 `finished_at < now - 30 days` 的 task，其 events 行批量 INSERT 到 `events_archive` 表（同 schema、不带索引），然后 DELETE 主表行。归档作为后续 RFC 落地，v1 暂不实现。

### 15.3 projection rebuild 性能

冷启动全量 fold ≈ O(events 总数)。Bun + sqlite + 单语句 batch 估算 100k events/s。即使 5 GB events，rebuild ~ 5 分钟。增量 apply ≈ O(单条 event 处理 < 1 ms)；每 task actor 顺序 apply 不卡。

### 15.4 ready check SQL 性能

每 wake 跑一次 ready scan，全 task ≤ N 节点 × O(log N) edges。今日 task 最大 ~50 节点；ready scan < 10 ms。

### 15.5 单 actor per task scaling

按 task 数线性。同时跑 100 个 task = 100 个 actor，每个 actor 内部顺序消费。共享 sqlite WAL，写入序列化但读不阻塞。

## 16. 与 RFC-060 关系

RFC-060 是本 RFC 的 prereq——必须先完工合并。RFC-060 提供：

- 完整 NodeKind 集合（input / output / agent / review / clarify / clarify-cross-agent / wrapper-git / wrapper-loop / wrapper-fanout）
- 参数化 kind 系统（`path<T>` / `list<T>` / `signal`）
- `agent.role: 'aggregator'` frontmatter 支持
- wrapper-git 的 `git_diff` port 升级为 `list<path>`
- workflow $schema_version bump 完成

RFC-061 在这套既有基线上**重写执行模型**——不动 NodeKind 集合 / 不动 kind 系统 / 不动 agent role / 不动 wrapper-fanout 设计，只把"NodeKind 是如何被驱动的"从 scheduler.ts + 5 张可变表 + 5 类 counter 改为 events + projection + NodeKindHandler。

RFC-060 完工时它的实现代码（特别是 scheduler.ts 中的 runFanOutNode / runOneNode 等）会在 RFC-061 PR-B 随老 scheduler.ts 整体删除——这是预期的"重写下层驱动"，不是"推翻 RFC-060 设计"。RFC-060 的产品语义（wrapper-fanout 怎么工作、agent role 是什么、list<T> 怎么传输）在 RFC-061 完全保留。

## 17. 风险登记

| 风险 | 缓解 |
|---|---|
| events 表无 UPDATE/DELETE 守护被绕过 | grep guard + sqlite trigger 双锁；启动期一致性校验 |
| projection 与 events 不一致 (event-applier bug) | property test ≥ 100 case 验证 rebuild 幂等；nightly 跑一致性扫描 |
| RFC-060 完工时间不确定影响本 RFC 启动 | RFC-061 准备工作（设计文档审阅、property test 套件草稿）可与 RFC-060 并行做；落码必须等 |
| PR-B 硬切风险大 | PR-A baseline ≥ 20 e2e spec + ≥ 100 property test 提前锁所有 user-visible 行为；PR-B CI 必须 baseline 全绿才能合 |
| schema 改动跨多次启动 | upgrade-rolling test 锁；启动期 schema 自检确保 journal idx 一致 |
| 4 PR 7 周战线长 | 每 PR 独立可合；用户随时可暂停 |

## 18. 不在本 RFC 范围

- frontend xyflow 画布业务路径改动（不动）
- opencode 子进程交互 / envelope parsing / RFC-049 端口验证（不动）
- 实时 event 推送 latency 优化（v1 用 WS broadcaster 推 events 增量；后续 RFC 改 stream）
- multi-daemon 分布式（不动）
- events 表归档 / 分区策略（v1 不做，半年内不需要）
- 跨 task 事件查询性能优化（v1 不做）
