# RFC-059 Design — 跨节点反问问题作用域：技术设计

> 状态：**Ready（2026-05-23，RFC-058 已落 main，本文按 RFC-058 final API 刷新）**
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 复用基线：[RFC-056](../RFC-056-clarify-cross-agent/design.md)、[RFC-023](../RFC-023-agent-clarify/design.md)、[RFC-039](../RFC-039-clarify-ask-bias/design.md)、[RFC-058 clarify-sessions-unification](../RFC-058-clarify-sessions-unification/design.md)

> **2026-05-23 RFC-058 落地后差异（本次刷新已应用）**：
> - **migration 编号 0031 → 0032**（RFC-058 占用 0031）。
> - **目标表双写**：`cross_clarify_sessions`（legacy reader for `buildExternalFeedbackContext`）+ `clarify_rounds`（unified reader for `buildPromptContext`）双表都需要 `question_scopes_json TEXT NULLABLE` 列；submit dual-write 同步落两张表。
> - **shared helper 文件路径**：本文出现的 `packages/shared/src/clarify-cross.ts` 在本仓不存在；helper 落到 `packages/shared/src/clarify.ts`（`buildExternalFeedbackBlock` 已在该文件 line 443）。
> - **反问者侧两条入口**：生产实际走 `packages/backend/src/services/clarifyRounds.ts:294` 的 `buildPromptContext({ consumerKind: 'cross-questioner', ... })`；遗留 `packages/backend/src/services/crossClarify.ts:1223` 的 `buildQuestionerCrossClarifyContext` 仍作为 PR-A baseline 锚保留、本 RFC 都不改。C3 守门覆盖**两条**入口的 grep。
> - **DTO 重命名**：`CrossClarifySession` → `ClarifyRound`（带 `kind: 'self'|'cross'` 判别符）；GET `/api/clarify/:nodeRunId` 详情走 RFC-058 的 `getClarifyRoundDetail` 返回 `ClarifyRound`，前端把 scope UI 挂在 `s.kind === 'cross'` 分支。dual-write 期 `CrossClarifySessionSchema` 仍同步保留 `questionScopes` 字段，避免 RFC-058 dual-write helper 类型不一致。
> - 产品语义、scope 单向 destination flag 定义、UI Segmented 控件、三态 footer hint、i18n key 列表、5 条 C 守门测试目标保持不变。

## 1. 概览

本 RFC 在 RFC-056 cross-clarify 协议上加一个**人决策维度**：每道反问的题在 submit 时可被标记为 `'designer' | 'questioner'`，默认 `'designer'`。scope 是**单向 destination flag**——'designer' 表示"答案同时送达设计者 + 反问者"，'questioner' 表示"答案只发给反问者、设计者不被通知"。反问者**永远**收到全量 Q&A，scope 只决定设计者侧是否参与。

submit 时：若至少 1 题 scope=designer → 走 RFC-056 现 submit 流程，但 designer 的 External Feedback 仅含 designer-scoped 子集；若全部 scope=questioner → 跳过 designer 重跑，直接让 questioner cascade rerun（注入全量 Q&A）。

技术上分 5 块改动（按依赖链顺序）：

1. **shared/schemas**：`ClarifyQuestionScope` enum + `SubmitClarifyAnswers.questionScopes?` 字段 + `CrossClarifySession.questionScopes` 投影字段。
2. **shared/clarify-cross.ts**：`extractDesignerScopedSubset` / `countDesignerScopedAcrossSources` / `resolveQuestionScope` 三个纯函数（**反问者侧不需要过滤函数**，questioner 始终收全量）。
3. **backend migration 0031**：`cross_clarify_sessions.question_scopes_json TEXT NULLABLE` 列。
4. **backend services/crossClarify.ts**：`submitCrossClarifyAnswers` 内部按 scope 分支 + 新 helper `triggerQuestionerContinueRerun`；`buildExternalFeedbackContext` 在构造 sources 时按 scope 过滤（仅设计者侧）；`buildQuestionerCrossClarifyContext` 与 questioner cascade rerun 路径**字节级不动**——反问者继续看 session 的全量 Q&A。
5. **frontend routes/clarify.detail.tsx**：每题 Segmented 控件 + scope 状态管理 + submit body 携带 questionScopes + footer hint 三态文案 + sealed 状态只读 chip。

数据流（混合 scope，单源）：

```
[input] ─▶ [designer] ─▶ [questioner] ─▶ [reviewDesign]
              ▲                │
              │                │
              │       __clarify__ (auto)
              │                ▼
              │           cross-clarify node
              │           (1 in, 2 out)
              │                │
              │     to_designer (manual, scope='designer' 子集)
              └────────────────┤
                               │
                  to_questioner (auto, 全量 Q&A 始终)
                               │
                               ▼
                      questioner.__clarify_response__
```

## 2. shared 层增量

### 2.1 ClarifyQuestionScope enum + SubmitClarifyAnswers 字段

`packages/shared/src/schemas/clarify.ts` 追加（**不改既有 export 字节签名**）：

```ts
/** RFC-058: 每题 scope（designer / questioner）。默认 'designer'——向后兼容
 *  RFC-056 行为（所有题都送给设计者）。仅在 cross-clarify 节点路径生效；
 *  self-clarify 节点 POST 接受但忽略。 */
export const ClarifyQuestionScopeSchema = z.enum(['designer', 'questioner'])
export type ClarifyQuestionScope = z.infer<typeof ClarifyQuestionScopeSchema>

export const CLARIFY_QUESTION_SCOPE_DEFAULT = 'designer' as const
```

`SubmitClarifyAnswersSchema` 追加字段：

```ts
export const SubmitClarifyAnswersSchema = z.object({
  answers: z.array(ClarifyAnswerSchema),
  ifMatchIteration: z.number().int().nonnegative().optional(),
  directive: ClarifyDirectiveSchema.default('continue'),
  /** RFC-058: per-question scope mapping. Optional — when omitted (旧客户端 /
   *  self-clarify 路径) the backend treats every question as 'designer' for
   *  RFC-056 行为保留. Keys MUST be questionIds present in the session's
   *  questions array; unknown keys → HTTP 422 'cross-clarify-question-scopes-malformed'.
   *  Self-clarify 路径接受但忽略此字段（不写入 clarify_sessions、不影响 rerun）. */
  questionScopes: z.record(z.string(), ClarifyQuestionScopeSchema).optional(),
})
```

**RFC-058 final API**：GET 详情走 `ClarifyRoundSchema`（packages/shared/src/schemas/clarify.ts:322）；本 RFC 在该 schema 追加只读字段（自 `kind: 'cross'` 行有效，`kind: 'self'` 行恒为 null）：

```ts
export const ClarifyRoundSchema = z.object({
  // ...既有字段...
  /** RFC-059: scope mapping 持久化结果。NULL（旧行 / self-clarify 行）或缺 key
   *  → 视为 'designer'。仅在 kind='cross' + answered/abandoned 状态有意义；
   *  awaiting_human 与 kind='self' 期间永远是 null。 */
  questionScopes: z.record(z.string(), ClarifyQuestionScopeSchema).nullable().default(null),
})
```

dual-write 期 `CrossClarifySessionSchema` 也同步追加同字段，避免 RFC-058 dual-write helper 类型不一致：

```ts
export const CrossClarifySessionSchema = z.object({
  // ...既有字段...
  questionScopes: z.record(z.string(), ClarifyQuestionScopeSchema).nullable().default(null),
})
```

`ClarifyRoundSummarySchema` / `CrossClarifySessionSummarySchema`（列表项）**不**加 questionScopes 字段——列表不渲染 scope 详情，仅在详情页用到。

### 2.2 shared/clarify.ts 纯函数

`packages/shared/src/clarify.ts` 追加（**3 个新纯函数 — 全部仅用于设计者侧过滤**；反问者侧不需要任何新 helper，继续走生产入口 `buildPromptContext({ consumerKind: 'cross-questioner', ... })` 全量注入路径，遗留 `buildQuestionerCrossClarifyContext` 也维持原样）。注意本仓没有 `clarify-cross.ts` 文件；`buildExternalFeedbackBlock` 与 `CrossClarifySourceContext` 都已经住在 `clarify.ts:443`，本 RFC 的 helper 与之并列：

```ts
/** Default to 'designer' for any question id not present in the map (incl.
 *  the null case where the whole map was never set — e.g. RFC-056 rows). */
export function resolveQuestionScope(
  scopes: Record<string, ClarifyQuestionScope> | null,
  questionId: string,
): ClarifyQuestionScope {
  if (scopes === null) return CLARIFY_QUESTION_SCOPE_DEFAULT
  return scopes[questionId] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
}

/** Extract the subset of (questions, answers) that should be forwarded to the
 *  designer for External Feedback. Designer-scoped questions (the default)
 *  enter External Feedback; questioner-scoped questions are filtered out.
 *
 *  IMPORTANT: This is for the DESIGNER side only. The questioner side ALWAYS
 *  receives the full Q&A regardless of scope — the scope flag is a one-way
 *  "also send to designer" toggle. Do not use this helper to filter the
 *  questioner's cascade-rerun injection. */
export function extractDesignerScopedSubset(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
  scopes: Record<string, ClarifyQuestionScope> | null,
): { questions: ClarifyQuestion[]; answers: ClarifyAnswer[] } {
  const designerQ: ClarifyQuestion[] = []
  const designerA: ClarifyAnswer[] = []
  const byId = new Map(answers.map((a) => [a.questionId, a]))
  for (const q of questions) {
    const a = byId.get(q.id)
    if (a === undefined) continue
    if (resolveQuestionScope(scopes, q.id) === 'designer') {
      designerQ.push(q)
      designerA.push(a)
    }
  }
  return { questions: designerQ, answers: designerA }
}

/** Helper for service-layer "designerCount=0 → skip designer rerun" decision.
 *  Sums designer-scoped question count across all already-resolved sources. */
export function countDesignerScopedAcrossSources(
  sources: ReadonlyArray<{
    questions: ClarifyQuestion[]
    scopes: Record<string, ClarifyQuestionScope> | null
  }>,
): number {
  let n = 0
  for (const s of sources) {
    for (const q of s.questions) {
      if (resolveQuestionScope(s.scopes, q.id) === 'designer') n++
    }
  }
  return n
}
```

**`buildExternalFeedbackBlock` 不改签名**：调用方在传入 `CrossClarifySourceContext[]` 之前用 `extractDesignerScopedSubset` 过滤，传入的 questions/answers 已是 designer-scoped 子集。

### 2.3 schema 守门

`packages/shared/tests/clarify-question-scope-shared.test.ts`（新文件）：
- `ClarifyQuestionScopeSchema` enum 仅接受 'designer' / 'questioner'。
- `SubmitClarifyAnswersSchema` 接受 questionScopes 字段、缺省 / null / 空对象都 parse 成功。
- `ClarifyRoundSchema` 接受 questionScopes 字段 + nullable default null（kind='self' / 'cross' 两种行都要绿）。
- `CrossClarifySessionSchema` 接受 questionScopes 字段 + nullable default null（dual-write 期向后兼容）。
- `resolveQuestionScope(null, ...)` → 'designer'；scopes 缺 key → 'designer'；scopes 有 key → 该值。
- `extractDesignerScopedSubset` 单测：全 designer / 全 questioner / 混合 / 空 / 缺 answer 跳过对应题。
- `countDesignerScopedAcrossSources` 单测：多 source 聚合 / 空 sources / 全 questioner sources。

## 3. DB migration 0032

`packages/backend/db/migrations/0032_rfc059_clarify_rounds_question_scopes.sql`：

```sql
ALTER TABLE cross_clarify_sessions ADD COLUMN question_scopes_json TEXT;
ALTER TABLE clarify_rounds ADD COLUMN question_scopes_json TEXT;
```

无 index、无 FK——纯 nullable TEXT 列，NULL 默认。**双表都改**：RFC-058 dual-write 期两张表同时承载 cross-clarify 数据，任一缺列会让 submit dual-write 失败。drizzle schema 同步更新（`packages/backend/src/db/schema.ts`）：

```ts
export const crossClarifySessions = sqliteTable('cross_clarify_sessions', {
  // ...既有列...
  /** RFC-059: JSON object `Record<questionId, 'designer'|'questioner'>`. NULL
   *  when (a) session predates RFC-059 / (b) client didn't send questionScopes
   *  on submit. In both cases the runtime treats every question as 'designer'
   *  for byte-level RFC-056/058 compatibility. */
  questionScopesJson: text('question_scopes_json'),
})

export const clarifyRounds = sqliteTable('clarify_rounds', {
  // ...既有列（含 RFC-058 kind 判别符 + 重命名后字段）...
  /** RFC-059: same payload as crossClarifySessions.questionScopesJson; written
   *  by submit dual-write. Always NULL for kind='self' rows; may be NULL for
   *  kind='cross' rows when client didn't send questionScopes. */
  questionScopesJson: text('question_scopes_json'),
})
```

**测试**（`packages/backend/tests/migration-0032-rfc059-question-scopes.test.ts`，3 case）：
1. migration 上行：两张表都含 `question_scopes_json` 列，类型 TEXT、NULL 默认。
2. 已存 cross_clarify_sessions 行（譬如 RFC-056 happy path 装的）经过 migration 后该列 = NULL，其它列字节级不变。
3. 已存 clarify_rounds 行（RFC-058 dual-write 写入的）经过 migration 后该列 = NULL，其它列字节级不变。

## 4. backend service：submit 分支扩展

### 4.1 函数签名与 outcome 枚举

`packages/backend/src/services/crossClarify.ts` 的 `SubmitCrossClarifyAnswersArgs` 增字段：

```ts
export interface SubmitCrossClarifyAnswersArgs {
  // ...既有字段...
  /** RFC-058: per-question scope decision. Optional (旧客户端 / 全 designer
   *  默认行为). Keys 必须是 session.questions[].id；未引用的 key 默认 'designer'. */
  questionScopes?: Record<string, ClarifyQuestionScope>
}
```

`SubmitCrossClarifyAnswersResult.outcome` 枚举追加：

```ts
outcome:
  | { kind: 'designer-rerun-triggered'; designerNodeRunId: string; sourceCount: number }
  | { kind: 'designer-waiting'; pendingCrossClarifyNodeIds: string[] }
  | { kind: 'designer-target-missing' }
  | { kind: 'questioner-stop-triggered'; questionerNodeRunId: string }
  /** RFC-058 新增：directive='continue' + 本 session 全 questioner-scope →
   *  跳过 designer / readiness、直接触发 questioner cascade rerun. */
  | { kind: 'questioner-continue-triggered'; questionerNodeRunId: string }
  /** RFC-058 新增：directive='continue' + multi-source readiness=true + 聚合
   *  designer-scoped 题数=0 → 跳过 designer rerun. 每个 source 自己的 questioner
   *  已在各自 submit 时独立 cascade. */
  | { kind: 'designer-skipped-all-questioner-scope' }
```

### 4.2 submit 主路径分支

`submitCrossClarifyAnswers`（`packages/backend/src/services/crossClarify.ts:334`）内部修改（关键分支，伪码）：

```ts
// 1. 解析 + 校验 questionScopes（malformed → 400）
const scopes = validateQuestionScopes(args.questionScopes, questions)  // throws ValidationError

// 2. 写入 cross_clarify_sessions + clarify_rounds（追加 question_scopes_json 列；
//    RFC-058 dual-write 同事务、两条 UPDATE 顺序与 line 380+/391+ 一致）
const scopesJson = scopes === undefined ? null : JSON.stringify(scopes)
await db.update(crossClarifySessions).set({
  answersJson: JSON.stringify(sealedAnswers),
  status: 'answered',
  directive: args.directive,
  answeredAt,
  questionScopesJson: scopesJson,
}).where(eq(crossClarifySessions.id, row.id))
await db.update(clarifyRounds).set({
  answersJson: JSON.stringify(sealedAnswers),
  status: 'answered',
  directive: args.directive,
  answeredAt,
  questionScopesJson: scopesJson,
}).where(eq(clarifyRounds.id, row.id))

// 3. directive='stop' → 走 RFC-056 reject 路径，scope 持久但忽略
if (args.directive === 'stop') {
  // ...既有 triggerQuestionerStopRerun 路径，零改动...
}

// 4. directive='continue' + 本 session 全 questioner-scope → 快路径
const designerSplit = extractDesignerScopedSubset(questions, sealedAnswers, scopes ?? null)
if (designerSplit.questions.length === 0) {
  const outcome = await triggerQuestionerContinueRerun({
    db, taskId: row.taskId,
    questionerNodeRunId: row.sourceQuestionerNodeRunId,
  })
  broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
  // 不广播 designer-rerun-batched（designer 没动）
  return {
    session: sessionAfter,
    outcome: { kind: 'questioner-continue-triggered', questionerNodeRunId: outcome.questionerNodeRunId },
  }
}

// 5. directive='continue' + 有 designer-scoped → 走 RFC-056 multi-source readiness
const readiness = await evaluateDesignerRerunReadiness({...})
if (!readiness.ready) {
  return { session: sessionAfter, outcome: { kind: 'designer-waiting', ...} }
}

// 6. readiness=true + 聚合 designer-scoped=0 → 跳过 designer rerun
const aggregatedDesignerCount = countDesignerScopedAcrossSources(
  readiness.sources.map((s) => ({ questions: s.questions, scopes: s.questionScopes }))
)
if (aggregatedDesignerCount === 0) {
  broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
  return { session: sessionAfter, outcome: { kind: 'designer-skipped-all-questioner-scope' } }
}

// 7. 正常 designer rerun（External Feedback 在构造 sources 时按 scope 过滤）
const rerun = await triggerDesignerRerun({
  // ...既有参数...
  sources: readiness.sources.map((s) => {
    const subset = extractDesignerScopedSubset(s.questions, s.answers, s.questionScopes)
    return { ...s, questions: subset.questions, answers: subset.answers }
  }),
})
// ...broadcast designer-rerun-batched + 返回 designer-rerun-triggered outcome
```

### 4.3 新 helper triggerQuestionerContinueRerun

`packages/backend/src/services/crossClarify.ts` 加：

```ts
/** RFC-058: directive='continue' 但本 session 全 questioner-scope 时的快路径。
 *  与 triggerQuestionerStopRerun 并列、但**不**注入 STOP CLARIFYING anchor、
 *  **不**写 directive='stop' 持久化语义；走 RFC-056 现有 questioner cascade
 *  rerun 路径，只是不经过 designer 重跑。 */
export async function triggerQuestionerContinueRerun(args: {
  db: DbClient
  taskId: string
  questionerNodeRunId: string
}): Promise<{ questionerNodeRunId: string }> {
  // 复用 RFC-014 cascade reset + RFC-056 patch-2026-05-25 questioner cascade
  // no-skip 逻辑。本 helper 几乎是 triggerQuestionerStopRerun 的副本——区别
  // 仅在不追加 STOP CLARIFYING trailer；__clarify_questions__ /
  // __clarify_answers__ 注入走 RFC-056 既有 buildQuestionerCrossClarifyContext
  // 全量注入路径（不按 scope 过滤——反问者本就该看完整 Q&A）。
  // 实现 ~30 行；细节见 plan.md T4.
}
```

### 4.4 prompt 注入侧改动

**仅设计者侧需要新过滤逻辑**。`packages/backend/src/services/crossClarify.ts:1136` 的 `buildExternalFeedbackContext`：在构造 `CrossClarifySourceContext` 时把 `cross_clarify_sessions.questionScopesJson` 列读出来，按 'designer' 过滤 questions/answers 后再传给 `buildExternalFeedbackBlock`。

**反问者侧两条入口都字节级不动**——RFC-056/058 既有路径已经是"该 session 全量 Q&A 注入"，本 RFC 不改变这个行为：

- 生产入口 `packages/backend/src/services/clarifyRounds.ts:294` `buildPromptContext({ consumerKind: 'cross-questioner', ... })`（RFC-058 T13 合并后 scheduler 唯一调用方）—— 不读 `questionScopesJson`、不调 `extractDesignerScopedSubset`。
- 遗留入口 `packages/backend/src/services/crossClarify.ts:1223` `buildQuestionerCrossClarifyContext`（PR-A baseline 锚）—— 同样不读。

scope=NULL（旧行）/ scope 全 designer / scope 全 questioner / scope 混合，四种情况下反问者收到的 `__clarify_questions__` / `__clarify_answers__` 文本完全一致——单只 session 的全部 questions × answers。

伪码（实际位置在 `crossClarify.ts` 现有 `buildExternalFeedbackContext`）：

```ts
// 设计者侧（新增过滤）
async function buildExternalFeedbackContext(...) {
  // ...既有 source 收集逻辑...
  for (const session of consumedSessions) {
    const allQ = JSON.parse(session.questionsJson) as ClarifyQuestion[]
    const allA = JSON.parse(session.answersJson ?? '[]') as ClarifyAnswer[]
    const scopes = session.questionScopesJson === null
      ? null
      : (JSON.parse(session.questionScopesJson) as Record<string, ClarifyQuestionScope>)
    const subset = extractDesignerScopedSubset(allQ, allA, scopes)
    // skip empty sources（用户把该 source 全切 questioner、聚合时本就不会到这里、
    // 但二次防御兜底）
    if (subset.questions.length === 0) continue
    sources.push({
      sourceQuestionerNodeId: session.sourceQuestionerNodeId,
      crossClarifyNodeId: session.crossClarifyNodeId,
      iteration: session.iteration,
      questions: subset.questions,
      answers: subset.answers,
    })
  }
  return buildExternalFeedbackBlock(sources)
}

// 反问者侧（零改动，RFC-056/058 既有路径，两条入口都不动）
// (a) 生产入口：clarifyRounds.ts:294 buildPromptContext + consumerKind='cross-questioner'
//     直接从 clarify_rounds 取 row.questionsJson / row.answersJson 全量注入；
//     不读 row.questionScopesJson。
// (b) 遗留入口：crossClarify.ts:1223 buildQuestionerCrossClarifyContext
//     直接从 cross_clarify_sessions 取全量注入；不读 questionScopesJson。
// directive='stop' 时上层 dispatcher 还会追加 STOP CLARIFYING trailer（RFC-039）。
```

### 4.5 evaluateDesignerRerunReadiness 扩展

函数返回 `sources` 数组每项追加 `questionScopes: Record<string, ClarifyQuestionScope> | null` 字段（直接读 `cross_clarify_sessions.questionScopesJson` 解析——本函数本来就读 legacy 表，与 `buildExternalFeedbackContext` 同侧）。其它字段不变。

`ReadinessSource` 类型：

```ts
interface ReadinessSource {
  sessionId: string
  sourceQuestionerNodeId: string
  crossClarifyNodeId: string
  iteration: number
  questions: ClarifyQuestion[]
  answers: ClarifyAnswer[]
  /** RFC-058 新增 */
  questionScopes: Record<string, ClarifyQuestionScope> | null
}
```

`ready=true` 判定不变（仍要求所有 peer resolved）；本 RFC 在调用方（submit 主路径）增加二级判断 `countDesignerScopedAcrossSources(sources) > 0` 才真触发 designer rerun。

### 4.6 service 单测

`packages/backend/tests/cross-clarify-question-scope.test.ts`（新文件 + ≥ 9 case）：

1. `submitCrossClarifyAnswers` 不传 questionScopes → outcome 与 RFC-058 main baseline 同（happy path）+ 双表 question_scopes_json 都写 NULL。
2. 传 questionScopes 全 'designer' → 同上 + 双表 question_scopes_json 写 `{"q1":"designer","q2":"designer",...}`，两表字节级一致。
3. 传 questionScopes 全 'questioner' → outcome='questioner-continue-triggered' + designer 不重跑 + 双表 question_scopes_json 写。
4. 传 questionScopes 混合 → outcome='designer-rerun-triggered' + designer External Feedback **仅含 designer-scoped 题**；questioner cascade rerun Q&A **含全量题与答案**（不过滤）。
5. multi-source：peer A 全 questioner 快路径 + peer B 还在 awaiting → A outcome='questioner-continue-triggered'，B 状态不变；B submit 后聚合判断。
6. multi-source 聚合 designerCount=0 → outcome='designer-skipped-all-questioner-scope'。
7. 反 reject + 混合 scope：directive='stop' + questionScopes 混合 → outcome='questioner-stop-triggered'，questioner prompt 含全量 Q&A（含 STOP CLARIFYING anchor），question_scopes_json 持久但运行时忽略。
8. malformed questionScopes（引用未知 questionId）→ throw ValidationError → HTTP 422 + 错误码 `cross-clarify-question-scopes-malformed`。
9. dual-write 双表 questionScopesJson 字节级一致（防御 future 单写漂移）。

`packages/backend/tests/cross-clarify-rfc059-compat.test.ts`（C1 守门，2 case）：
- 不传 questionScopes 跑完整 happy path → designer prompt 文本与"RFC-059 上线前"main baseline 字节级一致（snapshot file 锁字符串）。
- 不传 questionScopes 跑 reject 路径 → questioner cascade rerun prompt 字节级一致（通过生产入口 `buildPromptContext` 调用断言）。

## 5. REST 路由

`packages/backend/src/routes/clarify.ts` 改动两处：

1. POST `/api/clarify/:nodeRunId/answers`：解析 `request.body.questionScopes`（已经在 `SubmitClarifyAnswersSchema` 里 optional），把它原样传给 `submitCrossClarifyAnswers`。self-clarify 路径**不读**该字段。
2. GET `/api/clarify/:nodeRunId`：RFC-058 已切到 `getClarifyRoundDetail` 返回 `ClarifyRound`；本 RFC 让该 helper 在拼装 DTO 时把 `clarify_rounds.questionScopesJson` 解析后填入 `ClarifyRound.questionScopes`（NULL → null；非空 → `Record<questionId, scope>`）。self-clarify 行恒为 null（migration 0032 后默认 NULL、submit 也不写）。

REST 单测（追加到 `packages/backend/tests/routes-cross-clarify.test.ts` + `packages/backend/tests/routes-clarify.test.ts`，4 case）：

1. POST 不带 questionScopes → 200 + 既有行为。
2. POST 带合法 questionScopes → 200 + 双表 question_scopes_json 写入。
3. POST 带 malformed questionScopes（譬如 scope='unknown'）→ 422 + 错误码 `cross-clarify-question-scopes-malformed`。
4. GET 详情 cross-clarify session → 返回 `ClarifyRound.questionScopes`（NULL → null；非空 → 解析后的对象）。

## 6. WS 事件

**不新增 WS variant**。`cross-clarify.answered` 已有，前端按 outcome 字段路由 invalidation；新 outcome 'questioner-continue-triggered' / 'designer-skipped-all-questioner-scope' 在 `cross-clarify.answered` payload 已涵盖（前端通过 query 重新拉详情拿到最新 status / outcome）。

## 7. frontend：详情页 per-question scope 控件

### 7.1 状态管理

`packages/frontend/src/routes/clarify.detail.tsx` 加 `scopes` 本地 state。**注意**：RFC-058 把前端切到 `ClarifyRound`（带 `kind: 'self'|'cross'` 判别符）；本 RFC 在 `s.kind === 'cross'` 分支内挂 UI。

```tsx
const [scopes, setScopes] = useState<Record<string, ClarifyQuestionScope>>({})

// 1. 初始化：kind='cross' + awaiting_human → 全部默认 'designer'；
//    kind='cross' + sealed → 从 round.questionScopes 还原（NULL → 全 designer）；
//    kind='self' → 不渲染 scope 控件、state 保持空。
useEffect(() => {
  const s = round.data
  if (s === undefined || s.kind !== 'cross') return
  const initial: Record<string, ClarifyQuestionScope> = {}
  for (const q of s.questions) {
    initial[q.id] = s.questionScopes?.[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
  }
  setScopes(initial)
}, [round.data])
```

### 7.2 Per-question Segmented 控件

修改 `QuestionForm` 调用层，把 scope 渲染加在题目标题右侧（不进 QuestionForm 内部、保持 RFC-023 self-clarify 路径零改动）：

```tsx
{s.questions.map((q, idx) => (
  <div key={q.id} className="clarify-question-wrapper">
    {isCross && (
      <div className="clarify-question-scope" data-testid={`clarify-scope-${q.id}`}>
        <span className="muted">{t('crossClarify.questionScope.label')}:</span>
        {readonly ? (
          <span
            className={`status-chip status-chip--${scopes[q.id] === 'questioner' ? 'blue' : 'neutral'}`}
            data-testid={`clarify-scope-chip-${q.id}`}
          >
            {t(`crossClarify.questionScope.${scopes[q.id]}`)}
          </span>
        ) : (
          <Segmented
            value={scopes[q.id] ?? 'designer'}
            options={[
              { value: 'designer', label: t('crossClarify.questionScope.designer') },
              { value: 'questioner', label: t('crossClarify.questionScope.questioner') },
            ]}
            onChange={(v) => setScopes((prev) => ({ ...prev, [q.id]: v as ClarifyQuestionScope }))}
            data-testid={`clarify-scope-segmented-${q.id}`}
          />
        )}
      </div>
    )}
    <QuestionForm {...既有 props} />
  </div>
))}
```

### 7.3 Footer submit hint

```tsx
{isCross && !readonly && (() => {
  const designerCount = s.questions.filter((q) => (scopes[q.id] ?? 'designer') === 'designer').length
  const questionerCount = s.questions.length - designerCount
  let hintKey: string
  let hintData: Record<string, number>
  if (designerCount === 0) {
    hintKey = 'crossClarify.submitHint.allQuestioner'
    hintData = { n: questionerCount }
  } else if (questionerCount === 0) {
    hintKey = 'crossClarify.submitHint.allDesigner'
    hintData = { n: designerCount }
  } else {
    hintKey = 'crossClarify.submitHint.mixed'
    hintData = { d: designerCount, q: questionerCount }
  }
  return (
    <p className="muted" data-testid="cross-clarify-submit-hint" data-hint-kind={hintKey}>
      {t(hintKey, hintData)}
    </p>
  )
})()}
```

### 7.4 提交体携带 questionScopes

`submitMut.mutationFn` 内构造请求体时追加：

```ts
const body: SubmitClarifyAnswers = {
  answers: arr,
  ifMatchIteration,
  directive,
}
if (s.kind === 'cross') {
  body.questionScopes = scopes
}
const resp = await api.post<SubmitClarifyAnswersResponse>(
  `/api/clarify/${ownerNodeRunId}/answers`,
  body,
)
```

### 7.5 i18n keys

`packages/frontend/src/i18n/zh-CN.ts` / `en-US.ts` 各加 6 个 key（详见 proposal §2.1 第 12 项）。i18next 占位符使用 `{{n}}` / `{{d}}` / `{{q}}`。

### 7.6 frontend 单测

`packages/frontend/tests/cross-clarify-scope-control.test.tsx`（新文件，6 case）：

1. cross-clarify awaiting + 3 题 → 渲染 3 个 Segmented，全部默认 'designer'。
2. 点 Segmented 切某题为 'questioner' → footer hint 切到 'mixed' 文案。
3. 全部题切到 'questioner' → footer hint 切到 'allQuestioner' 文案。
4. submit 触发 → 请求 body 含 questionScopes object（key=每题 id、value=当前 scope）。
5. sealed 状态（status='answered'）→ Segmented 被替换为只读 chip；scopes 从 session.questionScopes 还原。
6. self-clarify 节点 detail 页 → 不渲染 scope 控件、不传 questionScopes（行为字节级与 RFC-058 上线前一致）。

`packages/frontend/tests/cross-clarify-scope-i18n.test.ts`（C5 守门，1 case）：
- grep zh-CN.ts / en-US.ts 各含 `crossClarify.questionScope.label` / `.designer` / `.questioner` / `submitHint.allDesigner` / `.allQuestioner` / `.mixed` 6 个 key。
- 各 key 中英 value 都非空。
- 占位符严格匹配：`allDesigner` / `allQuestioner` 必须含 `{{n}}`；`mixed` 必须含 `{{d}}` 和 `{{q}}`。

## 8. backward compatibility

### 8.1 旧 cross_clarify_sessions / clarify_rounds 行

migration 0032 后所有 RFC-056/058 时代的 answered 行（双表）question_scopes_json=NULL。三处需要正确 fallback：

- `buildExternalFeedbackContext`（读 cross_clarify_sessions）：`extractDesignerScopedSubset(questions, answers, null)` → resolveQuestionScope 返回 'designer' → 全量进 designer 子集，与 RFC-056/058 行为一致。
- 反问者侧两条入口（生产 `buildPromptContext` 读 clarify_rounds + 遗留 `buildQuestionerCrossClarifyContext` 读 cross_clarify_sessions）：**零改动**，注入该 session 的全量 Q&A，与 RFC-056/058 一致；不读 questionScopesJson 列。
- `/clarify/{id}` 详情页 GET：clarify_rounds.question_scopes_json=NULL → `ClarifyRound.questionScopes: null` → 前端初始化 fallback 为全 designer chip（A8 验收）。

### 8.2 旧客户端

POST 不带 questionScopes → 后端跑 RFC-056 路径。question_scopes_json 写 NULL。

A7 验收覆盖。

### 8.3 self-clarify 路径

`packages/backend/src/services/clarify.ts` 的 `submitClarifyAnswers`（RFC-023 路径）**不读** `args.questionScopes`。`SubmitClarifyAnswersSchema` 的 optional 字段被 self-clarify route 忽略。

dual-write 期 self-clarify 也写 clarify_rounds（kind='self'），但本 RFC submit 路径不在 self 分支写 `questionScopesJson`，列保持 NULL；`getClarifyRoundDetail` 拼 DTO 时 `questionScopes: null` 给前端。

A10 验收 + RFC-023 既有套件零退化。

## 9. 错误码 + i18n

新增错误码 1 条：

| code                                          | severity | HTTP | 触发                                                                              |
| --------------------------------------------- | -------- | ---- | --------------------------------------------------------------------------------- |
| `cross-clarify-question-scopes-malformed`     | fail     | 422  | submit body 的 questionScopes 字段引用未知 questionId / scope 值非 enum / 非 Record。**注意**：proposal §A9 草稿写 HTTP 400，落地用 `ValidationError`（codebase 约定 → HTTP 422 Unprocessable Entity，语义更准）。 |

i18n key 6 条详见 proposal §2.1 第 12 项。

## 10. 测试策略总结

- **shared 单测** ≥ 7（schemas 3：Submit/ClarifyRound/CrossClarifySession + 纯函数 3 + enum 1）
  - 文件名 `clarify-question-scope-shared.test.ts`
- **backend 单测** ≥ 15
  - service `cross-clarify-question-scope.test.ts` 9 case
  - service `cross-clarify-rfc059-compat.test.ts` 2 case（C1 守门，main baseline）
  - service `cross-clarify-questioner-full-injection.test.ts` 1 case（C3 守门，反问者侧不过滤，覆盖**双入口** grep）
  - service `cross-clarify-fast-path-isolation.test.ts` 1 case（C4 守门）
  - migration `migration-0032-rfc059-question-scopes.test.ts` 3 case（双表 + 已有行）
- **frontend 单测** ≥ 6
  - `cross-clarify-scope-control.test.tsx` 6 case
  - `cross-clarify-scope-i18n.test.ts` 1 case（C5 守门）
- **e2e** 不增量（A1/A2/A3 在 vitest 已覆盖；e2e fixture stub-opencode 维护成本不抵收益）。

**回归防护汇总**：C1 RFC-058 main baseline happy path byte-level / C2 extractDesignerScopedSubset 纯函数 / C3 反问者侧两条入口不过滤 + reject 注入全量 / C4 multi-source 快路径不污染 / C5 i18n cn/en 对齐——共 5 条守门。

## 11. 关键决策理由与替代方案

详见 proposal.md §5。本节补 3 个 design 层细节：

1. **questionScopes 存 JSON 列 vs 表**：选 JSON 列。理由 proposal §5.2。补充：service 层用 `JSON.parse(session.questionScopesJson ?? 'null') ?? null` 拿到 `Record | null`、单行操作；表方案需要每次 JOIN + 单题列保存，性能 / 代码量 / 测试面都更大且没有查询场景需要单题 JOIN（scope 永远整体读/整体写）。
2. **submit body 字段名 `questionScopes` vs `questionScopeMap` vs `scopes`**：选 `questionScopes`。`scopes` 太泛、容易与未来其它"作用域"语义撞名；`questionScopeMap` 啰嗦；`questionScopes` 紧凑明确。
3. **outcome 新枚举值 'questioner-continue-triggered' vs '复用 questioner-stop-triggered'**：选新枚举。理由：前端 toast 文案 / navigate 行为 / WS event invalidation 路径都不同——stop 是终局决策（直接跳转 task detail），continue 是常规递进（与 designer rerun 类似的 inline 反馈）；复用会让前端两个语义混在一个分支里，未来加新行为成本高。

## 12. 实施风险与缓解（design 层）

| 风险 | 缓解 |
|------|------|
| `extractDesignerScopedSubset` 在 questions / answers 数组不同步时（譬如旧行 answers 部分缺失）产生空对结果 | 函数内 `byId.get(q.id) === undefined` 时跳过该题；测试 case 覆盖 |
| `triggerQuestionerContinueRerun` 与 `triggerQuestionerStopRerun` 代码重复 → 维护漂移 | 抽出共享 helper `_cascadeResetAndDispatchQuestioner({ injectStop: boolean })`；两个 public helper 都委托给它 |
| 反问者侧路径意外被改 → 注入按 scope 过滤 → RFC-056/058 行为退化 | C1 / C3 双守门：C1 锁 main baseline 字节级、C3 grep 锁**两条入口**（生产 `buildPromptContext` cross-questioner 分支 + 遗留 `buildQuestionerCrossClarifyContext`）不读 questionScopesJson；改动需要先跑两条 |
| RFC-058 dual-write 期单表漏写 questionScopesJson | T3 测试增加"双表 questionScopesJson 字节级一致"case；service 层抽 helper `serializeQuestionScopes()` 避免两条写路径分裂 |
| `evaluateDesignerRerunReadiness` 加 questionScopes 字段到 sources 后调用方需要更新 | 改动是 sources 数组每项**追加**字段（不删除既有字段）；TypeScript 编译期能捕获遗漏 |
| 前端 `<Segmented>` 控件在 RFC-035 中已使用、但本 RFC 把它放进 QuestionForm 外层 wrapper → 视觉与现有 self-clarify 题目不一致 | 视觉对齐自查：CSS 加 `.clarify-question-wrapper` + `.clarify-question-scope` 样式调；与 NodeInspector 的 sessionMode 控件 side-by-side 比对 |
