# RFC-238 · MCP 运行时多轮测试对话框 — 技术设计

## 1. 当前事实与边界

### 1.1 MCP 详情与保存依据

当前链路为：

```text
mcps.detail.tsx
  → TabBar(key='probe')
  → McpInventoryPanel
  → useMcpProbe / useProbeMcpMutation
  → POST /api/mcps/:id/probe
```

`McpInventoryPanel` 已经接收：

- stable `mcpId`；
- 已保存行派生出的 `operationConfigHash`；
- `dirty`；
- `onSaveForProbe()`，其返回值是精确 PUT receipt hash；
- split-detail `beginBusy()`。

RFC-238 复用这套“保存版本 vs 脏草稿”协调方式。runtime 测试不能另算一份 hash，也不能把 MCP
name 当 canonical identity。

### 1.2 Session 渲染

当前共享渲染链为：

```text
SessionConversationPanel
  → useQuery + SessionViewResponseSchema.safeParse
  → ConversationFlow
  → SubagentBlock / reasoning / tool use / tool result
```

Task Session 与 RFC-235 Intent turn 都复用它。RFC-238 的后端只生产同一个
`SessionViewResponse`；前端不得复制 `ConversationFlow`、自己解释 raw runtime event，
也不得造 MCP 专用 tool-call 卡片。

`parseSessionTree` 已支持 `extraUserPrompts`，可把同一 runtime-native session 的后续 prompt
按时间并入会话树。RFC-238 使用这一入口呈现多轮 user message。

### 1.3 Runtime 分层

- `RuntimeDriver.buildSpawn(SystemAgentSpawnContext)` 的既有合同明确是“无 MCP/Skill/Plugin/
  inventory”的系统 Agent，且 OpenCode production path 是 fresh、ephemeral、不可 resume。
- `RuntimeDriver.buildBusinessSpawn(BusinessNodeSpawnContext)` 能注入 MCP，但同时承载 Agent
  dependencies、Skill、Plugin、repo、inventory、task/node identity 与 business session owner。
- `runSystemAgent` 已有有界 timeout、AbortSignal、detached process group、TERM→KILL→reap、
  stdout/stderr pump、event sink、OpenCode post-run capture、scratch cleanup。
- RFC-224 verified OpenCode business session owner 当前绑定 task/node/node_run；伪造 task id
  会污染 owner、恢复、指标与审计，不可接受。

结论：

1. 不扩宽 `SystemAgentSpawnContext` 的“无 MCP”不变量；
2. 不把 playground 塞进 `BusinessNodeSpawnContext` 并制造假的 Task/NodeRun；
3. 给 `RuntimeDriver` 增加闭集、可选的 MCP 测试 capability；
4. 抽取 `runSystemAgent` 已验证的通用进程生命周期，system agent 与 MCP test 分别做薄适配；
5. OpenCode 使用独立、持久、可 resume 的 playground owner/store，不复用 task owner 表。

### 1.4 RFC-237 并发关系

本 RFC 落档时，工作区里已有并行 Draft `RFC-237-intent-builder-claude-code-runtime`。它讨论
Claude Code 的 `intent-read-v1` 与 binary seal；RFC-238 的 `mcp-only-v1` 是另一项能力，
不能把 RFC-237 Draft 当作已落地事实。

实施前重新读取 RFC-237 的最终状态：

- 若通用 Claude binary seal / env scrub 已合入，RFC-238 复用；
- 若未合入，RFC-238 在自己的 capability 内实现所需边界；
- 无论哪种情况，都不覆盖或夹带 RFC-237 的未提交文件。

## 2. 领域模型与状态机

### 2.1 Session 状态

```ts
type McpRuntimeTestSessionStatus = 'active' | 'ending' | 'ended'

type McpRuntimeTestEndReason =
  | 'user'
  | 'idle-timeout'
  | 'mcp-deleted'
  | 'mcp-disabled'
  | 'mcp-config-changed'
  | 'access-revoked'
  | 'runtime-disabled'
  | 'runtime-deleted'
  | 'runtime-profile-changed'
  | 'runtime-identity-changed'
  | 'capture-truncated'
  | 'capture-incomplete'
  | 'session-unusable'

type McpRuntimeTestContinuationBlockedReason =
  | 'mcp-config-changed'
  | 'runtime-profile-changed'
  | 'runtime-identity-changed'
  | 'mcp-execution-changed'
  | 'capture-truncated'
  | 'capture-incomplete'
  | 'session-root-mismatch'
  | 'session-store-missing'
```

状态转换：

```text
create(first message) ───────────────→ active(inFlight)
active(inFlight) ── turn terminal ──→ active(idleDeadlineAt=now+10m)
active(idle) ───── accept message ──→ active(inFlight)
active(*) ───── manual/expiry/etc ──→ ending
ending ───── child reaped + cleanup ─→ ended
```

`ending` 是持久化 cleanup intent，不是短暂 UI 假状态。进入 `ending` 后不可发送新消息；daemon
崩溃后由 boot recovery 继续取消、reap、cleanup 并写 `ended`。

turn settle 只有同时满足下列条件才回 active+idle：

- `runtime_session_id` 已由 OpenCode ACK barrier 或 Claude preallocated UUID 建立；
- owner/identity/store lock 与 cleanup proof 完整；
- capture 未 truncated/incomplete；
- session 未 ending/blocked。

首轮在 native session 建立前 canceled/failed/timed_out/interrupted 时直接
`ending(session-unusable)`；不得把第二条 prompt 当成 fresh root 后仍声称是同一多轮 session。

### 2.2 Turn 状态

```ts
type McpRuntimeTestTurnStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'interrupted'
```

单个 session 同时最多一个 queued/running turn。`cancelRequestedAt` 是 durable intent：
HTTP 先写它，再触发 in-memory AbortController；即使响应或 daemon 随后失败，worker/boot
recovery 也会看见。

每个 turn 在接纳事务里持久化 `hard_deadline_at = created_at + 600_000`。该 deadline 包含
排队与执行：worker 拿到 semaphore 后必须先 CAS `queued → running` 并重验 session active、
未 cancel/end、deadline 未过，随后只把剩余预算交给进程 lifecycle。失败 CAS 的 queued turn
只做 terminal settle，绝不迟到 spawn。

### 2.3 三种“停止”

1. **turn 自然终态**：进程一定经过 reap；session 回 idle。
2. **cancel turn**：turn 进入 canceled；session 在 store/root session 完整时回 idle。
3. **end session**：session 先进入 ending；取消 in-flight、清理 persistent runtime state，
   再进入 ended。

普通 Dialog close 与以上三者没有任何写路径。

### 2.4 Idle TTL 的线性化点

- running/queued 时 `idle_deadline_at=NULL`。
- 清空 `in_flight_turn_id` 的同一事务写
  `idle_deadline_at = terminalAt + 600_000`。
- message 接纳事务只允许：

```sql
status = 'active'
AND in_flight_turn_id IS NULL
AND idle_deadline_at > now
AND continuation_blocked_reason IS NULL
```

- idle reaper 只允许：

```sql
status = 'active'
AND in_flight_turn_id IS NULL
AND idle_deadline_at <= now
```

两者以同一 SQLite writer transaction 串行，先提交者获胜。客户端倒计时只是展示，
服务端 deadline 才是事实源。

## 3. 持久化

实施时从当时 migration tail 取下一个编号；不得预占当前共享树可能被 RFC-237 或其它 session
使用的编号。

### 3.1 `mcp_runtime_test_sessions`

建议列：

| 列                               | 说明                                                                      |
| -------------------------------- | ------------------------------------------------------------------------- |
| `id`                             | ULID，逻辑测试会话 id                                                     |
| `mcp_id`                         | FK `mcps.id ON DELETE RESTRICT`；先回收 runtime state 再显式删 transcript |
| `owner_user_id`                  | FK `users.id ON DELETE RESTRICT`；账号删除同样先结束/回收其测试会话       |
| `client_create_id`               | 创建 POST 的 durable idempotency key                                      |
| `client_create_digest`           | 创建参数 canonical digest，用于 same-token mismatch                       |
| `status`                         | `active/ending/ended`                                                     |
| `end_reason`                     | nullable closed enum                                                      |
| `mcp_config_hash`                | 创建时精确 `operationConfigHash`，非 secret                               |
| `runtime_name`                   | 创建时解析后的实际 runtime row name                                       |
| `runtime_protocol`               | `opencode/claude-code`                                                    |
| `runtime_fingerprint`            | 受控 profile 的 SHA-256，不含 secret/明文路径 DTO                         |
| `runtime_binary_digest`          | 首轮 plan 的实际 executable bytes digest，首轮 plan 前可空                |
| `mcp_execution_digest`           | exact MCP transport/wrapper execution identity digest，首轮 plan 前可空   |
| `session_contract_digest`        | native root session contract digest，首轮 plan 前可空                     |
| `runtime_session_id`             | 首轮 ownership barrier 后得到的 native session id                         |
| `native_session_state`           | `pending/ready/unusable`；预分配 id 不等于已可 resume                     |
| `in_flight_turn_id`              | soft pointer；同 intent session，避免循环 FK                              |
| `turn_seq`                       | 单调 turn 序号                                                            |
| `session_version`                | mutation/WS cursor CAS                                                    |
| `idle_deadline_at`               | 仅 active+idle 非空                                                       |
| `continuation_blocked_reason`    | nullable closed enum；config/runtime/capture/store 漂移                   |
| `scratch_root`                   | daemon-private 绝对路径，仅后端/recovery 使用                             |
| `session_store_root`             | daemon-private runtime state root                                         |
| `session_store_db_path`          | OpenCode locator；Claude 为 null                                          |
| `cleanup_state`                  | `not-started/pending/complete/quarantined`                                |
| `cleanup_error_code`             | masked stable code，不存 raw exception                                    |
| `created_at/updated_at/ended_at` | 时间                                                                      |

索引与 CHECK：

- partial unique `(mcp_id, owner_user_id) WHERE status IN ('active','ending')`；
- unique `(mcp_id, owner_user_id, client_create_id)`；
- status / deadline / in-flight / cleanup 的闭合 CHECK；
- active+in-flight ⇒ deadline null；
- active+idle ⇒ deadline non-null，除刚创建事务内不可见状态外不允许空；
- ended ⇒ ended_at/end_reason 非空；
- runtime/MCP hash 均严格 64 hex。
- 三个 execution digest 要么尚未 plan 全空，要么在首个模型请求前全量写入；resume 时不可改写。
- 只有 `native_session_state='ready'` 才允许 active+idle/message resume；Claude preallocated
  UUID 在首个 exact stream/transcript proof 前仍为 pending。

不把 MCP config JSON、env、headers、oauth、provider credential、runtime auth 或 prompt
拼进 `runtime_fingerprint`。fingerprint 的 canonical input 仅包括：

```ts
{
  runtimeRowId,
  name,
  protocol,
  resolvedBinaryPath,
  model,
  variant,
  temperature,
  steps,
  maxSteps,
  configDirEnv,
  configDirName,
  probeFence,
  mcpTestProfileCodec,
}
```

绝对 binary path 可留在内部 snapshot/recovery 列或 turn 的 `spawn_binary_path`，但 API 只返回
hash 与 runtime name。

`runtime_fingerprint` 证明 registry/profile 没漂移；`runtime_binary_digest` 证明同一路径的
实际 bytes 没被替换；`mcp_execution_digest` 证明 local command/wrapper/toolchain 或 remote
transport 的受控执行身份没漂移。后两者来自 driver 返回的 secret-free plan receipt，不能由
generic service 猜测。

### 3.2 `mcp_runtime_test_turns`

| 列                                                      | 说明                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id/session_id/seq`                                     | ULID、FK cascade、会话内唯一序号                                         |
| `client_message_id`                                     | 客户端生成 ULID/UUID；`(session_id, client_message_id)` unique           |
| `prompt_text`                                           | 用户消息，≤64 KiB                                                        |
| `status`                                                | turn 状态闭集                                                            |
| `hard_deadline_at`                                      | 接纳时刻 + 10 分钟；覆盖 queue + process                                 |
| `capture_state`                                         | `live/complete/truncated/incomplete`                                     |
| `capture_incomplete_reason`                             | 复用 RFC-235 closed reasons                                              |
| `capture_first_event_seq/last_event_seq`                | 指向 session-wide event cursor                                           |
| `cancel_requested_at`                                   | durable cancel intent                                                    |
| `pid/spawned_at/spawn_binary_path/spawn_command_digest` | raw plan 与 containment wrapper 的 exact stale-process identity/recovery |
| `exit_code/failure_code/stderr_tail/duration_ms`        | masked run metadata                                                      |
| `started_at/finished_at/created_at`                     | 时间                                                                     |

首条消息与 session 创建在一个事务中完成。后续 message 在一个事务中：

1. 重验 session owner/state/deadline/version；
2. 重验 MCP hash、enabled、runtime fingerprint/capability；
3. 插入 turn；
4. `in_flight_turn_id=turn.id`、`idle_deadline_at=NULL`、`turn_seq++`、`session_version++`。

message request 还带 `expectedSessionVersion`，用于多 tab stale send CAS。处理顺序必须先按
`client_message_id` 查 exact replay，再检查 version；否则一次成功但响应丢失的重放会因版本
已增长而错误 409。若 token 相同而 prompt 不同，返回 409
`mcp-test-idempotency-mismatch`。

### 3.3 `mcp_runtime_test_events`

events 按**逻辑 session**排序，而不是每 turn 独立排序，避免 resume 后 post-run capture 把
旧 transcript 再复制一遍：

| 列                                                    | 说明                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `id`                                                  | autoincrement                                                 |
| `test_session_id`                                     | FK cascade                                                    |
| `first_seen_turn_id`                                  | 首次观察到该 event 的 turn                                    |
| `event_seq`                                           | session-wide 单调序号                                         |
| `ts/kind/payload/session_id/parent_session_id/source` | 与现有 normalized event 同形                                  |
| `external_event_key`                                  | domain-separated SHA-256(runtime/session/part identity)，可空 |

约束：

- unique `(test_session_id, event_seq)`；
- partial unique `(test_session_id, external_event_key) WHERE external_event_key IS NOT NULL`；
- 一个 session 只有一个 ordered sink promise tail；
- live 与 post-run capture 使用同一个 bounded canonical external digest，不能把 source 差异当成两个
  业务事件；
- 没有稳定 external key 的 raw text/stderr 只由 stream source 写一次，post-run importer
  不重造。

### 3.4 `mcp_runtime_test_create_receipts`

create 的幂等键不能只寄存在 session row：用户开始下一次测试后，旧 `cleanup=complete`
session/transcript 会被清理；此时迟到重放旧 POST 不能再次产生模型/MCP side effect。

新增无 prompt/secret 的最小 receipt：

| 列                                      | 说明                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `mcp_id/owner_user_id/client_create_id` | 复合唯一键；资源/用户删除走显式 teardown                                 |
| `request_digest`                        | 覆盖 expected hash、实际 runtime 选择、message digest 与 clientMessageId |
| `session_id/accepted_turn_id`           | 原始稳定 locator；不以会被清理的 transcript FK 级联                      |
| `created_at/expires_at`                 | 幂等保证窗固定 24 小时                                                   |

receipt 与 session+first turn 在同一个 transaction 写入。digest 相同的重放始终返回原
`{sessionId, acceptedTurnId}`；即使 transcript 已清理，也只返回这两个已应用 locator，
绝不创建新 session。digest 不同返回 `mcp-test-idempotency-mismatch`。前端不会自动复用过期
token；只有用户明确点击“开始新测试”才生成新的 `clientCreateId/clientMessageId`。
后台只删除已过保证窗且不存在在途 HTTP attempt 的 receipt。它不保存 prompt、Session DTO、
MCP config 或 runtime credential。

### 3.5 OpenCode 独立 owner

新增 `opencode_mcp_test_session_owners`，字段与 RFC-224 business owner 的 immutable
identity/lease 语义等价，但归属键是 `test_session_id/created_turn_id/current_turn_id`，
不是 task/node/node_run：

- `runtime_session_id` primary/unique；
- `test_session_id` unique；
- `created_turn_id`；
- `identity_digest/runtime_binary_digest/session_contract_digest/session_store_key/project_id/
protocol_codec/reported_version`；
- all-or-none lease triple
  `lease_turn_id/lease_acquired_at/lease_nonce_digest`。

不得把 playground row 插入现有 `opencode_session_owners`，也不得用伪 task/node id 欺骗
`claimNewOpencodeSession`。

owner row 对 test session 使用 `ON DELETE RESTRICT` 或等价显式 teardown：store cleanup
complete 前不得删除 owner/session。否则一条级联删除会让 boot reaper 丢失唯一 binary/store/
lease 身份。

## 4. Shared API 契约

新增 strict Zod schemas：

- `McpRuntimeTestSessionStatusSchema`
- `McpRuntimeTestTurnStatusSchema`
- `McpRuntimeTestEndReasonSchema`
- `McpRuntimeTestContinuationBlockedReasonSchema`
- `McpRuntimeTestSessionDtoSchema`
- `McpRuntimeTestCreateRequestSchema`
- `McpRuntimeTestMessageRequestSchema`
- `McpRuntimeTestCancelRequestSchema`
- `McpRuntimeTestEndRequestSchema`
- mutation receipt schemas

DTO 只暴露：

```ts
interface McpRuntimeTestSessionDto {
  id: string
  mcpId: string
  status: 'active' | 'ending' | 'ended'
  endReason: McpRuntimeTestEndReason | null
  runtime: { name: string; protocol: RuntimeKind }
  mcpConfigHash: string
  runtimeFingerprint: string
  nativeSessionReady: boolean // projection of native_session_state === 'ready'
  continuationBlockedReason: McpRuntimeTestContinuationBlockedReason | null
  inFlightTurnId: string | null
  sessionVersion: number
  idleDeadlineAt: number | null
  cleanupState: 'not-started' | 'pending' | 'complete' | 'quarantined'
  turns: McpRuntimeTestTurnDto[]
  eventCursor: number
  createdAt: number
  updatedAt: number
  endedAt: number | null
}
```

不暴露 scratch/store/binary path、PID、raw stderr、MCP config 或 provider auth。

## 5. HTTP 与 WebSocket

canonical routes 全部按 MCP stable id：

```text
GET  /api/mcps/:mcpId/runtime-test-session
POST /api/mcps/:mcpId/runtime-test-sessions
GET  /api/mcps/:mcpId/runtime-test-sessions/:sessionId
POST /api/mcps/:mcpId/runtime-test-sessions/:sessionId/messages
POST /api/mcps/:mcpId/runtime-test-sessions/:sessionId/cancel-turn
POST /api/mcps/:mcpId/runtime-test-sessions/:sessionId/end
GET  /api/mcps/:mcpId/runtime-test-sessions/:sessionId/session
```

### 5.1 GET latest

- 返回当前 actor 在该 MCP 下的 active/ending；没有则返回最近 ended；都没有返回 204。
- system admin 的“latest”仍按 admin 自己 owner slot，不意外返回其他用户内容。
- exact session metadata endpoint 只允许 session owner 或 system admin；system admin 只有提供
  精确 id 才能审计，不提供跨用户 list/search。

### 5.2 Create

```ts
{
  expectedMcpConfigHash: string
  runtimeName: string | null // null = 解析全局默认，但 receipt 存实际 name
  message: string
  clientCreateId: string
  clientMessageId: string
}
```

返回 `202 { sessionId, acceptedTurnId }`；前端 optimistic 显示已接纳 user message，并立即
读取 metadata/Session view。处理顺序先查 durable create receipt
`(mcpId, actorId, clientCreateId)`：digest 相同返回原 receipt（即使 session 已 ended），digest
不同返回 `mcp-test-idempotency-mismatch`；只有没有 exact replay 时才判断 active/ending。
若存在其它 active/ending，返回 409 并附当前 session locator；前端应恢复它，不暗中创建
第二条。若只存在 ended，创建事务只删除
`cleanup_state='complete'` 的旧记录，再插入新 session+first turn；pending row 留给 GC，
quarantined row 因仍可能存在同一 MCP 的 live side effect 而阻止新建并提示管理员恢复。
不得删除尚在承载 process/store recovery identity 的 row。
若 replay receipt 指向的旧 transcript 已按上述规则清理，metadata GET 可以是 404；UI 显示
“该创建请求已执行且记录已被后续测试替代”，并恢复当前 latest，而不是自动换 token 重发。

### 5.3 Message

请求为
`{message, clientMessageId, expectedSessionVersion}`，返回 202。服务端在接纳事务里处理：

- deadline；
- single-flight；
- config/runtime fingerprint；
- capability；
- 32-turn limit；
- idempotency token。

任何失败都发生在插入新 turn 和模型 side effect 前。

### 5.4 Cancel 与 end

`cancel-turn` body 带精确 `turnId`。重复取消同一已终态 turn 返回当前投影，不把后来的 turn
误取消。queued turn 先 durable 写 cancel intent/terminal；worker 的 pre-spawn CAS 因而失败。

`end` 是 idempotent：

- active → ending，写 end reason=user；queued worker禁止 spawn，running worker由
  AbortController 完成 TERM→KILL→reap 与 cleanup；
- ending → 返回当前 receipt；
- ended → 200 返回最终 receipt。

### 5.5 Session view

`GET .../:sessionId/session`：

1. 加载 session 与所有 prompt turns；
2. 加载 session-wide events；
3. 第一条 prompt 作为 `promptText`，余下作为 `extraUserPrompts`；
4. `parseSessionTree`；
5. 只返回 `SessionViewResponseSchema.parse({tree})`。

空/queued 首轮仍返回合法空树 + user prompt，不返回 ad-hoc placeholder wire。

### 5.6 WS

新增 owner-gated MCP test session subscription，frame 只含 locator：

```ts
{
  sessionId,
  sessionVersion,
  inFlightTurnId,
  turnStatus,
  eventCursor,
  captureState,
}
```

不经 WS 推 prompt、tool result 或 stderr。前端用 locator invalidate REST query；同时保留
1.5 秒 polling fallback，WS 不是正确性的唯一来源。ACL 每次 subscribe/reconnect 重验，
撤销后关闭。

## 6. 服务层与并发

### 6.1 `McpRuntimeTestService`

职责：

- actor + `canViewResource('mcp')`；
- stable-id load 与 operation hash；
- runtime resolution/fingerprint/capability；
- create/message/cancel/end 的短事务；
- DTO projection；
- MCP save/delete/ACL 与 runtime mutation 的 invalidation hook。

不得在 HTTP request transaction 内等待模型。202 receipt 提交后把 turn 交给 coordinator。

### 6.2 `McpRuntimeTestCoordinator`

daemon-scoped 单例，拥有：

- turn id → AbortController map；
- 每个 session 的 non-reentrant mutex；
- 有界全局 semaphore（v1 容量 2）；
- earliest-idle-deadline 单 timer（`unref`）；
- boot recovery 与 graceful shutdown hook。

锁顺序固定：

```text
global turn semaphore → session mutex → 短 DB transaction
```

禁止在持有 SQLite transaction 时等待 semaphore、spawn、kill 或文件 IO。

队列中的 turn 已占 session in-flight slot，因此不计 idle；daemon crash 时 queued turn 由 boot
recovery 收敛，不永久占位。

### 6.3 MCP operation 与 runtime 竞态

MCP test 的“读取当前行→构造 frozen spawn material”接入现有 stable-id
`mcpOperationCoordinator`：

1. 在 coordinator 临界区重读 MCP、校验 actor/enabled/hash；
2. 复制一份内存中的 validated MCP row；
3. 生成 driver plan 所需 frozen input；
4. 释放 coordinator；
5. spawn/模型运行不持有 MCP 编辑锁。

因此 save/delete 不与读取半行竞态，也不会被一个 10 分钟 turn 长时间阻塞。plan 已构造后
发生的普通 config save 不热切当前 turn；下一轮 hash gate 阻止恢复。

runtime row 同理用 profile fingerprint 的 pre-plan/post-resolution recheck；OpenCode/Claude
各自 binary seal 在 exec 前再证明实际字节。runtime profile edit 不改变已构造 turn。

### 6.4 删除/禁用/撤权

- MCP delete：在同一 stable-id `mcpOperationCoordinator` fence 下，第一段短事务把相关
  active session 持久化为 ending；事务外取消并证明所有 child 已 reap、store cleanup
  complete；第二段权威 delete transaction 显式删除 owner/test rows 并复核 Agent references，
  最后删除 MCP。FK 为 RESTRICT；不能证明时删除失败关闭并保留进程身份。整个 fence 不与
  10 分钟业务 turn 共持有，只覆盖有界 cancel/reap/delete。
- MCP enabled→false、runtime disable/delete、MCP ACL 撤销导致 owner 失权：各 canonical
  mutation 在同一 DB transaction 把受影响 session 写 ending；提交后同步触发 in-memory abort。
- 用户账号删除同样先把该 owner 的 test sessions 写 ending 并完成回收；`owner_user_id`
  RESTRICT 防止 future/raw writer 跳过该顺序。
- 任意会改变 `operationConfigHash` 的 MCP update/rename/ACL mutation 都在其 canonical tx
  标记现有 session `mcp-config-changed`；仍有权限且正在运行的 turn 可完成，失权/disabled
  则立即 abort。这样不会出现 DB hash 已变但旧 session 仍显示可续聊的窗口。
- 普通 runtime profile 修改：不杀已启动 turn，但设置 continuation blocked；idle session
  立即进入 ending，running session 在 turn reap 后进入 ending。下一条消息只能等 cleanup 后
  new，不保留一个永远不能继续的 active session。
- abort 通知失败不会重新打开会话；高频 coordinator reconciliation 与 boot scan 读取 durable
  ending/cancel intent 并补偿。每分钟扫描只作最终兜底，不是权限生效的线性化点。

为避免 module cycle 与“提交后再猜谁失权”，写点使用显式 in-tx callback：

- `updateResourceAcl(..., { afterWriteInTx })` 在 `type='mcp'` 的同一 `dbTxSync` 内先把全部旧
  hash session 标记 `mcp-config-changed`，再把新 visibility/owner/grant set 交给纯函数，
  对失权 owner 升级为立即 ending/abort；
- `commitMcpUpdateInTx` 与 rename write core 在任何 operation-hash 改动后调用 MCP session
  transition helper，disabled 使用立即 ending；
- runtime update/disable/delete 的 canonical tx 调 runtime session helper；
- `disableUser` 与 `patchUser(status→disabled)` 在 user 状态和 auth session 撤销的同一 writer
  transaction 标记该 owner 的 test sessions ending。

callback 只写 DB，不 spawn/kill/await；post-commit coordinator notification 才做进程 abort。

## 7. 通用进程生命周期抽取

从 `runSystemAgent` 抽出不含产品语义的 `runCapturedRuntimeAttempt`（名称可在实现中调整）：

```ts
interface CapturedRuntimeAttemptOptions {
  feature: string
  driver: RuntimeDriver
  buildPlan(): Promise<SpawnPlan>
  cwd: string
  timeoutMs: number
  abortSignal?: AbortSignal
  eventSink: SystemAgentEventSinkV1
  onSpawned?(receipt: {
    pid: number
    spawnedAt: number
    spawnBinaryPath: string
    spawnCommandDigest: string
  }): Promise<void>
  captureAfterExit?(ctx: CaptureContext): Promise<void>
  finalizePlanPolicy: 'attempt-ephemeral' | 'session-persistent'
}
```

它保留现有行为：

- `detached:true` process group；
- SIGTERM → bounded SIGKILL → final reap deadline；
- stdout/stderr 同时 drain；
- stdin pipe；
- AbortSignal 与 hard timeout；
- normalized parse + masked stderr；
- post-exit drain bounded；
- capture terminal stronger-state monotonicity；
- cleanup 只在已证明 child reaped 后执行。

严格 pre-prompt 顺序：

1. `buildPlan` 返回 secret-free `McpTestPlanIdentityReceipt`
   （runtime binary/MCP execution/session contract/command digests）；
2. 首轮用 CAS 写 session digests，续轮精确比较；
3. spawn 后 `onSpawned` 持久化 pid/spawnedAt/raw+wrapped command identity；
4. `onSpawned` 成功后才向 Claude stdin 写 prompt；失败立即 kill/reap；
5. OpenCode verified launcher 继续由 control ACK 阻止首个模型请求，ACK 只在第 2/3 步均
   持久化后写。

因此“进程已启动”不等于“模型已收到 prompt”。generic reaper 必须比较实际 wrapped process
command 与 raw runtime digest 两层证据，不能把 bwrap/launcher head 错当 runtime binary。

`runSystemAgent` 改为行为字节等价的 adapter；现有调用和测试全部保持。MCP turn adapter 另外：

- `onSpawned` 在继续模型前持久化 pid/spawnedAt/exact raw+wrapped identity；
- turn 成功也只删除 per-turn manifest/seal，不删除 session scratch/store；
- session end/reaper 才删除 persistent state；
- child 未证明 reaped 时写 `cleanup_state=quarantined`，禁止删除可能仍被写入的目录。

## 8. RuntimeDriver capability

### 8.1 闭集声明

```ts
interface RuntimeMcpTestCapabilityV1 {
  readonly codec: 'mcp-test-v1'
  containmentProfile(input: { mcp: Mcp }): ContainmentRequirementProfileId
  buildSpawn(ctx: McpTestSpawnContext): Promise<McpTestSpawnPlan>
}

interface RuntimeDriver {
  // existing methods...
  readonly mcpTest?: RuntimeMcpTestCapabilityV1
}
```

`McpTestSpawnContext` 是 closed product context，只含：

- session/turn ids；
- 固定 persona + 用户 prompt；
- exact one validated MCP；
- frozen runtime profile/binary/config-dir；
- new/resume native session identity；
- empty session cwd、session root、per-turn run root；
- prepared containment；
- OpenCode 专用 owner/control raw material（discriminated union）；
- test-only command seam。

它没有 `dependents/plugins/skills/memory/inventory/repoWorktreePaths/git identity` 字段，避免未来
调用方“顺手”注入。

`McpTestSpawnPlan` 扩展 `SpawnPlan`，并携带 secret-free identity receipt：

```ts
interface McpTestPlanIdentityReceipt {
  codec: 'mcp-test-plan-identity-v1'
  runtimeBinaryDigest: string
  mcpExecutionDigest: string
  sessionContractDigest: string
  rawCommandDigest: string
}
```

首轮写入后，续轮 plan 必须重算并匹配；同一路径 runtime binary 或 local MCP command 字节
改变都阻止 resume。receipt 不携带 config/env/header；secret-bearing manifest/config 文件必须
位于 0700 private root、文件 0600，并只在 child reaped 后删除。

runtime list DTO 增加基于“driver capability + 当前 row profile”的
`capabilities.mcpRuntimeTestV1` eligibility；例如 verified OpenCode model 无法解析时不能仅因
driver 有方法就标 capable。picker 只显示 enabled+eligible。后端不信前端过滤，每次
create/message 都重算 eligibility 并重验 `driver.mcpTest?.codec === 'mcp-test-v1'`。
全局默认仅在 eligible 时预选；否则保持未选择并解释原因，不自动改投另一 provider。

### 8.2 合成 persona

固定 persona 只说明：

- 你正在测试一个 MCP；
- 仅使用已提供 MCP tools；
- 根据用户自然语言选择工具并如实报告 tool result/error；
- 不声称执行不存在的工具；
- 对明显有写副作用的动作，若用户没有明确要求，先在自然语言回复中说明风险。

persona 不包含 MCP config、secret、owner、ACL、runtime path，也不要求模型输出 workflow
envelope。

### 8.3 MCP 执行材料

generic service 先调用单一 `prepareMcpTestExecutionMaterial()`，driver 只能消费其 frozen
结果，不能各自重新解释 MCP row：

- local stdio MCP 解析实际 executable，复用现有 containment 的 sealed child launcher，
  对 executable bytes、canonical argv、cwd 与非敏感 env shape 生成 execution digest；
  wrapper 在 exec 前再次核对 sealed identity。无法稳定解析/封印的动态命令失败关闭为
  `mcp-test-execution-identity-unsupported`，不以原始 shell 字符串直接运行。
- remote HTTP/SSE MCP 对 canonical transport、endpoint 与 credential slot/version 生成
  domain-separated digest；credential 值只在 spawn 前投影到私有配置文件，不进入 digest
  明文、argv、receipt 或日志。
- 每轮产生新的 daemon-private `0700` material root 与 `0600` MCP config；argv 只携带该文件
  path。文件内容只能含 exact one MCP，且 child reap 前不删除。
- 首轮把 `mcpExecutionDigest` 写进 session；续轮 materialize 后必须 exact match，再允许
  model prompt。这个比较证明的是实际受控 launch material，而不是“DB path/string 看起来没变”。

OpenCode 与 Claude Code 均走该入口；OpenCode 可复用 verified child launcher，Claude 的
`--mcp-config` 也只能指向这里生成的私有文件。

## 9. OpenCode `mcp-test-v1`

### 9.1 独立 verified plan

新增 `buildVerifiedOpencodeMcpTestPlan`，复用 RFC-224/227/233：

- exact selected binary snapshot/re-hash；
- hermetic env/config/source guard；
- same-instance direct API；
- behavior codec；
- containment admission；
- local MCP sealed wrapper/no-network child policy；
- persistent daemon-private XDG store；
- strict root session comparator；
- launcher control ACK 与 lease。

差异由新的 manifest discriminant `storeKind='mcp-test'` 表达，不把它伪装为 business：

```ts
{
  storeKind: 'mcp-test',
  mode: 'new' | 'resume',
  testSessionId,
  createdTurnId,
  turnId,
  expectedSessionId?,
  // same identity/lease/control fields
}
```

launcher 对 `business|mcp-test` 共用 persistent-store lock、path=''、session-ready marker、
ACK barrier、resume strict comparator；DB claim/confirm/release 由调用方各自 owner adapter
处理。system-ephemeral 路径保持 fresh/no-control。

playground identity digest 必须基于 stable logical descriptors
（session id、canonical MCP semantics、execution digests、selected model/agent、store key），
不能把 per-turn `runRoot/sealRoot` 绝对路径写进 persistent equality。每轮 wrapper/seal 可以位于
新的 turn root，但其 canonical `mcpExecutionDigest` 必须与首轮相同；否则合法第二轮会因路径
变化永远 mismatch，或反过来漏过同路径字节替换。

### 9.2 Controlled config

配置只含：

- 一个固定 synthetic agent；
- exact one MCP；
- empty plugin/skill/instructions/lsp/formatter/snapshot；
- 选定 provider/model；
- closed permission profile。

agent permission 顺序要求：

```ts
{
  '*': 'deny',
  [`${canonicalMcpRuntimeKey}_*`]: 'allow',
  bash: 'deny',
  edit: 'deny',
  write: 'deny',
  read: 'deny',
  grep: 'deny',
  glob: 'deny',
  skill: 'deny',
  task: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  lsp: 'deny',
  external_directory: { '*': 'deny' },
}
```

精确 key/pattern 由 OpenCode driver 根据它的 MCP tool namespace 生成；generic service 不拼
vendor 字符串。Agent.Info 有序 rules 与最终 config 同时进入 identity comparison。资格测试
必须用真实 fixture MCP 证明：

- fixture tool 可见并能调用；
- Read/Bash/Web/Task/Question 不在有效工具面或被 deterministic deny；
- 第二轮 resume 仍只有同一个 MCP；
- global/repo MCP 不出现。

只证明 JSON 里“看起来有 deny”不算资格通过。

### 9.3 Owner/lease

first turn：

1. launcher 建 root session；
2. 向 parent 写带 `turnId/leaseNonceDigest/binaryDigest/codec` 的 session-ready marker；
3. parent 在一个事务中写 playground owner + session.runtimeSessionId；
4. parent O_EXCL 写 ACK；
5. launcher 收到 ACK 后才发送第一条 model prompt。

resume：

1. parent 在任何 store/materialization 前读取 owner 并预占 lease；
2. builder 重算全部 immutable digest；
3. launcher 验证 exact session；
4. marker/parent confirm/ACK；
5. 首个模型请求。

任一步失败都不能留下“模型已调用但 owner 未落库”的可恢复假 session。

## 10. Claude Code `mcp-test-v1`

使用独立 `buildClaudeMcpTestSpawn`，不改变 business `buildClaudeSpawn` 的历史 argv。

### 10.1 配置与工具面

至少包含：

```text
-p
--output-format stream-json
--verbose
--permission-mode dontAsk
--tools ""
--mcp-config <daemon-private 0600 one-MCP config path>
--strict-mcp-config
--setting-sources ""
--disable-slash-commands
[--allowedTools <driver 生成的当前 MCP namespace>]
[--model <runtime profile model>]
[首轮: --session-id <服务端预先持久化的 UUID>]
[续轮: --resume <同一 native session id>]
```

约束：

- 不出现 `bypassPermissions` / `--dangerously-skip-permissions`；
- `--tools ""` 裁剪 built-in tool set，MCP allow selector 只覆盖当前 MCP namespace；
- 私有 session-scoped `CLAUDE_CONFIG_DIR`，不注入 Skill/Agent/Plugin；
- MCP config path 来自 §8.3；env/header/oauth/provider credential 不进入 argv/process title；
- cwd 是平台新建的空目录，因此无 project CLAUDE.md；
- 清理/屏蔽 user/project/local settings 与 slash command 自动发现；
- binary 与环境边界达到 capability 声明要求；可复用已合入的 RFC-237 通用 seal，但不能依赖
  未落地 Draft。

Claude 没有 RFC-224 same-instance attestation，故 capability qualification 必须用当前受支持
CLI 的真实 behavior fixture 证明：

- 当前 MCP tool 可调用；
- Read/Write/Edit/Bash/Web/Agent 等均不可调用；
- 额外 MCP 配置不被发现；
- 首轮 `--session-id` 与续轮 `--resume` 互斥，且都绑定同一持久 row；
- `--resume` 在相同 cwd/config dir 下保持 session id 与上下文；
- stream-json 提供稳定 session id 与 tool events。

不满足时该 runtime attempt fail closed 为稳定 `mcp-test-runtime-unsupported`，不自动退回
business bypass path。

### 10.2 Session store

Claude transcript/config 目录按 logical session 保留；per-turn system prompt/临时文件单独放
turn run root。创建 session+first turn 的事务同时生成并持久化合法 UUID
`runtime_session_id`；首轮专用 spawn 传 `--session-id`，因此模型请求发生前 native identity
已有 owner，不依赖事后从 stream “捞到 id”，但 `native_session_state` 仍为 pending。只有
首个 exact stream id + private transcript existence proof 成功后才 CAS 为 ready；仅仅预分配
UUID 不能授权 resume。续轮只传 `--resume`。end/idle 才删除 session config dir；resume 必须
使用相同 cwd/config dir，stream 回显 id 也必须精确相等。任何目录丢失或 root session
mismatch 都把 continuation 标为 `session-unusable`。

## 11. Session event capture

### 11.1 通用 sink

把 `IntentTurnSessionEventSink` 中的 ordered queue、terminal precedence、limit 检查抽成
可复用 core；Intent adapter 行为不变，MCP adapter 把 counter/rows 写到 session-wide 表。

MCP sink：

- append event；
- canonical external key dedupe；
- OpenCode first root id 只能由 ownership ACK path CAS 写 session；Claude first root id 必须与
  preallocated UUID 相等，sink 不能把任意 stream id 覆盖进去；
- 后续 turn root id 必须精确相同；
- protocol-specific owner/transcript proof 完成后才把 `native_session_state` CAS ready；
- notify WS locator；
- capture failure 不改写模型业务结果，但设置 continuation blocked。

### 11.2 跨轮解析

```ts
parseSessionTree({
  rootSessionId: session.runtimeSessionId,
  promptText: turns[0].promptText,
  startedAt: turns[0].startedAt,
  primaryAgentName: 'mcp-runtime-test',
  events: sessionEvents,
  extraUserPrompts: turns.slice(1).map((turn) => ({
    text: turn.promptText,
    ts: turn.startedAt ?? turn.createdAt,
  })),
})
```

turn canceled/failed 的用户消息也保留；它确实被服务端接纳。若 queued turn 在 spawn 前因
boot recovery 变 interrupted，Session 仍显示用户消息，并在外层 turn 状态给出未执行提示。

### 11.3 限额

session sink 在 20,000 rows 或 16 MiB 前 fail closed：

- 超限事件不写；
- capture state 变 truncated；
- 当前 turn 仍完成 process lifecycle；
- session 写 `continuation_blocked_reason='capture-truncated'`；
- UI 要求立即结束/开始新测试。

stream parser 还要在 session 总量之前执行更小的边界：raw frame ≤2 MiB、单 normalized event
payload ≤1 MiB、masked stderr tail ≤256 KiB。超限后 parser 不再累积该 frame/event，标记
truncated/incomplete，并继续以固定 buffer drain pipes 直到进程退出；不能因“最终只写 16 MiB”
而先在 daemon heap 中无界拼接一条 tool result。

incomplete 同理阻止后续 resume，避免模型继续使用一段用户不可见且无法审计的历史。end/idle
在删除 native store 前先做一次 bounded final capture retry；仍 incomplete 时保留 store 为
`cleanup_state=pending` 交给 recovery/GC 再试，不能直接删掉唯一可补捞证据。达到明确 retention
上限后才可在写审计 reason 后清理；无法证明 store unlock 则仍为 quarantined。

## 12. Process recovery 与 cleanup

### 12.1 正常 settle

所有 turn 最终顺序：

1. TERM/KILL（如需要）；
2. child/process group 已 reap；
3. stdout/stderr drain 或 bounded incomplete；
4. post-run capture；
5. release OpenCode/Claude store lock；
6. plan per-turn cleanup；
7. DB transaction 写 turn terminal、清 in-flight；
8. 若 session 仍 active 且可继续，写 `idleDeadlineAt=now+10m`；
9. 若 session ending/blocked，进入 session cleanup。

不得先把 turn 写 terminal 再让进程继续写 session store。

### 12.2 Graceful shutdown

`gracefulShutdown` 增加 coordinator hook：

- 停止接纳新 turn；
- 所有 running turn durable 标记 cancel reason=`daemon-shutdown`；
- AbortController TERM→KILL；
- 在 shutdown budget 内 settle；
- queued/running survivor 标 interrupted，保留 PID/store identity；
- 可证明 store 完整的 logical session 保持 active，并从 recovery settle 时刻设置 10 分钟
  deadline；重启时 deadline 已过则直接 idle-expire。

### 12.3 Boot recovery

启动时、对外监听前：

1. queued turn：若 first turn 尚无 native session，标 interrupted +
   `session-unusable`；否则清 slot、允许用户重发；
2. running turn：调用从 `killStaleRunProcessTree` 抽出的 generic exact PID/startedAt/
   spawn-binary identity reaper；
3. identity match 且 reap 成功：turn interrupted，验证 store；
4. PID 不存在：turn interrupted，验证 store；
5. identity mismatch/无法证明：不杀未知进程，不删目录，cleanup quarantined，session ended
   `session-unusable`；
6. ending session：继续 cleanup；
7. active idle deadline 已过：进入 ending(idle-timeout)；
8. active 权限/runtime/MCP 已失效：进入对应 ending/blocked。

不得用 `/opencode|claude/` 模糊进程名 kill。

### 12.4 Idle reaper

coordinator 只维护一个 earliest-deadline timer；timer 触发后批量 CAS 所有到期 active+idle
session 为 ending，再逐个 cleanup。每次 create/turn-settle/message/end 后重新计算最早 deadline。
此外每分钟 reconciliation 是 timer 丢失、ACL hook 失败与 wall-clock 跳变的补偿。

turn hard deadline 另由 coordinator 的有界 queue/run timer 与 periodic reconciliation
处理；queued 到期写 `timed_out`，running 到期走 AbortController。两条路径都先持久化 intent，
并在任何 spawn 前执行 `queued → running` CAS，因此 cancel/end/timeout 不会在释放 semaphore
后反向变成迟到进程。

### 12.5 Cleanup failure

- 已证明没有 child，但文件删除失败：`cleanup_state=pending`，GC 重试；session 可显示 ended。
- 不能证明 child 已死或 store unlock：`cleanup_state=quarantined`，不删除；告警只含 stable
  ids/error code。
- pending（已证明无 child，只剩 capture/delete 重试）不阻止新会话；新会话使用全新不可预测
  目录。quarantined 仍可能有同一 MCP 的 live side effect，故阻止该 user+MCP 新建，直到
  recovery 证明安全；任何情况都不复用旧 path。
- GC 只有在重新通过 process/store identity 证明后才从 quarantined 转 pending/complete。

## 13. Frontend

### 13.1 组件结构

```text
McpInventoryPanel
  └─ trigger button
     └─ McpRuntimeTestDialog
        ├─ NoticeBanner(saved/dirty + side-effect warning)
        ├─ RuntimeSelect (new session only)
        ├─ status / idle deadline / runtime summary
        ├─ SessionConversationPanel
        ├─ TextArea composer
        └─ footer: Cancel turn / End test / Send
```

复用公共：

- `Dialog size="lg"` + trigger/initial-focus refs；
- `RuntimeSelect`，必要时最小扩展 capability filter prop，而不是 fork；
- `TextArea`；
- `NoticeBanner` / `ErrorBanner` / `LoadingState` / `EmptyState` / `FeedbackStack`；
- `StatusChip`；
- `ConfirmDialog`；
- `SessionConversationPanel`。

只为 conversation body/composer 响应式布局增加 MCP-test 命名空间 CSS；不自写 overlay、input、
select、button chrome。

`RuntimeSelect` 的 capability-filter 模式必须 fail closed：runtime registry 尚在 loading/error
时 picker disabled 并走公共 loading/error 状态，不能沿用当前“opencode/claude-code fallback
options”，因为 protocol 默认名不等于该 exact runtime 已声明/满足 `mcp-test-v1`。普通
settings/agent 调用不传 filter 时保持现有 fallback 行为。

### 13.2 Phase

```ts
type DialogPhase =
  | 'loading'
  | 'new'
  | 'submitting-first'
  | 'running'
  | 'idle'
  | 'ending'
  | 'ended'
  | 'error'
```

- first/message 提交从 click 到 202/错误全程 single-flight；
- running 时 composer disabled，Cancel 可用，End 可用；
- idle 时 composer enabled，显示绝对 expiry + 秒级纯展示倒计时；
- ending 时 send/cancel disabled，Dialog 仍可隐藏；
- ended 时历史 flow 可读，“开始新测试”为主操作。

### 13.3 Dirty flow

若详情 form dirty：

- Dialog 顶部 warning 明示当前保存 hash；
- “保存并开始”调用现有 detail save helper，校验 draft 未在 await 中变化，并使用 PUT receipt
  hash 创建 session；
- “使用已保存版本”直接使用当前 query row hash；
- 保存失败留在 Dialog，错误走 `ErrorBanner`；
- active session 已存在时忽略当前草稿，显示“本会话固定在 hash …；结束后才能使用新配置”。

### 13.4 Dismiss/focus

- 普通 close/Esc/overlay 永远只 `setOpen(false)`；
- HTTP mutation pending 不等于必须锁 Dialog：create/message 响应未落定时用
  `dismissDisabled` 防止重复非幂等交互；202 后 running 可以正常关闭；
- End 的确认层是 nested public `ConfirmDialog`；
- close 后焦点回 trigger；390px 下 footer 可换行但主 send/end 保持 ≥44px hit target。

### 13.5 Cache 与 live update

query keys：

```ts
;['mcps', mcpId, 'runtime-test-session'][
  ('mcps', mcpId, 'runtime-test-session', sessionId, 'session-view')
]
```

WS cursor 变化 invalidate metadata + active Session view。即使 metadata 先看到 terminal，
也像 `IntentTurnSession` 一样强制按最终 event cursor refetch 一次，避免停 poll 后遗漏尾批。

## 14. 失败模式

| 场景                               | Turn                                           | Session                                                      | 用户动作                         |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| runtime/MCP spawn 准备失败         | failed                                         | 首轮 unusable→ending；后续保留旧 native session 视证明而定   | 新建或在证明允许时重试           |
| provider/auth/model 失败           | failed                                         | native session 完整则 idle                                   | 修配置后；fingerprint 漂移则新建 |
| MCP request timeout                | tool error 或 turn failed                      | store 完整则 idle                                            | 可追问/重试                      |
| turn 10m timeout                   | timed_out                                      | store 完整则 idle                                            | 可续，否则新建                   |
| cancel                             | canceled                                       | native session/store 完整则 idle；首轮 pre-session 则 ending | 可续或新建                       |
| capture truncated/incomplete       | 业务状态独立                                   | continuation blocked                                         | end + new                        |
| native session id mismatch         | failed                                         | session-unusable→ending                                      | new                              |
| MCP hash/runtime fingerprint drift | 不创建新 turn；在跑 turn 可完成                | ending→ended                                                 | cleanup 后 new                   |
| deadline 已过同时发送              | 不创建 turn                                    | idle-timeout→ending                                          | new                              |
| end 同时发送                       | 一个 DB writer 获胜；end 获胜则 message 不创建 | ending                                                       | 等待 ended                       |
| response loss 后重发 message       | 返回同 clientMessageId receipt                 | 不重复模型调用                                               | 继续                             |
| MCP delete且 child 不可回收        | 不删 MCP                                       | ending/quarantined                                           | 管理员处理告警                   |
| daemon crash                       | interrupted                                    | boot proof 决定 active/ended                                 | 重开查看                         |

## 15. 测试策略

### 15.1 Shared

- 所有 enum/request/DTO/receipt strict parse；
- unknown field、oversize prompt、坏 hash/id 拒绝；
- Session response 仍只有 canonical schema。

### 15.2 DB/service

- partial unique：同 user+MCP 只一个 active/ending；不同 user 可并行；
- create first turn 原子性；
- single-flight CAS；
- idle deadline vs message/end 竞态两种提交顺序；
- clientMessageId exact replay 与 mismatch；
- owner/admin/另一可见用户/撤权 404 矩阵；
- MCP delete/disable/update、runtime disable/delete/edit；
- 用户删除 teardown 与 owner FK restrict；
- cleanup-complete 的旧 ended 显式替换；pending/quarantined recovery row 保留；
- 32 turns/20k events/16 MiB；
- secret 不进新表/DTO/log/fingerprint。

### 15.3 Driver/identity

OpenCode：

- exact one MCP controlled config；
- effective permission 只有 current MCP namespace；
- no repo/global config/skills/plugins/dependents/inventory/built-ins；
- new/owner ACK before prompt；
- resume preclaim/exact owner/lease/release；
- identity/binary/config/session/store mismatch pre-prompt fail；
- local/remote MCP、containment profile；
- crash store lock/recovery。

Claude：

- exact argv/env/private config dir；
- `--tools ""`、strict one-MCP、setting sources empty、no bypass；
- new/resume session id；
- fixture MCP 可调用，Read/Bash/Web/Agent 不可用；
- global/repo MCP 不可见；
- unsupported/custom binary fail closed。

RuntimeDriver：

- capability completeness/source guard；
- absent capability 不进 picker且后端 422；
- `runSystemAgent` 既有 no-MCP contract byte/behavior unchanged。

### 15.4 Process lifecycle

- normal/exit-nonzero/timeout/abort；
- queued cancel/end/hard-deadline 后拿到 semaphore 也不 spawn；
- TERM ignored → SIGKILL；
- grandchild/group kill；
- inherited pipe flush timeout；
- PID reuse/command mismatch 不误杀；
- turn terminal 写在 reap 后；
- graceful shutdown与 boot recovery；
- cleanup pending/quarantined；
- idle timer + reconciliation。

### 15.5 Capture/session

- 多 turn session-wide event sequence；
- resume replay external-key dedupe；
- root session first-set + exact subsequent match；
- `extraUserPrompts` 两轮以上；
- final cursor refetch；
- complete/truncated/incomplete precedence；
- tool use/result/reasoning/stderr masking；
- owner-only Session endpoint。

### 15.6 Frontend

- trigger/Dialog/public primitives/source guard；
- runtime default/filter/first-send lock；
- dirty 两路径与 active-session fixed hash；
- send/cancel/end/close/reopen；
- 关闭不调用 cancel/end；
- idle deadline 展示，打开/打字不产生续期请求；
- end nested confirm；
- strict Session renderer reuse；
- WS + polling final cursor；
- zh-CN/en-US；
- desktop light/dark、390px、keyboard focus trap/restore、axe。

### 15.7 真实 daemon E2E

使用 mock model runtime + fixture MCP，不调用外部 provider：

1. fixture MCP 暴露 read-like 与 stateful tool；
2. 第一轮调用 tool 并得到值；
3. 关闭 Dialog，后端 turn 继续；
4. 重开看到同一 Session；
5. 第二轮依赖第一轮上下文并再次调用 MCP；
6. 断言 native session id 相同、两个 user prompts、完整 tool events；
7. 尝试调用 builtin/其它 MCP 失败；
8. cancel 一轮后仍可续；
9. fake clock 推进 idle 10 分钟，session ended；
10. 新测试获得新 logical/native session；
11. queued 中立即结束不 spawn；running 中立即结束最终 child reap + cleanup complete。

## 16. 预计改动面

- `packages/shared/src/schemas/`：MCP runtime test contracts。
- `packages/backend/db/migrations/` 与 `src/db/schema.ts`：session/turn/event/create-receipt
  四张 test 表 + OpenCode playground owner。
- `packages/backend/src/services/mcpRuntimeTest*.ts`：service/coordinator/recovery/sink/view。
- `packages/backend/src/routes/mcps*.ts`、WS registry：HTTP 与 locator。
- `packages/backend/src/services/systemAgentRun.ts`：只抽 lifecycle core，行为保持。
- `packages/backend/src/services/runtime/types.ts`：可选 `mcpTest` capability。
- `packages/backend/src/services/runtime/opencode/`：mcp-test verified plan/manifest/owner adapter。
- `packages/backend/src/services/runtime/claudeCode/`：专用 MCP-only spawn。
- `packages/backend/src/services/shutdown.ts`、`cli/start.ts`：shutdown/boot hook。
- `packages/frontend/src/components/mcps/McpRuntimeTestDialog.tsx`。
- `McpInventoryPanel.tsx` / `mcps.detail.tsx`：入口与 save-basis bridge。
- `RuntimeSelect.tsx`：如需要，向后兼容的 capability filter。
- i18n、最小 MCP-test layout CSS、unit/integration/E2E。

实施前必须重新检查共享树、migration tail 与 RFC-237 最终改动，精确 path 操作，不覆盖并行 WIP。
