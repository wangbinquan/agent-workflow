# RFC-026 Design — Clarify inline-session 技术设计

> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)、基线 [RFC-023 design.md](../RFC-023-agent-clarify/design.md)

## 1. 改动地图

| 文件 | 改动类型 | 摘要 |
| --- | --- | --- |
| `packages/shared/src/schemas/workflow.ts` | edit | `ClarifyNodeSchema` 加 optional `sessionMode: z.enum(['isolated','inline']).optional()`（undefined = isolated）。WORKFLOW_SCHEMA_VERSION 不变（v3 继续）。 |
| `packages/shared/src/clarify.ts` | edit (minimal) | 新增 helper `resolveClarifySessionMode(node): 'isolated'\|'inline'`（undefined → 'isolated'），统一 callsite 行为。 |
| `packages/shared/src/prompt.ts` | edit | `ClarifyPromptContext` 新增可选 `mode?: 'isolated'\|'inline'`（runner 决定走哪条分支用）+ `currentRoundOnly?: boolean`（inline 时 true，questionsBlock/answersBlock 仅含本轮）。`renderUserPrompt` 在 `mode==='inline'` 时只 emit `## Clarify Q&A — User Answers` + tail reminder，**不**追加 Last-Round Questions section。 |
| `packages/backend/src/db/schema.ts` | edit | `node_runs` 加 `opencode_session_id TEXT`（nullable，default NULL）。 |
| `packages/backend/db/migrations/0008_*.sql` | new | 单纯 `ALTER TABLE node_runs ADD COLUMN opencode_session_id TEXT;`（drizzle-kit generate 产物）。 |
| `packages/backend/src/services/runner.ts` | edit | (a) `RunNodeOptions` 加 `resumeSessionId?: string`；(b) `buildCommand` 在 resumeSessionId 非空时追加 `'--session', resumeSessionId`；(c) `RunResult.sessionId` 已存在，把它持久化到 node_runs 的工作放到 scheduler / clarify service 侧调用点统一做（runner 不直接写 DB）。 |
| `packages/backend/src/services/scheduler.ts` | edit | (a) clarify 触发 agent 重跑路径（既有 `triggerAgentRerunFromClarify` → 新 node_run pending → scheduler 调度）调用 runner 前查 clarify 节点 sessionMode + source agent node_run.opencode_session_id；inline 路径填 `resumeSessionId` 并 build inline-mode `ClarifyPromptContext`（currentRoundOnly=true、mode='inline'）。(b) review reject/iterate / retry / loop 路径**显式不传** resumeSessionId（默认 undefined）。(c) 接到 RunResult.sessionId 后持久化到 node_runs.opencode_session_id。 |
| `packages/backend/src/services/clarify.ts` | edit | `buildClarifyPromptContext` 加可选 `mode` 参数。inline 模式只查最新一轮 answered session（不拼历史），并标记 `currentRoundOnly=true`。 |
| `packages/backend/src/services/clarifyFallback.ts` | new | 纯函数 + 副作用极小的兜底判定：`decideResumeSessionId(opts)` 返回 `{ resumeSessionId?: string; fallbackReason?: 'missing-session-id' \| 'session-not-found' \| 'unsupported-opencode-version' }`；scheduler / runner 集中调用。session-not-found 检测放在 runner 退出后扫 stderr 的 helper 里（`detectSessionNotFoundFromStderr(stderr): boolean`）。 |
| `packages/backend/src/services/events.ts`（既有节点事件流写入点） | edit (small) | 写入 `clarify.eventStream.sessionResumed` info 行 + `inline-clarify-fallback-to-isolated` warning 行（沿用既有 node_run_events 写入 helper） |
| `packages/frontend/src/components/canvas/NodeInspector.tsx` | edit | clarify 分支新增 segmented `sessionMode` 选择器 + 帮助文字。 |
| `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts` | edit | 新增约 6 条 key（见 §9）。 |
| `packages/frontend/src/routes/tasks.$taskId.tsx`（或既有节点运行 tab 渲染处） | edit (small) | 节点行 chip 渲染 + 事件流行 info/warning 样式 |
| `STATE.md` | edit | 顶部"进行中 RFC"加 RFC-026 + 完工挪到"已完成 RFC"表 |
| `design/plan.md` | edit | RFC 索引追加 RFC-026 |

明示不动：

- `packages/backend/src/services/review.ts`：零行不动。review 路径不知道 inline 模式存在。
- `packages/backend/src/db/migrations/0007_*.sql`：不动（本 RFC 新加 0008，绝不修改 0007）。
- 既有 RFC-023 落地的 clarify_sessions 表 schema 不动；clarify service `createClarifySession` / `submitClarifyAnswers` 主体不动（只在 buildClarifyPromptContext 加可选参数）。
- isolated 路径的 `buildClarifyProtocolBlock()` / `renderUserPrompt` 既有分支零接触——inline 是新增并列 if 分支。

## 2. Schema 扩展

### 2.1 ClarifyNode 字段（v3 兼容，不 bump v4）

```ts
// packages/shared/src/schemas/workflow.ts
export const ClarifyNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('clarify'),
    position: XYSchema.optional(),
    title: z.string().default(''),
    description: z.string().default(''),
    assignee: z.string().optional(),

    // NEW (RFC-026)
    sessionMode: z.enum(['isolated', 'inline']).optional(),
  })
  .passthrough()
```

向后兼容：

- 旧 v3 workflow JSON 不含 `sessionMode` → zod parse 后字段 undefined → `resolveClarifySessionMode` 返回 `'isolated'` → 行为完全等价于 RFC-023 落地版本。
- 显式写 `"sessionMode":"isolated"` 与 undefined 同义。
- YAML 导入导出：字段未指定时不 emit；显式时按字面值 emit。

### 2.2 shared helper

```ts
// packages/shared/src/clarify.ts
export function resolveClarifySessionMode(node: ClarifyNode): 'isolated' | 'inline' {
  return node.sessionMode ?? 'isolated'
}
```

### 2.3 ClarifyPromptContext 扩展

```ts
// packages/shared/src/prompt.ts
export interface ClarifyPromptContext {
  questionsBlock?: string
  answersBlock?: string
  iteration?: string
  remaining?: string
  directive?: 'continue' | 'stop'

  // NEW (RFC-026)
  /** Which mode emitted this context. Defaults to 'isolated' if missing. */
  mode?: 'isolated' | 'inline'
  /**
   * When true, questionsBlock/answersBlock represent ONLY the current round
   * (no concatenation of prior rounds). Always true under inline mode.
   * When false / undefined and mode='isolated', the blocks contain the
   * full multi-round concatenation (RFC-023 b5296c0 behavior).
   */
  currentRoundOnly?: boolean
}
```

### 2.4 renderUserPrompt 分支

```ts
// pseudo
if (cc !== undefined) {
  const inline = cc.mode === 'inline'
  // questions block:
  if (!inline && cc.questionsBlock?.trim() && !referenced.has('__clarify_questions__')) {
    sections += `\n\n## Clarify Q&A — Last-Round Questions\n${cc.questionsBlock}`
  }
  // answers block: ALWAYS emit (isolated full history vs inline current-only)
  if (cc.answersBlock?.trim() && !referenced.has('__clarify_answers__')) {
    sections += `\n\n## Clarify Q&A — User Answers\n${cc.answersBlock}`
  }
}
```

末尾"协议提醒"：

- isolated 路径：保留 `buildClarifyProtocolBlock()` 完整块（与 RFC-023 一致）。
- inline 路径：runner 改追加精简提醒（单行）；详见 §4。

## 3. DB schema

### 3.1 node_runs 加列

```ts
export const nodeRuns = sqliteTable('node_runs', {
  // ... existing fields ...
  opencodeSessionId: text('opencode_session_id'), // NEW (RFC-026), nullable
})
```

### 3.2 Migration 0008

```sql
-- packages/backend/db/migrations/0008_*.sql
ALTER TABLE node_runs ADD COLUMN opencode_session_id TEXT;
```

SQLite `ADD COLUMN` 原子、O(1)，已存量行字段 NULL，无回滚风险（drizzle 默认 down 即 `DROP COLUMN`，SQLite 自 3.35 支持）。

### 3.3 索引策略

不加单独索引：

- 主要查询路径是"给定 nodeRunId 查 sessionId"，走 PK index 已足够。
- 列稀疏（大部分行 NULL），加索引反而占空间。
- 未来若加 task-detail debug "列出某 task 内所有 sessionId" 等查询再补 covering index。

## 4. Runner 改造

### 4.1 RunNodeOptions 加 resumeSessionId

```ts
export interface RunNodeOptions {
  // ... existing ...
  /**
   * RFC-026: when set (only ever non-empty for clarify-inline-mode reruns),
   * runner appends `--session <id>` to the opencode command line. opencode
   * loads the prior session's full history; user prompt becomes a small
   * incremental message ("user answered ..."). Scheduler decides when to
   * populate; review/retry/loop paths never set this.
   */
  resumeSessionId?: string
}
```

### 4.2 buildCommand 分支

```ts
// runner.ts:534
function buildCommand(opts: RunNodeOptions, prompt: string): string[] {
  const head = opts.opencodeCmd ?? ['opencode']
  const cmd = [...head, 'run', prompt, '--agent', opts.agent.name, '--format', 'json']
  if (opts.dangerouslySkipPermissions ?? true) cmd.push('--dangerously-skip-permissions')
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    cmd.push('--session', opts.resumeSessionId)
  }
  return cmd
}
```

放在 `--dangerously-skip-permissions` 之后；与现有 args 顺序无依赖（yargs 不要求顺序）。

### 4.3 inline 模式 protocol block 调整

runner 既有逻辑（line 207）：

```ts
opts.hasClarifyChannel === true ? renderedPrompt + buildClarifyProtocolBlock() : renderedPrompt
```

inline 模式下 `buildClarifyProtocolBlock()` 内容已在 session 历史里，不需要再注。调整：

```ts
function appendProtocol(prompt: string, opts: RunNodeOptions): string {
  if (opts.hasClarifyChannel !== true) return prompt
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    // inline mode: short reminder only
    return prompt + buildClarifyInlineReminder()
  }
  return prompt + buildClarifyProtocolBlock()
}
```

新增 shared 函数：

```ts
// packages/shared/src/prompt.ts
export function buildClarifyInlineReminder(): string {
  return `\n\n---\n用户已对你的上一轮反问做出选择，本轮请直接产出 \`<workflow-output>\` 或继续 \`<workflow-clarify>\`（如仍有阻塞）；二者择一。`
}
```

英文 mirror（agent prompt 文本本就是中英混杂的——既有 protocol block 是英文，这条提醒采用中文与既有 builtin tokens 注释风格一致；如未来要切英文按 RFC-025 i18n 套路单独 RFC）。

### 4.4 stderr 检测

```ts
// packages/backend/src/services/clarifyFallback.ts
const SESSION_NOT_FOUND_PATTERNS = [
  /session not found/i,
  /session.*does not exist/i,
  /unknown session id/i,
]
export function detectSessionNotFoundFromStderr(stderr: string): boolean {
  return SESSION_NOT_FOUND_PATTERNS.some((re) => re.test(stderr))
}
```

runner 在 spawn 退出后已经收集 stderr（既有路径）；调用方（scheduler clarify 路径）拿 RunResult + stderr buffer 调用该检测函数。若命中且本轮带了 resumeSessionId → 标 fallbackReason='session-not-found' + 触发 retry 走 isolated。

## 5. Scheduler 改造

### 5.1 dispatch 路径

既有 clarify 触发重跑路径（scheduler.ts 端的 `triggerAgentRerunFromClarify` 后的下一次调度）汇集点：

```ts
// 伪代码（在调用 runner.runNode 前）

const clarifyNode = findClarifyNodeForAgentNode(definition, nodeRun.nodeId)
const sessionMode = clarifyNode
  ? resolveClarifySessionMode(clarifyNode)
  : 'isolated'

// 仅 clarify 触发的重跑路径（nodeRun.clarifyIteration > prevSource.clarifyIteration
// 且 trigger=submitClarifyAnswers）走 inline；review reject / retry / loop 路径
// 永远 isolated。
const isClarifyRerun = nodeRun.clarifyIteration > 0
  && nodeRun.retryIndex === 0
  && rerunTrigger === 'clarify'

let resumeSessionId: string | undefined
let inlineMode = false
let fallbackReason: string | undefined

if (sessionMode === 'inline' && isClarifyRerun) {
  // find source agent node_run = the one that produced the clarify envelope
  const source = await db.findSourceAgentNodeRun(nodeRun)
  if (source?.opencodeSessionId) {
    resumeSessionId = source.opencodeSessionId
    inlineMode = true
  } else {
    fallbackReason = 'missing-session-id'
  }
}

const clarifyContext = hasClarifyChannel
  ? await clarifyService.buildClarifyPromptContext({
      taskId, agentNodeId: nodeRun.nodeId, targetIteration: nodeRun.clarifyIteration,
      mode: inlineMode ? 'inline' : 'isolated',
    })
  : undefined

if (fallbackReason) {
  await eventsService.recordNodeRunEvent(nodeRun.id, {
    level: 'warning',
    code: 'inline-clarify-fallback-to-isolated',
    detail: fallbackReason,
  })
}

const result = await runner.runNode({
  // ... existing ...
  clarifyContext,
  hasClarifyChannel: effectiveHasClarifyChannel,
  resumeSessionId,
})

// Persist sessionId for next rerun lookup
if (result.sessionId) {
  await db.updateNodeRun(nodeRun.id, { opencodeSessionId: result.sessionId })
}

// session-not-found detection
if (resumeSessionId && detectSessionNotFoundFromStderr(result.stderr ?? '')) {
  await eventsService.recordNodeRunEvent(nodeRun.id, {
    level: 'warning',
    code: 'inline-clarify-fallback-to-isolated',
    detail: 'session-not-found',
  })
  // mark this node_run failed; existing retry path will retry with isolated
  // (next retry doesn't set resumeSessionId because clarifyIteration didn't change
  // but retryIndex did → branch above's `isClarifyRerun` requires retryIndex===0)
}

if (inlineMode && resumeSessionId && !fallbackReason) {
  await eventsService.recordNodeRunEvent(nodeRun.id, {
    level: 'info',
    code: 'clarify-session-resumed',
    detail: `sessionId=${resumeSessionId.slice(0, 8)} clarify_iteration=${nodeRun.clarifyIteration}`,
  })
}
```

### 5.2 review / retry 路径守卫

review reject/iterate 路径走 `services/review.ts` 的 sibling cascade → 触发 agent 重跑——这条路径**不**经过本 RFC 加的 inline 判定（条件 `isClarifyRerun` 不满足，因为 trigger 不是 clarify 而是 review）。同理：

- 技术 retry（retry_index > 0）：`isClarifyRerun` 要求 retryIndex===0，故 retry 永不 inline。
- wrapper-loop 跨 iter：每次 iter 是新 node_run（loop 维度），但 `clarifyIteration` 也从 0 起算（loop 是新一轮"开始"）；故跨 iter 不满足 `clarifyIteration > 0` 不走 inline。loop **内**的反问续接（同 node_run lineage 内 clarifyIteration 递增）继续按 inline 走，自洽。

### 5.3 agent-multi fan-out 路径

scheduler.ts 既有 fanout 调度处（line 1136-1200 范围）同样需要把 resumeSessionId 透传——shard 子 node_run 各有独立 opencode_session_id，inline 续接是 shard 局部决定。修改点：fanout 子调度调用 runner 前查"本 shard 子 node_run 的 source（即上一轮该 shard 的 clarify envelope 来源）"的 opencode_session_id，与 single-agent 路径同套逻辑。

## 6. clarify service 改造

`buildClarifyPromptContext` 扩展：

```ts
export interface BuildClarifyPromptContextOptions {
  taskId: string
  agentNodeId: string
  targetIteration: number
  mode?: 'isolated' | 'inline' // NEW
  shardKey?: string | null
}

async function buildClarifyPromptContext(opts): Promise<ClarifyPromptContext | undefined> {
  const sessions = await findClarifySessionsForAgent({
    taskId: opts.taskId,
    sourceAgentNodeId: opts.agentNodeId,
    shardKey: opts.shardKey ?? null,
    answeredOnly: true,
    // isolated → all up to targetIteration; inline → only most recent answered
    limit: opts.mode === 'inline' ? 1 : undefined,
    iterationLessThan: opts.targetIteration,
    orderBy: 'iterationIndex DESC',
  })
  if (sessions.length === 0) return undefined

  const useSessions = opts.mode === 'inline' ? sessions.slice(0, 1) : sessions.reverse()
  return {
    mode: opts.mode ?? 'isolated',
    currentRoundOnly: opts.mode === 'inline',
    questionsBlock: renderQuestionsBlocks(useSessions),
    answersBlock: renderAnswersBlocks(useSessions),
    iteration: String(opts.targetIteration),
    remaining: computeRemaining(...),
    directive: useSessions[useSessions.length - 1].directive,
  }
}
```

isolated 路径行为不变（继续取所有历史轮拼接）；inline 取最近一轮。

## 7. Edge cases & 死结点

| 情形 | 处理 |
| --- | --- |
| inline + 用户首次反问（clarify_iteration=0 → 1） | source agent node_run 是第一轮（带 sessionId），下一轮带 `--session`、prompt 只含答案。即所谓 "first rerun" 走 inline。 |
| inline + sessionId 抓取失败（opencode 没吐 event） | scheduler fallbackReason='missing-session-id' → 本轮走 isolated（拼全量 + 完整协议块） + warning。 |
| inline + opencode 报 session not found | runner 退出后 stderr 检测命中 → 本 node_run failed + warning 'session-not-found' → 既有 retry 路径接管，retry_index+1 重跑（retry 不走 inline，自然 isolated）。 |
| inline + agent-multi shard 内反问 | shard 子 node_run 各自独立 sessionId，inline 沿 shard 链路续接（design.md §5.3）。 |
| inline + wrapper-loop 内反问 | 同 loop iteration 内反问续 session；跨 iteration 不续（每次 iter 新 node_run、clarifyIteration 重置 0、不满足 `isClarifyRerun`）。 |
| inline + 用户中途把 sessionMode 改回 isolated | 编辑器改 → workflow PUT；task 重启后下次反问按新 mode；task 跑到一半时只对未来的反问生效（已发出 clarify_session 仍按当时的 mode 决定走哪条路径）。 |
| inline + clarify 节点上接 agent-multi（fanout 时 multi 父级没 sessionId） | 父级 multi 本身不直接调 opencode（shard 子才调）；source 一定是 shard 子 node_run，按 shard 子 sessionId 续。 |
| inline + agent 在反问回合里同时改了 worktree 文件 | RFC-023 协议规定"反问 = 放弃本轮输出"——agent 不应改文件。即便它改了，inline 续接的 session 会把这部分工具调用记录留在历史里，与 isolated 模式（rollback to pre_snapshot）行为差异由 agent 协议层兜底；inline 模式跳过 worktree rollback（详见 §8）。 |

## 8. worktree pre_snapshot 处理

RFC-023 design §5.4 step 2：clarify 触发重跑前 `worktree.restoreSnapshot(pre_snapshot)`。inline 模式下：

- agent 协议明确"反问 = 放弃输出"——agent 不应该写文件；isolated 路径仍 restore 是保险措施。
- inline 路径下 agent 的"session 视角"和 worktree 文件系统状态必须保持一致——如果 rollback 导致 session 历史里 agent "记得自己创建过 file X" 但 worktree 没了，agent 会困惑。
- 安全选择：inline 模式**跳过** restoreSnapshot；isolated 模式保持 RFC-023 行为。
- 配合 §6 协议提醒里加一行（可选）："你 worktree 中文件保持你上一轮结束时的状态。"

```ts
if (!inlineMode) {
  await worktree.restoreSnapshot(source.preSnapshot)
}
```

## 9. i18n

新增 key（zh-CN + en-US 同步）：

```
clarify.inspector.sessionMode.title       — "反问 Session 模式"
clarify.inspector.sessionMode.isolated    — "独立 session（默认）"
clarify.inspector.sessionMode.inline      — "同 session 内反问"
clarify.inspector.sessionMode.hint        — "选「同 session」时 agent 保留前几轮上下文、省 token + 响应更快；session 失效时自动回退到独立模式。"
clarify.eventStream.sessionResumed        — "已复用 opencode session {{prefix}}（第 {{n}} 轮反问）"
clarify.eventStream.fallbackToIsolated    — "本轮 inline session 不可用（原因：{{reason}}），自动回退为独立 session"
clarify.node.chip.inline                  — "session=inline"
```

## 10. 测试矩阵

| 模块 | 文件 | case 数 |
| --- | --- | --- |
| shared schemas | `tests/clarify-schema-session-mode.test.ts` | 3（undefined default isolated + 显式 isolated + 显式 inline；序列化 round-trip） |
| shared prompt | `tests/clarify-prompt-inline.test.ts` | 4（inline 不 emit Last-Round Questions + inline 仅本轮 answers + isolated 行为零差异 + inline reminder 末尾追加） |
| runner buildCommand | `tests/runner-resume-session-flag.test.ts` | 2（resumeSessionId 非空 → 命令行含 --session + 空 → 不含 --session） |
| clarifyFallback | `tests/clarify-fallback.test.ts` | 3（detectSessionNotFoundFromStderr 三种 pattern 命中 + 空字符串 false） |
| migration 0008 | `tests/migration-0008.test.ts` | 1（已有 0007 schema → 0008 后 node_runs 多一列 + 旧行 NULL + drizzle reflect 一致） |
| clarify service | `tests/clarify-service-inline-context.test.ts` | 2（mode='inline' → 仅最新一轮；mode='isolated' / undefined → 全部历史拼接） |
| scheduler | `tests/scheduler-clarify-inline.test.ts` | 6（sessionMode=inline + 首次反问续 session + sessionId 缺失自动回退 + session-not-found 后 retry 走 isolated + agent-multi shard 续 + loop 跨 iter 不续 + review reject 不走 inline） |
| 节点 events | `tests/scheduler-clarify-inline-events.test.ts` | 2（成功 resume 写 info 行 + 回退写 warning 行） |
| frontend Inspector | `tests/node-inspector-clarify-session-mode.test.tsx` | 2（segmented 渲染 + 切换触发 PUT） |
| frontend chip | `tests/node-stats-session-chip.test.tsx` | 1 |
| 回归防护 | `tests/clarify-inline-isolated-parity.test.ts` + `tests/clarify-inline-spawn-args.test.ts` + `tests/clarify-inline-fallback.test.ts` + `tests/review-reject-not-inline.test.ts` + `tests/clarify-inline-loop-isolation.test.ts` | 5 spec files |
| e2e | `e2e/clarify.spec.ts` 扩展 | 1 子 case |

合计 backend +20、frontend +5、e2e +1。proposal §4 B3/B4 上限 +14/+6——本设计实际拆得更细，仍在数量级内（多出的 case 集中在 fallback / loop / shard 等边角守卫）。

## 11. 性能 & 风险

| 项 | 风险 | 缓解 |
| --- | --- | --- |
| opencode `--session` 加载老 session 时阻塞 | 低 | opencode 自己有 session 大小管理；超大 session 时直接报错 → 兜底 fallback |
| stderr 检测 false positive（其他错误消息含 "session"） | 极低 | regex 限定 `not found` / `does not exist` / `unknown session id`；多 pattern 守护 |
| node_runs 加列影响热路径写入 | 极低 | 单列追加、SQLite ALTER 即时；写入路径仅 scheduler 1 次 UPDATE |
| inline 模式下 framework synthesis 与 session 内 agent 自记忆冗余 | 极低 | synthesis 是确定性纯函数 1 行/题；冗余成本 < 200 bytes/轮 |
| migration 0008 与 RFC-024 / 其他在飞 RFC 编号冲突 | 中 | RFC-024 / RFC-025 已 Done（不引 migration）；本 RFC 占 0008 |

## 12. 与 design.md（项目主设计）的同步点

完工时改 `design/design.md`：

- §3 数据模型：`node_runs` 表加 `opencode_session_id` 列描述。
- §7.4 envelope：在 RFC-023 段落后追加一段说明 inline 模式下 opencode session resume 的工作方式（一句话指向 RFC-026 即可）。
- §9 节点状态机：不动（状态机本身没变化）。
- §11 配置：不引入新 settings 字段。

## 13. 与 RFC-005/007/014/023 的代码隔离审计

| 文件 | 本 RFC 改动行数（粗估） | 既有 RFC 路径是否变化 |
| --- | --- | --- |
| `services/review.ts` | 0 | 否 |
| `services/runner.ts` | +20（resumeSessionId option + buildCommand 1 行 + protocol block 分支 helper） | 否（既有 hasClarifyChannel/clarifyContext 路径作为 isolated 分支保留） |
| `services/scheduler.ts` | +60（inline 判定 + sessionId persist + events 写入 + fallback） | 否（既有 clarify dispatch / fanout dispatch 增加分支，不动 review/retry/loop 既有判定） |
| `services/clarify.ts` | +15（buildClarifyPromptContext 加 mode 参数 + 内部 limit） | 否（默认参数兼容） |
| `services/clarifyFallback.ts` | +50（new file） | n/a |
| `db/schema.ts` | +1 | 否 |
| `prompt.ts` | +20（mode/currentRoundOnly 字段 + renderUserPrompt 分支 + buildClarifyInlineReminder） | 否（既有 emit 路径作为 mode!=='inline' 分支保留） |
| `NodeInspector.tsx` | +30（segmented + hint） | 否 |
| `i18n/{zh-CN,en-US}.ts` | +14 lines | 否 |

CI grep 守卫（C2/C4）：

```
grep -c "resumeSessionId" packages/backend/src/services/review.ts
# expected 0
grep -c "--session" packages/backend/src/services/scheduler.ts
# expected 0 (only runner constructs the command line)
grep -c "resumeSessionId" packages/backend/src/services/runner.ts
# expected ≥ 1
```
