# RFC-058 Design — Clarify Sessions 合表重构：技术设计

> 状态：Draft（2026-05-23）
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 复用基线：[RFC-023](../RFC-023-agent-clarify/design.md)、[RFC-026](../RFC-026-clarify-inline-session/design.md)、[RFC-039](../RFC-039-clarify-ask-bias/design.md)、[RFC-053](../RFC-053-node-run-lifecycle-hardening/design.md)、[RFC-056](../RFC-056-clarify-cross-agent/design.md)（含 patch-2026-05-22..25）

## 1. 概览

把 `clarify_sessions`（RFC-023）+ `cross_clarify_sessions`（RFC-056）合并为单一 `clarify_rounds` 表 + `kind: 'self' | 'cross'` discriminator；service 层 `services/clarify.ts` + `services/crossClarify.ts` 合并为单一 `services/clarify.ts`；前端 wire DTO `ClarifySession` + `CrossClarifySession` 合并为单一 `ClarifyRound`。**所有 RFC-023 + RFC-056 用户可观察行为字节级守恒**——除反问者侧 aging gap 1-2 处由 fail 变 pass（GENERAL 规则补齐）。

技术上分 7 块（按依赖链顺序）：

1. **shared/schemas**：`ClarifyRoundSchema`（含 kind discriminator）+ `ClarifyRoundSummary` + 类型重命名映射；删除 `ClarifySession` / `CrossClarifySession` / `ClarifyInboxEntry` 等旧 export。
2. **shared 纯函数**：`computeHistoryCutoff(args)` + `applyAgingCutoff(rows, cutoff)` 两个新公共 helper；clarify-cross.ts 与 clarify.ts 中既有纯函数（envelope parsing / synthesis / prompt block render）抽合并 / 共用。
3. **backend migration 0031**：建 `clarify_rounds` 表 + 索引 + 行迁移 + 验证 + DROP 两旧表。
4. **backend services/clarify.ts**：合并两 service 入口 + kind 分支；submitClarifyAnswers / buildPromptContext / triggerDesignerRerun / triggerQuestionerCascadeRerun 单一入口；删 `services/crossClarify.ts`。
5. **backend scheduler.ts**：1347-1455 inline cutoff 计算 + cross / self dispatch 两条路径合并为单一调用；调用 `computeHistoryCutoff` + `buildPromptContext`。
6. **backend REST `/api/clarify`**：响应 body 切单 `ClarifyRound + kind`；submit 路径单一 dispatch。
7. **frontend**：12+ callsite 类型重命名 + clarify routes 按 kind 分支渲染 + fixture 同步刷。

数据流（self-clarify happy path 重构后）：

```
[agent A] ──emit envelope──▶ [runtime parses, INSERT clarify_rounds(kind='self')]
                              ▼
                       awaiting_human
                              ▼
                   [user POST /api/clarify/:id/answers]
                              ▼
        submitClarifyAnswers({kind: 'self'}) → triggerSelfClarifyRerun()
                              ▼
                  agent A cci+1 cascade dispatch
                              ▼
          buildPromptContext({kind: 'self', cutoff: computeHistoryCutoff(...)})
                              ▼
                       agent A rerun, output
```

数据流（cross-clarify happy path 重构后）：

```
[questioner Q] ──emit envelope──▶ [INSERT clarify_rounds(kind='cross', target_consumer=D)]
                                   ▼
                            awaiting_human
                                   ▼
                  [user POST /api/clarify/:id/answers]
                                   ▼
       submitClarifyAnswers({kind: 'cross', directive: 'continue'})
                                   ▼
             readiness scan + triggerDesignerRerun(D)
                                   ▼
        D cci+1 cascade dispatch
                                   ▼
   buildPromptContext({kind: 'cross-designer', cutoff: computeHistoryCutoff(...)})
   → External Feedback + Prior Output + Update Directive
                                   ▼
                       D rerun output → cascade Q → ...
                       buildPromptContext({kind: 'cross-questioner', ...}) [本次 aging gap 自动修复]
```

## 2. shared 层增量

### 2.1 新表对应的 zod schema

`packages/shared/src/schemas/clarify.ts`（**全量重写**——`ClarifySession{,Summary}Schema` + `CrossClarifySession{,Summary}Schema` 删除、新 schema 替代）：

```ts
/** Discriminator: which clarify-round kind this row represents. */
export const ClarifyRoundKindSchema = z.enum(['self', 'cross'])
export type ClarifyRoundKind = z.infer<typeof ClarifyRoundKindSchema>

/** RFC-058: status enum union (self 走 'canceled'、cross 走 'abandoned'，
 *  统一接受、kind 决定可达性). */
export const ClarifyRoundStatusSchema = z.enum([
  'awaiting_human',
  'answered',
  'canceled',
  'abandoned',
])
export type ClarifyRoundStatus = z.infer<typeof ClarifyRoundStatusSchema>

/** Single clarify round (Q&A turn). Replaces both ClarifySession (RFC-023)
 *  and CrossClarifySession (RFC-056). */
export const ClarifyRoundSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: ClarifyRoundKindSchema,

  /** Asking agent node — kind='self': asking agent itself; kind='cross':
   *  the questioner. Always set. */
  askingNodeId: z.string(),
  askingNodeRunId: z.string(),
  /** Asking-side shard key (agent-multi shard child). NULL for agent-single
   *  + cross (RFC-056 v1 限定 agent-single). */
  askingShardKey: z.string().nullable(),

  /** Intermediary node (RFC-023 clarify node / RFC-056 cross-clarify node).
   *  Always set. */
  intermediaryNodeId: z.string(),
  intermediaryNodeRunId: z.string(),

  /** Cross-clarify target consumer (designer). NULL for kind='self' —
   *  the consumer is the asking agent itself. */
  targetConsumerNodeId: z.string().nullable(),

  /** Wrapper-loop iter (RFC-056 partial persistence). 0 for kind='self' or
   *  cross outside loop. */
  loopIter: z.number().int().nonnegative(),

  /** Monotonic round counter, scoped to (intermediaryNodeId, loopIter).
   *  Matches RFC-023 iterationIndex when kind='self' (per agent shard) and
   *  RFC-056 iteration when kind='cross' (per cross-clarify node × loop iter). */
  iteration: z.number().int().nonnegative(),

  questions: z.array(ClarifyQuestionSchema),
  answers: z.array(ClarifyAnswerSchema).optional(),
  directive: ClarifyDirectiveSchema.nullable(),
  status: ClarifyRoundStatusSchema,

  /** Truncation warnings from envelope parsing. */
  truncationWarnings: z.array(ClarifyTruncationWarningSchema).optional(),

  /** Display name from workflow snapshot (matches RFC-037 task name parity). */
  intermediaryNodeTitle: z.string().nullable().optional(),

  /** RFC-056 cross-clarify only. NULL for kind='self'. */
  designerRunTriggeredAt: z.number().int().nullable(),
  abandonedAt: z.number().int().nullable(),

  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
  answeredBy: z.string().nullable(),
})
export type ClarifyRound = z.infer<typeof ClarifyRoundSchema>

/** Compact inbox entry — replaces ClarifySessionSummary + CrossClarifySessionSummary. */
export const ClarifyRoundSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  kind: ClarifyRoundKindSchema,
  askingNodeId: z.string(),
  askingNodeTitle: z.string().nullable().optional(),
  askingShardKey: z.string().nullable(),
  intermediaryNodeId: z.string(),
  intermediaryNodeTitle: z.string().nullable().optional(),
  intermediaryNodeRunId: z.string(),
  targetConsumerNodeId: z.string().nullable(),
  loopIter: z.number().int().nonnegative(),
  iteration: z.number().int().nonnegative(),
  questionCount: z.number().int().nonnegative(),
  status: ClarifyRoundStatusSchema,
  directive: ClarifyDirectiveSchema.nullable(),
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
})
export type ClarifyRoundSummary = z.infer<typeof ClarifyRoundSummarySchema>
```

**删除**：`ClarifySessionSchema` / `CrossClarifySessionSchema` / `ClarifySessionSummarySchema` / `CrossClarifySessionSummarySchema` / `ClarifyInboxEntry` 等旧 export。引用方在 PR-B 实施期间一并刷掉。

### 2.2 SubmitClarifyAnswers schema 不动

`SubmitClarifyAnswersSchema`（RFC-023 §3.5）保留——既有 self / cross 路径都接受 `{ answers, ifMatchIteration?, directive }` shape。submit 路由按 round.kind 分支。

RFC-059 后续在此 schema 上加 `questionScopes?` 字段（不属本 RFC 范围）。

### 2.3 shared 纯函数（新增）

`packages/shared/src/clarify-aging.ts`（新文件）：

```ts
/** Generic row shape for aging cutoff filter. Matches both clarify_rounds
 *  (self path) and clarify_rounds (cross path) — both have `iteration`. */
export interface ClarifyRoundForAging {
  iteration: number
}

/** Filter clarify rounds by aging cutoff. `undefined` cutoff is no-op
 *  (full history). Rule: drop rows with iteration < cutoff. */
export function applyAgingCutoff<T extends ClarifyRoundForAging>(
  rows: ReadonlyArray<T>,
  cutoff: number | undefined,
): T[] {
  if (cutoff === undefined) return rows.slice()
  return rows.filter((r) => r.iteration >= cutoff)
}
```

backend 侧的 `computeHistoryCutoff` 函数留在 backend（需要 db 访问），见 §4.4。

### 2.4 既有 clarify-cross.ts 合并

`packages/shared/src/clarify-cross.ts`（RFC-056 引入的纯函数模块）合并入 `packages/shared/src/clarify.ts`——`buildExternalFeedbackBlock` / `summariseCrossAnswer` / `parseCrossClarifyEnvelopeBody` / `CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE` 等纯函数 / 常量原样搬过去；导出表只少几个，外部引用方更新一行 import 路径。删 `clarify-cross.ts`。

### 2.5 schema 测试守门

`packages/shared/tests/clarify-rfc058-schema.test.ts`（新文件，≥ 8 case）：

- `ClarifyRoundSchema` happy parse（kind='self' / 'cross' 两类）。
- `ClarifyRoundSchema` kind='self' targetConsumerNodeId 必须为 null（otherwise warning）。
- `ClarifyRoundSchema` kind='cross' targetConsumerNodeId 可空可填。
- `ClarifyRoundStatusSchema` enum 完整（含 'canceled' 与 'abandoned'）。
- `ClarifyRoundSummary` 简化字段集。
- `applyAgingCutoff` undefined cutoff / 0 cutoff / N cutoff / 全过滤 4 case。
- type-level：`ClarifySession` / `CrossClarifySession` 等旧名 grep 在 shared/src 不存在（source-text 守门）。
- 类型重命名一致性：`ClarifyRound['kind']` 联合两个枚举值正确。

## 3. DB migration 0031

### 3.1 新表 DDL

```sql
CREATE TABLE clarify_rounds (
  id                          TEXT PRIMARY KEY,
  task_id                     TEXT NOT NULL,
  kind                        TEXT NOT NULL CHECK (kind IN ('self', 'cross')),

  asking_node_id              TEXT NOT NULL,
  asking_node_run_id          TEXT NOT NULL,
  asking_shard_key            TEXT,

  intermediary_node_id        TEXT NOT NULL,
  intermediary_node_run_id    TEXT NOT NULL,

  target_consumer_node_id     TEXT,
  loop_iter                   INTEGER NOT NULL DEFAULT 0,
  iteration                   INTEGER NOT NULL DEFAULT 0,

  questions_json              TEXT NOT NULL,
  answers_json                TEXT,
  directive                   TEXT CHECK (directive IS NULL OR directive IN ('continue', 'stop')),
  status                      TEXT NOT NULL DEFAULT 'awaiting_human'
                                CHECK (status IN ('awaiting_human', 'answered', 'canceled', 'abandoned')),

  -- RFC-058 决策点 Q2：kind × status 跨域约束 DB 层 enforce。
  -- self 永不进 abandoned（abandoned 是 RFC-056 cross-clarify CR-1 invariant 升级专属）。
  -- cross 永不进 canceled（canceled 是 RFC-023 task-cancel 路径专属）。
  -- 违反时 INSERT 抛 SQLite CHECK constraint error、application 层无需再重复检查。
  CHECK (
    (kind = 'self'  AND status != 'abandoned') OR
    (kind = 'cross' AND status != 'canceled')
  ),

  -- RFC-026 inline / RFC-056 sessionMode (cross 时 designer / questioner 分两次注入)
  session_mode                TEXT,

  -- RFC-056 cross-clarify only
  designer_run_triggered_at   INTEGER,
  abandoned_at                INTEGER,

  created_at                  INTEGER NOT NULL,
  answered_at                 INTEGER,
  answered_by                 TEXT,

  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (intermediary_node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (asking_node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_clarify_rounds_task ON clarify_rounds(task_id);
CREATE INDEX idx_clarify_rounds_kind ON clarify_rounds(kind, status);
CREATE INDEX idx_clarify_rounds_asking ON clarify_rounds(asking_node_id, loop_iter, iteration);
CREATE INDEX idx_clarify_rounds_intermediary ON clarify_rounds(intermediary_node_id, loop_iter, iteration);
CREATE INDEX idx_clarify_rounds_target_designer ON clarify_rounds(target_consumer_node_id, status) WHERE kind = 'cross';
```

### 3.2 行迁移 INSERT

```sql
-- 1. 迁 self-clarify 行（RFC-023 clarify_sessions）
INSERT INTO clarify_rounds (
  id, task_id, kind,
  asking_node_id, asking_node_run_id, asking_shard_key,
  intermediary_node_id, intermediary_node_run_id,
  target_consumer_node_id, loop_iter, iteration,
  questions_json, answers_json, directive, status, session_mode,
  designer_run_triggered_at, abandoned_at,
  created_at, answered_at, answered_by
)
SELECT
  id, task_id, 'self' AS kind,
  source_agent_node_id, source_agent_node_run_id, source_shard_key,
  clarify_node_id, clarify_node_run_id,
  NULL AS target_consumer_node_id,
  0 AS loop_iter,
  iteration_index AS iteration,
  questions_json, answers_json, directive, status, session_mode,
  NULL AS designer_run_triggered_at, NULL AS abandoned_at,
  created_at, answered_at, answered_by
FROM clarify_sessions;

-- 2. 迁 cross-clarify 行（RFC-056 cross_clarify_sessions）
INSERT INTO clarify_rounds (
  id, task_id, kind,
  asking_node_id, asking_node_run_id, asking_shard_key,
  intermediary_node_id, intermediary_node_run_id,
  target_consumer_node_id, loop_iter, iteration,
  questions_json, answers_json, directive, status, session_mode,
  designer_run_triggered_at, abandoned_at,
  created_at, answered_at, answered_by
)
SELECT
  id, task_id, 'cross' AS kind,
  source_questioner_node_id, source_questioner_node_run_id,
  NULL AS asking_shard_key,  -- RFC-056 v1 限定 agent-single
  cross_clarify_node_id, cross_clarify_node_run_id,
  target_designer_node_id, loop_iter, iteration,
  questions_json, answers_json, directive, status,
  NULL AS session_mode,  -- RFC-056 sessionMode 存在 cross-clarify 节点 definition、不存 session 行
  designer_run_triggered_at, abandoned_at,
  created_at, answered_at, NULL AS answered_by
FROM cross_clarify_sessions;

-- 3. 验证行数
-- 由 migration test 执行：SELECT COUNT(*) FROM clarify_sessions + cross_clarify_sessions
-- == SELECT COUNT(*) FROM clarify_rounds，否则 abort

-- 4. drop 旧表
DROP TABLE clarify_sessions;
DROP TABLE cross_clarify_sessions;
```

### 3.3 migration test

`packages/backend/tests/migration-0031-clarify-rounds.test.ts`（≥ 6 case，含 Q2 CHECK 守门）：

1. **空库 migration**：旧表无行 → 新表创建 + 0 行；旧表 drop。
2. **仅 self 行**：旧 `clarify_sessions` 有 3 行（含 awaiting + answered + canceled + agent-multi shard child）→ 新表 3 行、字段字节级映射；旧表 drop。
3. **仅 cross 行**：旧 `cross_clarify_sessions` 有 4 行（含 awaiting + answered+continue + answered+stop + abandoned）→ 新表 4 行、字段映射 + kind='cross'；旧表 drop。
4. **混合 self + cross**：5 self + 4 cross → 新表 9 行；按 kind 分组检查每类完整性；FK ON DELETE CASCADE 仍有效（删 task 时连带删 clarify_rounds 行）。
5. **行数校验失败 abort**：手动 corrupt（譬如临时插入额外行）→ migration script abort + 旧表保留（rollback）。
6. **DB CHECK 跨域约束工作**（Q2）：手动 `INSERT INTO clarify_rounds (..., kind='self', status='abandoned', ...)` 抛 SQLite CHECK constraint failed；`INSERT ... kind='cross', status='canceled'` 同样抛错；合法组合 (self, canceled) / (cross, abandoned) 不抛错。

### 3.4 drizzle schema 同步

`packages/backend/src/db/schema.ts`：
- 加 `clarifyRounds` sqliteTable 对象；
- 删 `clarifySessions` + `crossClarifySessions` 对象（确保 grep 不到任何引用后）；
- 加 `clarifyRoundsRelations`（含 task / askingNodeRun / intermediaryNodeRun）。

## 4. backend service 合并

### 4.1 删除 `services/crossClarify.ts`

整个文件物理删除。所有 export（`submitCrossClarifyAnswers` / `triggerDesignerRerun` / `triggerQuestionerStopRerun` / `evaluateDesignerRerunReadiness` / `buildExternalFeedbackContext` / `buildQuestionerCrossClarifyContext` / `listCrossClarifySummaries` 等）迁入 `services/clarify.ts` 并按 kind 分支。

### 4.2 重构后的 `services/clarify.ts` 入口总览

```ts
// ============ Submit ============
export interface SubmitClarifyAnswersArgs {
  db: DbClient
  /** clarify_rounds.id (or intermediary node_run id for backward path). */
  roundId: string
  answers: ClarifyAnswer[]
  directive: ClarifyDirective
  ifMatchIteration?: number
  answeredBy?: string
  now?: () => number
}
export async function submitClarifyAnswers(args): Promise<SubmitClarifyAnswersResult>
// 内部 dispatch by round.kind ↓
async function _commitSelfAnswers(...): ...   // 原 RFC-023 submitClarifyAnswers
async function _commitCrossAnswers(...): ...  // 原 RFC-056 submitCrossClarifyAnswers

// ============ Prompt 注入 ============
export interface BuildPromptContextArgs {
  db: DbClient
  definition: WorkflowDefinition
  taskId: string
  /** 'self' agent / 'cross-designer' / 'cross-questioner' — which consumer's
   *  prompt is being built. */
  consumerKind: 'self' | 'cross-designer' | 'cross-questioner'
  /** Asking-side node id when consumerKind='self' / 'cross-questioner';
   *  designer node id when consumerKind='cross-designer'. */
  consumerNodeId: string
  /** Current node_run's iteration / cci. */
  targetIteration: number
  /** RFC-058: aging cutoff (computed by computeHistoryCutoff). */
  historyCutoff?: number
  shardKey: string | null
  sessionMode?: 'isolated' | 'inline'
  applyLatestDirective?: boolean
  // RFC-056 §6 update mode for cross-designer:
  priorDoneRun?: NodeRunRow
}
export async function buildPromptContext(args): Promise<ClarifyPromptContext | undefined>
// 内部按 consumerKind 分支 ↓
// consumerKind='self' → 拉 clarify_rounds WHERE kind='self' AND asking_node_id=...
// consumerKind='cross-designer' → 拉 clarify_rounds WHERE kind='cross' AND target_consumer_node_id=...
//   外加 Prior Output + Update Directive 拼装（RFC-056 §6）
// consumerKind='cross-questioner' → 拉 clarify_rounds WHERE kind='cross' AND asking_node_id=...
//   GENERAL aging cutoff 在此生效（修复反问者侧 aging gap）

// ============ Cutoff 计算 ============
export interface ComputeHistoryCutoffArgs {
  db: DbClient
  taskId: string
  nodeId: string
  /** clarifyIteration (kind='self') or crossClarifyIteration (kind='cross'). */
  iterationField: 'clarifyIteration' | 'crossClarifyIteration'
  /** Current run row — exclude when looking up prior completed run. */
  currentRunRow?: NodeRunRow
  shardKey: string | null
}
export async function computeHistoryCutoff(
  args: ComputeHistoryCutoffArgs,
): Promise<number | undefined>

// ============ 触发动作 ============
export async function triggerSelfClarifyRerun(args): Promise<...>
export async function triggerDesignerRerun(args): Promise<...>          // RFC-056 cross-clarify designer
export async function triggerQuestionerCascadeRerun(args): Promise<...> // RFC-056 cascade questioner (continue / stop 合一)
export async function evaluateDesignerRerunReadiness(args): Promise<...> // RFC-056 multi-source

// ============ 列表 / 详情 ============
export async function listClarifyRoundSummaries(
  db: DbClient, filter: { taskId?: string; kind?: ClarifyRoundKind; status?: ... }
): Promise<ClarifyRoundSummary[]>
export async function getClarifyRoundByIntermediaryNodeRunId(
  db: DbClient, intermediaryNodeRunId: string
): Promise<ClarifyRound | null>
```

### 4.3 buildPromptContext 内部分支

```ts
export interface BuildPromptContextArgs {
  // ...（同 §4.2 既有字段）
  /** RFC-058 决策点 Q1：wrapper-loop loop_iter 隔离修复。
   *  consumerKind='cross-questioner' 时必须传当前 questioner node_run 的 loop_iter，
   *  WHERE 加 `loop_iter = args.loopIter` 让 iter ≥ 2 反问者看不到上 iter 的 Q&A。
   *  consumerKind='cross-designer' 同样按 loop_iter 限定 External Feedback。
   *  consumerKind='self' 时该字段 ignored（RFC-023 self-clarify 不进 wrapper-loop 内 iter 隔离语义）。*/
  loopIter?: number
}

export async function buildPromptContext(
  args: BuildPromptContextArgs,
): Promise<ClarifyPromptContext | undefined> {
  if (args.targetIteration <= 0) return undefined

  // 取候选 rounds（全部 kind='self' 或全部 kind='cross'，按 consumerKind 切）
  // RFC-058 Q1：consumerKind 涉及 cross 路径时 WHERE 加 loop_iter 过滤
  const rows = await _selectAnsweredRoundsForConsumer(args)
  if (rows.length === 0) return undefined

  // GENERAL aging cutoff — 单一入口
  const filtered = applyAgingCutoff(rows, args.historyCutoff)
  if (filtered.length === 0) return undefined

  // inline 模式 collapse 到最后一轮（RFC-026）
  const inlineMode = args.sessionMode === 'inline'
  const finalRows = inlineMode ? filtered.slice(-1) : filtered

  // 渲染 Q&A blocks（reuse renderClarifyQuestionsBlock / buildClarifyPromptBlock 既有纯函数）
  return _renderClarifyPromptContext(finalRows, args, inlineMode)
}

async function _selectAnsweredRoundsForConsumer(args: BuildPromptContextArgs): Promise<ClarifyRoundRow[]> {
  // consumerKind='self': WHERE kind='self' AND asking_node_id=? AND asking_shard_key<=>?
  // consumerKind='cross-designer': WHERE kind='cross' AND target_consumer_node_id=? AND directive='continue' AND loop_iter=?
  //                                  ORDER BY iteration DESC LIMIT 1 PER intermediary_node_id（每 source 取最新）
  // consumerKind='cross-questioner': WHERE kind='cross' AND asking_node_id=? AND loop_iter=?
  //                                    ORDER BY iteration ASC（全量历史按 round 升序拼装）
  // ...
}
```

**关键点**：
1. `applyAgingCutoff` 这一行对 consumerKind='cross-questioner' 同样生效——这是反问者侧 aging gap 修复（RFC-056 缺口 1）的物理体现。
2. `_selectAnsweredRoundsForConsumer` 在 cross-* 路径 WHERE 加 `loop_iter` 过滤——这是 wrapper-loop loop_iter 隔离修复（RFC-056 缺口 2）的物理体现。
两个修复**共享同一处代码**——合表的天然收益。

### 4.4 computeHistoryCutoff 实现

scheduler.ts:1372-1402 inline 计算逻辑搬到此处：

```ts
export async function computeHistoryCutoff(
  args: ComputeHistoryCutoffArgs,
): Promise<number | undefined> {
  const candidates = await args.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.nodeId, args.nodeId)))

  const eligible = candidates.filter((r) => {
    if (args.currentRunRow !== undefined && r.id === args.currentRunRow.id) return false
    if (r.parentNodeRunId !== null) return false
    if ((r.shardKey ?? null) !== args.shardKey) return false
    if (args.currentRunRow !== undefined && !isFresherNodeRun(args.currentRunRow, r)) return false
    return true
  })

  if (eligible.length === 0) return undefined

  // 找有 node_run_outputs 行的（= 真出过 <workflow-output> 的）最新 fresher run
  const outputsRows = await args.db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, eligible.map((r) => r.id)))
  const haveOutputs = new Set(outputsRows.map((o) => o.nodeRunId))

  let priorCompleted: NodeRunRow | undefined
  for (const r of eligible) {
    if (!haveOutputs.has(r.id)) continue
    if (isFresherNodeRun(r, priorCompleted)) priorCompleted = r
  }
  if (priorCompleted === undefined) return undefined

  return args.iterationField === 'clarifyIteration'
    ? priorCompleted.clarifyIteration
    : priorCompleted.crossClarifyIteration
}
```

调用方（scheduler.ts）：

```ts
const historyCutoff = await computeHistoryCutoff({
  db, taskId, nodeId: node.id,
  iterationField: clarifyMode === 'cross' ? 'crossClarifyIteration' : 'clarifyIteration',
  currentRunRow,
  shardKey: currentShardKey,
})
const clarifyContext = await buildPromptContext({
  db, definition, taskId,
  consumerKind:
    clarifyMode === 'cross' && isQuestionerCrossClarifyRerun ? 'cross-questioner'
    : clarifyMode === 'cross' && hasExternalFeedbackChannel  ? 'cross-designer'
    :                                                          'self',
  consumerNodeId: node.id,
  targetIteration: clarifyMode === 'cross' ? currentCrossClarifyIteration : currentClarifyIteration,
  historyCutoff,
  shardKey: currentShardKey,
  ...(inlineMode ? { sessionMode: 'inline' } : {}),
  ...(priorDoneDesigner ? { priorDoneRun: priorDoneDesigner } : {}),
})
```

scheduler.ts:1283-1455 范围内的所有 cross / self 分支条件 + inline cutoff 计算 + 两 build 函数 dispatch 全部归一化到这两行调用。

### 4.5 RFC-053 invariant 适配（CR-1）

`packages/backend/src/services/lifecycleInvariants.ts`：CR-1 查询条件改为 `clarify_rounds WHERE kind='cross' AND status='answered' AND directive='continue' AND target_consumer_node_id IS NOT NULL`；其余字段一致。invariant test 跟着 schema 重命名刷一遍 fixture。

## 5. REST `/api/clarify`

### 5.1 GET `/api/clarify`（列表）

返回 `ClarifyRoundSummary[]`（含 kind）。query 参数 `?kind=self|cross|all`（默认 all）+ `?status=...` + `?taskId=...`。前端按 `entry.kind` 渲染 chip + 分支详情链接。

### 5.2 GET `/api/clarify/:nodeRunId`（详情）

接受 intermediary node_run id（既能定位 self-clarify node_run 也能定位 cross-clarify node_run）。响应 `ClarifyRound`（含 kind）。前端按 `round.kind` 渲染 form / footer。

### 5.3 POST `/api/clarify/:nodeRunId/answers`

接受 `SubmitClarifyAnswersSchema`（不变）；内部按 round.kind 分支至 `_commitSelfAnswers` / `_commitCrossAnswers`。响应 `SubmitClarifyAnswersResponseSchema`（不变）。

### 5.4 REST 单测

`packages/backend/tests/routes-clarify-rfc058.test.ts`（≥ 6 case）：

- GET 列表 mixed self + cross 含 kind 字段。
- GET 详情 self / cross 各返回 `ClarifyRound + kind`。
- POST submit self → `_commitSelfAnswers` 路径触发。
- POST submit cross continue → `_commitCrossAnswers` + designer readiness 路径触发。
- POST submit cross stop → `_commitCrossAnswers` + questioner stop cascade 触发。
- POST 引用错误 intermediary node_run id → 404 + 错误码 `clarify-round-not-found`。

## 6. WS event 保留

`clarify.created` / `clarify.answered` / `cross-clarify.created` / `cross-clarify.answered` / `cross-clarify.rejected` / `cross-clarify.designer-rerun-batched` 等 6 个 event 名保留。broadcaster 函数内部按 round.kind 选择正确的 event 名 publish。

未来若有合并诉求（譬如统一 `clarify.round.*`）单独 RFC-XXX；本 RFC 不动 wire event。

## 7. 前端类型重命名 + 路由 kind 分支

### 7.1 类型重命名映射

| 旧（删除） | 新（采用） |
|---|---|
| `ClarifySession` | `ClarifyRound`（kind='self'） |
| `CrossClarifySession` | `ClarifyRound`（kind='cross'） |
| `ClarifySessionSummary` | `ClarifyRoundSummary`（kind='self'） |
| `CrossClarifySessionSummary` | `ClarifyRoundSummary`（kind='cross'） |
| `ClarifyInboxEntry` discriminated union | `ClarifyRoundSummary`（自带 kind） |
| `SubmitClarifyAnswersResponse` | 不变 |

### 7.2 frontend callsite 清单

预估 ≥ 12 处需要切（PR-B 实施期间逐一改）：

1. `packages/frontend/src/routes/clarify.tsx` — 列表页 entry 类型 + chip 分支。
2. `packages/frontend/src/routes/clarify.detail.tsx` — 详情页 round 类型 + form 分支。
3. `packages/frontend/src/hooks/useClarifyWs.ts` — 类型 import。
4. `packages/frontend/src/api/client.ts`（若有 typed 包装）。
5-12. fixture 文件 + 单测：`packages/frontend/tests/clarify-rfc056-{list,detail}-route.test.tsx` / `cross-clarify-ui-bugs-2026-05-22.test.tsx` / `cross-clarify-inspector-palette.test.tsx` / `clarify-rfc056-{list,detail}-route` 等。
- 准则：`ClarifySession` / `CrossClarifySession` / `ClarifyInboxEntry` 等旧名 grep 在 `packages/frontend/src` 与 `packages/frontend/tests` 不到（除明确 deprecation 兼容场景）。

### 7.3 路由内部按 kind 分支

`clarify.detail.tsx` 现有路径：

```tsx
const isCross = s.kind === 'cross'  // 从 entry.kind 直接拿
{isCross ? <CrossFooter /> : <SelfFooter />}
```

简化于旧版从两种类型 narrowing 的逻辑；视觉行为 / chip / Reject 按钮 / 多源 banner 字节级一致。

## 8. 测试策略

### 8.1 PR-A baseline 测试加固（≥ 60 case）

详见 plan.md §2.PR-A。分布：
- shared 8（envelope parse self / cross / 错误码 / synthesis / 协议块 render / inline mode / directive trailer）
- backend 45（详分 service 自路径 18 + cross 22 + RFC-056 patch chain 5）
- frontend 7（clarify list / detail / chip / reject modal / multi-source banner / sealed readonly）

**关键**：每条测试必须 fixture 可控 + 输出可断言（prompt 文本 snapshot / REST body / WS payload / DOM 文本）。snapshot 文件落库到 `packages/backend/tests/__snapshots__/clarify-rfc058/`、`packages/frontend/tests/__snapshots__/clarify-rfc058/`。

### 8.2 PR-B 重构守门（**分层 diff 规则**——Q3 决策）

**字节级守门**（PR-A baseline → PR-B 后必须 diff = 0）适用于**面向用户层**：
- prompt 文本（喂给 opencode 的最终字符串）
- REST response body（JSON 字段、字段顺序、值）
- WS event payload（type 字段、payload 字段集 + 值）
- 面向用户的 error code（譬如 `cross-clarify-iteration-mismatch`）+ error message 字符串
- 前端 DOM textContent（用户实际看到的文本）

**行为级守门**（PR-A baseline 不锁、允许 PR-B refactor 微调）适用于**内部观察层**：
- console.log / log.info / log.warn 内容（observability 内部消息可改）
- 内部函数 / 私有 helper 名 / 变量名
- SQL 查询语句字符串 / 内部 query 执行顺序（结果集相同即可）
- 内部 TypeScript 实现细节 / inline 注释
- DB row 返回顺序（如果 application 层会重新 sort）
- 测试本身使用的 snapshot key 与 fixture 名（与生产路径无关）

**守门执行**：
- 跑 PR-A 60+ case：**面向用户层零字节 diff** 必须满足；**两类 fail 由 fail 变 pass 例外**（cci=N+1 questioner aging gap 1 case + wrapper-loop iter ≥ 2 loop_iter 隔离 1-2 case），专门标注 `// LOCKS: RFC-058 fixed RFC-056 aging gap` / `// LOCKS: RFC-058 fixed RFC-056 wrapper-loop gap`。
- 跑 RFC-056 既有套件（cross-clarify-service / cross-clarify-multi-source-wait / cross-clarify-loop-partial-persistence / etc.）：在新表 / 新 service 上必须全绿。
- 跑 RFC-023 既有套件（clarify-service / clarify-stop-directive-scoped-to-clarify-rerun / etc.）：同上。
- 跑 RFC-053 invariant 套件（含 CR-1）：CR-1 测试 fixture 改 `clarify_rounds WHERE kind='cross'` 后全绿。
- 跑 RFC-039 / RFC-026 / RFC-014 / RFC-042 既有套件：零退化。

### 8.3 新增测试（≥ 24 case）

- `cross-clarify-questioner-aging.test.ts`（C3 守门，2 case）：cci=1 done + outputs / cci=2 cascade rerun → prompt 不含 cci < 1 轮 Q&A；幂等扫两次行为一致。
- `cross-clarify-loop-iter-isolation.test.ts`（C6 守门，2 case）：wrapper-loop iter 1 反问 + submit + done / iter 2 反问者 cascade rerun → prompt 不含 iter 1 的 Q&A；嵌套 wrapper-git in wrapper-loop 时 loop_iter 仍正确过滤。
- `aging-single-source.test.ts`（C4 守门，1 case）：grep `computeHistoryCutoff` ≥ 2 callsite（scheduler 主路径 + 测试 hook）；`historyCutoffClarifyIteration =` inline 模式 grep 不到。
- `migration-0031-clarify-rounds.test.ts`（C5 守门，6 case）：详见 §3.3（含 DB CHECK 跨域约束 case）。
- `routes-clarify-rfc058.test.ts`（REST 测试，6 case）：详见 §5.4。
- `clarify-rfc058-schema.test.ts`（shared 守门，8 case）：详见 §2.5。

合计 PR-B 新增：≥ 25 case；总 ≥ 85 case（含 PR-A baseline 60）。

## 9. 关键决策理由与替代方案

详见 proposal.md §5。本节补 design 层 4 个细节：

1. **`clarify_rounds.iteration` 单字段 vs 双字段（iterationIndex + iteration）**：选**单字段**。理由：两个旧字段（RFC-023 iterationIndex / RFC-056 iteration）语义都是"单调递增轮次计数、按 intermediary 节点分组"——本质同一字段、不同列名只是历史巧合。合并为 `iteration` 名义更准（"第 N 轮"）。
2. **`asking_shard_key` 默认 NULL vs 非 nullable**：选 NULL（agent-multi 时 self-clarify 可填、cross-clarify v1 限制 agent-single 永远 NULL）。理由：RFC-023 既有 source_shard_key 支持 agent-multi、本 RFC 不收紧 agent-multi 在 self-clarify 路径上的支持。
3. **`session_mode` 字段 vs 不存**：选**存**。理由：RFC-023 clarify_sessions 既有该字段（RFC-026 inline）、迁移要保留语义；RFC-056 cross-clarify v1 在 session 行不存（存在 cross-clarify 节点 definition 的 sessionModeForDesigner / sessionModeForQuestioner）——cross 行该列恒 NULL 即可。
4. **status enum 含 'canceled' + 'abandoned' 双值**：选**全集**。理由：'canceled' 来自 RFC-023 self-clarify（task cancel 时 awaiting_human → canceled）；'abandoned' 来自 RFC-056 cross-clarify CR-1 invariant 升级；两值都需要保留语义、kind 决定可达性（self 永不进 abandoned、cross 永不进 canceled）。

## 10. 风险缓解（design 层）

| 风险 | 缓解 |
|---|---|
| PR-A baseline snapshot 在 PR-B 后被 jest update（误 update 接受 diff） | snapshot 文件 commit 时手动检查 + PR review 时 grep snapshot 文件 diff；任何 snapshot diff 必须显式标注 reason（譬如 `// LOCKS: RFC-058 fixed aging gap`） |
| migration 0031 在某用户 home 残留 RFC-056 schema 但缺 RFC-058 → 启动 abort | migration scripts 0029 / 0031 串行执行；0029 上行后才允许 0031；测试覆盖 0029 → 0031 完整链 |
| `services/clarify.ts` 合并后函数体超大 → 难读 | 内部按 kind 拆 `_commitSelfAnswers` / `_commitCrossAnswers` 等私有 helper（前缀 `_`）；公共原语（aging / cutoff / render）抽到独立小模块；目标主文件 ≤ 1500 行（合并前两文件合计 ~1850 行、合并后预估 1300 行净减） |
| 前端 12 处 callsite 改动遗漏 / 某 fixture 写错 | 删 `ClarifySession` 类型 export 后 typecheck 立即报错；CI 跑全 vitest 覆盖 |
| PR-A 已锁住 cluster 1 行为、PR-B 实施时发现 cluster 2 缺漏（典型如 wrapper-loop 内 cross-clarify 边角） | PR-A 拒绝快速完结：完成度由 user + 1-2 reviewer 共同 sign-off；不强求一次性所有边角、但已锁住的 case 必须真覆盖；PR-B 后发现的额外漏点可作 follow-up patch 加入 baseline |
| WS event 名保留但 broadcaster 实现合并出错 → event payload 缺字段 | broadcaster 函数签名变化时 TypeScript 立即报错；新加 5 case 测试覆盖 6 个 event 字段完整性（含 kind 区分）|
