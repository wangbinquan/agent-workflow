// RFC-306 — the ONE projection of "which edges actually feed data into this
// node at run time". Pure: definition + edges in, edges out. No DB.
//
// Why this exists as its own module rather than a local helper: RFC-306 adds a
// SECOND consumer of that projection. `resolveUpstreamInputs` (scheduler.ts)
// uses it to build a node's prompt inputs; the branch-activation judgment uses
// it to decide whether the node runs at all. If the two ever disagreed — one
// counting an edge the other ignores — the result is the worst class of bug this
// feature can have: a node judged "active" whose inputs are all empty, or a node
// skipped while an edge that would have fed it was live. Sharing the function
// makes that disagreement impossible rather than merely unlikely.
//
// The filter itself is unchanged from what resolveUpstreamInputs has always
// done:
//   * `boundary !== undefined` — fanout wrapper-input/-output edges are
//     structural mirrors, not row-to-row dataflow;
//   * `channelEdgeDataflowSkip` — the prompt-injected clarify / cross-clarify
//     channels (`__clarify_response__`, `__external_feedback__`, `to_*`) are
//     not dataflow; `agent.__clarify__ → <gate>` IS a real dependency for both
//     gate kinds (RFC-354 D7: a gate is a row-backed node whose asker is its
//     structural upstream).

import { channelEdgeDataflowSkip } from '@agent-workflow/shared'
import type { WorkflowEdge } from '@agent-workflow/shared'

export function collectDataflowInboundEdges(
  edges: readonly WorkflowEdge[],
  nodeId: string,
): WorkflowEdge[] {
  return edges.filter(
    (e) => e.target.nodeId === nodeId && e.boundary === undefined && !channelEdgeDataflowSkip(e),
  )
}

// RFC-354 (schema v6): there are no implicit inbound references any more —
// a review's reviewed source is its `__review_input__` edge and an output
// node's ports are its inbound edges, so `collectDataflowInboundEdges` above is
// the complete dependency set for every kind. (RFC-306's
// `collectImplicitInboundRefs` walked `review.inputSource` / `output.ports[].bind`
// and was retired with those fields.)
