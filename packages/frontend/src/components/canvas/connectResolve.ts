// RFC-106 — combined new-vs-reuse drop resolver, shared by the live preview
// (ConnectDropHint), the custom connection line, and the edge build
// (handleConnect / onConnectEnd) so all four agree.
//
// Existing input handles are isConnectableEnd=false (no accidental snap), so
// "reuse an existing input" is detected geometrically: the drop must land within
// a SMALL screen radius of an existing input handle's centre — otherwise it's a
// NEW input (the default). The node hit-test is in FLOW coords (findNewInputTarget);
// the precise-reuse check is in SCREEN coords (DOM handle rects vs the pointer).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import {
  existingInputPorts,
  findNewInputTarget,
  namedInputDropPolicy,
  type NodeBox,
} from './dropTarget'

export type ResolvedDrop = { kind: 'new' | 'reuse'; nodeId: string; portName: string }

/** Minimal slice of the ReactFlow instance the box builder needs. */
interface RfLike {
  getNodes: () => Array<{
    id: string
    position: { x: number; y: number }
    measured?: { width?: number; height?: number }
    width?: number | null
    height?: number | null
  }>
  getInternalNode: (
    id: string,
  ) => { internals?: { positionAbsolute?: { x: number; y: number } } } | undefined
}

/**
 * Node bounding boxes in ABSOLUTE flow coords (Codex P2). `node.position` is
 * parent-RELATIVE for nodes inside a wrapper (git/loop/fanout), while the pointer
 * (screenToFlowPosition / connection.to) is absolute — so the hit-test must use
 * each node's `internals.positionAbsolute`, falling back to `position` for
 * top-level nodes.
 */
export function getNodeBoxes(rf: RfLike): NodeBox[] {
  return rf.getNodes().map((n) => {
    const abs = rf.getInternalNode(n.id)?.internals?.positionAbsolute ?? n.position
    return {
      id: n.id,
      x: abs.x,
      y: abs.y,
      w: n.measured?.width ?? n.width ?? 0,
      h: n.measured?.height ?? n.height ?? 0,
    }
  })
}

/** Screen radius (px) within which a drop snaps to an EXISTING input port. Small
 *  on purpose — reuse requires aiming AT the port dot; everywhere else on the
 *  node is a NEW input, and moving off the dot flips straight back to new. */
export const REUSE_RADIUS_PX = 8

/** Pure: nearest candidate within `radius` of (px, py), or null. */
export function nearestPort(
  centers: ReadonlyArray<{ name: string; x: number; y: number }>,
  px: number,
  py: number,
  radius: number,
): string | null {
  let best: string | null = null
  let bestDist = radius
  for (const c of centers) {
    const d = Math.hypot(px - c.x, py - c.y)
    if (d <= bestDist) {
      bestDist = d
      best = c.name
    }
  }
  return best
}

/** DOM: screen-space centres of a node's REAL existing input handles (skips the
 *  catch-all + system ports + the injected preview port). */
function existingInputHandleCenters(
  definition: WorkflowDefinition,
  nodeId: string,
): Array<{ name: string; x: number; y: number }> {
  const node = definition.nodes.find((n) => n.id === nodeId)
  if (node === undefined) return []
  const out: Array<{ name: string; x: number; y: number }> = []
  for (const port of existingInputPorts(definition, node)) {
    if (/^__.+__$/.test(port)) continue // system input ports are channel-owned
    const el = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .react-flow__handle[data-handleid="${CSS.escape(port)}"]`,
    )
    if (el === null) continue
    const r = el.getBoundingClientRect()
    out.push({ name: port, x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  return out
}

/**
 * Resolve a drag over the canvas to a new-or-reuse target (or null when not over
 * an open named-input target node). `flowPoint` finds the hovered node; `screenPoint`
 * (the same pointer, in screen coords) drives the precise-reuse check.
 */
export function resolveDropTarget(
  definition: WorkflowDefinition,
  boxes: readonly NodeBox[],
  flowPoint: { x: number; y: number },
  screenPoint: { x: number; y: number },
  sourceNodeId: string,
  sourceHandle: string,
): ResolvedDrop | null {
  const target = findNewInputTarget(definition, boxes, flowPoint, sourceNodeId, sourceHandle)
  if (target === null) return null
  // Output is NEW-only: it natively APPENDS a collection port per upstream;
  // rebinding one of its existing ports would route through the disconnect path
  // and clear that port's `ports[].bind` after the new bind was written, leaving
  // it unbound (Codex P2). Other open named-input cards share precise REUSE.
  const targetNode = definition.nodes.find((n) => n.id === target.nodeId)
  if (targetNode !== undefined && namedInputDropPolicy(targetNode.kind) === 'new-or-reuse') {
    const reuse = nearestPort(
      existingInputHandleCenters(definition, target.nodeId),
      screenPoint.x,
      screenPoint.y,
      REUSE_RADIUS_PX,
    )
    if (reuse !== null) return { kind: 'reuse', nodeId: target.nodeId, portName: reuse }
  }
  return { kind: 'new', nodeId: target.nodeId, portName: target.portName }
}
