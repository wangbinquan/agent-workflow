// Clarify schemas (RFC-023). The clarify node lets an agent emit a structured
// "I need answers before I can produce output" envelope. The framework parks
// the task, surfaces the questions to the user, captures structured answers,
// and re-spawns the asking agent with the answers injected into the next-round
// prompt.
//
// Reads/parses are PERMISSIVE: agents that over-emit questions/options are
// truncated to limits and a non-fatal warning is recorded. Hard schema
// failures (kind enum, options < 2, empty title) reject the envelope and the
// node fails with the standard retries path.

import { z } from 'zod'

export const CLARIFY_MAX_QUESTIONS = 5
export const CLARIFY_MAX_OPTIONS_PER_QUESTION = 4
export const CLARIFY_MIN_OPTIONS_PER_QUESTION = 2
export const CLARIFY_MAX_CUSTOM_TEXT_LEN = 2000

export const ClarifyQuestionKindSchema = z.enum(['single', 'multi'])
export type ClarifyQuestionKind = z.infer<typeof ClarifyQuestionKindSchema>

/** Per-option metadata (RFC-023 iteration #2 — moved Recommended from
 *  question level down to option level). Each option carries the label the
 *  user sees, an explanatory description (rendered muted under the label),
 *  a recommended flag (the agent's pick), and an explanation of why it's
 *  recommended. All but `label` default to empty strings / false so the
 *  bare-minimum agent emission still parses cleanly. */
export const ClarifyOptionSchema = z.object({
  /** Picker text (≤ 256 chars). */
  label: z.string().min(1).max(256),
  /** Free-form explanation of what this option means, the expected outcome,
   *  trade-offs. Rendered in muted text below the label. ≤ 512 chars. */
  description: z.string().max(512).default(''),
  /** When true, this option is highlighted as the agent's suggestion. The
   *  parser sorts recommended options first within their question so the
   *  user's eye lands on them. */
  recommended: z.boolean().default(false),
  /** Why the agent recommends this option (rendered below the description
   *  in the recommended-callout style). Only meaningful when `recommended`
   *  is true. ≤ 512 chars. */
  recommendationReason: z.string().max(512).default(''),
})
export type ClarifyOption = z.infer<typeof ClarifyOptionSchema>

/** Accepts both legacy `string` options (backward compat with v1 envelope
 *  + already-stored sessions in clarify_sessions.questions_json) and the
 *  new {label, description, recommended, recommendationReason} object form.
 *  Strings get lifted into the object shape with defaults. */
const ClarifyOptionInputSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    return { label: v, description: '', recommended: false, recommendationReason: '' }
  }
  return v
}, ClarifyOptionSchema)

/** One question the agent asked. The framework appends a 5th "free-text" row
 *  in the UI automatically; agents must NOT include a free-text option here. */
export const ClarifyQuestionSchema = z.object({
  /** Stable identifier chosen by the agent. ≤ 64 chars. */
  id: z.string().min(1).max(64),
  /** Question text (≤ 512 chars). */
  title: z.string().min(1).max(512),
  /** single = radio + mutually-exclusive custom row; multi = checkbox + parallel custom row. */
  kind: ClarifyQuestionKindSchema,
  /** DEPRECATED — kept for backward compatibility with already-stored sessions.
   *  Old envelopes used this flag to mark a question "required to answer";
   *  the chip was confusing and the user moved "recommended" semantics down
   *  to option level. New emissions should leave this false (default) and
   *  set `recommended` per-option instead. The form no longer renders a
   *  required-question chip; submit accepts empty answers. */
  recommended: z.boolean().default(false),
  /** Candidate options. Between MIN (2) and MAX (4); over-emission is
   *  truncated and a warning recorded at parse time. Sorted by `recommended`
   *  (true first) at the parsing layer so the UI doesn't have to re-sort. */
  options: z
    .array(ClarifyOptionInputSchema)
    .min(CLARIFY_MIN_OPTIONS_PER_QUESTION)
    .max(CLARIFY_MAX_OPTIONS_PER_QUESTION)
    .transform((opts) => sortOptionsByRecommended(opts)),
})
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>

/** Stable sort: recommended options first, preserving original order
 *  within each group (so a deterministic emission stays deterministic). */
export function sortOptionsByRecommended(opts: ClarifyOption[]): ClarifyOption[] {
  const annotated = opts.map((opt, i) => ({ opt, i }))
  annotated.sort((a, b) => {
    const ra = a.opt.recommended ? 0 : 1
    const rb = b.opt.recommended ? 0 : 1
    if (ra !== rb) return ra - rb
    return a.i - b.i
  })
  return annotated.map((a) => a.opt)
}

/** What `<workflow-clarify>` body JSON.parse must yield (after truncation). */
export const ClarifyEnvelopeBodySchema = z.object({
  questions: z.array(ClarifyQuestionSchema).min(1).max(CLARIFY_MAX_QUESTIONS),
})
export type ClarifyEnvelopeBody = z.infer<typeof ClarifyEnvelopeBodySchema>

/** One user answer for one question. */
export const ClarifyAnswerSchema = z.object({
  questionId: z.string().min(1),
  /** Indices into question.options. Empty array means "no candidate selected". */
  selectedOptionIndices: z.array(z.number().int().nonnegative()).default([]),
  /** Mirrors selectedOptionIndices via question.options[idx]. The backend
   *  re-fills this from the indices on submit — clients cannot inject
   *  arbitrary label strings. */
  selectedOptionLabels: z.array(z.string()).default([]),
  /** User-entered free-text. For single questions: filled means the custom
   *  row was chosen (mutually exclusive with selectedOptionIndices). For
   *  multi questions: filled means the user added supplementary text in
   *  addition to whatever candidates they ticked. */
  customText: z.string().max(CLARIFY_MAX_CUSTOM_TEXT_LEN).default(''),
})
export type ClarifyAnswer = z.infer<typeof ClarifyAnswerSchema>

/** User-supplied directive carried alongside the answers: tells the asking
 *  agent whether the next round should keep asking clarifications or stop and
 *  produce the final output. `continue` is the default — preserves legacy
 *  behaviour where the asking agent re-receives the clarify protocol block
 *  and decides on its own. `stop` instructs the runtime to (1) inject an
 *  explicit "user wants no more clarifications" sentence into the next-round
 *  prompt and (2) NOT append `<workflow-clarify>` protocol instructions to
 *  that same prompt, so the agent cannot re-ask this round even if it wanted
 *  to. Scope is exactly one rerun — see RFC-023 directive iteration. */
export const ClarifyDirectiveSchema = z.enum(['continue', 'stop'])
export type ClarifyDirective = z.infer<typeof ClarifyDirectiveSchema>

/** RFC-059: per-question scope flag (cross-clarify only).
 *
 *   - 'designer'   → answer is forwarded to BOTH the designer (External
 *                    Feedback) and the questioner (cascade rerun Q&A).
 *                    Default — preserves RFC-056 behaviour byte-for-byte.
 *   - 'questioner' → answer is forwarded ONLY to the questioner; the designer
 *                    is not notified and does not rerun on this question's
 *                    behalf. The questioner ALWAYS sees the full Q&A
 *                    regardless of scope (scope is a one-way "also send to
 *                    designer" toggle, not two-way routing).
 *
 *   Self-clarify rows ignore this field — the asking agent is itself the
 *   consumer, so there is no designer/questioner split. */
export const ClarifyQuestionScopeSchema = z.enum(['designer', 'questioner'])
export type ClarifyQuestionScope = z.infer<typeof ClarifyQuestionScopeSchema>

/** RFC-059: fallback for any question id missing from the scope map, AND for
 *  rows persisted before RFC-059 shipped (questionScopes column = NULL).
 *  Preserves RFC-056/058 behaviour. */
export const CLARIFY_QUESTION_SCOPE_DEFAULT = 'designer' as const

export const SubmitClarifyAnswersSchema = z.object({
  answers: z.array(ClarifyAnswerSchema),
  /** Optimistic-lock guard: must equal the session's current iterationIndex
   *  or the server returns 412 Precondition Failed (defends against two-tab
   *  double-submit). */
  ifMatchIteration: z.number().int().nonnegative().optional(),
  /** RFC-023 directive iteration: 'continue' (default — legacy behaviour) or
   *  'stop' (no more clarifying this rerun). Omitted bodies still parse so
   *  pre-directive clients keep working. */
  directive: ClarifyDirectiveSchema.default('continue'),
  /** RFC-059: per-question scope mapping for cross-clarify nodes.
   *  Optional — when omitted (old clients / self-clarify route) the backend
   *  treats every question as 'designer' (default), preserving RFC-056/058
   *  behaviour. Keys MUST be questionIds present in the session's questions
   *  array; unknown keys → HTTP 400 `cross-clarify-question-scopes-malformed`.
   *  Self-clarify route accepts but ignores this field — it is not written
   *  to clarify_rounds and does not influence rerun routing. */
  questionScopes: z.record(z.string(), ClarifyQuestionScopeSchema).optional(),
  /** RFC-128 P2 (T6) — defer intent / channel selector. Omitted / falsy = QUICK channel:
   *  the current whole-round behaviour (seal + mint the source/handler rerun + resume the
   *  task). `true` = CONTROL channel: seal the answered SUBSET via `sealRoundQuestions`
   *  WITHOUT minting any rerun or resuming — the sealed question(s) enter 待指派 for the
   *  centralized-answer pane / batch dispatch. Kept `.optional()` (NOT `.default(false)`)
   *  so the inferred type stays back-compatible: existing whole-round callers that omit it
   *  still satisfy `SubmitClarifyAnswers` ⇒ byte-for-byte the pre-RFC-128 submit (golden
   *  lock). */
  defer: z.boolean().optional(),
  /** RFC-128 P2 (T5) — optional subset cap. When present, only the answers whose
   *  `questionId` is in this list are sealed/submitted (the rest are ignored). Lets the
   *  centralized pane and the /clarify coordination (P4) declare EXACTLY which questions a
   *  submission may touch (so it never re-seals a sibling already sealed by another tab).
   *  Omitted ⇒ every answer is processed (golden lock — unchanged whole-round submit). */
  questionIds: z.array(z.string()).optional(),
})
export type SubmitClarifyAnswers = z.infer<typeof SubmitClarifyAnswersSchema>

export const ClarifySessionStatusSchema = z.enum(['awaiting_human', 'answered', 'canceled'])
export type ClarifySessionStatus = z.infer<typeof ClarifySessionStatusSchema>

export const ClarifyTruncationWarningSchema = z.object({
  code: z.string(),
  detail: z.string(),
})
export type ClarifyTruncationWarning = z.infer<typeof ClarifyTruncationWarningSchema>

export const ClarifySessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sourceAgentNodeId: z.string(),
  sourceAgentNodeRunId: z.string(),
  /** Shard key when the asking agent is a wrapper-fanout shard child; null otherwise. */
  sourceShardKey: z.string().nullable().default(null),
  clarifyNodeId: z.string(),
  /**
   * Display name from the workflow snapshot's clarify node (`WorkflowNode.title`).
   * Mirrors `sourceAgentNodeTitle`; surfaced so the detail H1 can render
   * "任务名 / 节点名" parity with the review side (RFC-037 follow-up). Null
   * when the clarify node has no title set or the snapshot is unavailable.
   */
  clarifyNodeTitle: z.string().nullable().optional(),
  clarifyNodeRunId: z.string(),
  /** Matches the source agent node_run's clarifyIteration at ask-time. */
  iterationIndex: z.number().int().nonnegative(),
  questions: z.array(ClarifyQuestionSchema),
  answers: z.array(ClarifyAnswerSchema).optional(),
  status: ClarifySessionStatusSchema,
  truncationWarnings: z.array(ClarifyTruncationWarningSchema).optional(),
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable().default(null),
  answeredBy: z.string().nullable().default(null),
  /** User's continue-or-stop directive captured at submit time. Null until
   *  the session is answered. Old answered rows persisted before the
   *  directive feature shipped will surface as 'continue' (the default
   *  semantics they always had). */
  directive: ClarifyDirectiveSchema.nullable().default(null),
})
export type ClarifySession = z.infer<typeof ClarifySessionSchema>

/** Compact entry for /api/clarify list. */
export const ClarifySessionSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /**
   * RFC-037: display name of the owning task (`tasks.name`). Required; backend
   * joins at query time. Lets the inbox show "PR-1234 修分页 bug · review:final"
   * instead of opaque ULIDs across multi-user mixed-source rows.
   */
  taskName: z.string(),
  sourceAgentNodeId: z.string(),
  /**
   * Display name from the workflow snapshot's source-agent node (the new
   * `WorkflowNode.title` field). Surfaced so the inbox can show the
   * user-set "节点名" instead of the opaque `sourceAgentNodeId`. Null when
   * the agent node has no title set or when the snapshot is unavailable.
   * Field is optional for backwards compatibility — clients that haven't
   * upgraded still see `sourceAgentNodeId`.
   */
  sourceAgentNodeTitle: z.string().nullable().optional(),
  sourceShardKey: z.string().nullable(),
  clarifyNodeId: z.string(),
  /**
   * Display name from the workflow snapshot's clarify node. Parallel to
   * `sourceAgentNodeTitle`; lets the inbox row render "节点标题" instead of
   * the opaque `clarifyNodeId`. Null when no title is set or the snapshot
   * is unavailable. Optional for back-compat with older daemons.
   */
  clarifyNodeTitle: z.string().nullable().optional(),
  clarifyNodeRunId: z.string(),
  iterationIndex: z.number().int().nonnegative(),
  questionCount: z.number().int().nonnegative(),
  status: ClarifySessionStatusSchema,
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
})
export type ClarifySessionSummary = z.infer<typeof ClarifySessionSummarySchema>

// ---------------------------------------------------------------------------
// RFC-056 cross-clarify wire shapes.
// ---------------------------------------------------------------------------

/** RFC-056: cross_clarify_sessions.status enum. No 'canceled' value (the
 *  cross-clarify path doesn't have a canceled state — only awaiting_human,
 *  answered, or abandoned). */
export const CrossClarifySessionStatusSchema = z.enum(['awaiting_human', 'answered', 'abandoned'])
export type CrossClarifySessionStatus = z.infer<typeof CrossClarifySessionStatusSchema>

/** Compact entry returned by GET /api/clarify when `kind=='cross'`. The
 *  list endpoint mixes self + cross summaries on the same wire; clients
 *  branch on `kind` (or on the presence of `crossClarifyNodeId` vs
 *  `clarifyNodeId`). */
export const CrossClarifySessionSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** RFC-037 parity: display name of the owning task. Lets the mixed inbox
   *  group rows by task name regardless of whether the row is self or cross. */
  taskName: z.string(),
  crossClarifyNodeId: z.string(),
  crossClarifyNodeRunId: z.string(),
  sourceQuestionerNodeId: z.string(),
  targetDesignerNodeId: z.string().nullable(),
  loopIter: z.number().int().nonnegative(),
  iteration: z.number().int().nonnegative(),
  questionCount: z.number().int().nonnegative(),
  status: CrossClarifySessionStatusSchema,
  directive: ClarifyDirectiveSchema.nullable(),
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
})
export type CrossClarifySessionSummary = z.infer<typeof CrossClarifySessionSummarySchema>

/** Full RFC-056 cross-clarify session (returned by GET /api/clarify/:nodeRunId
 *  when the node is `clarify-cross-agent`). */
export const CrossClarifySessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  crossClarifyNodeId: z.string(),
  crossClarifyNodeRunId: z.string(),
  sourceQuestionerNodeId: z.string(),
  sourceQuestionerNodeRunId: z.string(),
  targetDesignerNodeId: z.string().nullable(),
  loopIter: z.number().int().nonnegative(),
  iteration: z.number().int().nonnegative(),
  questions: z.array(ClarifyQuestionSchema),
  answers: z.array(ClarifyAnswerSchema).optional(),
  directive: ClarifyDirectiveSchema.nullable(),
  status: CrossClarifySessionStatusSchema,
  designerRunTriggeredAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
  abandonedAt: z.number().int().nullable(),
  /** RFC-059: per-question scope persisted at submit time. NULL when row
   *  predates RFC-059 OR when client did not send `questionScopes` — runtime
   *  treats every question as 'designer' in those cases (RFC-056 behaviour).
   *  Dual-write target: mirrors `ClarifyRound.questionScopes` (RFC-058
   *  dual-write retains both legacy + unified DTOs). */
  questionScopes: z.record(z.string(), ClarifyQuestionScopeSchema).nullable().default(null),
})
export type CrossClarifySession = z.infer<typeof CrossClarifySessionSchema>

/** RFC-056: tagged union returned by GET /api/clarify (mixed self + cross). */
export type ClarifyInboxEntry =
  | (ClarifySessionSummary & { kind: 'self' })
  | (CrossClarifySessionSummary & { kind: 'cross' })

// ---------------------------------------------------------------------------
// RFC-058 unified clarify_rounds schema (replaces both ClarifySession and
// CrossClarifySession in the upcoming refactor). Kept additive in PR-B's
// T9 step so the existing wire / services keep compiling while the migration
// + service merge land in T11/T12. The old types are removed when PR-B
// concludes (T17 grep guard).
// ---------------------------------------------------------------------------

/** RFC-058: which kind of clarify round this row represents. */
export const ClarifyRoundKindSchema = z.enum(['self', 'cross'])
export type ClarifyRoundKind = z.infer<typeof ClarifyRoundKindSchema>

/** RFC-058: unified status enum union. `'canceled'` is reachable only when
 *  kind='self' (RFC-023 task-cancel path); `'abandoned'` is reachable only
 *  when kind='cross' (RFC-056 CR-1 invariant upgrade). The DB CHECK constraint
 *  in migration 0031 enforces the cross-domain rule so application code does
 *  not need to re-validate. */
export const ClarifyRoundStatusSchema = z.enum([
  'awaiting_human',
  'answered',
  'canceled',
  'abandoned',
])
export type ClarifyRoundStatus = z.infer<typeof ClarifyRoundStatusSchema>

/** RFC-058: a single clarify round (Q&A turn). Replaces both
 *  {@link ClarifySession} and {@link CrossClarifySession}. The `kind`
 *  discriminator decides which fields are populated:
 *    - kind='self'  → `targetConsumerNodeId` is null; `askingNodeId` IS the
 *                     consuming agent (asking agent itself reads the answers
 *                     in its next rerun).
 *    - kind='cross' → `askingNodeId` is the questioner; `targetConsumerNodeId`
 *                     is the designer that receives the External Feedback;
 *                     `askingShardKey` is always null (RFC-056 v1 keeps
 *                     cross-clarify on agent-single).
 */
export const ClarifyRoundSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: ClarifyRoundKindSchema,

  askingNodeId: z.string(),
  askingNodeRunId: z.string(),
  /** Asking-side shard key — wrapper-fanout shard child for kind='self'; null for
   *  kind='cross' (RFC-056 v1 limits cross-clarify to agent-single). */
  askingShardKey: z.string().nullable().default(null),

  /** The clarify / clarify-cross-agent node id (the human-gated form node). */
  intermediaryNodeId: z.string(),
  intermediaryNodeRunId: z.string(),
  /** Display name from the workflow snapshot (parallel to RFC-037 task name). */
  intermediaryNodeTitle: z.string().nullable().optional(),

  /** Designer node id that receives External Feedback when kind='cross'. Null
   *  for kind='self' (the asking agent itself is the consumer). */
  targetConsumerNodeId: z.string().nullable().default(null),

  /** wrapper-loop iter (RFC-056 partial persistence). 0 for kind='self' or
   *  cross outside a loop. */
  loopIter: z.number().int().nonnegative().default(0),

  /** Monotonic round counter scoped to (intermediaryNodeId, loopIter). Matches
   *  RFC-023 `iterationIndex` when kind='self' and RFC-056 `iteration` when
   *  kind='cross'. */
  iteration: z.number().int().nonnegative(),

  questions: z.array(ClarifyQuestionSchema),
  answers: z.array(ClarifyAnswerSchema).optional(),
  directive: ClarifyDirectiveSchema.nullable().default(null),
  status: ClarifyRoundStatusSchema,

  truncationWarnings: z.array(ClarifyTruncationWarningSchema).optional(),

  /** RFC-026 inline session mode (kind='self' only; cross-clarify node
   *  carries the inline flag on the workflow node definition). */
  sessionMode: z.enum(['isolated', 'inline']).nullable().default(null),

  /** RFC-056 cross-clarify only. NULL for kind='self'. */
  designerRunTriggeredAt: z.number().int().nullable().default(null),
  abandonedAt: z.number().int().nullable().default(null),

  /** RFC-059: per-question scope persisted at submit time. Only meaningful for
   *  kind='cross'; kind='self' rows always carry null. NULL within kind='cross'
   *  means the client did not supply a `questionScopes` map (RFC-056/058
   *  backward compatibility) — runtime treats every question as 'designer'.
   *  Use {@link resolveQuestionScope} / {@link extractDesignerScopedSubset}
   *  (in `packages/shared/src/clarify.ts`) to read this safely. */
  questionScopes: z.record(z.string(), ClarifyQuestionScopeSchema).nullable().default(null),

  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable().default(null),
  answeredBy: z.string().nullable().default(null),
  /** RFC-099 (D7) — task-relationship role snapshot of answeredBy. UI-only.
   *  Optional so pre-RFC-099 fixtures keep compiling; backend always sets it. */
  submittedByRole: z.enum(['owner', 'user', 'admin']).nullable().optional(),
  /** RFC-099 (D8) — Record<questionId, {userId, role, updatedAt}>; live during
   *  drafting, frozen at submit. NEVER injected into agent prompts. */
  answerAttributions: z
    .record(
      z.string(),
      z.object({
        userId: z.string(),
        role: z.enum(['owner', 'user', 'admin']),
        updatedAt: z.number().int(),
      }),
    )
    .nullable()
    .optional(),
  /** RFC-099 (D8/D14) — server-side per-question draft values
   *  ({selectedOptionIndices, customText} per questionId); null once submitted. */
  draftAnswers: z
    .record(
      z.string(),
      z.object({
        selectedOptionIndices: z.array(z.number().int().nonnegative()).default([]),
        customText: z.string().default(''),
      }),
    )
    .nullable()
    .optional(),
})
export type ClarifyRound = z.infer<typeof ClarifyRoundSchema>

/** RFC-058: compact list-entry shape (replaces both ClarifySessionSummary and
 *  CrossClarifySessionSummary). */
export const ClarifyRoundSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** Owning task name (RFC-037 parity). */
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

export const ListClarifyQuerySchema = z.object({
  taskId: z.string().optional(),
  status: z.union([ClarifySessionStatusSchema, z.literal('all')]).optional(),
  limit: z.number().int().positive().max(500).default(100),
})
export type ListClarifyQuery = z.infer<typeof ListClarifyQuerySchema>

export const ClarifyPendingCountSchema = z.object({
  count: z.number().int().nonnegative(),
})
export type ClarifyPendingCount = z.infer<typeof ClarifyPendingCountSchema>

export const SubmitClarifyAnswersResponseSchema = z.object({
  session: ClarifySessionSchema,
  /** Newly minted source agent node_run id (clarifyIteration + 1, retry_index = 0). */
  rerunNodeRunId: z.string(),
})
export type SubmitClarifyAnswersResponse = z.infer<typeof SubmitClarifyAnswersResponseSchema>
