// Control-flow edge detection — extends RFC-060's signal-kind visual language
// from ports onto the connecting lines themselves.
//
// RFC-060 defines `signal` as a control-flow-only port kind: its wire content
// is always empty and it carries NO data (carriesData() === false, see
// packages/shared/src/outputKinds/signal.ts) — it only means "I'm done,
// downstream may start". RFC-060 F.T2 already renders signal ports on
// wrapper-fanout (notably the implicit `__done__` outlet when no aggregator is
// wired) with a dashed grey handle ring + dimmed label (styles.css
// `.canvas-node__handle--signal` / `.canvas-node__bottom-port--signal`) so
// authors "visually distinguish control-flow edges from data edges at a
// glance". The line connecting them, however, was still drawn like a data edge.
// This module decides whether an edge is a control-flow line so WorkflowCanvas
// can tag it with `canvas-edge--control`; styles.css then renders it as the
// same grey dashed line.
//
// The kind test follows RFC-080: instead of hard-coding the 'signal' base name
// we ask the kind handler whether it `carriesData()` — any future no-data
// control kind is then auto-classified (same decision surface as
// signalPromptGuard.ts).

import {
  declaredPorts,
  tryHandlerForParsedKind,
  tryParseKind,
  type Agent,
  type WorkflowDefinition,
  type WorkflowEdge,
} from '@agent-workflow/shared'

/**
 * className tagged onto the xyflow Edge of a control-flow line. Drives the grey
 * dashed `.react-flow__edge.canvas-edge--control` rules in styles.css.
 */
export const CONTROL_FLOW_EDGE_CLASS = 'canvas-edge--control'

/**
 * Whether a port-kind string is "control-flow" — i.e. carries no data (e.g.
 * `signal`).
 *
 * Uses the RFC-080 handler capability query rather than a hard-coded base name.
 * A kind that is absent / unparseable / has no registered handler is treated as
 * a data edge (returns false) so we never mis-tag.
 */
export function isControlFlowKind(kind: string | undefined): boolean {
  if (kind === undefined || kind.length === 0) return false
  const parsed = tryParseKind(kind)
  if (parsed === null) return false
  const handler = tryHandlerForParsedKind(parsed)
  return handler !== null && !handler.carriesData(parsed)
}

/**
 * Resolve the declared kind string of an edge's SOURCE port.
 *
 * RFC-146: reads the shared port-declaration table (fork #4 of five is gone).
 * The table carries kinds exactly where this function historically derived
 * them — agent outputs (`agent.outputKinds`), wrapper-fanout outlets
 * (aggregator mirror or the `__done__` = signal outlet) — and no kind
 * elsewhere (input/output/review/clarify/wrapper-git/wrapper-loop ⇒ undefined
 * ⇒ default data edge).
 *
 * A missing source node (stale snapshot vs edited definition) also ⇒ undefined.
 */
export function sourcePortKind(
  edge: WorkflowEdge,
  definition: WorkflowDefinition,
  agentByName: ReadonlyMap<string, Agent>,
): string | undefined {
  const src = definition.nodes.find((n) => n.id === edge.source.nodeId)
  if (src === undefined) return undefined
  return declaredPorts(src, definition, agentByName).dataOutputs.find(
    (p) => p.name === edge.source.portName,
  )?.kind
}

/**
 * Whether an edge is a control-flow line — its source port is a no-data kind
 * such as `signal`.
 */
export function isControlFlowEdge(
  edge: WorkflowEdge,
  definition: WorkflowDefinition,
  agentByName: ReadonlyMap<string, Agent>,
): boolean {
  return isControlFlowKind(sourcePortKind(edge, definition, agentByName))
}

/**
 * Set of every control-flow edge id in a definition. WorkflowCanvas computes
 * this once per edge rebuild and hands it to `toFlowEdges` to decide which
 * edges get the control className.
 */
export function buildControlFlowEdgeIds(
  definition: WorkflowDefinition,
  agentByName: ReadonlyMap<string, Agent>,
): Set<string> {
  const ids = new Set<string>()
  for (const e of definition.edges) {
    if (isControlFlowEdge(e, definition, agentByName)) ids.add(e.id)
  }
  return ids
}
