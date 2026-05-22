// RFC-056 — pure functions and constants for the `clarify-cross-agent` node.
//
// Parallel to `shared/clarify.ts` (RFC-023 self-clarify) — different node kind,
// different runtime semantics (multi-source aggregation, reject persistence,
// designer rerun trigger), but the envelope schema and the per-answer synthesis
// are reused verbatim from RFC-023. No Bun / Node / DB imports — pure module.

import type {
  ClarifyCrossAgentNode,
  ClarifyCrossAgentSessionMode,
  WorkflowDefinition,
  WorkflowEdge,
} from './schemas/workflow'
import {
  CLARIFY_SOURCE_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
} from './schemas/workflow'
import {
  parseClarifyEnvelopeBody,
  type ParseClarifyEnvelopeResult,
  renderClarifyQuestionsBlock,
  summariseClarifyAnswer,
} from './clarify'
import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'

// -----------------------------------------------------------------------------
// constants
// -----------------------------------------------------------------------------

/** Title used by the auto-appended External Feedback section in the designer's
 *  user prompt. Exported as a constant so the regression-guard grep test can
 *  catch silent renames in `shared/prompt.ts`. */
export const CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE = '## External Feedback' as const

/** RFC-056 §6 update mode (2026-05-22 amendment): when cross-clarify triggers
 *  a designer rerun, the prompt switches from "regenerate from inputs" to
 *  "update prior output". The framework injects two extra sections — the
 *  designer's last done output verbatim + an explicit update directive — so
 *  the agent's mental model matches the product semantic (cross-clarify Q&A
 *  is a change driver, not a from-scratch signal). Constants exported so
 *  regression-guard grep tests can pin the literal headings.
 */
export const CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE = '## Prior Output (to be updated)' as const
export const CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE = '## Update Directive' as const

/** Stable English directive text that primes the designer for update mode.
 *  Kept short — opencode is good at the rest once the contract is clear. */
export const CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT = [
  'Your goal this round is to **update** the prior output above to incorporate the',
  'External Feedback Q&A. Do NOT regenerate the output from scratch. Preserve every',
  'detail of the prior output that the External Feedback does not contradict; only',
  'change the parts the cross-clarify answers require. Treat the External Feedback',
  'as the source of changes, the prior output as the working draft.',
].join(' ')

// -----------------------------------------------------------------------------
// envelope parsing — lifts the RFC-023 5-question cap for the cross path.
// -----------------------------------------------------------------------------

/**
 * RFC-056: parse the JSON body of a `<workflow-clarify>` envelope produced by a
 * questioner agent wired through a cross-clarify node. Reuses the RFC-023
 * parser end-to-end; the only difference is `maxQuestions = +Infinity` which
 * disables the question-count truncation. Per-question option count, kind /
 * options validation, sort-by-recommended, custom-text length cap, etc. all
 * preserve RFC-023 semantics — same parse function under the hood.
 */
export function parseCrossClarifyEnvelopeBody(jsonText: string): ParseClarifyEnvelopeResult {
  return parseClarifyEnvelopeBody(jsonText, { maxQuestions: Number.POSITIVE_INFINITY })
}

// -----------------------------------------------------------------------------
// External Feedback block rendering (designer-side prompt injection).
// -----------------------------------------------------------------------------

/** One source's contribution to the designer's External Feedback batch. The
 *  scheduler builds this per-source by looking up the latest answered +
 *  directive='continue' cross_clarify_sessions row for each cross-clarify
 *  node targeting the same designer. */
export interface CrossClarifySourceContext {
  /** The questioner agent node id whose `<workflow-clarify>` envelope drove
   *  this source. Stable across reruns; used by the renderer to sort sources
   *  in dictionary order for deterministic output. */
  sourceQuestionerNodeId: string
  /** The cross-clarify node id (the human-gated form node). Surfaced in the
   *  sub-heading so the designer can correlate feedback with the node the
   *  user actually filled. */
  crossClarifyNodeId: string
  /** Per-source cross-clarify iteration this batch represents. */
  iteration: number
  /** The questions the questioner asked this round. */
  questions: ClarifyQuestion[]
  /** The user's answers (one per question, indexed by question.id). */
  answers: ClarifyAnswer[]
}

/**
 * Render the designer-facing `## External Feedback` body. Each source becomes
 * a `### From '{nodeId}' (round {iteration})` sub-section, sorted by source
 * questioner nodeId (dictionary order). Within a source, each question gets
 * the FULL question detail (title + Type + Candidate options with description
 * + [recommended] flag + reason — same shape as the RFC-023 self-clarify
 * "Prior Rounds (Questions)" rendering via `renderClarifyQuestionsBlock`)
 * PLUS the user's answer synthesised by {@link summariseClarifyAnswer}.
 *
 * Returns ONLY the body — the leading `## External Feedback` heading is
 * applied by `shared/prompt.ts` via the auto-append mechanism (when the
 * template doesn't reference `{{__external_feedback__}}`).
 *
 * Question detail surfaces the candidate options + recommendations + reasons
 * that the questioner agent emitted — so the designer reading this prompt
 * sees the SAME context the user saw when they made the call. Without this
 * the designer reads only "User chose: Jest" and can't tell whether the
 * user picked Jest over Vitest / Mocha / Cypress, or whether the questioner
 * even surfaced those alternatives. The RFC-023 self-clarify path already
 * carries full Q detail; the cross-clarify designer prompt would otherwise
 * be a strictly worse information path.
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
    // Full per-question detail (Type + Candidate options + descriptions +
    // [recommended] flags + reasons) — reuses the RFC-023 renderer so any
    // future format change keeps the two paths byte-for-byte symmetric.
    const questionsBlock = renderClarifyQuestionsBlock(src.questions)
    // `renderClarifyQuestionsBlock` uses `### Q{N}` (one less than our
    // `#### Q{N}` convention since cross-clarify is one heading level deeper).
    // Shift the prefix so the cross-clarify section keeps a coherent
    // markdown outline: `## External Feedback` → `### From '<id>'` →
    // `#### Q{N}`.
    lines.push(questionsBlock.replace(/^### Q/gm, '#### Q'))
    lines.push('')
    // Then per-question answer synthesis under each question (matches the
    // RFC-023 "Prior Rounds (Answers)" section but inline so cross-clarify
    // stays a single contiguous sub-section per source).
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

/**
 * Render a single source's contribution — useful for incremental rendering
 * (e.g. an editor preview that streams one source at a time). Same per-source
 * formatting as `buildExternalFeedbackBlock`, but no sort and no leading
 * `## External Feedback` framing.
 */
export function renderCrossClarifySource(src: CrossClarifySourceContext): string {
  return buildExternalFeedbackBlock([src])
}

/**
 * RFC-056 §6 update mode: render the designer's last done output verbatim so
 * the agent can read the working draft instead of regenerating from scratch.
 *
 * Format:
 *   ### <port_name>
 *
 *   <content body>
 *
 * Each output port gets a sub-heading + the captured content body. Ports are
 * emitted in the declared order on the agent's outputs[]. Returns ONLY the
 * body — the leading `## Prior Output (to be updated)` heading is applied
 * by `shared/prompt.ts` via the auto-append mechanism.
 *
 * Empty / NULL content rows are dropped (no `### port_name` heading with
 * empty body); the goal is a clean draft for the agent to update.
 *
 * For markdown_file outputs the content row may be the raw markdown body
 * (when the framework captured it post-port-validation). Path-shaped
 * content is left as-is — the designer's prompt template can resolve via
 * filesystem read if needed; mixing raw + path is a port-kind decision
 * outside this renderer's scope.
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
 * RFC-056 reuses the RFC-023 implementation verbatim — the framework's per-
 * answer English summary semantics are identical regardless of whether the
 * questioner was the designer itself (self-clarify) or a downstream auditor
 * (cross-clarify). Exported under a cross-clarify name so the runtime
 * call-sites read clearly and so future divergence (if any) only requires
 * editing this re-export, not every caller.
 */
export function summariseCrossAnswer(question: ClarifyQuestion, answer: ClarifyAnswer): string {
  return summariseClarifyAnswer(question, answer)
}

// -----------------------------------------------------------------------------
// sessionMode resolution.
// -----------------------------------------------------------------------------

/**
 * RFC-056 + RFC-026: resolve which sessionMode to use for a particular rerun
 * direction off a cross-clarify node.
 *
 *  - 'designer'    → reads `node.sessionModeForDesigner` (the agent that gets
 *                    rerun on submit).
 *  - 'questioner'  → reads `node.sessionModeForQuestioner` (the agent that
 *                    gets rerun on reject + cascade with STOP CLARIFYING).
 *
 * Missing field resolves to `'isolated'` in both cases — preserves RFC-026
 * "default-isolated keeps the run path fresh" semantic and means an older v3
 * doc that does not carry the field after a transparent v3 → v4 upgrade still
 * behaves predictably.
 */
export function resolveCrossClarifySessionMode(
  node: ClarifyCrossAgentNode,
  direction: 'designer' | 'questioner',
): ClarifyCrossAgentSessionMode {
  if (direction === 'designer') {
    return node.sessionModeForDesigner ?? 'isolated'
  }
  return node.sessionModeForQuestioner ?? 'isolated'
}

// -----------------------------------------------------------------------------
// definition-level topology helpers — used by scheduler / runner / canvas drag.
// -----------------------------------------------------------------------------

/**
 * RFC-056: locate the cross-clarify node attached to a given questioner via
 * the auto-edge `questioner.__clarify__ → newNode.questions`. Returns the
 * cross-clarify nodeId, or `undefined` when the questioner has no cross-
 * clarify channel wired. The runner uses this to decide whether the asking
 * agent's `<workflow-clarify>` envelope feeds the RFC-023 self-clarify path
 * or the RFC-056 cross-clarify path (when both target kinds exist on the
 * same agent's `__clarify__` source port, the cross-clarify path wins by
 * design — see design.md §4.2 mode 标识).
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
 * RFC-056: check whether an agent node (any kind) has at least one inbound
 * `__external_feedback__` system port edge — meaning some cross-clarify
 * node's `to_designer` output targets it. The prompt renderer auto-appends
 * the `## External Feedback` section only when this is true on the agent
 * being run.
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
 * `to_designer` output. Returns `undefined` when no manual edge exists (the
 * validator already emits `cross-clarify-manual-edge-missing` warning in
 * the editor; at runtime we surface the missing target via the error code
 * `cross-clarify-designer-target-missing-at-runtime`).
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
 * targets `designerNodeId`. Used by the multi-source aggregation in
 * `evaluateDesignerRerunReadiness` to decide when ALL feedback sources have
 * been resolved (submit or reject) before triggering the designer rerun.
 * Order is preserved from `definition.nodes` for caller convenience; the
 * service sorts by `source_questioner_node_id` separately when building the
 * prompt.
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
  // Preserve workflow.nodes declaration order for deterministic traversal.
  const order = new Map<string, number>()
  ;(definition.nodes ?? []).forEach((n, idx) => order.set(n.id, idx))
  return Array.from(targeting).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

/**
 * RFC-056: resolve the QUESTIONER NodeId attached to a cross-clarify node via
 * the auto-edge `questioner.__clarify__ → crossClarify.questions`. Returns
 * `undefined` when no such edge exists (validator fail
 * `cross-clarify-input-source-missing`). Used by `triggerQuestionerStopRerun`
 * + scheduler cascade reset.
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
 * node's input handle onto an agent node:
 *
 *   questioner.__clarify__       → crossClarify.questions       (system question channel)
 *   crossClarify.to_questioner   → questioner.__clarify_response__ (visual completion)
 *
 * The second edge can be deleted by the user without breaking answer
 * injection (the runtime ties session ↔ questioner via cross_clarify_session
 * rows, not via this edge). It exists for canvas legibility, mirroring
 * RFC-023 `buildClarifyEdges`.
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
