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
//   * `channelEdgeDataflowSkip` — clarify / cross-clarify channels are prompt
//     injections, with the deliberate carve-out that
//     `agent.__clarify__ → clarify-cross-agent` IS a real dependency.

import { channelEdgeDataflowSkip } from '@agent-workflow/shared'
import type { NodeKind, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'

export function collectDataflowInboundEdges(
  edges: readonly WorkflowEdge[],
  nodeId: string,
  kindById: ReadonlyMap<string, NodeKind>,
): WorkflowEdge[] {
  return edges.filter(
    (e) =>
      e.target.nodeId === nodeId &&
      e.boundary === undefined &&
      !channelEdgeDataflowSkip(e, (targetId) => kindById.get(targetId)),
  )
}

/** Convenience: the kind index both call sites build from a definition. */
export function nodeKindIndex(
  definition: WorkflowDefinition | undefined,
): ReadonlyMap<string, NodeKind> {
  return new Map(definition?.nodes.map((node) => [node.id, node.kind]) ?? [])
}

// RFC-354 (schema v6): there are no implicit inbound references any more —
// a review's reviewed source is its `__review_input__` edge and an output
// node's ports are its inbound edges, so `collectDataflowInboundEdges` above is
// the complete dependency set for every kind. (RFC-306's
// `collectImplicitInboundRefs` walked `review.inputSource` / `output.ports[].bind`
// and was retired with those fields.)
