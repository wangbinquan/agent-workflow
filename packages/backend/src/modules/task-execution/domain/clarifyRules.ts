// RFC-454 — the clarify rules task-execution's agent node execution applies (bound into
// `application/ports/agentNodeExecution`'s `rules` by the composition). Moved verbatim from collaboration's
// infrastructure (`clarifyRounds.ts`, `clarify/service.ts`): task-execution is their only user, and task-execution →
// collaboration is not a target DAG edge (they used to arrive through `services/clarifyRounds` /
// `services/clarify/service`). One change on arrival: `computeRemaining` reads the loop's members through the scope
// index's one reader (`directNodeIdsOf`, RFC-339) instead of the raw `nodeIds` field — same answer for every input.

import type { ClarifyDirective, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { directNodeIdsOf } from './executionScope'

/**
 * RFC-122: pure oracle for the scheduler's `effectiveHasClarifyChannel` — the
 * "mandatory ask-back is ACTIVE" signal threaded to the runner. Extracted from
 * the inline scheduler boolean so the per-node STOP override has a directly
 * testable surface (golden-lock: `nodeStopOverride=false` reproduces the exact
 * pre-RFC-122 expression). Ask-back is active ⟺ the node wires a clarify channel
 * AND no STOP directive is in force (neither a 'stop' answered round nor the
 * on-canvas per-node toggle) AND the run is a genuine clarify round (not a
 * review reject/iterate re-production, unless it is itself a clarify-answer
 * rerun mid-review). Covers BOTH self-clarify and cross-questioner, since
 * `hasClarifyChannel` (agentHasClarifyChannel) is true for either.
 */
export function resolveEffectiveClarifyChannel(args: {
  hasClarifyChannel: boolean
  /** `clarifyContext?.directive` — 'stop' from a prior answered round. */
  contextDirective?: ClarifyDirective
  /** RFC-122 per-(task, asking-node) override resolved to 'stop' at dispatch. */
  nodeStopOverride: boolean
  /** `reviewContext !== undefined`. */
  reviewActive: boolean
  /** This run continues a clarify round. RFC-183: the scheduler feeds the
   *  LINEAGE verdict (`continuesClarifyLineage` over the persisted cause
   *  chain), so a clarify-answer round's technical continuations
   *  (process-retry / revival) count too — not just the answer rerun itself. */
  isClarifyRerun: boolean
}): boolean {
  return (
    args.hasClarifyChannel &&
    args.contextDirective !== 'stop' &&
    !args.nodeStopOverride &&
    (!args.reviewActive || args.isClarifyRerun)
  )
}

/**
 * RFC-122 (H2 fix): should the renderer inject the standalone
 * `### User directive: STOP CLARIFYING` trailer for this dispatch?
 *
 * Inject exactly when the per-(task, asking-node) override is 'stop' AND the
 * clarifyContext's `answersBlock` does NOT already carry the trailer — which it
 * does iff `ctx.directive === 'stop'` (set by buildPromptContext when the
 * directiveOverride was applied, i.e. `applyLatestDirective` was in effect).
 * This guarantees the STOP text appears EXACTLY ONCE across all cases:
 *   - undefined context (first run / pre-clarify error-retry)              → notice,
 *   - context whose trailer was withheld because `applyLatestDirective=false`
 *     (a review reject/iterate rerun that still carries prior clarify Q&A)  → notice,
 *   - context that already carries the STOP trailer                        → no notice.
 * No override ⇒ false (golden-lock — the trailer source is unchanged).
 */
export function shouldInjectStopNotice(args: {
  nodeStopOverride: boolean
  /** `clarifyContext?.directive`. */
  contextDirective?: ClarifyDirective
}): boolean {
  return args.nodeStopOverride && args.contextDirective !== 'stop'
}

/**
 * RFC-023 design §5.6 wrapper-loop remaining counter — copied from
 * services/clarify.ts so this module stays self-contained. Returns '' when
 * the consumer is not inside an enclosing loop with a maxIterations cap.
 *
 * Exported for RFC-132 PR-C: the scheduler assembles the flat ClarifyPromptContext
 * (which no longer flows through buildClarifyNodeQueueContext) and reuses this to
 * populate the `{{__clarify_remaining__}}` token.
 */
export function computeRemaining(
  definition: WorkflowDefinition,
  consumerNodeId: string,
  targetIteration: number,
): string {
  for (const node of definition.nodes) {
    if (node.kind !== 'wrapper-loop') continue
    const rec = node as unknown as Record<string, unknown>
    if (!directNodeIdsOf(rec).includes(consumerNodeId)) continue
    const maxIterRaw = rec.maxIterations
    if (typeof maxIterRaw !== 'number' || maxIterRaw <= 0) continue
    return String(Math.max(0, maxIterRaw - targetIteration))
  }
  return ''
}

/** Returns the workflow node object for a clarify id, when present. */
export function findClarifyNode(
  definition: WorkflowDefinition,
  clarifyNodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((n) => n.id === clarifyNodeId && n.kind === 'clarify')
}
