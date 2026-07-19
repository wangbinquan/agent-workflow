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
import { fenceUntrusted, sanitizeInlineField } from './promptFencing'
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
import { isSystemChannelEdge } from './systemChannelPorts'
import {
  ClarifyEnvelopeBodySchema,
  ClarifyQuestionSchema,
  CLARIFY_MAX_QUESTIONS,
  CLARIFY_MAX_OPTIONS_PER_QUESTION,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyEnvelopeBody,
  type ClarifyQuestion,
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

/** Render the trailing English instruction that converts the user's
 *  continue-or-stop directive into a sentence the asking agent can read in
 *  its next-round prompt. Emitted at the tail of clarify prompt content
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

/** RFC-141: ask-back variant of the prior-output section. A mandatory ask-back
 *  round (clarify-only protocol) with a prior captured output now ALSO gets the
 *  agent's own draft injected — RFC-119 D6 suppressed it on the premise that the
 *  combination was "nearly impossible", which cross-clarify multi-round flows
 *  disproved (a node with a done draft re-enters ask-back on every new answer
 *  batch). The title deliberately does NOT say "update or regenerate": this
 *  round must not produce output — the directive tells the agent to frame its
 *  QUESTIONS around revising the draft instead. */
export const ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE =
  "## Prior Output (your previous run's output)" as const
export const ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE = '## Prior Output Directive' as const
export const ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT = [
  'The "Prior Output" section above is what you produced on your previous run of',
  'this node. This round is still a clarify-only round — you MUST reply with a',
  'single <workflow-clarify> envelope and NO <workflow-output>. Frame your',
  'questions around how this prior output should be REVISED — do not re-litigate',
  'decisions the user has already settled in the Clarify Q&A. When a Prior Output',
  'port is a file path, read that file for its contents before asking.',
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

// =============================================================================
// RFC-132 — unified FLAT clarify queue render (PR-1 / T1).
//
// The single, flat `## Clarify Q&A` block that supersedes BOTH the round-grouped
// round-grouped loop (self / questioner) AND the designer-only External
// Feedback renderer — both deleted by RFC-148 (RFC-132 收尾). Every answered
// question renders as an EQUAL peer:
//   - NO `### Round N` grouping, NO history-vs-current-round split,
//   - NO sibling scope block, NO per-question directive trailer,
//   - ZERO attribution (RFC-099 — never render who asked / who answered).
// self, questioner and designer entries are INDISTINGUISHABLE here (the flat
// model's core invariant — the input type carries no role / round / owner field,
// so a caller structurally cannot group or attribute). Only a manual instruction
// (§15, no Q&A) differs in shape, rendered as a peer bullet of its body.
//
// RFC-132 PR-1 landed this UNWIRED next to the legacy renderers; the injector
// routing shipped with PR-C, and RFC-148 finished the ledger by deleting the
// round-grouped / External-Feedback renderers — this is the only surface.
// =============================================================================

/** The stable heading of the flat clarify queue block. Exported so the golden
 *  test locks it and PR-2 callers reference one constant. */
export const FLAT_CLARIFY_QUEUE_BLOCK_TITLE = '## Clarify Q&A' as const

/** One rendered entry of the flat queue: a resolved clarify Q&A (self /
 *  questioner / designer — all peers) OR a manual instruction (§15). The type
 *  deliberately has NO role / round / owner field — the flat model cannot group
 *  or attribute even if a caller tried. */
export type FlatClarifyEntry =
  | { question: ClarifyQuestion; answer: ClarifyAnswer | undefined }
  | { manualTitle: string | null; manualBody: string | null }

function isManualFlatEntry(
  e: FlatClarifyEntry,
): e is { manualTitle: string | null; manualBody: string | null } {
  return !('question' in e)
}

/** Render one Q&A entry as a flat peer bullet (self/questioner/designer alike). */
function renderFlatQaItem(
  question: ClarifyQuestion,
  answer: ClarifyAnswer | undefined,
  nonce: string,
): string {
  const kindLabel = question.kind === 'single' ? 'single-choice' : 'multi-choice'
  const optionLabels = question.options
    .map((o) => (o.recommended ? `${o.label} [recommended]` : o.label))
    .join(', ')
  const answerText =
    answer === undefined
      ? 'User did not answer this question.'
      : summariseClarifyAnswer(question, answer)
  const safe = (value: string): string => (nonce.length > 0 ? sanitizeInlineField(value) : value)
  return [
    `- Q: ${safe(question.title)}`,
    `  Type: ${kindLabel} / Options: ${safe(optionLabels)}`,
    `  Answer: ${safe(answerText)}`,
  ].join('\n')
}

/** Render one manual instruction (§15) as a flat peer bullet. Title (if any) is
 *  the bullet line; the body indents under it. Returns '' when both are empty. */
function renderFlatManualItem(title: string | null, body: string | null, nonce: string): string {
  const t = (title ?? '').trim()
  const b = (body ?? '').trim()
  if (t.length === 0 && b.length === 0) return ''
  if (nonce.length > 0) {
    const safeTitle = t.length > 0 ? sanitizeInlineField(t) : 'Manual instruction'
    const safeBody = fenceUntrusted('manual-instruction', b, nonce)
    return safeBody.length > 0 ? `- ${safeTitle}\n${safeBody}` : `- ${safeTitle}`
  }
  if (t.length === 0) {
    return b
      .split('\n')
      .map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`))
      .join('\n')
  }
  if (b.length === 0) return `- ${t}`
  const bodyLines = b
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
  return `- ${t}\n${bodyLines}`
}

/**
 * Render a list of already-answered clarify entries into the single flat
 * `## Clarify Q&A` block. Entries render in the given order (the caller sorts by
 * dispatched_at / id for a stable flat order); empty / all-empty input →
 * `undefined` (no block to inject). See the section header for the invariants
 * this locks (no rounds / scope / directive trailer / attribution).
 */
export function renderFlatClarifyQueue(
  entries: FlatClarifyEntry[],
  nonce = '',
): string | undefined {
  const items: string[] = []
  for (const e of entries) {
    const item = isManualFlatEntry(e)
      ? renderFlatManualItem(e.manualTitle, e.manualBody, nonce)
      : renderFlatQaItem(e.question, e.answer, nonce)
    if (item.length > 0) items.push(item)
  }
  if (items.length === 0) return undefined
  return [FLAT_CLARIFY_QUEUE_BLOCK_TITLE, '', ...items].join('\n')
}

// RFC-162: the per-question scope helpers (`resolveQuestionScope`,
// `extractDesignerScopedSubset`, `countDesignerScopedAcrossSources`) are DELETED with
// scope. A clarify answer no longer routes to a designer by a scope flag — cross unified
// with self (the ASKER always reruns + gets the full Q&A), and "let the upstream revise"
// is a reassign that adds a designer handler, not a per-question scope.

/** RFC-128 §7 — merge a freshly-sealed answer subset into a round's existing answers
 *  (per-question merge-write; the round's `answers_json` stays the answer-content SoT).
 *  Incoming answers WIN per `questionId`; existing answers for questions NOT in the
 *  incoming subset are preserved untouched. Order is stable: existing answers keep
 *  their position (value replaced in place when re-sealed), then never-before-seen
 *  incoming answers are appended in incoming order. So a whole-round one-shot seal
 *  (existing empty) returns exactly the incoming array — byte-for-byte identical to the
 *  pre-RFC-128 overwrite (golden-lock). Returns a fresh array (no input aliasing).
 *
 *  RFC-128 P2-2 — `lockedIds`: question ids whose answer is ALREADY sealed (locked) and
 *  must NOT be changed. For a locked qid the EXISTING answer is preserved and any incoming
 *  value for it is ignored (a locked qid that has no existing answer — which shouldn't
 *  happen, since sealed ⇒ present in answers_json — is also dropped from incoming). This
 *  lets the whole-round quick-channel finalize (which posts ALL question values) coexist
 *  with the per-question control channel WITHOUT overwriting a sealed answer. Empty/omitted
 *  `lockedIds` ⇒ unchanged behavior (golden-lock). */
export function mergeSealedAnswers(
  existing: ClarifyAnswer[],
  incoming: ClarifyAnswer[],
  lockedIds?: ReadonlySet<string>,
): ClarifyAnswer[] {
  const incomingById = new Map(incoming.map((a) => [a.questionId, a]))
  const isLocked = (qid: string): boolean => lockedIds !== undefined && lockedIds.has(qid)
  const merged: ClarifyAnswer[] = []
  const seen = new Set<string>()
  for (const a of existing) {
    // Locked ⇒ keep the existing (sealed) value; otherwise incoming wins when present.
    merged.push(isLocked(a.questionId) ? a : (incomingById.get(a.questionId) ?? a))
    seen.add(a.questionId)
  }
  for (const a of incoming) {
    // Append a never-before-seen incoming answer — unless it targets a locked qid.
    if (!seen.has(a.questionId) && !isLocked(a.questionId)) {
      merged.push(a)
      seen.add(a.questionId)
    }
  }
  return merged
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
  nonce = '',
): string {
  if (outputs.length === 0) return ''
  const lines: string[] = []
  for (const o of outputs) {
    if (o.content.trim().length === 0) continue
    const portName = nonce.length > 0 ? sanitizeInlineField(o.portName) : o.portName
    lines.push(`### ${portName}`)
    lines.push('')
    lines.push(fenceUntrusted(`prior-output:${portName}`, o.content, nonce))
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
  // RFC-147: thin alias over the system-channel-port registry
  // (systemChannelPorts.ts) — the historical 5-port or-chain lived here;
  // the registry is now the single source and this name stays for its
  // established import surface (canvas cascade delete, validator
  // dangling-edge exemption, scheduler topologicalOrder cycle-break).
  return isSystemChannelEdge(e)
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
