# RFC-367 — 技术设计

## 0. 现状锚点（file:line，2026-09-21 源码）

| 关注点            | 位置                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| 自建 spawn        | `packages/backend/src/modules/memory/application/distill/memoryDistiller.ts:782-871`（`defaultDistillerSpawn`） |
| stdout 尾巴       | 同上 `:868`（`run.rawStdout.slice(-DISTILLER_OUTPUT_CAP_BYTES)`，256KB）；行截断 `services/execution/managedProcess.ts:35`（1MiB） |
| 候选解析          | `memoryDistiller.ts:637-682`（`parseDistillerOutput`，三条 `log.warn` + `return []`） |
| 事后捕获          | `memoryDistiller.ts:974-988` → `modules/memory/infrastructure/memoryDistillSessionCapture.ts` → `services/runtime/opencode/distillSessionCapture.ts` |
| 调度器            | `modules/memory/application/distill/schedule.ts:305-352`（成功 `markDone` / 抛错 `markFailed`+退避） |
| 公共协议块        | `packages/shared/src/prompt.ts:876-940`（`buildProtocolBlock`）             |
| 公共补问文案      | `packages/shared/src/prompt.ts:1380+`（`renderEnvelopeFollowupPrompt`）、预算 `:1248`（`DEFAULT_PROTOCOL_RETRY_BUDGET=3`） |
| 系统代理运行原语  | `packages/backend/src/services/systemAgentRun.ts`（`runSystemAgent`，intent / change-narrative 已消费） |
| 事件 sink 契约    | `packages/backend/src/services/sessionEventSink.ts`（`SystemAgentEventSinkV1`） |
| runtime resume    | `services/runtime/opencode/spawn.ts:115`（`--session <id>`）、`claudeCode/spawn.ts:220`（`--resume <id>`） |
| 会话页投影        | `modules/memory/application/distillQueries.ts:266-317`（`getJobSessionView`） |
| 事后子会话清扫    | `services/systemAgentRun.ts:762-775`（`driver.captureSessionsToSink`）→ `services/runtime/opencode/driver.ts:482`（`includeRoot:false` 的 SQLite 走查）——**迁移后继承，不丢** |
| scratch orphan GC | `platform/persistence/sqlite/systemWorkspaceGc.ts:763-793`（`runScratchOrphanGc`，扫 `<appHome>/scratch`，24h 后回收非任务目录） |
| 提示词 SHA 基线   | `packages/backend/tests/memory-distiller-grep-output-lang-directive.test.ts:62,91`（`BASELINE_SHA256`，改提示词必须同批更新） |
| capture 源码锁    | `packages/backend/tests/rfc143-runtime-driver-capability.test.ts:344-348`（`readFileSync` 读 `memoryDistillSessionCapture.ts`，删文件会 ENOENT 抛错） |
| claude resume 依赖 cwd | `services/runtime/claudeCode/sessionCapture.ts:5,52-53`（`projects/<cwd-slug>/<sessionId>`）+ RFC-111 `design.md:225,283,298,363`（实测：不复用同目录 `--resume` 落空） |

opencode 侧已按 CLAUDE.md §「opencode 源码自取规则」核对：`opencode run` 的
`--session/-s` 是 "session id to continue"（`packages/opencode/src/cli/cmd/run.ts:152-156`）；
`--replay` 只在 `--mini` 交互模式生效，而 `--mini` 与 `--format json` 互斥（`run.ts:304-306,331,884`），
因此 resume 一轮不会把历史事件重放进我们的 stdout。

## 1. 总体数据流（目标态）

```
runDistill(job, siblings)
  ├─ 组 prompt（源事件 + 去重快照 + buildProtocolBlock + 语言指令）  [不变]
  ├─ savePrompt（attempts===0 时）                                   [不变]
  └─ round 循环（round = 0 … DEFAULT_PROTOCOL_RETRY_BUDGET）
       ├─ runFn({ …, prompt: round===0 ? 全量 prompt : followupPrompt,
       │           resumeSessionId: round===0 ? undefined : sessionId,
       │           eventSink: MemoryDistillSessionEventSink(jobId, attemptIndex) })
       ├─ saveSpawnResult({ sessionId: result.capturedSessionId, exitCode, stderrExcerpt })
       ├─ 进程级失败（spawn-failed/timeout/aborted/unreaped/exit-nonzero/result-error）→ throw（不补问）
       ├─ parseDistillerCandidates(result.eventText, nonce)
       │     ├─ ok  → validateAndPersistCandidate ×N → return DistillResult
       │     └─ err → 协议失败：有 sessionId 且预算未尽 → 组 followupPrompt，continue
       │                        否则 → throw DistillerProtocolError
       └─ （finally）scratch 由 runSystemAgent 自行清理
```

事件流唯一化：`runSystemAgent` 的 pump 把每行 stdout 交给 `driver.parseEvent` 规范化一次，
**同一份规范化事件**同时喂给 ①`eventText`（业务输出=候选解析输入）与 ②`eventSink`（会话记录）。
`SystemAgentEventSinkV1` 契约要求「sink 持久化失败不得影响业务结果」——本设计天然满足：解析读的
是内存里的 `eventText`，不读 `memory_distill_events`。

## 2. 接口契约

### 2.1 shared：新增一个补问 reason（渲染域）

`packages/shared/src/prompt.ts`

```ts
export type EnvelopeFollowupReason =
  | 'envelope-missing'
  | 'both-present'
  | 'clarify-malformed'
  | 'port-validation'
  | 'clarify-required'
  | 'envelope-port-malformed'
  | 'branch-marker'
  | 'port-missing'   // ← 新增
```

`renderEnvelopeFollowupPrompt` 为 `'port-missing'` 增加开场白（放在 `!hasClarify` 泛化分支之前，
与 `envelope-port-malformed` / `branch-marker` 同级）：

> Your previous reply in this session emitted a `<workflow-output>` envelope, but it contained no
> `<port name="...">` element — the JSON/body was placed directly inside the envelope (or inside a
> code fence). The framework reads ONLY `<port name="...">…</port>` children. Re-emit the envelope
> with every value wrapped in its port tag, with nothing between the envelope tag and the port tags.

**边界**：只动渲染域枚举，**不动** `FollowupFailureCode` / `FOLLOWUP_POLICY`（worker 节点的生产域
与路由 oracle）。节点侧「declared port 缺失只 warn」的既有行为零变更——那是另一条待评估的同类问题，
不在本 RFC 范围。`FOLLOWUP_POLICY` 是 `Record<FollowupFailureCode, …>`，不新增 key 即不会破坏其
编译期棘轮。

### 2.2 backend：`runSystemAgent` 最小扩展 resume

`packages/backend/src/services/systemAgentRun.ts`

```ts
export interface SystemAgentRunOptions {
  …
  /** 在既有原生会话内继续一轮（协议补问）。透传给 driver.buildSpawn。 */
  resumeSessionId?: string
}
```

`defaultUnifiedCtx()` 里按既有可选字段风格 spread：

```ts
...(opts.resumeSessionId != null && opts.resumeSessionId !== ''
  ? { resumeSessionId: opts.resumeSessionId }
  : {}),
```

不传时渲染出的 ctx 与今天**逐字段相同**（intent / change-narrative 零影响）。

### 2.3 memory/application：判别式解析结果

`memoryDistiller.ts`

```ts
export type DistillProtocolFailureCode =
  | 'envelope-missing'    // extractLastEnvelope 返回 null（含残标签 / nonce 不符）
  | 'port-missing'        // envelope 在，但 parseEnvelope.missingDeclared 含 'candidates'
  | 'port-malformed'      // parseEnvelope.malformedPorts 含 'candidates'（</port> 未闭合/损坏）
  | 'json-malformed'      // port 内容 JSON.parse 抛错
  | 'candidates-not-array'// 解析出的 candidates 不是数组

export type DistillerOutputParse =
  | { readonly ok: true; readonly candidates: RawCandidate[] }
  | { readonly ok: false; readonly code: DistillProtocolFailureCode; readonly detail?: string }

export function parseDistillerCandidates(
  eventText: string,
  envelopeNonce?: string,
): DistillerOutputParse
```

实现要点：

- **判定顺序固定为 `malformedPorts` → `missingDeclared`**（设计门 P3-3）：`envelope.ts:509-512`
  在 `</port>` 缺失时把端口塞进 `malformed` 且 **不**塞进 `collected`，而 `missingDeclared`
  是 `declaredOutputs.filter(p => !collected.has(p))`——所以「port 开了没闭合」会**同时**命中两
  个集合。若先看 `missingDeclared`，就会对一个确实写了 `<port name="candidates">` 的回复说
  「你把 JSON 直接放在 envelope 里了」，正是本 RFC 要消灭的那类错误纠正。
- 输入是**已规范化的 assistant 文本**，因此删除原 `parseDistillerOutput` 里那段
  `driver.parseEvent` 逐行走查——规范化只剩 pump 一个 owner（原函数的 `protocol` 入参随之消失）。
- 改用公共件 `parseEnvelope(envelope, ['candidates'], nonce)` 取代手写正则，`missingDeclared` /
  `malformedPorts` 直接映射成上面的 code。
- `{"candidates": []}` → `{ ok: true, candidates: [] }`（成功路径，AC-6）。
- `parsed.candidates === undefined` → 视为 `candidates-not-array`（今天是静默 `[]`；按 G4 的严格
  口径，缺字段是格式错误，不是「没有候选」）。

### 2.4 memory/application：协议错误类型

```ts
export class DistillerProtocolError extends Error {
  constructor(
    readonly code: DistillProtocolFailureCode,
    readonly roundsTried: number,
    readonly lastDetail?: string,
  ) {
    super(`distiller output protocol failure after ${roundsTried} round(s): ${code}`)
    this.name = 'DistillerProtocolError'
  }
}
```

调度器无需识别该类型：它 catch 任何抛错 → `markFailed({ error: message.slice(0,2000) })` + 退避，
`last_error` 自然带上 code 与轮次（AC-5）。

### 2.5 memory/infrastructure：实时事件 sink

新文件 `modules/memory/infrastructure/memoryDistillSessionEventSink.ts`

```ts
export function createMemoryDistillSessionEventSink(
  db: ProviderNeutralDatabase,
): (input: { distillJobId: string; attemptIndex: number }) => SystemAgentEventSinkV1
```

- `append(ev)` → INSERT `memory_distill_events`（`distill_job_id` / `attempt_index` / `ts` /
  `kind` / `payload` / `session_id` / `parent_session_id`）。
- **`session_id` 是 NOT NULL**，而流首几个事件可能尚未携带 session id。sink 内部持一个
  `pendingBeforeRoot: Event[]` 缓冲：`rootSessionId` 未知前入缓冲；`setRootSessionId(id)` 触发
  flush（缓冲行补写该 id）并转为直写。运行结束仍未取得 id → 丢弃缓冲并 `log.warn`（capture 是
  辅助记录，不得反过来 gate 业务结果；对应 AC-9 的业务侧判定另行由 `capturedSessionId` 缺失触发）。
- **marker 行的 `session_id` 走哨兵值**（设计门 P3-7）：`memory_distill_events.session_id` 是
  `NOT NULL`（`db/schema.ts:4246`），而 `markTerminal('incomplete', …)` 可能在**从未拿到 root
  session id** 时触发（spawn 失败轮）。若此时 INSERT 违反 NOT NULL，`runSystemAgent` 的
  `markSinkTerminal` 会把异常吞掉（`systemAgentRun.ts:327-332`），结果该 attempt 在
  `memory_distill_events` 里一行都没有，详情页连 `captureFailed` 徽标都渲染不出来——AC-9 的
  失败在 UI 上彻底无痕。故 sink 在 root 未知时用 `parseSessionTree` 已识别的
  `UNKNOWN_SESSION_ID` 哨兵写 marker 行。
- `markTerminal(state, reason)`：`state !== 'complete'` 时写一行既有
  `DISTILL_CAPTURE_FAILED_KIND`（`rfc043/distill-capture-failed`）marker，payload 带 reason ——
  会话页 `captureFailed` 标记（`distillQueries.ts:281`）因此继续工作。
- 顺序性：与 intent 的 `IntentTurnSessionEventSink` 同构，用 promise tail 串行化写入。
- 不做行数/字节上限（与今天的事后走查一致）；stderr 行照常落库，`sessionView.ts:379-385` 已能渲染。

### 2.6 端口收缩

`application/ports/distillWorkStore.ts`：

- 删除 `captureSession(input: MemoryDistillCaptureInput): Promise<void>` 与
  `MemoryDistillCaptureInput`。
- 新增 `eventSinkFor(input: { distillJobId: string; attemptIndex: number }): SystemAgentEventSinkV1`
  ——由 `MemoryDistillWorkStore` 提供（store 已是 DB 持有者），`runDistill` 不直接碰 db。

`public/commands.ts` / bootstrap 装配：`MemoryDistillWorkerOptions` 不变（`timeoutMs` 等既有字段
保持，含并发 session 正在加的 `config.memoryDistillTimeoutMs` 通路）。

### 2.8 输出保留上限的行为差 + 缺失原因分类器归位

**行为差（必须写明）**：今天 `result.stdout = run.rawStdout.slice(-256KB)` 是**留尾**，结构上总能
覆盖最后一个 envelope；`runSystemAgent` 的 `eventText` 是**留头**——`systemAgentRun.ts:615-625`
一旦 `eventTextBytes + bytes > maxEventTextBytes`（默认 8MB）就丢弃后续 assistant 文本并置
`outputEvidence.eventTextCapHit = true`。

| 场景                    | 今天（256KB 留尾）  | 目标态（8MB 留头）                                      |
| ----------------------- | ------------------- | ------------------------------------------------------- |
| assistant 文本 < 256KB  | 可解析              | 可解析（保真度更高：无 1MiB 行截断）                    |
| 256KB ~ 8MB             | **可能丢**（尾巴外）| 可解析                                                  |
| > 8MB                   | 可解析（留尾）      | envelope 被截掉 → 判协议失败                            |

> 判断：>8MB 的蒸馏输出在本产品里属病态（候选 JSON 上限 ~400 字符 × N），而且新设计下它**不再静默**
> ——协议失败会补问，补问轮只重发 envelope、输出极小，天然自愈；补问仍失败才 markFailed。
> 因此接受该行为差，但要求失败原因如实说明（见下）。

**另两条一并写明（设计门 P3-5）**：

- **非 JSON 行不再进解析缓冲**。今天 `parseDistillerOutput` 把 `driver.parseEvent` 返回 `null`
  的行**原样保留**在 envelope 搜索缓冲里（`memoryDistiller.ts:653-655`）；`runSystemAgent` 对
  同一档只置 `outputEvidence.unparsedStdoutSeen`、落 sink，**不进 `eventText`**
  （`systemAgentRun.ts:601-611`）。生产上 `--format json` / `--output-format stream-json` 不会把
  envelope 印在非事件行上，故影响面是测试夹具（`memory-distiller.test.ts` 的「clean envelope on
  raw stdout」一例按新口径迁移），不是产品行为。
- **stderr 从「256KB 留尾 + `redactGitUrl`」变成「8KB 留头 + `maskDiagnosticsText`」**
  （`systemAgentRun.ts` 的 `STDERR_TAIL_CAP = 8 * 1024`）。`stderr_excerpt` 本就只是诊断摘要，
  且 8KB 留头对「进程启动就报错」这类最常见场景更有用；接受。

**缺失原因分类器归位**：intent 已有一个纯函数
`classifyMissingEnvelope(evidence): MissingEnvelopeReason`（`modules/intent/application/turnEngine.ts:126-150`，
取值 `output-cap-hit` / `no-assistant-text` / `terminal-without-envelope` /
`assistant-stopped-without-envelope` / `runtime-shape-unknown`），内容与 intent 毫无耦合，只读
`SystemAgentOutputEvidence`。memory 不得跨 context import intent（RFC-294），而复制一份又会漂移，
因此**把它连同 `MissingEnvelopeReason` 迁到 `SystemAgentOutputEvidence` 的中立同侧**
（`services/systemAgentRun.ts`，与 `releaseSystemAgentScratch` 同级导出），intent 改为从新家
import（**零行为变更**，只改 import 与 re-export 点）。

**用法收窄（设计门 P3-4）**：该分类器的**整个值域都是「为什么没有 envelope」**。对
`port-missing` / `json-malformed` 这类「envelope 明明在」的失败，它会返回
`assistant-stopped-without-envelope`，写进 `last_error` 就是在告诉管理员「模型没发 envelope」
——又一句假话。因此：

- `code === 'envelope-missing'` 时才调 `classifyMissingEnvelope`，其结果进 detail；
- 其余 code 只读 `evidence.eventTextCapHit`（真 → 追加「上一轮回复超出保留上限被截断」），
  格式错本身由 `DistillProtocolFailureCode` 自己讲清楚。

`runDistill` 用它把证据写进两处：

- `DistillerProtocolError.lastDetail` → 最终落 `memory_distill_jobs.last_error`，管理员能区分
  「模型没按格式写」与「输出超过保留上限被截断」；
- 补问 prompt 的 detail 行（design §3 的 `json-malformed` / `candidates-not-array` 之外，
  `envelope-missing` 且 `output-cap-hit` 时追加一句「上一轮回复过长被截断，请只回 envelope、
  不要复述任何输入」）。

### 2.7 退役清单

| 退役对象                                                     | 去向                                    |
| ------------------------------------------------------------ | --------------------------------------- |
| `defaultDistillerSpawn` / `DistillerSpawnFn` / `DistillerSpawnInput` / `DistillerSpawnResult` | `runSystemAgent` + `runFn` 测试缝       |
| `IndeterminateRuntimeProcessError`                            | `SystemAgentRunStatus: 'unreaped'` 映射 |
| `extractFirstSessionIdFromStdout`                             | `result.capturedSessionId`              |
| `parseDistillerOutput`（含 driver 逐行走查）                  | `parseDistillerCandidates`              |
| `DISTILLER_OUTPUT_CAP_BYTES` / `DISTILLER_DRAIN_GRACE_MS`     | executor 既有边界                       |
| `services/runtime/opencode/distillSessionCapture.ts`、`RuntimeDriver.captureDistillSession`、`DistillSessionCaptureContext/Sink`、`infrastructure/memoryDistillSessionCapture.ts` | 实时 sink（C1）                          |

**`DISTILL_CAPTURE_FAILED_KIND` 的落点（设计门 P3-1 更正）**：初稿说「保持原导出点、不改
import 图」，与「删掉定义它的 `distillSessionCapture.ts`」自相矛盾。实际情况是它已经有第二个
中立定义点——`modules/runtime-management/public/types.ts`，`distillQueries.ts` 正是从那里取的。
因此：`services/runtime/index.ts` 的 re-export 改为从 `modules/runtime-management/public/types`
转出，`tests/distill-session-capture.test.ts` 与 `tests/routes-memory-distill-job-detail.test.ts`
的 import 保持可用。

**`captureDistillSession` 的源码锁必须同批改写（设计门 P2-2）**：
`tests/rfc143-runtime-driver-capability.test.ts:344-348` 用 `readFileSync` 直接读
`modules/memory/infrastructure/memoryDistillSessionCapture.ts` 并断言它包含
`getRuntimeDriver(input.protocol).captureDistillSession?.(`。**删文件会让这条守卫 ENOENT 抛错**
（不是 fail 是 error）。T7 必须把它改写成新不变量：memory 模块不得再出现
`captureDistillSession` 引用。

## 3. 补问循环的精确语义

```
budget   = DEFAULT_PROTOCOL_RETRY_BUDGET   // 3，语义：首轮之后最多 3 次补问（总计 ≤4 轮）
deadline = now() + timeoutMs               // §3.2：整次蒸馏（含全部补问轮）共享一个总预算
scratchName = `distiller-${rand}`          // §3.1：整条补问链共用一个 scratch
sessionId: string | undefined
for (round = 0; round <= budget; round++) {
  remaining = deadline - now()
  if (remaining <= 0) throw new Error(`distiller timeout after ${timeoutMs}ms`)
  prompt = round === 0 ? fullPrompt
                       : renderEnvelopeFollowupPrompt({
                           hasClarifyChannel: false,
                           reason: reasonFor(lastCode),   // port-missing / envelope-port-malformed / envelope-missing
                           envelopeNonce,
                         }) + detailFor(lastCode, lastEvidence)
  result = await runFn({
    …, prompt, scratchName, timeoutMs: remaining,
    retainScratchOnSuccess: true,                         // §3.1：链未结束前不许删
    ...(round > 0 ? { resumeSessionId: sessionId! } : {}),
  })
  sessionId ??= result.capturedSessionId
  saveSpawnResult(...)                     // 每轮覆盖（与今天「retry 覆盖」语义一致）
  if (result.status !== 'ok') { releaseChainScratch(result); throw mapRunStatus(result) }
  parse = parseDistillerCandidates(result.eventText, envelopeNonce)
  if (parse.ok) { releaseChainScratch(result); return persist(parse.candidates) }
  lastCode = parse.code; lastEvidence = result.outputEvidence
  if (sessionId === undefined) { releaseChainScratch(result); throw new DistillerProtocolError(lastCode, round + 1) }  // AC-9
}
releaseChainScratch(lastResult)
throw new DistillerProtocolError(lastCode, budget + 1, detailFor(lastCode, lastEvidence))
```

`reasonFor` 映射（全部落在 `hasClarifyChannel: false` 分支，措辞准确性是本次的核心诉求）：

| code                   | reason                     |
| ---------------------- | -------------------------- |
| `envelope-missing`     | `'envelope-missing'`       |
| `port-missing`         | `'port-missing'`（新增）   |
| `port-malformed`       | `'envelope-port-malformed'`|
| `json-malformed`       | `'port-missing'` + detail  |
| `candidates-not-array` | `'port-missing'` + detail  |

> `json-malformed` / `candidates-not-array` 复用 `'port-missing'` 的开场白会**措辞不准**，因此这两
> 者由 `runDistill` 在补问 prompt 尾部追加一行 detail（`The "candidates" port was present but its
> content was not the required JSON object …`）。detail 是 `runDistill` 本地拼的字符串，不进 shared
> 渲染域——shared 保持「纯字符串拼接、不懂业务」。

**整条补问链共用一个 scratch（设计门 P1-2 改判）**：初稿写的是「每轮独立 scratch，会话状态在
runtime 自己的 store 里，scratch 只是 cwd」——对 opencode 成立（会话按 id 存 SQLite，
`opencode run --session <id>` 与 cwd 无关），**对 claude-code 不成立**：claude 的 transcript 落在
`<configRoot>/projects/<cwd-slug>/<sessionId>.jsonl`（`services/runtime/claudeCode/sessionCapture.ts:5,52-53`
的路径布局；RFC-111 `design.md:225/283/298/363` 记录了实测——「不复用同一持久目录，`--resume`
就找不到上一轮会话文件」）。换 scratch = 换 cwd-slug = `--resume` 落空，claude-code 上的补问
**必然失败**，AC-3/AC-4/AC-8 在该 runtime 下直接不可达。

因此：`runDistill` 自己生成**一个** `scratchName` 贯穿全链，每轮都传 `retainScratchOnSuccess: true`
（否则 round 0 的 `status==='ok'` 会让 `runSystemAgent` 把目录删掉），链结束时由 `runDistill`
显式释放（§3.1）。opencode 侧这么做无任何代价。

### 3.1 scratch 归属与释放（设计门 P1-1 / P3-2 改判）

**先更正初稿的两个错误前提。**

① 「`~/.agent-workflow/scratch/distiller-*` 没有 GC owner」——**错**。
`platform/persistence/sqlite/systemWorkspaceGc.ts:763-793` 的 `runScratchOrphanGc` 会 readdir
`<appHome>/scratch` 下**每一个**目录，凡是名字不对应现存 `tasks.id`、也不在物化租约里的，超过
`SCRATCH_ORPHAN_MIN_AGE_MS`（24h）一律 `rm -rf`。所以显式释放的价值是「别让失败残留白占 24
小时」，不是「防永久泄漏」。

② 「非 ok 状态一律释放即可与今天等价」——**错，且危险**。
`runSystemAgent` 在 `plan.cleanup()` 抛错时会把结果改写成
`{ status: 'spawn-failed', stderrTail: 'runtime cleanup failed', scratchRetained: true }` 并
**跳过自己的 rmSync**（`services/systemAgentRun.ts:783-794`）——这正是「子进程可能还持有
scratch 下的文件」的那一档。今天的蒸馏器对同一档的处置是 `preserveCwd = true` +
`IndeterminateRuntimeProcessError`（`memoryDistiller.ts` 的 `finally` 段）。若按「非 ok 且非
unreaped 就释放」，就会在活着的孙进程脚下 `rm -rf`，把两处现存代码专门防的事做了一遍。

**释放规则**（`releaseChainScratch`，整链只执行一次，且只在链终止时）：

| `result.status`                                  | 处置     | 理由                                                     |
| ------------------------------------------------ | -------- | -------------------------------------------------------- |
| `ok`（链正常结束）                                | **释放** | 子进程已 reap、plan cleanup 已成功                        |
| `timeout` / `aborted` / `exit-nonzero` / `result-error` | **释放** | 同上：executor 已完成 TERM→KILL→reap，cleanup 也跑过了     |
| `unreaped`                                        | 保留     | 子进程未确认死亡，可能仍持有文件（今天同）                 |
| `spawn-failed`                                    | 保留     | 与「cleanup 失败被改写成 spawn-failed」不可区分，宁可留给 24h orphan GC |

```ts
const scratchParent = join(Paths.root, 'scratch')
const scratchName = `distiller-${randomBytes(8).toString('hex')}`   // 整链一个
function releaseChainScratch(result: SystemAgentRunResult): void {
  if (result.status === 'unreaped' || result.status === 'spawn-failed') return
  releaseSystemAgentScratch({ scratchDir: result.scratchDir, expectedParent: scratchParent, expectedName: scratchName })
}
```

`releaseSystemAgentScratch`（`systemAgentRun.ts:204`）是既有导出件，自带
`scratchDir === join(expectedParent, expectedName)` 校验与符号链接拒绝，因此 `scratchName`
必须由 `runDistill` 生成并同时用于 `runFn` 与释放。

AC 追加：**AC-12** —— `ok` / `timeout` / `aborted` / `exit-nonzero` / `result-error` 跑完后 scratch
目录不复存在；`unreaped` / `spawn-failed` 跑完后仍存在（交给 orphan GC）。

### 3.2 超时预算：整次蒸馏一个总额度（设计门 P2-4，用户 2026-09-21 裁决）

补问把「一次蒸馏 = 一个子进程」变成「一次蒸馏 = 最多 4 个子进程」。若每轮各享完整
`timeoutMs`，最坏阻塞是
`DISTILL_BATCH_LIMIT(5 个 head 串行) × 4 轮 × timeoutMs(默认 1h) = 20h`
（`schedule.ts:100` 的批量上限、`for (const head of heads)` 的串行、以及 ticker 的单飞重入
保护共同决定），而蒸馏 loop 单飞——这 20 小时里整个蒸馏队列停摆。

**裁决：`config.memoryDistillTimeoutMs` 的语义 = 「本次蒸馏（含全部补问轮）总共最多跑多久」。**
`runDistill` 进门算一次 `deadline`，每轮把**剩余额度**当作该轮 `timeoutMs`；额度耗尽即按超时
失败（与今天的超时同一条错误路径，走调度器退避）。最坏 tick 阻塞回到 `5 × timeoutMs`，与
今天相同；设置页那句「一次蒸馏最多跑 1 小时」也就字面为真。

## 4. 提示词改动

### 4.1 系统提示词（`domain/distillPrompt.ts`）

替换末段「Output exactly one workflow-output envelope using the exact opening tag …」为：

```
Output EXACTLY ONE workflow-output envelope. Copy the opening tag — including its `nonce` attribute —
byte-for-byte from the user prompt; do not abbreviate or re-spell the tag name. The envelope contains
exactly one port element named "candidates". Literal shape:

<workflow-output nonce="THE-NONCE-FROM-THE-USER-PROMPT">
<port name="candidates">{"candidates": [ … ]}</port>
</workflow-output>

The JSON goes DIRECTLY inside <port name="candidates">…</port>. Do NOT wrap it in a ``` code fence.
Do NOT put the JSON between the envelope tag and the port tag. A reply whose JSON is not inside a
<port name="candidates"> element is discarded in full.
```

JSON 形状说明与 `{"candidates": []}` 兜底句保持原位不动。所有被 grep 守卫锁定的字面量
（`real business workflows` / `BUSINESS and ARCHITECTURE` / 十个 `[category:xxx]` / `rationale` /
`ALWAYS include the chosen category as a tag` / 三条 REJECT 字面）**逐字保留**。

### 4.2 用户提示词（`buildDistillerUserPrompt`）

```ts
lines.push('# Instructions')
lines.push(buildProtocolBlock(['candidates'], undefined, envelopeNonce).trimStart())
lines.push('The "candidates" port carries the JSON shape documented in your system prompt. If nothing is worth distilling, emit `{"candidates": []}` inside that port.')
lines.push('', DISTILLER_OUTPUT_LANG_DIRECTIVE[outputLang])
```

`buildProtocolBlock` 会渲染出 open tag + nonce 必填告警 + `Format:` 段（含
`  <port name="candidates">...</port>` 与 `</workflow-output>`），正是今天缺失的字面语法。
语言指令仍在最后（RFC-050 的「离生成点最近」原则不变）。

## 5. 失败模式表

| 场景                                   | 今天                    | 目标态                                                    |
| -------------------------------------- | ----------------------- | --------------------------------------------------------- |
| 无 envelope（含残标签 / nonce 不符）   | warn + done(0)          | 补问（`envelope-missing`）→ 用尽 failed                    |
| 有 envelope 无 port（本次生产实况）    | warn + done(0)          | 补问（`port-missing`）→ 用尽 failed                        |
| port 未闭合                            | 正则匹配失败 → done(0)  | 补问（`envelope-port-malformed`）→ 用尽 failed             |
| port 内 JSON 非法 / 围栏               | warn + done(0)          | 补问（`port-missing` + detail）→ 用尽 failed               |
| `{"candidates": []}`                   | done(0)                 | **不变**：done(0)、不补问                                  |
| 单条候选 zod 不过（**部分**）          | warn + skip（保留其余） | **不变**：warn + skip（批量可救优先，非协议层问题）        |
| 候选**全部** zod 不过（N>0 落 0）      | warn + done(0)（绿）    | **改**：job failed，`last_error` 写明「解析出 N 条、0 条通过校验」+ 首条拒因（用户 2026-09-21 裁决；AC-14） |
| spawn 失败 / 超时 / 非零退出 / unreaped| throw → 退避重试        | **不变**（由 `SystemAgentRunStatus` 映射）；不补问；scratch 按 §3.1 显式释放（unreaped 除外） |
| 无 session id + 协议失败               | warn + done(0)          | 直接 failed（无法 resume，交给调度器整批退避）             |
| sink 落库失败                          | warn，不影响结果        | **不变**：`markTerminal('incomplete')` + marker 行          |

## 6. 测试策略（CLAUDE.md §Test-with-every-change）

纯函数优先，三层：

**L1 纯函数**
- `parseDistillerCandidates`：七类输入（合规 / 空数组 / 无 envelope / 残标签 / 无 port / 围栏 JSON /
  未闭合 port / candidates 缺字段）各一例，断言 `ok` 与 `code`。三条畸形用例的 fixture **直接取自
  2026-09-21 生产捕获**，文件头注释写明取证来源与 job id。
- `reasonFor` 映射表逐项。
- `renderEnvelopeFollowupPrompt({reason:'port-missing'})` 文案断言（含 `<port name=` 字面）。
- 提示词 grep 守卫：系统提示词含三层嵌套字面 + 「no ``` code fence」；用户提示词尾部含
  `buildProtocolBlock` 产物的 `Format:` 与 `</workflow-output>`；既有业务焦点守卫全部保留。

**L2 编排（`runFn` 假件，不起子进程）**
- 首轮无 port → 第二轮假件收到 `resumeSessionId === 首轮 capturedSessionId` 且 prompt 含补问文案 →
  第二轮合规 → 候选落库、`DistillResult.candidatesCreated` 正确（AC-3/AC-4）。
- 连续 4 轮畸形 → 抛 `DistillerProtocolError`，`roundsTried === 4`（AC-5）。
- 首轮 `capturedSessionId === undefined` + 畸形 → 一轮即抛，假件只被调用一次（AC-9）。
- `{"candidates": []}` → done、0 候选、假件只调一次（AC-6）。
- `status !== 'ok'` 的六种取值各断言「抛错且不补问」。
- sink：假 sink 记录 append 顺序，断言 root 未知前的缓冲 flush 行为。

**L3 调度器 + 库（`describeEachProvider` 双库）**
- 畸形输出跑完整 `distillTick`：job 落 `failed`、`last_error` 含 code、`next_run_at` 有退避；
  达 `DISTILL_MAX_ATTEMPTS` 后 `retryAt === null`（AC-2/AC-5）。
- 合规输出：job `done`、`memories` 有 `distill_job_id` 回链（AC-4）。
- `memory_distill_events` 由 sink 写入后，`getJobSessionView` 能渲染出 attempt 与 tree（AC-7/AC-8，
  claude-code protocol 也跑一遍）。

**现存用例迁移**：`memory-distiller.test.ts`（`parseDistillerOutput` 段 + `runDistill orchestration`
段）、`memory-distill-scheduler*.test.ts`、`memory-distiller-capture-rfc043.test.ts`、
`distill-session-capture.test.ts` 全部改用 `runFn` 缝；`distill-session-capture.test.ts` 若只覆盖被
退役的 SQLite 走查则整体删除，并在新 sink 测试头注释里写明它取代了谁。

## 7. RFC-294 对齐

- **落位**：`memory` bounded context。`domain/distillPrompt.ts`（提示词常量，纯数据）、
  `application/distill/*`（编排 + 解析纯函数）、`application/ports/distillWorkStore.ts`（sink 工厂
  端口）、`infrastructure/memoryDistillSessionEventSink.ts`（DB 适配）。分层与 RFC-294 的
  `domain / application / ports / infrastructure` 一致。
- **跨模块依赖**：application 直接 import `@/services/systemAgentRun` 与 `@/services/envelope` —
  与 intent（`modules/intent/application/turnEngine.ts:36-44`）、change-narrative 的既有批准形态
  同构，不新增 cross-context 内部 import，不新增 facade。
- **演进增量**：本 RFC 把 memory 模块对「进程/协议」的自建实现（spawn + stdout 尾巴 + driver 专有
  capture 方法）清零，全部回到共享 kernel，减少 `services/runtime` 的 driver 可选方法面
  （`captureDistillSession` 退役 = RuntimeDriver 接口收窄一格）。
- **偏离项（请用户确认）**：`runSystemAgent` 本身仍在 legacy `services/` 下，本 RFC **只做最小
  扩展（+`resumeSessionId`）不顺手迁位**——它的归位属 RFC-294 后续 wave，本 RFC 不承担。
