// RFC-016 T8: pure transformations behind the wrapper right-click menu
// items. The closures in WorkflowCanvas wrap these with commitChange and
// setSelection; everything that touches the WorkflowDefinition lives here
// so tests can exercise it without rendering the canvas.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

/** Clear `size` (and any sizeLocked flag) on a wrapper so the next render
 * recomputes its bounding rect from the current inner-node bbox. Returns
 * prevDef by reference when the target is missing or not a wrapper. */
export function clearWrapperSize(
  prevDef: WorkflowDefinition,
  wrapperId: string,
): WorkflowDefinition {
  const target = prevDef.nodes.find((n) => n.id === wrapperId)
  if (target === undefined) return prevDef
  if (
    target.kind !== 'wrapper-git' &&
    target.kind !== 'wrapper-loop' &&
    target.kind !== 'wrapper-fanout'
  )
    return prevDef
  let changed = false
  const nodes = prevDef.nodes.map((n) => {
    if (n.id !== wrapperId) return n
    const rec = { ...(n as Record<string, unknown>) }
    if (rec.size === undefined) return n
    delete rec.size
    changed = true
    return rec as unknown as WorkflowNode
  })
  if (!changed) return prevDef
  return { ...prevDef, nodes }
}

/** Remove a wrapper AND every node listed in its nodeIds (and any orphaned
 * edges). Returns prevDef by reference for non-wrapper targets so callers
 * can short-circuit. */
export function deleteWrapperWithChildren(
  prevDef: WorkflowDefinition,
  wrapperId: string,
): WorkflowDefinition {
  const target = prevDef.nodes.find((n) => n.id === wrapperId)
  if (target === undefined) return prevDef
  if (
    target.kind !== 'wrapper-git' &&
    target.kind !== 'wrapper-loop' &&
    target.kind !== 'wrapper-fanout'
  )
    return prevDef
  const inner = (target as Record<string, unknown>).nodeIds
  const innerIds = Array.isArray(inner)
    ? (inner as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  const toRemove = new Set<string>([wrapperId, ...innerIds])
  const keptNodes = prevDef.nodes.filter((n) => !toRemove.has(n.id))
  const stillIds = new Set(keptNodes.map((n) => n.id))
  const keptEdges = prevDef.edges.filter(
    (e) => stillIds.has(e.source.nodeId) && stillIds.has(e.target.nodeId),
  )
  return { ...prevDef, nodes: keptNodes, edges: keptEdges }
}
