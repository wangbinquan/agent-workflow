# RFC-027 — 技术设计

> 配套文件：[proposal.md](./proposal.md) / [plan.md](./plan.md)

## 1. 总览

```
┌────────────────────────────────────────────────────────────────────┐
│  opencode run --format json                                        │
│                                                                    │
│   ├─ stdout (NDJSON) ─► runner.ts (现有)  ─► node_run_events       │
│   │                                          (session_id 落库)     │
│   │                                                                │
│   └─ child.exited ──► sessionCapture.ts                            │
│                          (后置读 opencode SQLite                   │
│                           ~/.local/share/opencode/opencode.db      │
│                           或 macOS Application Support 等价路径)   │
│                          BFS session.parent_id 树                  │
│                          → 把每个子 session 的 message + part 行   │
│                            transcode 成 normalized event           │
│                          → INSERT 进 node_run_events               │
│                            (session_id, parent_session_id 填好)    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        GET /api/tasks/:taskId/node-runs/:nodeRunId/session
        ─► services/sessionView.ts: parseSessionTree(events)
        ─► JSON: { root: SessionNode }，SessionNode 包含 messages[] 与
                   subagents[]（recursive）
                              │
                              ▼
        NodeDetailDrawer 第 1 个 tab: <SessionTab />
        ─► <ConversationFlow tree={root}/>
              ├─ <UserMessageBlock/>
              ├─ <AssistantTextBlock/>
              ├─ <ToolCallBlock/>
              ├─ <SubagentBlock>  (折叠 / 递归)
              │     └─ <ConversationFlow tree={child}/>
              └─ ...
```

## 2. shared 层（packages/shared）

### 2.1 normalized 会话树类型（新文件 `src/sessionView.ts`）

```ts
/** 一次发给 opencode 的 user prompt（来自 node_runs.prompt_text）。 */
export interface SessionUserMessage {
  kind: 'user'
  text: string
  ts: number /* node_run.startedAt */
}

/** 一段 assistant 输出的纯文本（来自 message.part.updated, part.type==='text'）。 */
export interface SessionAssistantText {
  kind: 'assistant-text'
  text: string
  ts: number
  /** opencode messageID，便于去重 / 排序兜底。 */
  messageId: string | null
}

/**
 * 一次 tool 调用（来自 message.part.updated, part.type==='tool'）。
 * 同一个 callID 在多次 state 变化中只保留最终 part（status===completed/error）。
 */
export interface SessionToolCall {
  kind: 'tool-call'
  toolName: string
  callId: string
  status: 'pending' | 'running' | 'completed' | 'error'
  input: unknown /* tool 调用参数 */
  output: string | null /* 完成后 part.state.output；error 时含错误文本 */
  ts: number
  messageId: string | null
}

/**
 * 一次 task 工具调用 = 嵌套子 session 入口。承担两职：
 *  1) 作为 SessionToolCall 出现在父 session 时间线
 *  2) 关联到一棵 child SessionTree（按子 sessionID 索引）
 */
export interface SessionSubagentCall extends Omit<SessionToolCall, 'kind'> {
  kind: 'subagent-call'
  /** 子 sessionID（从 part.metadata.sessionID 抽取，可能为 null —— 子 session 未创建 / 捕获失败）。 */
  childSessionId: string | null
  /** 子 agent 显示名；优先从子 session 的第一条 message.agent 拿，兜底显示 'subagent'。 */
  childAgentName: string | null
  /** 嵌套子树；childSessionId 为 null 时此处为 null。 */
  child: SessionTree | null
  /** AC-10 兜底：当 child === null 但父收到了 task 完成回执时，把父侧的 output 文本透传出来。 */
  childOutputFallback: string | null
}

export type SessionMessage =
  | SessionUserMessage
  | SessionAssistantText
  | SessionToolCall
  | SessionSubagentCall

export interface SessionTree {
  sessionId: string
  /** 父 session 树。根 session 此处为 null。 */
  parentSessionId: string | null
  /** 真实展示用的 agent name；根为本 node_run 的 primary agent，子为该子 session 的 agent。 */
  agentName: string | null
  messages: SessionMessage[]
  /** 子 session 事件捕获是否完整（false → UI 展示「事件未捕获」提示）。 */
  captureComplete: boolean
}
```

### 2.2 纯函数 `parseSessionTree`

```ts
export function parseSessionTree(input: {
  rootSessionId: string | null /* runner 抽到的父 sessionID；null = 还没拿到 */
  promptText: string | null /* node_runs.prompt_text */
  startedAt: number | null
  primaryAgentName: string
  events: Array<{
    id: number
    ts: number
    kind: NodeRunEventKind
    sessionId: string | null
    parentSessionId: string | null
    payload: string /* raw JSON line */
  }>
}): SessionTree
```

实现要点（**纯函数、零 I/O**，便于单测覆盖所有分支）：

1. **按 sessionId 分桶**。无 sessionId 的事件（如 stderr / capture-failed marker）挂到 root。
2. **每桶内按 (ts, id) 升序**。`id` 是 INTEGER PRIMARY KEY AUTOINCREMENT，纯粹用作 stable tiebreaker。
3. **逐事件折叠**：
   - `text` 事件且 `part.type === 'text'` 且 `part.time?.end` 存在 → 追加 `SessionAssistantText`（同一 messageId 的多个 text part 拼接成一条；以 `part.time.end` 最新者为准）。
   - `tool_use` 事件 → 用 `part.callID` 维护一张表；同一 callID 的多次更新原地覆盖；遇到 `part.tool === 'task'` 时升级为 `SessionSubagentCall`，从 `part.metadata.sessionID` / `metadata.sessionId` 抽 `childSessionId`，把 `part.state.output`（成功时即子 session 最终回复）落到 `childOutputFallback`。
   - `step_finish` / `step_start` / `reasoning` / `permission_asked` / `error` / `stderr`：v1 **不渲染为对话块**，但保留它们用来辅助决定 captureComplete（譬如发现 `subagent-capture-failed` marker → `captureComplete = false`）。
4. **构建 SubagentCall.child**：对每个 subagent call，递归调用 `parseSessionTree` 在剩余事件桶里跑一遍；返回的 SessionTree 挂到 `child` 字段。
5. **prompt 注入**：在根 SessionTree 的 messages 数组前 unshift 一条 `SessionUserMessage`（text = promptText 或空字符串；ts = startedAt 或最小事件 ts）。子 session 无 promptText（opencode 没暴露 user prompt 给外部进程），子 session 的 user prompt 跳过。
6. **captureComplete 判定**：根 session 永远 true（父 stdout 一定捕到）。子 session 当且仅当其 sessionId 桶**非空且不含** `subagent-capture-failed` marker 时为 true。

### 2.3 zod schema

`src/schemas/sessionView.ts` 给上述类型补一份 `SessionTreeSchema`（用 `z.lazy` 处理递归），供 backend route 校验与 frontend client 解析共享。

## 3. backend

### 3.1 DB migration（新增 `0010_rfc027_node_run_events_session.sql`）

```sql
ALTER TABLE node_run_events ADD COLUMN session_id TEXT;
ALTER TABLE node_run_events ADD COLUMN parent_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_session
  ON node_run_events(node_run_id, session_id, id);
```

- 两列均 nullable，**老行（RFC-023 / 026 之前的 events）保持 NULL**；shared parser 见到 NULL 时把事件归到 root 桶，行为与今天一致。
- 同步把 `db/schema.ts` 的 `nodeRunEvents` 表 drizzle 定义加 `sessionId` / `parentSessionId` 两列与 `sessionIdx`。
- _journal.json / `meta/0010_snapshot.json` 走 `bun run db:generate` 自动产出；需小心 RFC-026 并发 in-flight 的 journal 链，按照 [feedback_drizzle_journal_chain] 风格手动校正（与 RFC-024 修复 0007 snapshot 链同模式）。

### 3.2 子 session 事件捕获 —— 后置读 opencode SQLite（新文件 `services/sessionCapture.ts`）

> **背景**：opencode 1.15.0 的 `run` 子命令**不开 TCP 端口**。`packages/opencode/src/cli/cmd/run.ts:806/838` 用 `Server.Default().app.fetch(request)` 走进程内 fetch；`runtime.ts:7` 注释明示 "local in-process mode (no server)"。因此外部进程无法通过 HTTP/SSE 实时订阅子 session 事件。

> **解决路径**：opencode 把所有 session / message / part 数据持久化进单机 SQLite（`packages/opencode/src/storage/db.ts:33` → `Global.Path.data/opencode.db`，其中 `Global.Path.data` 走 `xdg-basedir` → Linux `~/.local/share/opencode/opencode.db`，macOS `~/Library/Application Support/opencode/opencode.db`；`OPENCODE_TEST_HOME` 可覆盖 home）。`session` 表有 `parent_id` 索引 `session_parent_idx`（packages/opencode/src/session/session.sql.ts:57），`message` / `part` 各自带 `session_id` 索引。**runner 在 child.exited 之后、清理 runDir 之前**，以**只读**模式打开该 SQLite，按根 sessionID 递归 BFS 拉出整棵子 session 树，把每行 message / part transcode 成本框架的 normalized event 后批量 INSERT 进 `node_run_events`。

捕获流程（伪代码，放在 `services/sessionCapture.ts`）：

```ts
export async function captureChildSessions(opts: {
  rootSessionId: string
  nodeRunId: string
  db: DbClient
  log: Logger
  /** 默认 = 计算后的 opencode SQLite 路径；测试 / OPENCODE_TEST_HOME 可覆盖。 */
  opencodeDbPath?: string
}): Promise<{ capturedSessionIds: string[]; failed: boolean }> {
  const dbPath = opts.opencodeDbPath ?? resolveOpencodeDbPath()
  if (!existsSync(dbPath)) {
    /* opencode 从未跑过 / 路径换了 → 不报错，仅 warn + capture-failed marker */
    await markCaptureFailed(opts.db, opts.nodeRunId, 'opencode-db-not-found')
    return { capturedSessionIds: [], failed: true }
  }
  /* 用 bun:sqlite 以 readonly 模式打开 */
  using opencodeDb = new Database(dbPath, { readonly: true })
  /* BFS：从 rootSessionId 出发，按 parent_id 找子 session */
  const queue = [opts.rootSessionId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const sid = queue.shift()!
    if (visited.has(sid)) continue
    visited.add(sid)
    const children = opencodeDb
      .query<{ id: string }>('SELECT id FROM session WHERE parent_id = ?')
      .all(sid)
      .map((r) => r.id)
    for (const c of children) queue.push(c)
  }
  /* 根 session 是父 stdout 已经写过的，跳过；只 transcode 真正的子 session。 */
  const childSessionIds = [...visited].filter((s) => s !== opts.rootSessionId)
  for (const sid of childSessionIds) {
    const parentSid = opencodeDb
      .query<{ parent_id: string | null }>('SELECT parent_id FROM session WHERE id = ?')
      .get(sid)?.parent_id ?? null
    const messages = opencodeDb
      .query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(sid)
    const parts = opencodeDb
      .query("SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id")
      .all(sid)
    /* transcode 见 §3.2.1 */
    const events = transcodeOpencodeRowsToEvents({ sid, parentSid, messages, parts })
    if (events.length === 0) continue
    await opts.db.insert(nodeRunEvents).values(
      events.map((e) => ({
        nodeRunId: opts.nodeRunId,
        ts: e.ts,
        kind: e.kind,
        payload: e.payload,
        sessionId: sid,
        parentSessionId: parentSid,
      })),
    )
  }
  return { capturedSessionIds: childSessionIds, failed: false }
}
```

#### 3.2.1 opencode 行 → 本框架 normalized event

opencode 的 message / part data 是 JSON blob（schema 见 `packages/core/src/session-message.ts` 与 `packages/opencode/src/session/message-v2.ts`）。本 RFC **不直接消费这些 JSON 字段**到 UI，而是 transcode 成与父 stdout 同形态的"模拟 NDJSON 行"塞进 `node_run_events.payload`：

- message.data.role === 'assistant' + part.type === 'text' → 一行 `{"type":"text","sessionID":sid,"part":{...},"timestamp":part.time_created}`
- part.type === 'tool' → 一行 `{"type":"tool_use","sessionID":sid,"part":{...},"timestamp":part.time_created}`
- part.type === 'step-start' / 'step-finish' / 'reasoning' → 对应一行
- 不识别的 part type → 丢弃（不入库），并在 warn 日志里记 type 名

这一层 transcoder 是**纯函数** `transcodeOpencodeRowsToEvents`，输入是 `messages[] + parts[]`，输出是 `Array<{ ts, kind, payload }>`。让 frontend 的 `parseSessionTree` **完全不需要区分**事件来源（父 stdout vs 子 session DB），保持单一渲染路径。

#### 3.2.2 关键不变量

- **绝不阻塞主流程**：SQLite 读取失败（文件不存在 / 锁冲突 / schema 不匹配 / 任意异常）都 catch 住，记 warn + 落一行 `kind='subagent-capture-failed'` 的 marker 事件，不抛出。
- **只读**：用 `readonly: true` 打开，禁止任何写入；不影响并行运行的其他 opencode 进程。
- **不复制大文件**：opencode DB 在 user-level 全局共享、可能 GB 级；只做按需查询，不整库读到内存。
- **多 task 并发安全**：opencode SQLite 启用 WAL（与本框架一致），多 reader 互不阻塞。
- **runner cleanup 顺序**：必须**在** `rmSync(runRoot)` **之前**调 `captureChildSessions` —— rm 不会动 opencode 的 home，但保持 "捕获 → cleanup" 显式顺序便于阅读。

### 3.3 runner.ts 调整

```diff
   const stdoutPump = pumpLines(child.stdout, async (line) => {
     ...
+    /* 给每条 stdout 事件标记 sessionId（父 = rootSessionId）+ parentSessionId=null */
     await opts.db.insert(nodeRunEvents).values({
       nodeRunId: opts.nodeRunId,
       ts,
       kind,
       payload: line,
+      sessionId: sessionId ?? null,
+      parentSessionId: null,
     })
   })
   ...
   const exitCode = await child.exited
   await Promise.all([stdoutPump, stderrPump])
+
+  /* 后置读 opencode SQLite 把子 session 行 transcode 入库。 */
+  if (sessionId !== undefined) {
+    try {
+      await captureChildSessions({ rootSessionId: sessionId, nodeRunId: opts.nodeRunId, db: opts.db, log })
+    } catch (e) {
+      log.warn('subagent-capture-unhandled', { err: String(e) })
+    }
+  }
   ...
   try {
     rmSync(runRoot, { recursive: true, force: true })
   }
```

**对运行时性能的影响**：单次只查若干行 message / part，毫秒级；加在 `await child.exited` 之后、`finishedAt` 落库之前，不影响用户感知的"任务完成"时间（finishedAt 由 step 10 写入，整段 transcode 在 step 9 与 10 之间）。

> 如果未来 opencode 改了 schema（譬如 message.data 结构变了），transcoder 单测会爆掉 —— 这是有意为之的"故障早期暴露"，参考 [feedback_opencode_version_lock]（如有）；不在本 RFC 引入额外的版本探测，运行时只在 transcode 抛错时落 capture-failed 兜底。

### 3.4 REST 端点

新增 `routes/sessionView.ts`：

```
GET /api/tasks/:taskId/node-runs/:nodeRunId/session
  → 200 SessionTreeResponse
  → 404 node-run-not-found / task-not-found
  → 410 node-kind-not-supported  (input / output / wrapper / review)
```

实现：

```ts
const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId))
if (!rows[0]) return 404
if (!isPromptCapableKind(workflowSnapshot, rows[0].nodeId)) return 410
const events = await db.select().from(nodeRunEvents).where(eq(...)).orderBy(...)
const tree = parseSessionTree({
  rootSessionId: deriveSessionIdFromEvents(events) /* runner 没单独存 sessionId 字段；从根桶事件挑第一个 */,
  promptText: rows[0].promptText,
  startedAt: rows[0].startedAt,
  primaryAgentName: resolveAgentNameFromSnapshot(...),
  events,
})
return c.json({ tree })
```

> 注意：`node_runs.sessionId` 当前在 runner 里只作为局部变量返回 RunResult，没落库。本 RFC **不**新加 `node_runs.session_id` 列 —— 因为 events 表里同名信息已足够派生（`deriveSessionIdFromEvents` 拿桶里第一个非空 sessionId 即可）。

### 3.5 WS invalidation

无新增频道。复用现有 `/ws/tasks/:taskId` 推送的 `node.event` 与 `node.updated`：前端 query key 加 `['tasks', taskId, 'node-runs', nodeRunId, 'session']`，在 useTaskSync 里的 invalidator 表加一条对应映射，让既有 WS 事件顺带刷 Session 视图。

## 4. 前端

### 4.1 NodeDetailDrawer.tsx

```diff
- type Tab = 'prompt' | 'events' | 'output' | 'stats'
+ type Tab = 'session' | 'events' | 'output' | 'stats'

- const [tab, setTab] = useState<Tab>('prompt')
+ const [tab, setTab] = useState<Tab>('session')

- ['prompt', t('nodeDrawer.tabPrompt')],
+ ['session', t('nodeDrawer.tabSession')],

- {tab === 'prompt' && (<PromptTab ... />)}
+ {tab === 'session' && (<SessionTab ... />)}
```

### 4.2 新文件 `components/node-session/SessionTab.tsx`

- 顶部沿用 RFC-011 的 attempts 切换器（直接复用 `sortNodeRunsForPromptHistory` + `formatAttemptLabel` + `isFanoutParentRun` + `isPromptCapableKind`，与现有 PromptTab 保持一致）。
- 选定 attempt 后，`useQuery<SessionTreeResponse>` 取 `/session` 端点。
- 渲染分支：
  - `isPromptCapableKind === false` → `<div className="muted">{t('nodeDrawer.sessionNotApplicable')}</div>`
  - attempts 空 / fan-out parent → 沿用既有占位 key（新增 `nodeDrawer.sessionPending` / `nodeDrawer.sessionFanoutParent`）。
  - 正常 → `<ConversationFlow tree={data.tree} />`。

### 4.3 新文件 `components/node-session/ConversationFlow.tsx`

- 接收 `tree: SessionTree`，map 出 messages：
  - `kind === 'user'` → `<MessageBlock role="user" text={msg.text}/>`
  - `kind === 'assistant-text'` → `<MessageBlock role="assistant" text={msg.text}/>`
  - `kind === 'tool-call'` → `<ToolCallBlock call={msg}/>`
  - `kind === 'subagent-call'` → `<SubagentBlock call={msg}/>`（受控 `open` state，默认折叠；展开后递归 `<ConversationFlow tree={msg.child} />`）
- 缩进控制：每层 ConversationFlow 由父 SubagentBlock 用 `<div className="session-flow session-flow--nested">` 包住，CSS 上做 `padding-left: var(--depth-pad, 16px)`；嵌套深度只反映在 DOM 嵌套，**不** 在组件 props 里传 depth（避免组件树和数据树双重耦合）。

### 4.4 i18n 新 key（中英各一份）

```
nodeDrawer.tabSession      = "Session" / "会话"
nodeDrawer.sessionPending  = "Session not yet captured" / "会话尚未生成"
nodeDrawer.sessionNotApplicable = "This node kind has no opencode session." / "该节点类型无 opencode 会话。"
nodeDrawer.sessionFanoutParent  = (同 promptFanoutParent 文案；两 key 并存，UI 用各自的)
session.user               = "User" / "用户"
session.assistant          = "Assistant" / "助手"
session.toolCall           = "Tool call" / "工具调用"
session.toolResult         = "Tool result" / "工具返回"
session.subagent           = "Subagent" / "子代理"
session.captureMissing     = "Subagent events were not captured." / "未能捕获子代理事件。"
session.fallbackOutput     = "Final output from parent:" / "父代理收到的最终回复："
session.expand             = "Expand" / "展开"
session.collapse           = "Collapse" / "折叠"
```

> 旧 `nodeDrawer.tabPrompt` / `promptPending` / `promptNotApplicable` / `promptFanoutParent` / `promptEmpty` / `promptAttemptLabel` **保留不删** —— 兜底防御任何被忘掉的引用；ESLint 不会误报因为它们继续被新组件的旧 fallback 复用。

### 4.5 样式

`styles.css` 新增约 80 行：

```css
.session-flow { display: flex; flex-direction: column; gap: 10px; }
.session-flow--nested { margin-left: 16px; border-left: 2px solid var(--surface-border); padding-left: 12px; }
.session-block { ... }
.session-block--user { ... }
.session-block--assistant { ... }
.session-block--tool { ... }
.session-block--subagent { ... }
.session-block__head { display: flex; align-items: center; gap: 8px; }
.session-block__role { font-size: 12px; opacity: 0.75; }
.session-block__ts { font-size: 11px; opacity: 0.5; margin-left: auto; }
.session-block__body { white-space: pre-wrap; font-family: var(--mono); }
.session-subagent__toggle { ... }
.session-capture-warning { color: var(--warn); font-size: 12px; }
```

## 5. 接口契约

```
GET /api/tasks/:taskId/node-runs/:nodeRunId/session

200 application/json:
{
  "tree": SessionTree   // 见 §2.1 SessionTreeSchema
}

404 / 410 / 401：遵循现有 ApiError 包格（{ code, message }）
```

## 6. 测试策略

| 模块 | 文件 | 覆盖目标 | 数量 |
|------|------|----------|------|
| shared | `tests/session-view-parse.test.ts` | parseSessionTree 全分支：user-only / pure-text / 单 tool / N 个 tool / 1 层 task / 3 层嵌套 task / capture-failed marker / 同 callID 多次更新 / messageId null / 事件乱序 (id, ts) tie-break | **≥ 12** |
| shared | `tests/session-view-schema.test.ts` | SessionTreeSchema 接受合法树 / 拒绝 child 缺字段 / 拒绝 recursive 自指环 / fallbackOutput nullable | 4 |
| backend | `tests/migration-0010-events-session-id.test.ts` | ALTER 表后老行 NULL 兼容 / 新行可写 / 索引存在 / 回滚 drop index 干净 | 4 |
| backend | `tests/session-capture-sqlite.test.ts` | sessionCapture: 给定一个含三层嵌套 session 的 fixture SQLite，BFS 出全部子 sessionID / transcode message+part → events / 路径不存在记 capture-failed / readonly 打开不写 / 根 sessionID 未知 skip | 6 |
| backend | `tests/transcode-opencode-rows.test.ts` | transcoder 纯函数：assistant text part / tool part / step part / 不识别 part type 丢弃 / message 排序 (time_created, id) tiebreaker | 5 |
| backend | `tests/routes-session.test.ts` | GET /session 200 happy path / 404 / 410（非 agent kind）/ pending attempt 空树 / multi-attempt 隔离（id-A 不串到 id-B） | 5 |
| backend | `tests/runner-session-id-persist.test.ts` | stdout 路径落 events.session_id 与 parent_session_id（父 = null） | 2 |
| frontend | `tests/node-drawer-session-tab.test.tsx` | tab label "Session" / 默认 selected / 与 PromptTab 行为一致的 attempts 切换 / 非 agent kind 占位 / pending 占位 | 5 |
| frontend | `tests/conversation-flow-render.test.tsx` | user/assistant/tool 三种 block 渲染 / 角色文案 i18n / ts 渲染 | 4 |
| frontend | `tests/subagent-block-nested.test.tsx` | 默认折叠 / 点击展开 / 三层嵌套缩进 / capture missing 兜底文案 / fallbackOutput 渲染 | 5 |
| frontend | `tests/session-tab-grep.test.ts` | 源代码层 grep 锁：NodeDetailDrawer 含 `tab === 'session'`；不含残留 `tab === 'prompt'` 主分支；SessionTab 必引用 `ConversationFlow`；runner 必 import `sessionCapture` 入口（防止 refactor 把 SSE 拿掉） | 4 |
| e2e | `e2e/main.spec.ts` 增 1 case | 启动一个有 subagent 的 task → 等 done → 打开 NodeDetailDrawer → Session tab → 看到 Subagent 折叠块 → 展开后看到子 session 文本 | 1 spec |

**测试合计预估 ≥ 50**，含源代码层 grep 兜底。

## 7. 与现有模块的耦合点

- **RFC-011 prompt history**：SessionTab 顶部直接复用 PromptTab 的 attempts 切换器逻辑（抽出 `useAttempts` hook 让两者共享，PromptTab 老分支不删，仅当 `tab === 'prompt'` 的死路径作为兜底；本 RFC 把 tab 切换默认 = 'session'，PromptTab 在 v1 后期由 follow-up issue 移除）。
- **RFC-022 dependsOn**：subagent 嵌套展示是 RFC-022 实际跑起来后的关键 review 路径。本 RFC 不改 RFC-022 的 inline JSON 注入。
- **RFC-023 / 026 clarify**：clarify 走的是独立 `<workflow-clarify>` envelope；clarify session 的事件继续按现有 awaiting_human 路径，**不**通过本 RFC 的 sessionView 展示（避免概念混淆 —— clarify 有专门 `/clarify/$nodeRunId` 详情页）。Session 视图遇到 envelope=clarify 的回合，把它当成普通 assistant text 行渲染（agent 文本里仍可见 `<workflow-clarify>` block），不做特殊处理。

## 8. 失败模式总览

| 场景 | 行为 |
|------|------|
| opencode DB 文件不存在（OPENCODE_TEST_HOME 指向空目录等）| `captureChildSessions` 记 warn + 落 `subagent-capture-failed` marker；运行不受影响；UI 走 AC-10 兜底 |
| opencode DB 文件存在但 schema 不匹配（opencode 升级 break change）| transcoder 抛 → outer try/catch 落 marker；UI 兜底 |
| opencode DB 写锁竞争 | readonly 模式 + WAL，不会被阻塞 |
| 父 session sessionId 抓不到（mock-opencode / 异常退出）| skip 后置读（rootSessionId 未知）；UI 渲染父 stdout 的 events，子 session 走 AC-10 兜底 |
| 子 session 已经结束但 part.state.output 仍为 null | `SessionSubagentCall.childOutputFallback = null`；UI 显示"事件未捕获 + 无可显示文本" |
| 同 callID 多次更新 | 原地覆盖（最后写入胜出） |
| 多 attempt（RFC-011 retry）| 每个 attempt 是独立 node_run_id，events 表天然隔离；前端 attempts 切换器切 nodeRunId，整个 SessionTree 重查 |
| opencode DB 路径在 Windows / 容器内不同 | xdg-basedir 已处理；本框架 v1 只测 macOS + Linux（与 RFC 总体支持列表一致）|

## 9. 配置 / 环境变量

零新增配置。`OPENCODE_TEST_HOME` 由 opencode 自身定义（`packages/core/src/global.ts:18`），本框架的 e2e fixture 可借此把 opencode DB 重定向到临时目录，避免污染用户数据。runner 不要求用户设置任何变量。
