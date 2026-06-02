# RFC-077 — 技术设计

> 配套：`proposal.md`（背景/目标）、`plan.md`（任务分解）。
>
> 本文以"先盘点现状 → 列出必须保留的差异 → 提出抽象 → 映射三站点 → 失败模式 → 测试策略 → 备选方案"展开。

## 1. 现状盘点：已共享 vs 仍复制

### 1.1 已经共享（无需动）

| 工件 | 定义处 | 复用方 |
| --- | --- | --- |
| `resolveOpencodeDbPath(env?)` | `sessionCapture.ts:80` | ②③ import |
| `transcodeOpencodeRowsToEvents({sessionId,messages,parts})` | `sessionCapture.ts:133` | ②③ import |
| `loadSiblingsCapturedSessionIds(db,taskId,myNodeRunId)` | `sessionCapture.ts:326` | ③ import（②不需要）|
| `TranscodedEvent` 类型 | `sessionCapture.ts:119` | ③ 隐式经 transcode 返回值 |

### 1.2 仍逐字复制（本 RFC 目标）

| 复制片段 | ① sessionCapture | ② distillSessionCapture | ③ subagentLiveCapture |
| --- | --- | --- | --- |
| `OpencodeSessionRow/MessageRow/PartRow` 接口 | `:100-117` | `:41-58` | `:85-102` |
| BFS（visited+queue+`WHERE parent_id=?`）| `:212-230` | `:94-118` | `:174-192` |
| 逐 session 两条 SELECT | `:248-259` | `:122-133` | `:198-209` |
| `markCaptureFailed`（marker 行 + 永不抛）| `:348-367` | `:175-193` | —（live 不写 marker，靠 auto-disable）|

## 2. 必须保留的差异（抽象的约束条件）

任何统一方案**不得**抹平以下按 owner 真实不同的语义。这张表是设计的核心约束，也是 review 的检查清单：

| 维度 | ① 节点后置 | ② 蒸馏后置 | ③ 实时轮询 |
| --- | --- | --- | --- |
| **root 是否纳入 order** | **否**（root 事件由 stdout pump 实时写，BFS 只收子孙）`:213/227` | **是**（蒸馏不经我们的 pump，SQLite 是唯一源，显式 seed rootRow `:98-101`）| **否**（同①，root 由 pump 写）`:175/189` |
| **目标表 / 行形状** | `nodeRunEvents{nodeRunId,ts,kind,payload,sessionId,parentSessionId}` | `memoryDistillEvents{distillJobId,attemptIndex,ts,kind,payload,sessionId,parentSessionId}` | 同① |
| **marker kind** | `'subagent_capture_failed'` | `'rfc043/distill-capture-failed'`（导出常量 `DISTILL_CAPTURE_FAILED_KIND`）| 无 marker |
| **sibling-session 去重** | 有（`taskId` 时 `loadSiblingsCapturedSessionIds` → skip set）`:237-247` | **无** | 有（首 tick 缓存 sibling set）`:169-171/197` |
| **partId 去重** | 有（`alreadyInsertedPartIds` 过滤 live 已写的 part）`:266-270` | **无** | 有（自管 `insertedPartIdsBySession`，且**transcode 丢空时也要标记 fresh part 为已见**避免每 tick 重处理）`:211-231/243-247` |
| **DB 句柄生命周期** | 每次 open→close（`:209/308`）| 同①（`:90/167`）| **跨 tick 复用**，错误时丢弃重开（`:160-162/272`）|
| **编排** | 一次性 | 一次性 | interval 调度 + 重入保护 + 连续失败 auto-disable + `onInsert` 回调 + `stats()` 暴露 partId memo 回灌后置捕获 |

**关键洞察**：差异几乎全部落在"句柄生命周期 + insert/dedup + 编排"层；而"BFS 遍历 + 逐 session 读 message/part"这层在三处**完全相同**（只差一个 root-inclusion 布尔）。因此抽象边界应当切在"遍历/读取"与"落库/编排"之间。

## 3. 提出的抽象

新建 `packages/backend/src/services/opencodeSessionWalk.ts`，**只负责遍历与读取**，吃掉 §1.2 表中前三行复制。生命周期与落库留给调用方。

### 3.1 行接口（单一声明，导出）

```ts
export interface OpencodeSessionRow { id: string; parent_id: string | null; agent: string | null }
export interface OpencodeMessageRow { id: string; time_created: number; data: string }
export interface OpencodePartRow { id: string; message_id: string; time_created: number; data: string }

export interface WalkedSession {
  session: OpencodeSessionRow
  messages: OpencodeMessageRow[]
  parts: OpencodePartRow[]
}
```

### 3.2 遍历核心（吃掉 BFS + 逐 session SELECT）

```ts
/**
 * BFS the opencode session tree from rootSessionId over an ALREADY-OPEN
 * readonly handle, yielding each reached session with its message+part rows.
 * Caller owns the Database lifecycle (one-shot paths open/close per call;
 * the live poller reuses one handle across ticks).
 *
 * includeRoot=false  → root is only a BFS seed, never yielded (node paths:
 *                      root events come from the stdout pump).
 * includeRoot=true   → root session row is seeded into the yield order first
 *                      (distiller: SQLite is the only source for root events).
 *
 * Bounded by a visited set → malformed self-loops can't hang the runner.
 */
export function* walkOpencodeSessions(
  db: Database,
  rootSessionId: string,
  opts: { includeRoot: boolean },
): Generator<WalkedSession>
```

实现 = 把三处的 BFS（含 distill 的 `SELECT ... WHERE id=?` 根 seed，仅 `includeRoot` 时执行）+ 两条逐 session SELECT 合并为一份。**纯遍历，不做 dedup、不 transcode、不 insert**——这些是调用方差异，留在站点内。

### 3.3 失败 marker（吃掉 §1.2 第四行，可选小工具）

```ts
// opencodeSessionWalk.ts —— 仅 ①② 用，③ 无 marker
export async function writeCaptureFailedMarker(args: {
  insert: (row: CaptureFailedRow) => Promise<void>  // owner 提供：往自己的表插一行
  kind: string
  rootSessionId: string
  reason: string
}): Promise<void>  // 永不抛（内部 try/catch 吞掉，与现状一致）
```

> 该工具是否值得抽取见 §6 Option 取舍——它很小，但能把"marker 永不抛"这条不变式收敛到一处。

### 3.4 （可选，Option C）落库 sink 接口

若进一步统一 insert 循环：

```ts
export interface CaptureSink {
  readonly markerKind: string | null
  insertSessionEvents(s: { sessionId: string; parentSessionId: string | null; events: TranscodedEvent[] }): Promise<number>
  markFailed(rootSessionId: string, reason: string): Promise<void>
}
```

一次性站点再加一个 driver：
```ts
export async function captureOnce(args: {
  sink: CaptureSink
  dbPath?: string
  rootSessionId: string
  includeRoot: boolean
  skipSession?: (sessionId: string) => boolean      // ① sibling set；② 恒 false
  filterParts?: (sessionId: string, parts: OpencodePartRow[]) => OpencodePartRow[]  // ① partId 过滤；② identity
}): Promise<{ capturedSessionIds: string[]; insertedEventRows: number; failed: boolean; failureReason?: string }>
```
`captureChildSessions` / `captureDistillJobSession` 退化为"构造 sink + 调 `captureOnce`"。**Option C 不在首个 PR 强求**（见 §6）。

## 4. 三站点映射

| 站点 | 改动 | 保留 |
| --- | --- | --- |
| ① `captureChildSessions` | BFS+SELECT → `walkOpencodeSessions(db, root, {includeRoot:false})`；删本地行接口；marker 改用 `writeCaptureFailedMarker` | open/close、sibling skip、partId 过滤、row 形状、返回结构、永不抛 |
| ② `captureDistillJobSession` | 同上但 `{includeRoot:true}`；marker 同样收敛 | open/close、root 纳入、`attemptIndex` 行形状、`DISTILL_CAPTURE_FAILED_KIND` |
| ③ live poller tick 内 | tick 里那段 BFS+SELECT → `walkOpencodeSessions(opencodeDb, root, {includeRoot:false})`；删本地行接口 | **整个编排不动**：跨 tick 句柄复用、重入保护、auto-disable、`onInsert`、`stats()`、partId memo（含"transcode 丢空也标记 fresh 为已见"`:222-231`）、sibling skip |

> ③ 的"transcode 返回空数组时仍要把这批 fresh part 标记为已见"是个**易漏的细节**（否则每 tick 重读同一批 garbage）。统一遍历核心后，这段逻辑**仍留在 live tick 内**（它属于 dedup/编排，不属于遍历），由 `subagent-live-capture` 现有测试守护。

## 5. 失败模式（必须与现状逐条一致）

1. **opencode DB 不存在**：①② 写各自 marker 行 + warn + 返回 `failed:true, reason:'opencode-db-not-found'`；③ 抛进 tick 的 catch → 计一次失败、不写 marker、可能 auto-disable。`existsSync` 守卫位置：①② 在 driver 入口、③ 在 tick 内（句柄复用语义不同），故 `existsSync` **不进 `walkOpencodeSessions`**，留在各调用方。
2. **遍历中途 SELECT 抛**（schema mismatch）：①② driver catch → marker + failed 结果；③ tick catch → 丢句柄重开 + 失败计数。`walkOpencodeSessions` 自身**不吞异常**（让调用方按自己的语义处理），但内部 visited-set 保证 self-loop 不挂。
3. **marker 写入本身失败**：吞掉（现状 `sessionCapture.ts:363` / `distillSessionCapture.ts:190`），保证父运行路径不受影响——`writeCaptureFailedMarker` 内部 try/catch 复刻。
4. **空 part / 未知 part.type**：`transcode` 已处理（丢弃），遍历核心原样 yield，行为不变。

## 6. 备选方案与推荐

| 选项 | 内容 | 收益 | 风险/成本 |
| --- | --- | --- | --- |
| **A. 不做** | 维持三份复制，仅在 `distillSessionCapture.ts` 头注释补"已评估，暂不抽象" | 零风险 | 漂移风险继续累积；第三 owner 触发条件已被忽视一次 |
| **B. 抽遍历核心（推荐）** | 仅提取 `walkOpencodeSessions` 生成器 + 单一行接口（+ 可选 `writeCaptureFailedMarker`）；insert/dedup/编排留站点内 | 吃掉最大且最危险的重复（3× BFS + 3× SELECT + 3× 接口）；遍历行为收敛到一处可测；改动面小、易证等价 | 需小心 root-inclusion 布尔与"句柄留外面"两个边界 |
| **C. B + 落库 sink 接口** | 再把 ①② 的 insert 循环统一进 `captureOnce`/`CaptureSink` | 连"一次性捕获"骨架也单一 | 把 owner 行形状/dedup 钩子穿进接口——正是 RFC-043 当初担心的"thread both shapes through hot path"；回归面更大 |

**推荐 B**，把 C 作为 B 落地、测试稳定后的可选 follow-up（单独 PR、单独评估）。理由：B 已经关闭绝大部分漂移风险，且 `walkOpencodeSessions` 是纯遍历、最容易写出强等价单测；C 的边际收益（再省两段十几行 insert 循环）不抵它重新引入 RFC-043 担心的耦合。

## 7. 测试策略

### 7.1 等价性预言机（现有测试，断言不得改）

后端：`session-capture-sqlite.test.ts`、`distill-session-capture.test.ts`、`subagent-live-capture.test.ts`、`subagent-live-capture-source.test.ts`、`memory-distiller-capture-rfc043.test.ts`、`routes-session.test.ts`、`sessions.test.ts`、`runner-subagent-live-capture.test.ts`、`scheduler-subagent-live-capture-passthrough.test.ts`、`runner-session-id-persist.test.ts`。
这些覆盖了三站点的端到端落库形状、dedup、marker、live↔post-run partId 交接、byte-for-byte 不变式。**重构通过 = 它们全绿且无断言改动。**

### 7.2 新增（遍历核心契约）

新建 `opencode-session-walk.test.ts`，对 `walkOpencodeSessions` 直接喂内存 SQLite fixture，断言：

1. `includeRoot:false` → yield 顺序不含 root，仅含子孙；`includeRoot:true` → 首个 yield 为 root。
2. 多层嵌套（root→A→B）BFS 顺序确定（与现状 `order` 一致）。
3. self-loop（`parent_id` 指回自身/祖先）不挂、visited 去重。
4. 每个 WalkedSession 的 messages/parts 按 `time_created,id` 升序（复刻 SELECT 的 ORDER BY）。
5. root 在 `session` 表缺失时 `includeRoot:true` 的退化行为（`rootRow===null` → 不 seed，与 `distillSessionCapture.ts:101` 一致）。

### 7.3 回归注释

`opencode-session-walk.test.ts` 顶部写明："locks in the BFS/SELECT semantics extracted from sessionCapture/distillSessionCapture/subagentLiveCapture (RFC-077); any divergence here would silently break one of the three capture owners." 并链接本 RFC。

## 8. 耦合点与风险清单（review 检查项）

- [ ] `existsSync` 守卫**留在调用方**（①②driver / ③tick），不进核心——句柄生命周期三站点不同。
- [ ] `walkOpencodeSessions` **不 transcode、不 insert、不 dedup**——只遍历+读。
- [ ] ② 的 `includeRoot:true` 与 root-row seed 退化（缺失→不 seed）逐字保留。
- [ ] ③ 的 partId memo / "transcode 丢空也标记已见" / sibling skip / auto-disable / `onInsert` / `stats()` 全部留在 tick 内，**核心替换只动那段 BFS+SELECT**。
- [ ] ①③ 共用的 `loadSiblingsCapturedSessionIds` 不动。
- [ ] `transcodeOpencodeRowsToEvents` / `resolveOpencodeDbPath` 维持现位置与签名（避免无谓 import 抖动）。
- [ ] marker 永不抛语义（含 marker 写入自身失败被吞）逐字保留。
