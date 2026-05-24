# RFC-062 — 调度器 stall 三层防御（技术设计）

> 配套 [proposal.md](./proposal.md) + [plan.md](./plan.md)。

## 1. 三层结构总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Layer 1 · 契约（编译期 + grep 期）                                       │
│   shared/src/workflow/edges.ts                                            │
│     SYSTEM_PORT_NAMES (公开 readonly Set)                                 │
│     isFeedbackEdge(edge) → boolean                                        │
│     filterDataEdges(edges) → WorkflowEdge[]                               │
│     filterFeedbackEdges(edges) → WorkflowEdge[]                           │
│   grep guard: 任意 .ts 命中 workflow.edges 必走上述 helper                │
│                                                                            │
│ Layer 2 · 真实工作流 e2e 夹具（PR-time）                                  │
│   packages/backend/tests/e2e-snapshots/                                   │
│     cross-clarify-roundtrip.json   ← 本次 incident workflow              │
│     self-clarify-only.json                                                │
│     wrapper-loop-with-clarify.json                                        │
│   rfc062-snapshot-replay.test.ts:                                         │
│     for each snapshot:                                                    │
│       launch → MockRunnerAdapter 驱动 → 断言 task-completed + 关键事件   │
│                                                                            │
│ Layer 3 · 运行期 stall 检测 + alert（5min cadence）                       │
│   lifecycleInvariants S5 scheduler-stalled                                │
│     SELECT tasks WHERE status='running' AND                               │
│       (now - max(events.ts WHERE task_id=tasks.id)) > thresholdMs         │
│   落 lifecycle_alerts → WS lifecycle.alert broadcast → UI 红条 / Inbox    │
└──────────────────────────────────────────────────────────────────────────┘
```

三层独立、可独立 PR、可独立回滚。

---

## 2. Layer 1 · 契约层

### 2.1 新文件 `packages/shared/src/workflow/edges.ts`

```ts
// RFC-062 §2 — workflow edge contracts
// Single source of truth for "which edges gate downstream dispatch vs.
// which edges carry feedback into a suspended/running node".

/**
 * Target port names whose inbound edges are FEEDBACK channels, not data
 * gates. The scheduler must NOT wait for these to be "done" before
 * minting a downstream logical_run; the framework injects their content
 * via dedicated prompt sections (Clarify Q&A / External Feedback) only
 * when the agent is in the corresponding suspension state.
 *
 * Adding to this set is a contract change — every consumer of
 * workflow.edges that gates topology MUST be re-audited.
 *
 * Mirrors / supersedes the private SYSTEM_PORT_NAMES in shared/prompt.ts
 * (which kept the same set for a different reason — auto-append loop
 * suppression). Both call sites now share this canonical set.
 */
export const SYSTEM_PORT_NAMES: ReadonlySet<string> = new Set([
  '__clarify_response__', // RFC-023 self-clarify answers target
  '__external_feedback__', // RFC-056 cross-clarify designer feedback target
])

export interface WorkflowEdgeLike {
  source?: { nodeId?: string; portName?: string } | undefined
  target?: { nodeId?: string; portName?: string } | undefined
}

/** True iff target.portName is a system-feedback port (back-edge, not gate). */
export function isFeedbackEdge(edge: WorkflowEdgeLike): boolean {
  const p = edge.target?.portName
  return typeof p === 'string' && SYSTEM_PORT_NAMES.has(p)
}

/** Edges whose target is a normal data port — used for upstream gating. */
export function filterDataEdges<E extends WorkflowEdgeLike>(edges: ReadonlyArray<E>): E[] {
  return edges.filter((e) => !isFeedbackEdge(e))
}

/** Edges whose target is a system-feedback port — used by clarify/cross-clarify wiring. */
export function filterFeedbackEdges<E extends WorkflowEdgeLike>(edges: ReadonlyArray<E>): E[] {
  return edges.filter((e) => isFeedbackEdge(e))
}
```

`packages/shared/src/index.ts` 重新 export 上述符号。

### 2.2 `prompt.ts` 私有常量改为 re-import

```ts
// packages/shared/src/prompt.ts:266 — replace the local Set
import { SYSTEM_PORT_NAMES } from './workflow/edges'
// (local const SYSTEM_PORT_NAMES deleted; downstream usage unchanged)
```

避免两份"真相"漂移。

### 2.3 scheduler 三处消费点改写

| 文件:行 | 当前 | 改成 |
|---|---|---|
| `scheduler-v2/readyScanner.ts:175` `scanFreshDownstream` 构 `upstreamMap` | `for (const e of edges)` | `for (const e of filterDataEdges(edges))` |
| `scheduler-v2/launcher.ts:134-144` `findEntryNodes` | 用全部 edges 判 hasInbound | 用 `filterDataEdges(edges)` 判（feedback edge 不算"入边占用"，故起点节点也不该被它阻挡） |
| `scheduler-v2/launcher.ts:178-220` `makeUpstreamInputsResolver` | 遍历所有 inbound 取最新输出 | 遍历 `filterDataEdges(inbound)` 取数据端口；feedback 端口的内容由 `buildPromptFromEvents` 走 SignalKind 通道注入，**不再从 node_outputs 读** |

`services/fanout.ts:70/86/125/187`、`services/workflow.validator.ts:97`、`services/task.ts:664` 同步 audit；预期 fanout 也走 `filterDataEdges`（feedback 边不参与 shard fan-out 拓扑），validator 应同时检查两类边（feedback 边继续需要 source 节点存在 + 端口存在）但不要求 cycle-free。

### 2.4 grep guard

新文件 `packages/backend/tests/rfc062-edges-guard.test.ts` + `packages/shared/tests/rfc062-edges-guard.test.ts`：

```ts
// 1) 任何 .ts 出现 \bworkflow\.edges\b | \bdefinition\.edges\b | \.edges \?\?
//    必须在同 100 行内出现 filterDataEdges / filterFeedbackEdges /
//    `// edges:include-system <reason>` 注释；否则 fail，error 信息提示
//    "use filterDataEdges/filterFeedbackEdges or annotate with reason"
// 2) frontend canvas/ 整批白名单（editor 天然要看所有 edges，drag/select/
//    inspector 都不走 gating 逻辑）
// 3) SYSTEM_PORT_NAMES 仅在 shared/workflow/edges.ts + shared/prompt.ts
//    出现；其他地方需要白名单理由
```

### 2.5 "未接通占位" grep guard

新文件 `packages/backend/tests/rfc062-no-deferred-todo.test.ts`：

```ts
const FORBIDDEN_PHRASES = [
  'unused in production',
  "caller's responsibility for now",
  'TODO: wire up',
  'the daemon hard-cut commit wires this up',
  'TBD',
]
// 扫所有 packages/*/src/**/*.ts，命中其一 + 不在白名单文件列表内 → fail
// 白名单：本测试文件自身（用来匹配的字符串）+ scripts/dev-*.md 之类
```

存量违例必须在本 RFC 修复（见 §6.4）。

---

## 3. Layer 2 · 真实工作流 e2e fixture

### 3.1 Fixture 目录布局

```
packages/backend/tests/e2e-snapshots/
├── README.md                              # 解释 fixture 来源 + 升级规则
├── cross-clarify-roundtrip.json           # 本次 incident workflow snapshot
├── self-clarify-only.json
├── wrapper-loop-with-clarify.json
└── ...                                    # 后续 RFC 可追加
```

每个 `.json` 文件结构：

```jsonc
{
  "$comment": "Frozen on 2026-05-25 from prod workflow 01KS7C0K5...",
  "$schema_version": 4,
  "workflow": { /* WorkflowDefinitionSchema-compatible */ },
  "inputs": { "requirement": "示例需求文本" },
  "scriptedAgentOutputs": [
    // 按 agent invocation 顺序列出 mock 输出
    {
      "matchNode": "agent_m7p3n1",
      "matchIter": 0,
      "envelopeXml": "<workflow-output><port name=\"docpath\">doc/design.md</port></workflow-output>"
    },
    {
      "matchNode": "agent_b48d63",
      "matchIter": 0,
      "envelopeXml": "<workflow-output><port name=\"docpath\">doc/test.md</port></workflow-output>"
    }
  ],
  "scriptedReviewDecisions": [
    { "matchNode": "rev_5h9xpz", "matchIter": 0, "decision": "approve", "comments": "" },
    { "matchNode": "rev_cbkatx", "matchIter": 0, "decision": "approve", "comments": "" }
  ],
  "expectedTerminalKind": "task-completed",
  "expectedEvents": {
    // 部分子串断言（不要求完整序列字节级守恒）
    "mustContainInOrder": [
      "task-started",
      "logical-run-created:in_0ck111",
      "logical-run-completed:in_0ck111",
      "logical-run-created:agent_m7p3n1",
      "attempt-started:agent_m7p3n1",
      "attempt-finished-success:agent_m7p3n1",
      "logical-run-created:rev_5h9xpz",
      "logical-run-created:agent_b48d63",
      "task-completed"
    ]
  }
}
```

### 3.2 测试驱动文件

`packages/backend/tests/rfc062-snapshot-replay.test.ts`：

```ts
const FIXTURES = readdirSync('tests/e2e-snapshots').filter((f) => f.endsWith('.json'))

describe.each(FIXTURES)('e2e snapshot %s', (file) => {
  it('reaches task-completed', async () => {
    const fixture = JSON.parse(readFileSync(`tests/e2e-snapshots/${file}`, 'utf8'))
    const db = createTestDb()
    const taskId = ulid()
    insertTaskRow(db, { id: taskId, workflowSnapshot: fixture.workflow, inputs: fixture.inputs, ... })

    const runner = new ScriptedRunnerAdapter(fixture.scriptedAgentOutputs)  // §3.3
    const clarifyAuto = autoResolveClarifyFromFixture(fixture)               // §3.3
    const reviewAuto = autoResolveReviewFromFixture(fixture.scriptedReviewDecisions)

    await runTaskActorViaProduction({
      db, taskId,
      workflow: fixture.workflow,
      inputsMap: fixture.inputs,
      worktreePath: tmpDir(),
      repoPath: tmpDir(),
      appHome: tmpDir(),
      runnerAdapterOverride: runner,
    })

    const events = readEvents(db, taskId)
    const kinds = events.map((e) => `${e.kind}:${e.nodeId ?? ''}`)
    expect(kinds[kinds.length - 1]).toMatch(/^(task-completed|task-failed)/)
    expect(kinds[kinds.length - 1]).toBe(fixture.expectedTerminalKind)
    assertContainsInOrder(kinds, fixture.expectedEvents.mustContainInOrder)
  }, { timeout: 30_000 })
})
```

### 3.3 ScriptedRunnerAdapter

复用 `MockRunnerAdapter` 的能力，新增一个 wrapper：

- 接收 fixture `scriptedAgentOutputs` 数组
- 每次 `spawn(req)` 时按 `(nodeId, iter)` 匹配 fixture，取对应 `envelopeXml`，立刻 `simulateExit({ outcome: 'success', envelope: ... })`
- 没匹配到的 spawn 调用 → 测试 fail（"unexpected dispatch"）

类似的 `autoResolveClarifyFromFixture` / `autoResolveReviewFromFixture` hook 到 SuspensionKindHandler，让 clarify / review suspension 立刻按 fixture 决策自动 resolve（v1 通过订阅 events 表新行 + 写对应 resolution 事件实现，不需要新框架抽象）。

### 3.4 Fixture 来源 + 升级规则（写进 `e2e-snapshots/README.md`）

- 初始 fixture 由 incident workflow 直接导出：`sqlite3 ~/.agent-workflow/db.sqlite "SELECT workflow_snapshot FROM tasks WHERE workflow_id='01KS7C0K5...'"`
- workflow schema 升级（如 RFC-060 那种 `$schema_version` bump）时，本目录所有 fixture 必须**显式 migrate + 重测**，作为 schema bump checklist 一部分；不允许"fixture 用老 schema、运行时升级"的隐式行为。
- 任何 PR 新增 NodeKind / SignalKind 必须**同步增加至少一个 fixture 覆盖该 kind 在含反馈环 workflow 里的行为**。

---

## 4. Layer 3 · stall 检测 + alert

### 4.1 新 InvariantRule `S5`

在 `packages/backend/src/services/lifecycleInvariants.ts`：

```ts
// 注意：S 系列在文件中既存（S1..S4），按既有命名续编 S5
export type StuckRule = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
export const STUCK_RULES: readonly StuckRule[] = ['S1', 'S2', 'S3', 'S4', 'S5']

async function checkS5(
  db: DbClient,
  ctx: TaskScanContext,
  now: number,
): Promise<LifecycleInvariantFinding[]> {
  const task = db.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get()
  if (!task || task.status !== 'running') return []

  const lastEvent = db
    .select({ ts: events.ts, kind: events.kind, nodeId: events.nodeId })
    .from(events)
    .where(eq(events.taskId, ctx.taskId))
    .orderBy(desc(events.ts))
    .limit(1)
    .get()
  if (!lastEvent) return [] // 还没有事件 = launcher 还没跑完 seed，不算 stall

  const thresholdMs = resolveStallThresholdMs(ctx, lastEvent)  // §4.2
  const idleMs = now - lastEvent.ts
  if (idleMs < thresholdMs) return []

  // 算可读诊断：哪个节点的哪条 upstream 没满足
  const diagnostic = computeStallDiagnostic(db, ctx.taskId, ctx.workflow)

  return [{
    rule: 'S5',
    severity: 'error',
    detail: {
      idleMs,
      thresholdMs,
      lastEventKind: lastEvent.kind,
      lastEventNodeId: lastEvent.nodeId,
      diagnostic, // { stuckNodeId, missingUpstreams: [{nodeId, portName}] }
    },
  }]
}
```

加入 `runLifecycleInvariants` 调用链；`INVARIANT_RULES` / `STUCK_RULES` 同步加 `S5`；`LifecycleAlertRule` 联合类型自动覆盖（已经是 `InvariantRule | StuckRule`）。

### 4.2 阈值策略

```ts
function resolveStallThresholdMs(ctx, lastEvent): number {
  const cfg = ctx.config.invariantStallMs                  // 默认 5 * 60_000
  // 若最近事件是某节点的 attempt-started，按该节点 timeoutMs × 2 算
  if (lastEvent.kind === 'attempt-started' && lastEvent.nodeId) {
    const node = findNode(ctx.workflow, lastEvent.nodeId)
    const nodeTimeoutMs = node?.timeoutMs ?? ctx.config.defaultPerNodeTimeoutMs
    if (nodeTimeoutMs) return Math.max(cfg, nodeTimeoutMs * 2)
  }
  return cfg
}
```

### 4.3 `computeStallDiagnostic` 算法

```ts
// 走一遍 scanFreshDownstream 的逻辑（独立实现，避免引用 scheduler-v2 产生循环依赖）
// 返回 "下游应该被 mint 但被某些上游 done 阻挡" 的最早一个节点
function computeStallDiagnostic(db, taskId, workflow) {
  const runs = db.select().from(logicalRuns).where(eq(logicalRuns.taskId, taskId)).all()
  const runsByNode = groupBy(runs, 'nodeId')

  for (const node of workflow.nodes) {
    const myRuns = runsByNode.get(node.id) ?? []
    if (myRuns.some((r) => r.loopIter === 0 && r.shardKey === '')) continue // 已 mint

    const inbound = filterDataEdges(workflow.edges).filter((e) => e.target.nodeId === node.id)
    const missing = []
    for (const e of inbound) {
      const upRuns = runsByNode.get(e.source.nodeId) ?? []
      const hasDone = upRuns.some((r) => r.status === 'done' && r.loopIter === 0 && r.shardKey === '')
      if (!hasDone) missing.push({ nodeId: e.source.nodeId, portName: e.source.portName })
    }
    if (missing.length > 0) return { stuckNodeId: node.id, missingUpstreams: missing }
  }
  return { stuckNodeId: null, missingUpstreams: [] } // 不知道
}
```

### 4.4 Alert 落库 + 通知

复用 RFC-053 `reconcileLifecycleAlerts` 的 open/promote/resolve 机制，**0 改动**——`S5` 自动走同一流程。`promoteCallback` 调用 `tasksListBroadcaster.broadcast('lifecycle.alert', { taskId, rule: 'S5', ... })`（既有），UI WS hook `useTaskWs` 已经监听 `lifecycle.alert` → 触发 `task.alerts` 查询失效 → `<TaskHeader>` 红条自动出现。

UI 文案（i18n key）：
- `tasks.alert.S5.title` = `调度器停滞 {{minutes}} 分钟` / `Scheduler stalled for {{minutes}} min`
- `tasks.alert.S5.detail` = `节点 {{stuckNodeId}} 未被调度，等待上游 {{missingUpstreams}}` / ...

### 4.5 ERROR ↔ alert 完备性 grep guard

新文件 `packages/backend/tests/rfc062-error-must-alert.test.ts`：

```ts
// 1) 扫 packages/backend/src/**/*.ts 找所有 log.error(...) 调用
// 2) 对每个 log.error 调用，要求在同一 try/catch 或 fn 内能匹配到
//    "lifecycle_alerts insert" / "broadcastAlert(...)" / 显式注释
//    `// log-only: <reason>`
// 3) 全文匹配豁免列表：daemon-bootstrap 类（已经在 daemon.log 即用户唯一通道）
```

注意：实际执行上不强求每条 error 都有 alert（很多 error 是合理的"已经走兜底分支了"日志）；guard 的核心是**任何无 alert 的 error 必须显式注释 `// log-only` 声明意图**——这样代码 review 时一眼看出"这条没有 user-visible 通道"是有意识的决定。

### 4.6 `daemonResume` Step 4 同步修复

`packages/backend/src/scheduler-v2/daemonResume.ts`：删除 "spawnActors (caller's responsibility for now)" / "unused in production" 注释；改 `resumeFromDisk` 在 Step 3 之后**真正** spawn actor loops。`cli/start.ts:138-139` 只需保持现状（依赖 `resumeFromDisk` 内部完成）。

spawn 策略：
```ts
// daemonResume.ts §Step 4
const launched: Promise<void>[] = []
for (const t of nonTerminal) {
  // 复用 services/task 里 kickActorPath 的入口，让所有恢复任务都走相同 launcher
  launched.push(launchTaskActor(t.id))   // 非 await，并发跑
}
// 不等待，让 resumeFromDisk 立刻返回；后台 actor 自驱动
```

`launchTaskActor` 是 `services/task.ts` 现有逻辑的薄抽象（把 task row + workflow + inputs 读出来后调 `runTaskActorViaProduction`）。

---

## 5. 失败模式 + 缓解

| 失败模式 | 触发条件 | 缓解 |
|---|---|---|
| **F1 fixture 跑超时** | MockRunnerAdapter 没匹配到某次 spawn → actor 死等 | 测试本身设 30s timeout；ScriptedRunnerAdapter 收到未匹配 spawn 立刻 throw + 测试 fail，带可读 "unexpected dispatch: nodeId=X iter=Y" |
| **F2 stall invariant 误报 long-running agent** | agent 自身要跑 30 分钟 | §4.2 按节点 timeoutMs × 2 动态算阈值 |
| **F3 stall invariant 自我递归** | 检测器自己卡 → 没人看检测器 | invariant scanner 由 `cli/start.ts` 5 分钟定时唤起（既有 cron），与被检测 task actor 解耦；scanner 卡死另立 `S6 invariant-scanner-stuck`（v2 范围，本 RFC 不做） |
| **F4 grep guard 卡掉合法新增代码** | 新 RFC 引入需扫所有 edges 的算法 | `// edges:include-system <reason>` 显式豁免；guard 解析 reason 长度 ≥ 5 才放过 |
| **F5 daemonResume 并发 launch 资源耗尽** | DB 里堆了 100+ running 任务 → 一次性起 100 个 actor loop | 不做并发限制（actor 本身轻量，每个就是个 async fn + queue）；若实际撞墙再加 semaphore |
| **F6 fixture workflow schema 漂移** | shared 加 NodeKind / 改 schema | §3.4 升级规则；CI 在 `$schema_version` bump 时强制重跑 fixture |

---

## 6. 测试策略

> CLAUDE.md "Test-with-every-change" 原则：每条改动配套测试。

### 6.1 PR-A 测试（契约 + 立即解锁）

| 文件 | case 数 | 覆盖 |
|---|---|---|
| `packages/shared/tests/rfc062-workflow-edges.test.ts` | 8 | `SYSTEM_PORT_NAMES` / `isFeedbackEdge` / `filterDataEdges` / `filterFeedbackEdges` 正向 + 边界（空 / undefined target / 未知 port） |
| `packages/backend/tests/rfc062-scanner-feedback-edge.test.ts` | 6 | `scanFreshDownstream` 在仅 `__clarify_response__` 上游、仅 `__external_feedback__` 上游、同时含两者、混合反馈+数据上游、纯数据上游、空 edges 各场景下行为正确 |
| `packages/backend/tests/rfc062-launcher-upstream-resolver.test.ts` | 3 | `makeUpstreamInputsResolver` 跳过 feedback 端口；feedback 端口的内容不出现在 UpstreamInput 列表 |
| `packages/backend/tests/rfc062-edges-guard.test.ts` | 1 | grep guard 扫全仓 |
| `packages/backend/tests/rfc062-no-deferred-todo.test.ts` | 1 | "未接通占位" guard |
| `packages/backend/tests/rfc062-daemon-resume-spawns-actors.test.ts` | 3 | `resumeFromDisk` 后非终态任务的 actor 真正在跑（断言任务 events 表有新增） |

合计 **≥ 22 case** PR-A。

### 6.2 PR-B 测试（fixture）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `packages/backend/tests/e2e-snapshots/*.json` | 3 fixture（incident workflow + self-clarify-only + wrapper-loop-with-clarify） | — |
| `packages/backend/tests/rfc062-snapshot-replay.test.ts` | 3（一 fixture 一 case） | 端到端走到 `task-completed`、事件序列断言 |
| `packages/backend/tests/rfc062-scripted-runner-adapter.test.ts` | 5 | ScriptedRunnerAdapter 行为：匹配命中 / 多 iter 匹配 / 未匹配 throw / clarify auto-resolve / review auto-resolve |

合计 **≥ 8 case + 3 fixture** PR-B。

### 6.3 PR-C 测试（stall invariant）

| 文件 | case 数 | 覆盖 |
|---|---|---|
| `packages/backend/tests/rfc062-stall-invariant-s5.test.ts` | 8 | running + stale events → 落 alert；running + 新事件 → 不落；非 running → 不落；阈值 default vs node-timeout 两条策略；diagnostic 包含 stuckNodeId + missingUpstreams |
| `packages/backend/tests/rfc062-stall-invariant-reconcile.test.ts` | 3 | alert open → 后续 scan resolved；promotion 触发 broadcast |
| `packages/backend/tests/rfc062-error-must-alert.test.ts` | 1 | grep guard：所有 log.error 要么有 alert 要么 `// log-only` 注释 |
| `packages/frontend/tests/rfc062-task-header-stall-banner.test.tsx` | 4 | `<TaskHeader>` 接收 S5 alert → 红条出现 + 文案 + i18n cn/en + 点击跳 diagnose 面板 |
| `packages/frontend/tests/rfc062-i18n-cn-en-parity.test.ts` | 1 | `tasks.alert.S5.*` 两语言键完整 |

合计 **≥ 17 case** PR-C。

### 6.4 已有套件零回归

- RFC-061 PR-A baseline（67 backend / 99 shared）/ W-1..W-5 / launcher-e2e / actor property / runner-v2 三件 / ProductionRunnerAdapter
- RFC-053 lifecycle invariants 既有 7+4 rules
- RFC-057 diagnose-repair 既有 99 case
- Playwright e2e
- 全 frontend tests
- single-binary build smoke

每 PR 推完按 `feedback_post_commit_ci_check` 立刻查 GitHub Actions 状态。

---

## 7. 与既有模块耦合点

| 模块 | 耦合点 | 处理 |
|---|---|---|
| `shared/prompt.ts:266` `SYSTEM_PORT_NAMES` 私有 const | 改为 `import { SYSTEM_PORT_NAMES } from './workflow/edges'`，删除局部声明 | PR-A |
| `shared/clarify.ts:353+` `isClarifyChannelEdge` | 已经识别 clarify channel；本 RFC 不动它（语义不同：clarify channel 是 ask/ans 整条边对，本 RFC 的 isFeedbackEdge 只看 target port 是不是反馈口）；交叉测试断言两者对同一 fixture 给出一致判断 | PR-A 加 1 case |
| `scheduler-v2/readyScanner.ts` `scanReadyScopes` | 与 `scanFreshDownstream` 配合；本 RFC 只动后者；前者不变（它扫 logical_runs 状态，不直接迭代 edges） | 不动 |
| `services/fanout.ts` 4 处 edges 迭代 | shard 拓扑天然不走 feedback edge；改 `filterDataEdges` + grep guard | PR-A 顺带 |
| `services/workflow.validator.ts:97` | validator 应同时检查两类边的端口存在性，但 cycle 检查只对 dataEdges 做（feedback 边天然是反向边）；增 `validateDataAcyclic` + `validateFeedbackEdgesHaveSources` 两函数 | PR-A 顺带（可独立小 commit） |
| `services/task.ts:664` snapshot edges 用于 input 解析 | audit；若仅用于"找 input 端口的数据来源"应走 dataEdges | PR-A audit + 改 |
| `services/lifecycleInvariants.ts` | 加 S5 + 调用链 | PR-C |
| `scheduler-v2/daemonResume.ts` Step 4 | 真正 spawn actor loops | PR-A（"占位 guard" 修复存量违例） |
| `services/task.ts` `kickActorPath` / `launchTaskActor` | daemonResume 复用此入口 | PR-A 拆出 `launchTaskActor` 公共 helper |
| 前端 `useTaskWs` / `<TaskHeader>` | 已经处理 `lifecycle.alert`；只需新增 S5 文案 + 视觉 | PR-C |
| 前端 `TaskDiagnosePanel`（RFC-057） | S5 alert 自动出现；本 RFC 不加 repair option（v2 范围） | 不动 |

---

## 8. 5 条不变量（INV）— 本 RFC 新增

继 RFC-061 的 INV-1..INV-5 之后：

- **INV-6**（契约层）：scheduler 路径上任何 `workflow.edges` 迭代都过 `filterDataEdges` 或 `filterFeedbackEdges`；grep guard 守门。
- **INV-7**（fixture 完整性）：`e2e-snapshots/*.json` 每个都能在 `rfc062-snapshot-replay.test.ts` 走到 `task-completed` 或显式 `expectedTerminalKind: 'task-failed'`；任何停在中间状态的 fixture = test fail。
- **INV-8**（stall 可见性）：`tasks.status='running'` 且最新事件 > thresholdMs 的所有 task 一律有 `lifecycle_alerts.rule='S5'` open 行；`runLifecycleInvariants` 一次 scan 后差集必须为空。
- **INV-9**（log↔alert 显式性）：`packages/backend/src/**/*.ts` 中 `log.error(...)` 调用必须或有 alert 路径或带 `// log-only: <reason>` 注释；grep guard 守门。
- **INV-10**（"无未接通占位"）：源码 + 注释禁止出现 §2.5 FORBIDDEN_PHRASES 列表中字符串；grep guard 守门。

---

## 9. PR 边界 + 风险

| PR | 范围 | 风险 |
|---|---|---|
| **PR-A** 契约层 + scanner 修复 + daemonResume Step 4 + 立即解锁 | shared/workflow/edges.ts + 3 scheduler 消费点 + daemonResume + 6 grep guard + ≥22 case | **低**：定义性 bug 修复 + 加 helper；行为偏差只发生在含 feedback edge 的 workflow 上、之前都死锁、修后只可能更对 |
| **PR-B** 真实 e2e fixture | 3 fixture + ScriptedRunnerAdapter + replay test | **中**：fixture 设计如不合理（mock 输出对不上 envelope schema）会写一堆假绿；缓解：fixture 故意复用 incident workflow，第一次跑能复现 + 反着证明 PR-A 修对了 |
| **PR-C** stall invariant + UI alert + log-must-alert guard | lifecycleInvariants S5 + i18n + `<TaskHeader>` 文案 + grep guard + ≥17 case | **低-中**：S5 检测逻辑独立；UI 改动小；唯一风险是 `log-must-alert` guard 在存量代码上炸出大批违例 → 用首次扫描结果做白名单，违例逐一在本 PR 修或显式 `// log-only` 注释 |

每 PR 独立 CI 全绿 + 独立 commit + 独立 push + 立刻按 `feedback_post_commit_ci_check` 查 CI 状态。
