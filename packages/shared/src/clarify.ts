// Pure functions and constants for the RFC-023 clarify node + RFC-056
// cross-clarify node. Shared between the backend runner / scheduler / clarify
// service and the frontend canvas drag helper / prompt preview pane. No Bun
// / Node / DB imports — keep this module easy to test in either runtime.
//
// RFC-058 merged the previous standalone `clarify-cross.ts` module into this
// file so the two clarify modes share a single source of truth (envelope
// parser, prompt block render, channel-edge detection). The cross-clarify
// helpers retain their `CROSS_CLARIFY_*` naming so external grep patterns
// keep working; only the import path changed.

import { z } from 'zod'

import type {
  ClarifyCrossAgentNode,
  ClarifyCrossAgentSessionMode,
  ClarifyNode,
  ClarifySessionMode,
  WorkflowDefinition,
  WorkflowEdge,
} from './schemas/workflow'
import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
} from './schemas/workflow'
import {
  ClarifyEnvelopeBodySchema,
  ClarifyQuestionSchema,
  CLARIFY_MAX_QUESTIONS,
  CLARIFY_MAX_OPTIONS_PER_QUESTION,
  CLARIFY_QUESTION_SCOPE_DEFAULT,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyEnvelopeBody,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
  type ClarifyTruncationWarning,
} from './schemas/clarify'

// -----------------------------------------------------------------------------
// envelope parsing
// -----------------------------------------------------------------------------

export interface ParseClarifyEnvelopeResult {
  /** Parsed body with truncations applied; null if a hard error occurred. */
  body: ClarifyEnvelopeBody | null
  /** Non-fatal warnings emitted while normalising the input. */
  warnings: ClarifyTruncationWarning[]
  /** Hard errors. When non-empty, body is null and the agent reply is rejected. */
  errors: ClarifyTruncationWarning[]
}

/** Options accepted by `parseClarifyEnvelopeBody`. RFC-023 self-clarify nodes
 *  pass nothing (or `maxQuestions: 5`); RFC-056 cross-clarify nodes pass
 *  `maxQuestions: Number.POSITIVE_INFINITY` to disable the question-count
 *  truncation entirely. Default preserves RFC-023 behavior byte-for-byte. */
export interface ParseClarifyEnvelopeOptions {
  /** Maximum question count before the parser truncates + emits a warning.
   *  Defaults to {@link CLARIFY_MAX_QUESTIONS} (5). Pass
   *  `Number.POSITIVE_INFINITY` for the RFC-056 cross-clarify path. */
  maxQuestions?: number
}

/**
 * Parse the JSON body found inside `<workflow-clarify>...</workflow-clarify>`.
 * Permissive: questions > MAX are truncated to the first MAX, options > MAX
 * per question are truncated, and each truncation produces a warning. Hard
 * failures (JSON.parse error, missing questions array, empty title, kind not
 * single/multi, options < MIN, options non-string) produce errors and body=null.
 *
 * RFC-056: optional `maxQuestions` lifts the question-count cap for the
 * cross-clarify path. Self-clarify callers pass no opts and keep the legacy
 * 5-question truncation behavior unchanged.
 */
export function parseClarifyEnvelopeBody(
  jsonText: string,
  opts: ParseClarifyEnvelopeOptions = {},
): ParseClarifyEnvelopeResult {
  const warnings: ClarifyTruncationWarning[] = []
  const errors: ClarifyTruncationWarning[] = []
  const maxQuestions = opts.maxQuestions ?? CLARIFY_MAX_QUESTIONS

  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch (err) {
    errors.push({
      code: 'clarify-questions-malformed',
      detail: `JSON.parse failed: ${(err as Error).message}`,
    })
    return { body: null, warnings, errors }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      code: 'clarify-questions-malformed',
      detail: 'envelope body must be a JSON object with a "questions" array',
    })
    return { body: null, warnings, errors }
  }
  const obj = raw as Record<string, unknown>
  const qList = obj.questions
  if (!Array.isArray(qList)) {
    errors.push({
      code: 'clarify-questions-malformed',
      detail: '"questions" must be an array',
    })
    return { body: null, warnings, errors }
  }

  let questions = qList
  if (questions.length > maxQuestions) {
    warnings.push({
      code: 'clarify-questions-too-many',
      detail: `got ${questions.length} questions, truncated to ${maxQuestions}`,
    })
    questions = questions.slice(0, maxQuestions)
  }

  const normalised: unknown[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      errors.push({
        code: 'clarify-questions-malformed',
        detail: `question[${i}] must be an object`,
      })
      continue
    }
    const qObj = q as Record<string, unknown>
    let opts = qObj.options
    if (Array.isArray(opts) && opts.length > CLARIFY_MAX_OPTIONS_PER_QUESTION) {
      warnings.push({
        code: 'clarify-options-too-many',
        detail: `question "${String(qObj.id ?? i)}" had ${opts.length} options, truncated to ${CLARIFY_MAX_OPTIONS_PER_QUESTION}`,
      })
      opts = opts.slice(0, CLARIFY_MAX_OPTIONS_PER_QUESTION)
    }
    normalised.push({ ...qObj, options: opts })
  }

  if (errors.length > 0) {
    return { body: null, warnings, errors }
  }

  // RFC-056: when `maxQuestions` lifts the question-count cap (cross-clarify
  // path), the static `.max(CLARIFY_MAX_QUESTIONS)` constraint on
  // `ClarifyEnvelopeBodySchema` would still reject the array. Build a parser
  // schema with the dynamic upper bound — questions individually still parse
  // through `ClarifyQuestionSchema`, so per-question validation is unchanged.
  const dynamicSchema =
    maxQuestions === CLARIFY_MAX_QUESTIONS
      ? ClarifyEnvelopeBodySchema
      : z.object({
          questions: z.array(ClarifyQuestionSchema).min(1).max(maxQuestions),
        })
  const result = dynamicSchema.safeParse({ questions: normalised })
  if (!result.success) {
    const flat = result.error.flatten()
    for (const issue of result.error.issues) {
      // Translate zod path errors into framework error codes wherever we can
      // recognise the shape; otherwise emit a generic malformed code with the
      // path joined for the runner / user log.
      const path = issue.path.join('.')
      if (path.includes('options') && issue.code === 'too_small') {
        errors.push({
          code: 'clarify-options-too-few',
          detail: `${path}: ${issue.message}`,
        })
      } else {
        errors.push({
          code: 'clarify-questions-malformed',
          detail: `${path}: ${issue.message}`,
        })
      }
    }
    if (errors.length === 0 && flat.formErrors.length > 0) {
      errors.push({
        code: 'clarify-questions-malformed',
        detail: flat.formErrors.join('; '),
      })
    }
    return { body: null, warnings, errors }
  }

  return { body: result.data, warnings, errors }
}

// -----------------------------------------------------------------------------
// prompt rendering (markdown)
// -----------------------------------------------------------------------------

/** Render the agent-facing markdown block listing the questions the agent
 *  asked last round. Used for `{{__clarify_questions__}}`. Option-level
 *  Recommended + description + recommendationReason are surfaced inline so
 *  the agent has the same context the user saw. */
export function renderClarifyQuestionsBlock(questions: ClarifyQuestion[]): string {
  const lines: string[] = []
  questions.forEach((q, idx) => {
    const kindLabel = q.kind === 'single' ? 'single-choice' : 'multi-choice'
    lines.push(`### Q${idx + 1}: ${q.title}`)
    lines.push(`- Type: ${kindLabel}`)
    lines.push(`- Candidate options:`)
    q.options.forEach((opt, i) => {
      const recMark = opt.recommended ? ' [recommended]' : ''
      lines.push(`  ${i + 1}. ${opt.label}${recMark}`)
      if (opt.description.length > 0) {
        lines.push(`     description: ${opt.description}`)
      }
      if (opt.recommended && opt.recommendationReason.length > 0) {
        lines.push(`     reason: ${opt.recommendationReason}`)
      }
    })
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

/** Render the user-answered Q&A block. One line per question summarising
 *  what the user picked. Used for `{{__clarify_answers__}}`.
 *
 *  Previous versions emitted four fields per question (Type / Selected /
 *  Custom note / Synthesis); the structured fields were redundant with the
 *  natural-language synthesis (and Type just repeated what the questions
 *  block above already showed). The synthesis sentence covers every case —
 *  empty answer, multi with custom, custom-only, etc — see
 *  {@link summariseClarifyAnswer}. Keeping only the synthesis halves the
 *  token cost of this block and removes a "why are these the same thing"
 *  trap for both the agent and any human reviewing the prompt. */
export function buildClarifyPromptBlock(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
  directive?: ClarifyDirective,
): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]))
  const lines: string[] = []
  questions.forEach((q, idx) => {
    const a = byId.get(q.id)
    lines.push(`### Q${idx + 1}: ${q.title}`)
    if (!a) {
      lines.push(`- User did not answer this question.`)
    } else {
      lines.push(`- ${summariseClarifyAnswer(q, a)}`)
    }
    lines.push('')
  })
  const trailer = renderClarifyDirectiveTrailer(directive)
  if (trailer.length > 0) {
    lines.push(trailer)
  }
  return lines.join('\n').trimEnd()
}

/** Render the trailing English instruction that converts the user's
 *  continue-or-stop directive into a sentence the asking agent can read in
 *  its next-round prompt. Emitted at the end of `buildClarifyPromptBlock`
 *  so the directive sits right where the agent finishes consuming the
 *  user's answers.
 *
 *  - 'continue' → RFC-100 mandatory directive: user clicked "Keep clarifying",
 *    so the agent MUST emit another `<workflow-clarify>` envelope. The runner
 *    keeps the clarify-only format attached AND rejects any `<workflow-output>`
 *    at runtime — there is no output escape hatch while clarifying.
 *  - 'stop'    → release: the user ended clarification, so the runner injects
 *    the `<workflow-output>` format (and withholds the clarify format) and the
 *    agent finalizes from the answers above.
 *  - undefined → empty string (legacy behaviour: no trailer at all).
 *
 *  Exported so backend tests can lock the exact wording — changing it is
 *  a contract break with already-running agents in mid-task. */
export function renderClarifyDirectiveTrailer(directive?: ClarifyDirective): string {
  if (directive === 'stop') {
    return [
      '### User directive: STOP CLARIFYING',
      '- The user has ended clarification. You are now RELEASED from ask-back mode — do NOT emit another <workflow-clarify> envelope.',
      '- Produce your final <workflow-output> reply now using the answers above. If any detail is still ambiguous, make your best informed call based on the answers and proceed.',
    ].join('\n')
  }
  if (directive === 'continue') {
    return [
      '### User directive: KEEP CLARIFYING',
      '- The user has clicked "Keep clarifying" — they want another round. This node is in mandatory ask-back mode: your next reply MUST be another `<workflow-clarify>` envelope.',
      '- Keep probing every still-unresolved detail that matters. Do not attempt <workflow-output> — the framework will reject it until the user clicks "Stop clarifying".',
    ].join('\n')
  }
  return ''
}

/** Deterministic single-sentence English synthesis for one answer. The agent
 *  reads this in its next prompt to quickly grasp what the user expressed.
 *  Five cases (see RFC-023 design §5):
 *   - single, idx selected, no custom: `User chose: "Postgres"`
 *   - single, custom only:             `User chose custom answer: "<text>"`
 *   - multi, ≥1 idx, no custom:        `User selected: "A", "B"`
 *   - multi, idx + custom:             `User selected: "A", "B" with additional note: "<text>"`
 *   - multi, custom only:              `User selected only the custom answer: "<text>"`
 *   - empty:                           `User did not answer this question.` */
export function summariseClarifyAnswer(question: ClarifyQuestion, answer: ClarifyAnswer): string {
  const labels = answer.selectedOptionLabels
  const custom = answer.customText.trim()
  if (labels.length === 0 && custom.length === 0) {
    return 'User did not answer this question.'
  }
  if (question.kind === 'single') {
    if (labels.length === 0) {
      return `User chose custom answer: "${custom}"`
    }
    // Single-choice with a candidate selected; custom should be empty per UI
    // mutual-exclusion, but tolerate it anyway by appending if present.
    const head = `User chose: "${labels[0]}"`
    return custom.length > 0 ? `${head} (additional note: "${custom}")` : head
  }
  // multi
  if (labels.length === 0) {
    return `User selected only the custom answer: "${custom}"`
  }
  const joined = labels.map((s) => `"${s}"`).join(', ')
  if (custom.length === 0) {
    return `User selected: ${joined}`
  }
  return `User selected: ${joined} with additional note: "${custom}"`
}

// -----------------------------------------------------------------------------
// definition-level helpers
// -----------------------------------------------------------------------------

/**
 * RFC-026: resolve the session mode for a clarify node. Missing field (legacy
 * v3 workflows authored before RFC-026) is normalized to `'isolated'`, which
 * preserves RFC-023 behavior byte-for-byte. Centralizing the fallback here
 * keeps callers from sprinkling `?? 'isolated'` everywhere and gives the
 * regression-guard test one place to lock the default.
 */
export function resolveClarifySessionMode(node: ClarifyNode): ClarifySessionMode {
  return node.sessionMode ?? 'isolated'
}

export function agentHasClarifyChannel(
  definition: WorkflowDefinition,
  agentNodeId: string,
): boolean {
  return definition.edges.some(
    (e) => e.source.nodeId === agentNodeId && e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
}

export function findClarifyNodeForAgent(
  definition: WorkflowDefinition,
  agentNodeId: string,
): string | undefined {
  const edge = definition.edges.find(
    (e) => e.source.nodeId === agentNodeId && e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
  return edge?.target.nodeId
}

/** Helper for the canvas reverse-drag interaction. Returns the two edges to
 *  splice into definition.edges when the user drags from a clarify node's
 *  input handle onto an agent node:
 *
 *    agent.__clarify__         → clarify.questions    (system question channel)
 *    clarify.answers           → agent.__clarify_response__ (visual completion of the cycle)
 *
 *  The second edge can be deleted by the user without breaking answer
 *  injection (the runtime ties session ↔ source agent via clarify_session
 *  rows, not via this edge). It exists for canvas legibility. */
export function buildClarifyEdges(
  sourceAgentNodeId: string,
  clarifyNodeId: string,
): WorkflowEdge[] {
  const base = `e_${sourceAgentNodeId}_${clarifyNodeId}`
  return [
    {
      id: `${base}_clarify`,
      source: { nodeId: sourceAgentNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: clarifyNodeId, portName: CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: `${base}_answers`,
      source: { nodeId: clarifyNodeId, portName: CLARIFY_OUTPUT_PORT_NAME },
      target: { nodeId: sourceAgentNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
}

// =============================================================================
// RFC-056 cross-clarify — pure helpers (merged from clarify-cross.ts via
// RFC-058 T10).
// =============================================================================

/** Title used by the auto-appended External Feedback section in the designer's
 *  user prompt. */
export const CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE = '## External Feedback' as const

// RFC-119: prior-output heading + directive constants. Originally RFC-056 §6
// cross-clarify-only (named CROSS_CLARIFY_*); RFC-119 renamed them to neutral
// and unified the directive to "update OR regenerate" so BOTH the cross-clarify
// update-mode path AND the generalized rerun path (review reject/iterate, manual
// retry, cascade, resume, self-clarify) share one wording. See RFC-119 design
// §3.1 / D4.
export const PRIOR_OUTPUT_BLOCK_TITLE = '## Prior Output (to update or regenerate)' as const
export const UPDATE_DIRECTIVE_BLOCK_TITLE = '## Update Directive' as const

/** Neutral directive shared by both prior-output paths (RFC-119 D4). Honors the
 *  user's 「更新或重新生成」: bias toward incremental update, allow a full
 *  regenerate when the feedback is fundamental, and demand the COMPLETE output
 *  (never a diff). The closing sentence handles file-path ports (the agent
 *  re-reads the worktree file). */
export const UPDATE_DIRECTIVE_TEXT = [
  'The "Prior Output" section above is what you produced on your previous run of',
  'this node. This run exists because that output needs to change — see the',
  'feedback in the sections above. Update the prior output to address that',
  'feedback, preserving the parts it does not contradict; regenerate it from',
  'scratch only if the feedback requires fundamental changes. Either way you MUST',
  'emit the COMPLETE updated output in the workflow-output envelope — never a diff',
  'or a description of changes alone. When a Prior Output port is a file path,',
  'read that file for its contents.',
].join(' ')

/**
 * RFC-056: parse the JSON body of a `<workflow-clarify>` envelope produced by a
 * questioner agent wired through a cross-clarify node. Reuses the RFC-023
 * parser end-to-end; the only difference is `maxQuestions = +Infinity` which
 * disables the question-count truncation.
 */
export function parseCrossClarifyEnvelopeBody(jsonText: string): ParseClarifyEnvelopeResult {
  return parseClarifyEnvelopeBody(jsonText, { maxQuestions: Number.POSITIVE_INFINITY })
}

/** One source's contribution to the designer's External Feedback batch. */
export interface CrossClarifySourceContext {
  sourceQuestionerNodeId: string
  crossClarifyNodeId: string
  iteration: number
  questions: ClarifyQuestion[]
  answers: ClarifyAnswer[]
}

/**
 * Render the designer-facing `## External Feedback` body. Sources sort by
 * questioner nodeId (dictionary order); each source becomes a
 * `### From '{nodeId}' (round {iteration})` sub-section with the full question
 * detail (via {@link renderClarifyQuestionsBlock}) shifted from `### Q` to
 * `#### Q` so the markdown outline stays coherent.
 */
export function buildExternalFeedbackBlock(sources: CrossClarifySourceContext[]): string {
  if (sources.length === 0) return ''
  const sorted = [...sources].sort((a, b) =>
    a.sourceQuestionerNodeId.localeCompare(b.sourceQuestionerNodeId),
  )
  const lines: string[] = []
  for (const src of sorted) {
    lines.push(`### From '${src.sourceQuestionerNodeId}' (round ${src.iteration})`)
    lines.push('')
    const questionsBlock = renderClarifyQuestionsBlock(src.questions)
    lines.push(questionsBlock.replace(/^### Q/gm, '#### Q'))
    lines.push('')
    const byId = new Map(src.answers.map((a) => [a.questionId, a]))
    lines.push('Answers:')
    src.questions.forEach((q, idx) => {
      const a = byId.get(q.id)
      lines.push(
        `- Q${idx + 1} (${q.title}): ${a === undefined ? 'User did not answer this question.' : summariseClarifyAnswer(q, a)}`,
      )
    })
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Render a single source's contribution. */
export function renderCrossClarifySource(src: CrossClarifySourceContext): string {
  return buildExternalFeedbackBlock([src])
}

/**
 * RFC-120 §15 — render ONE manual question's contribution to the `## External Feedback`
 * body. A manual question carries a human-authored instruction (no questioner Q&A), so it
 * renders as a `### Manual instruction: {title}` sub-section (same `###` level as a cross-
 * clarify source's `### From '...'`) followed by the body verbatim. This is the manual side
 * of the §15.4 "注入面归一": the per-node queue resolves each entry's content — cross from
 * the session Q&A (buildExternalFeedbackBlock), manual from manual_body (here) — and the two
 * concatenate into one block. Returns '' when both title and body are empty (skip the entry).
 */
export function renderManualFeedbackSection(title: string | null, body: string | null): string {
  const t = (title ?? '').trim()
  const b = (body ?? '').trim()
  if (t.length === 0 && b.length === 0) return ''
  const lines: string[] = []
  lines.push(`### Manual instruction: ${t.length > 0 ? t : '(untitled)'}`)
  lines.push('')
  if (b.length > 0) lines.push(b)
  return lines.join('\n').trimEnd()
}

// -----------------------------------------------------------------------------
// RFC-059 per-question scope helpers
//
// scope is a one-way "also send to designer" flag, decided per-question at
// submit time on cross-clarify nodes:
//   - 'designer'   → answer enters BOTH the designer's External Feedback
//                    (filtered subset, via extractDesignerScopedSubset) AND
//                    the questioner's cascade rerun Q&A (full, no filter).
//   - 'questioner' → answer enters ONLY the questioner's cascade rerun Q&A
//                    (full, no filter); the designer is not notified.
//
// IMPORTANT: the questioner side is NEVER filtered. The questioner always
// receives the entire session's Q&A in its cascade rerun, regardless of
// scope distribution. See design.md §4.4 + acceptance criterion A3b for the
// reasoning (the questioner needs full context to decide its next move).
// -----------------------------------------------------------------------------

/** Resolve the scope of a single question id against a stored map.
 *
 *   - `scopes === null` (row predates RFC-059 / kind='self' / client did not
 *     send questionScopes) → returns the default 'designer'.
 *   - `scopes` missing the key → also returns the default 'designer'.
 *   - `scopes[questionId]` set → returns that value verbatim.
 *
 *   Pure: no allocation, no validation (callers validate at submit time via
 *   validateQuestionScopes() in the backend service). */
export function resolveQuestionScope(
  scopes: Record<string, ClarifyQuestionScope> | null,
  questionId: string,
): ClarifyQuestionScope {
  if (scopes === null) return CLARIFY_QUESTION_SCOPE_DEFAULT
  return scopes[questionId] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
}

/** Extract the (questions, answers) subset that should be forwarded to the
 *  designer's External Feedback block. Questions whose scope resolves to
 *  'designer' (the default) are kept; 'questioner'-scoped questions are
 *  filtered out. Questions without a matching answer (e.g. the user closed
 *  the form without answering a particular row) are skipped — the backend
 *  treats "no answer" as "do not forward".
 *
 *  IMPORTANT: This is the DESIGNER side only. Do NOT use it to filter the
 *  questioner's cascade-rerun Q&A injection — the questioner always sees
 *  the full Q&A regardless of scope.
 *
 *  Returns a fresh tuple (no aliasing into the input arrays). */
export function extractDesignerScopedSubset(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
  scopes: Record<string, ClarifyQuestionScope> | null,
): { questions: ClarifyQuestion[]; answers: ClarifyAnswer[] } {
  const designerQuestions: ClarifyQuestion[] = []
  const designerAnswers: ClarifyAnswer[] = []
  const byId = new Map(answers.map((a) => [a.questionId, a]))
  for (const q of questions) {
    const a = byId.get(q.id)
    if (a === undefined) continue
    if (resolveQuestionScope(scopes, q.id) === 'designer') {
      designerQuestions.push(q)
      designerAnswers.push(a)
    }
  }
  return { questions: designerQuestions, answers: designerAnswers }
}

/** RFC-128 §7 — merge a freshly-sealed answer subset into a round's existing answers
 *  (per-question merge-write; the round's `answers_json` stays the answer-content SoT).
 *  Incoming answers WIN per `questionId`; existing answers for questions NOT in the
 *  incoming subset are preserved untouched. Order is stable: existing answers keep
 *  their position (value replaced in place when re-sealed), then never-before-seen
 *  incoming answers are appended in incoming order. So a whole-round one-shot seal
 *  (existing empty) returns exactly the incoming array — byte-for-byte identical to the
 *  pre-RFC-128 overwrite (golden-lock). Returns a fresh array (no input aliasing). */
export function mergeSealedAnswers(
  existing: ClarifyAnswer[],
  incoming: ClarifyAnswer[],
): ClarifyAnswer[] {
  const incomingById = new Map(incoming.map((a) => [a.questionId, a]))
  const merged: ClarifyAnswer[] = []
  const seen = new Set<string>()
  for (const a of existing) {
    merged.push(incomingById.get(a.questionId) ?? a)
    seen.add(a.questionId)
  }
  for (const a of incoming) {
    if (!seen.has(a.questionId)) {
      merged.push(a)
      seen.add(a.questionId)
    }
  }
  return merged
}

/** Sum the designer-scoped question count across multiple already-resolved
 *  cross-clarify sources. Used by `submitCrossClarifyAnswers` to decide
 *  whether the aggregated External Feedback batch is empty — when it is,
 *  the designer is not rerun (outcome
 *  `designer-skipped-all-questioner-scope`).
 *
 *  Sources whose own answers do not include a particular question are not
 *  double-counted — `extractDesignerScopedSubset` skips them, so this helper
 *  agrees with what eventually lands in the External Feedback block. */
export function countDesignerScopedAcrossSources(
  sources: ReadonlyArray<{
    questions: ClarifyQuestion[]
    answers: ClarifyAnswer[]
    scopes: Record<string, ClarifyQuestionScope> | null
  }>,
): number {
  let n = 0
  for (const s of sources) {
    const subset = extractDesignerScopedSubset(s.questions, s.answers, s.scopes)
    n += subset.questions.length
  }
  return n
}

/**
 * RFC-056 §6 update mode: render the designer's last done output verbatim so
 * the agent can read the working draft instead of regenerating from scratch.
 */
export function buildPriorOutputBlock(
  outputs: ReadonlyArray<{
    portName: string
    content: string
  }>,
): string {
  if (outputs.length === 0) return ''
  const lines: string[] = []
  for (const o of outputs) {
    if (o.content.trim().length === 0) continue
    lines.push(`### ${o.portName}`)
    lines.push('')
    lines.push(o.content)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Convenience deterministic synthesis for a single (question, answer) pair.
 * RFC-056 reuses the RFC-023 implementation verbatim.
 */
export function summariseCrossAnswer(question: ClarifyQuestion, answer: ClarifyAnswer): string {
  return summariseClarifyAnswer(question, answer)
}

/**
 * RFC-056 + RFC-026: resolve the QUESTIONER rerun's opencode session mode off a
 * cross-clarify node. The designer rerun is always isolated — it never resumes
 * a session — so RFC-056 patch 2026-06-22 removed the dead
 * `sessionModeForDesigner` and this helper no longer takes a direction.
 */
export function resolveCrossClarifySessionMode(
  node: ClarifyCrossAgentNode,
): ClarifyCrossAgentSessionMode {
  return node.sessionModeForQuestioner ?? 'isolated'
}

/**
 * RFC-023 + RFC-056: classify an edge as a "clarify-channel" edge — the kind
 * that connects the self-clarify cycle or the cross-clarify cycle.
 */
export function isClarifyChannelEdge(e: WorkflowEdge): boolean {
  return (
    e.source.portName === CLARIFY_SOURCE_PORT_NAME ||
    e.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME ||
    e.target.portName === CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT ||
    e.source.portName === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT ||
    e.source.portName === CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT
  )
}

/**
 * RFC-056: locate the cross-clarify node attached to a given questioner via
 * the auto-edge `questioner.__clarify__ → newNode.questions`.
 */
export function findCrossClarifyNodeForQuestioner(
  definition: WorkflowDefinition,
  questionerNodeId: string,
): string | undefined {
  const edges = definition.edges ?? []
  const nodes = definition.nodes ?? []
  for (const e of edges) {
    if (e.source.nodeId !== questionerNodeId) continue
    if (e.source.portName !== CLARIFY_SOURCE_PORT_NAME) continue
    if (e.target.portName !== CROSS_CLARIFY_INPUT_PORT_NAME) continue
    const tgt = nodes.find((n) => n.id === e.target.nodeId)
    if (tgt?.kind === 'clarify-cross-agent') return tgt.id
  }
  return undefined
}

/**
 * RFC-122: an "asking-agent node" is an agent that can clarify — either it
 * wires a RFC-023 self-clarify channel (`agentHasClarifyChannel`) OR its
 * `__clarify__` port feeds a RFC-056 cross-clarify node so it is a questioner
 * (`findCrossClarifyNodeForQuestioner`). Both predicates key on the same
 * `__clarify__` SOURCE port, so the second is a (documented) superset guard —
 * kept explicit so the per-(task, asking-node) clarify-directive toggle shows on
 * exactly the nodes the runtime gates ask-back for, and never on the
 * clarify / clarify-cross-agent CHANNEL nodes (which are edge TARGETS, not
 * sources). Single source of truth for the API validation + the canvas display
 * gate so the two can never drift.
 */
export function isClarifyAskingNode(definition: WorkflowDefinition, nodeId: string): boolean {
  return (
    agentHasClarifyChannel(definition, nodeId) ||
    findCrossClarifyNodeForQuestioner(definition, nodeId) !== undefined
  )
}

/**
 * RFC-056: check whether an agent node has at least one inbound
 * `__external_feedback__` system port edge.
 */
export function agentHasExternalFeedbackChannel(
  definition: WorkflowDefinition,
  agentNodeId: string,
): boolean {
  const edges = definition.edges ?? []
  return edges.some(
    (e) =>
      e.target.nodeId === agentNodeId && e.target.portName === CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  )
}

/**
 * RFC-056: resolve the designer NodeId pointed at by a cross-clarify node's
 * `to_designer` output.
 */
export function findDesignerNodeForCrossClarify(
  definition: WorkflowDefinition,
  crossClarifyNodeId: string,
): string | undefined {
  const edges = definition.edges ?? []
  const edge = edges.find(
    (e) =>
      e.source.nodeId === crossClarifyNodeId &&
      e.source.portName === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT &&
      e.target.portName === CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  )
  return edge?.target.nodeId
}

/**
 * RFC-056: enumerate every cross-clarify node whose `to_designer` manual edge
 * targets `designerNodeId`. Order is preserved from `definition.nodes`.
 */
export function findCrossClarifyNodesPointingToDesigner(
  definition: WorkflowDefinition,
  designerNodeId: string,
): string[] {
  const edges = definition.edges ?? []
  const targeting = new Set<string>()
  for (const e of edges) {
    if (e.target.nodeId !== designerNodeId) continue
    if (e.target.portName !== CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT) continue
    if (e.source.portName !== CROSS_CLARIFY_OUT_TO_DESIGNER_PORT) continue
    targeting.add(e.source.nodeId)
  }
  const order = new Map<string, number>()
  ;(definition.nodes ?? []).forEach((n, idx) => order.set(n.id, idx))
  return Array.from(targeting).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

/**
 * RFC-056: resolve the QUESTIONER NodeId attached to a cross-clarify node.
 */
export function findQuestionerNodeForCrossClarify(
  definition: WorkflowDefinition,
  crossClarifyNodeId: string,
): string | undefined {
  const edges = definition.edges ?? []
  const edge = edges.find(
    (e) =>
      e.target.nodeId === crossClarifyNodeId &&
      e.target.portName === CROSS_CLARIFY_INPUT_PORT_NAME &&
      e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
  return edge?.source.nodeId
}

/**
 * Helper for the canvas reverse-drag interaction. Returns the two edges to
 * splice into definition.edges when the user drags from a cross-clarify
 * node's input handle onto an agent node.
 */
export function buildCrossClarifyAutoEdges(
  questionerNodeId: string,
  crossClarifyNodeId: string,
): WorkflowEdge[] {
  const base = `e_${questionerNodeId}_${crossClarifyNodeId}`
  return [
    {
      id: `${base}_clarify`,
      source: { nodeId: questionerNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: crossClarifyNodeId, portName: CROSS_CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: `${base}_to_questioner`,
      source: { nodeId: crossClarifyNodeId, portName: CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT },
      target: { nodeId: questionerNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
}
