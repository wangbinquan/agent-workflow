// RFC-062 §2 — workflow edge contracts.
//
// Single source of truth for "which edges gate downstream dispatch
// vs. which edges carry feedback into a suspended/running node".
//
// The framework supports two distinct kinds of inbound edges per node:
//
//   1. Data edges — target port is a normal port whose content must be
//      produced upstream before the downstream node can start. The
//      scheduler waits for these to be done before minting the
//      downstream logical_run.
//
//   2. Feedback edges — target port is a system port like
//      `__clarify_response__` (RFC-023 self-clarify answers) or
//      `__external_feedback__` (RFC-056 cross-clarify designer
//      feedback). Content arrives via dedicated prompt sections only
//      when the agent is already running and suspends with the
//      corresponding signal. These edges form back-edges in the
//      workflow graph and MUST NOT gate downstream dispatch — gating
//      on them deadlocks the workflow because the source clarify /
//      cross-clarify node only produces content in response to the
//      target agent's question.
//
// Before RFC-062 this knowledge lived only in shared/prompt.ts as a
// private `SYSTEM_PORT_NAMES` constant used to suppress auto-append
// `## __port_name__` headers. RFC-061 hard-cut deleted the legacy
// scheduler that implicitly handled feedback edges; the new
// scheduler-v2/readyScanner.ts gated on all edges and deadlocked
// every workflow containing self-clarify or cross-clarify. Promoting
// the set + helpers to a public contract here, plus the grep guard
// in rfc062-edges-guard.test.ts, makes the distinction visible to
// every consumer of `workflow.edges`.
//
// Adding to SYSTEM_PORT_NAMES is a contract change — every consumer
// of workflow.edges that gates topology MUST be re-audited.

/**
 * Target port names whose inbound edges are FEEDBACK channels, not
 * data gates. The scheduler must NOT wait for these to be "done"
 * before minting a downstream logical_run.
 */
export const SYSTEM_PORT_NAMES: ReadonlySet<string> = new Set([
  '__clarify_response__', // RFC-023 self-clarify answers target
  '__external_feedback__', // RFC-056 cross-clarify designer feedback target
])

/**
 * Structural shape of a workflow edge that the helpers in this file
 * need. Both `source` and `target` may be undefined or missing
 * `nodeId` / `portName` — the helpers handle defensively so callers
 * can pass raw `definition.edges` rows without prior validation.
 */
export interface WorkflowEdgeLike {
  source?: { nodeId?: string; portName?: string } | undefined
  target?: { nodeId?: string; portName?: string } | undefined
}

/**
 * True iff the edge's target port is a SYSTEM_PORT_NAMES entry — i.e.
 * a feedback back-edge that must not gate downstream dispatch.
 */
export function isFeedbackEdge(edge: WorkflowEdgeLike): boolean {
  const p = edge.target?.portName
  return typeof p === 'string' && SYSTEM_PORT_NAMES.has(p)
}

/**
 * Filter to the data edges — the subset the scheduler must use to
 * compute "all upstream done" gating. Preserves input order.
 */
export function filterDataEdges<E extends WorkflowEdgeLike>(edges: ReadonlyArray<E>): E[] {
  return edges.filter((e) => !isFeedbackEdge(e))
}

/**
 * Filter to the feedback edges — the subset used by clarify /
 * cross-clarify wiring + the validator's "feedback source must
 * exist" check. Preserves input order.
 */
export function filterFeedbackEdges<E extends WorkflowEdgeLike>(edges: ReadonlyArray<E>): E[] {
  return edges.filter((e) => isFeedbackEdge(e))
}
