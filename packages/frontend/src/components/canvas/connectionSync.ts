// RFC-007 → RFC-354 (schema v6) — the review / output connection helpers.
//
// Until schema v6 this module kept `definition.edges[]` and the per-node
// PortRef mirrors (`review.inputSource`, `output.ports[i].bind`) in lock-step:
// every connect wrote the field, every disconnect cleared it, and a load-time
// heal reconciled the two. Those fields are gone — the review input IS its one
// inbound edge on `__review_input__`, and an output node's ports ARE its
// inbound edges (target portName = port name). What remains here is the
// edge-only shape of those two connections:
//
//   • review: single input — an incoming edge replaces any prior one;
//   • output: collection-shaped — a catch-all drop APPENDS a port, so a
//     colliding name is disambiguated (`_2`, `_3`, …) and the new edge's target
//     portName is rewritten to land on that port; a named-handle drop rebinds
//     that port (drops the edge that occupied it).
//
// All exports are pure and return the input definition by reference when
// nothing changes. Production edit surfaces reach them only through
// applyWorkflowTransition (RFC-199's single edit-time chokepoint).

import {
  REVIEW_INPUT_PORT_NAME,
  type WorkflowDefinition,
  type WorkflowEdge,
} from '@agent-workflow/shared'

/**
 * Stable handle id for the review node's single left-side target Handle
 * (see RFC-007 design §3.1). Distinct from RFC-003's `__inbound__` catch-all
 * so the two paths never collide in `translateInboundConnection`.
 */
export const REVIEW_INPUT_HANDLE_ID = REVIEW_INPUT_PORT_NAME

/** Distinct inbound-edge target port names of a node — its edge-declared ports. */
export function inboundPortNames(def: WorkflowDefinition, nodeId: string): string[] {
  const names: string[] = []
  for (const edge of def.edges) {
    if (edge.target.nodeId !== nodeId || edge.boundary === 'wrapper-output') continue
    if (!names.includes(edge.target.portName)) names.push(edge.target.portName)
  }
  return names
}

/**
 * Pick a port name that doesn't collide with any of `taken`. Suffixes with
 * `_2`, `_3`, … (no suffix for the first attempt, matching the
 * `default port_1` style the canvas uses for freshly minted ports).
 */
export function uniquePortName(taken: readonly string[], requested: string): string {
  if (!taken.includes(requested)) return requested
  for (let i = 2; i < 1000; i++) {
    const candidate = `${requested}_${i}`
    if (!taken.includes(candidate)) return candidate
  }
  // Defensive fallback — pathological case where 998 ports share a base name.
  return `${requested}_${Date.now()}`
}

/**
 * After WorkflowCanvas builds an edge from a fresh xyflow Connection and
 * appends it to `def.edges`, hand the whole definition through this fn.
 *
 * - target is a review node + targetHandle === REVIEW_INPUT_HANDLE_ID:
 *     drop any prior edge into that review node (review is single-input) and
 *     rewrite the just-appended edge's target.portName to the sentinel.
 * - target is an output node and `opts.viaCatchAll` is true (the user dropped
 *     on the catch-all left strip — see {@link translateInboundConnection}):
 *     the drop APPENDS a port. The proposed port name is
 *     `edge.target.portName` (the upstream port's name); if that name is
 *     already taken by another inbound edge it is suffixed `_2`, `_3`, … and
 *     the edge's target.portName is rewritten so the canvas line lands on the
 *     new port.
 * - target is an output node and `opts.viaCatchAll` is false (a specific named
 *     handle): drop any prior edge into that (outputNodeId, portName) pair —
 *     the explicit "rebind THIS port" action.
 * - otherwise: return def unchanged (caller's append is preserved as-is).
 */
export function applyConnectionForReviewOutput(
  def: WorkflowDefinition,
  edge: WorkflowEdge,
  opts: { viaCatchAll?: boolean } = {},
): WorkflowDefinition {
  const targetNode = def.nodes.find((n) => n.id === edge.target.nodeId)
  if (targetNode === undefined) return def

  if (targetNode.kind === 'review' && edge.target.portName === REVIEW_INPUT_HANDLE_ID) {
    const filtered = def.edges.filter((e) => e.id === edge.id || e.target.nodeId !== targetNode.id)
    return filtered.length === def.edges.length ? def : { ...def, edges: filtered }
  }

  if (targetNode.kind === 'output') {
    const requestedName = edge.target.portName
    const others = def.edges.filter((e) => e.id !== edge.id && e.target.nodeId === targetNode.id)
    const taken = others.map((e) => e.target.portName)
    if (opts.viaCatchAll === true) {
      const finalName = uniquePortName(taken, requestedName)
      if (finalName === requestedName) return def
      return {
        ...def,
        edges: def.edges.map((e) =>
          e.id === edge.id ? { ...e, target: { ...e.target, portName: finalName } } : e,
        ),
      }
    }
    // Explicit rebind onto an existing named handle: drop any prior edge
    // into (outputNodeId, requestedName).
    const filtered = def.edges.filter(
      (e) =>
        e.id === edge.id ||
        !(e.target.nodeId === targetNode.id && e.target.portName === requestedName),
    )
    return filtered.length === def.edges.length ? def : { ...def, edges: filtered }
  }

  return def
}
