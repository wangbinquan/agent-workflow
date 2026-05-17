// Pure functions and constants for the RFC-023 clarify node. Shared between
// the backend runner / scheduler / clarify service and the frontend canvas
// drag helper / prompt preview pane. No Bun / Node / DB imports — keep this
// module easy to test in either runtime.

import type {
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
} from './schemas/workflow'
import {
  ClarifyEnvelopeBodySchema,
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

/**
 * Parse the JSON body found inside `<workflow-clarify>...</workflow-clarify>`.
 * Permissive: questions > MAX are truncated to the first MAX, options > MAX
 * per question are truncated, and each truncation produces a warning. Hard
 * failures (JSON.parse error, missing questions array, empty title, kind not
 * single/multi, options < MIN, options non-string) produce errors and body=null.
 */
export function parseClarifyEnvelopeBody(jsonText: string): ParseClarifyEnvelopeResult {
  const warnings: ClarifyTruncationWarning[] = []
  const errors: ClarifyTruncationWarning[] = []

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
  if (questions.length > CLARIFY_MAX_QUESTIONS) {
    warnings.push({
      code: 'clarify-questions-too-many',
      detail: `got ${questions.length} questions, truncated to ${CLARIFY_MAX_QUESTIONS}`,
    })
    questions = questions.slice(0, CLARIFY_MAX_QUESTIONS)
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

  const result = ClarifyEnvelopeBodySchema.safeParse({ questions: normalised })
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
 *  - 'continue' → mild reminder that the agent may keep asking; the
 *    `<workflow-clarify>` protocol block remains attached by the runner.
 *  - 'stop'    → hard instruction not to clarify this rerun, paired with
 *    the runner withholding the protocol block so the agent literally
 *    can't see the JSON template anymore.
 *  - undefined → empty string (legacy behaviour: no trailer at all).
 *
 *  Exported so backend tests can lock the exact wording — changing it is
 *  a contract break with already-running agents in mid-task. */
export function renderClarifyDirectiveTrailer(directive?: ClarifyDirective): string {
  if (directive === 'stop') {
    return [
      '### User directive: STOP CLARIFYING',
      '- The user has explicitly asked you NOT to emit another <workflow-clarify> envelope this round.',
      '- Produce your final <workflow-output> reply now using the answers above. If any detail is still ambiguous, make your best informed call based on the answers and proceed.',
    ].join('\n')
  }
  if (directive === 'continue') {
    return [
      '### User directive: KEEP CLARIFYING IF NEEDED',
      '- The user is willing to answer more clarification questions. If material details remain unresolved after the answers above, emit another <workflow-clarify> envelope covering every remaining detail before producing <workflow-output>.',
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
