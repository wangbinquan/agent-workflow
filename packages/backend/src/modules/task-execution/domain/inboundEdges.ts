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
import type { NodeKind, PortRef, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'

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

/**
 * RFC-306 (design-gate P1#2) — the IMPLICIT inbound sources of a node: real
 * dependencies the scheduler already honours that are NOT user-authored edges.
 *
 * Two kinds carry them, and both are load-bearing for branch activation:
 *
 *   review  — `inputSource` names the port under review. Without it the
 *             activation judgment sees an edgeless node, calls it active, and a
 *             review opens on a CLOSED branch — showing the human the agent's
 *             "why I am not running this" sentence as if it were the document
 *             to approve. That is the exact opposite of D15/AC-9.
 *
 *   output  — `ports[].bind` is the canonical form (the canvas often emits an
 *             edge too, but bindings are authoritative per the validator). An
 *             output node whose every binding sits on a closed branch has to be
 *             SKIPPED, not `done` with empty ports — AC-12 and the relaxed T3
 *             invariant both read that distinction.
 *
 * This mirrors the implicit-dependency walk `buildScopeUpstreams` (scheduler.ts)
 * performs for ordering. Ordering and activation must agree on what counts as an
 * upstream: if the scheduler waits for a node that the activation judgment does
 * not even look at, the judgment is made against a dependency set the graph does
 * not have.
 *
 * `wrapper-loop`'s exitCondition / outputBindings are deliberately NOT included:
 * those are INNER references (a loop reads its own body), so treating them as
 * inbound would make a wrapper skip itself whenever its body closed a branch —
 * which is precisely the case where the wrapper must keep running to promote its
 * outlets.
 */
export function collectImplicitInboundRefs(node: {
  kind: string
  inputSource?: unknown
  ports?: unknown
}): PortRef[] {
  const refs: PortRef[] = []
  if (node.kind === 'review') {
    const inp = node.inputSource as { nodeId?: unknown; portName?: unknown } | undefined
    if (inp !== undefined && inp !== null && typeof inp.nodeId === 'string') {
      refs.push({
        nodeId: inp.nodeId,
        portName: typeof inp.portName === 'string' ? inp.portName : '',
      })
    }
  }
  if (node.kind === 'output' && Array.isArray(node.ports)) {
    for (const port of node.ports as unknown[]) {
      if (port === null || typeof port !== 'object') continue
      const bind = (port as { bind?: unknown }).bind
      if (bind === null || typeof bind !== 'object') continue
      const ref = bind as { nodeId?: unknown; portName?: unknown }
      if (typeof ref.nodeId !== 'string' || typeof ref.portName !== 'string') continue
      refs.push({ nodeId: ref.nodeId, portName: ref.portName })
    }
  }
  return refs
}
