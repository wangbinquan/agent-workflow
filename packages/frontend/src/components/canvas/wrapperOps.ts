// RFC-016 T8: pure transformations behind the wrapper right-click menu
// items. The closures in WorkflowCanvas wrap these with commitChange and
// setSelection; everything that touches the WorkflowDefinition lives here
// so tests can exercise it without rendering the canvas.

import { collectNodeReferenceClosure, isWrapperKind } from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

export interface WrapperDeleteSnapshot {
  wrapperId: string
  childIds: string[]
}

/** Snapshot the destructive scope shown in the confirmation dialog. Sorting
 * makes the comparison below set-like: reordering nodeIds alone does not make
 * the user's confirmation stale, while adding/removing a child does. */
export function snapshotWrapperDelete(
  definition: WorkflowDefinition,
  wrapperId: string,
): WrapperDeleteSnapshot | null {
  const target = definition.nodes.find((node) => node.id === wrapperId)
  if (target === undefined || !isWrapperKind(target.kind)) return null
  const childIds = collectNodeReferenceClosure(definition, [wrapperId])
    .nodeIds.filter((nodeId) => nodeId !== wrapperId)
    .sort((a, b) => a.localeCompare(b))
  return { wrapperId, childIds }
}

/** Reject a confirmation when its wrapper disappeared or its destructive
 * child set changed while the dialog was open. */
export function isWrapperDeleteSnapshotCurrent(
  definition: WorkflowDefinition,
  snapshot: WrapperDeleteSnapshot,
): boolean {
  const current = snapshotWrapperDelete(definition, snapshot.wrapperId)
  if (current === null || current.childIds.length !== snapshot.childIds.length) return false
  return current.childIds.every((id, index) => id === snapshot.childIds[index])
}

/** Clear `size` (and any sizeLocked flag) on a wrapper so the next render
 * recomputes its bounding rect from the current inner-node bbox. Returns
 * prevDef by reference when the target is missing or not a wrapper. */
export function clearWrapperSize(
  prevDef: WorkflowDefinition,
  wrapperId: string,
): WorkflowDefinition {
  const target = prevDef.nodes.find((n) => n.id === wrapperId)
  if (target === undefined) return prevDef
  if (!isWrapperKind(target.kind)) return prevDef
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

/** Remove a wrapper AND its complete recursive child closure (and any
 * orphaned edges). Returns prevDef by reference for non-wrapper targets so
 * callers can short-circuit. */
export function deleteWrapperWithChildren(
  prevDef: WorkflowDefinition,
  wrapperId: string,
): WorkflowDefinition {
  const target = prevDef.nodes.find((n) => n.id === wrapperId)
  if (target === undefined) return prevDef
  if (!isWrapperKind(target.kind)) return prevDef
  const toRemove = new Set(collectNodeReferenceClosure(prevDef, [wrapperId]).nodeIds)
  const keptNodes = prevDef.nodes.filter((n) => !toRemove.has(n.id))
  const stillIds = new Set(keptNodes.map((n) => n.id))
  const keptEdges = prevDef.edges.filter(
    (e) => stillIds.has(e.source.nodeId) && stillIds.has(e.target.nodeId),
  )
  return { ...prevDef, nodes: keptNodes, edges: keptEdges }
}
