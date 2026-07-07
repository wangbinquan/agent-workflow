// RFC-016: hit-test + nodeIds patch primitives for the canvas group container
// UX. resolveMembershipOnDragStop decides "where did the user drop the node"
// from the rectangles snapshotted at drag-start; applyMembershipPatch turns
// that decision into a non-mutating WorkflowDefinition update.
//
// Hit rule (proposal §2.1 #2): a wrapper is hit iff the *center point* of the
// dragged node falls inside its rect — avoids edge-jitter when corners brush.
// Nested wrappers: the innermost (smallest area) hit wraps.

import { isWrapperKind } from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WrapperHitInput {
  id: string
  rect: Rect
  /** Current nodeIds — used to compute leaveWrapperId. */
  nodeIds: string[]
}

export interface MembershipPatch {
  draggedNodeId: string
  joinWrapperId: string | null
  leaveWrapperId: string | null
}

function pointInRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

function rectArea(r: Rect): number {
  return r.width * r.height
}

/** Decide which wrapper (if any) the dropped node should now belong to, plus
 * which wrapper it just left. Returns both `null` when no patch is needed (the
 * common case where a node was just moved inside its current wrapper). */
export function resolveMembershipOnDragStop(args: {
  draggedNodeId: string
  draggedCenter: { x: number; y: number }
  wrappers: WrapperHitInput[]
}): MembershipPatch {
  const { draggedNodeId, draggedCenter, wrappers } = args
  // Exclude wrapper from hit-testing itself (nested case).
  const others = wrappers.filter((w) => w.id !== draggedNodeId)
  const hits = others.filter((w) => pointInRect(draggedCenter, w.rect))
  // Innermost = smallest-area hit; deterministic tie-break by id.
  hits.sort((a, b) => {
    const da = rectArea(a.rect) - rectArea(b.rect)
    if (da !== 0) return da
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const joinTarget = hits[0] ?? null

  let currentWrapperId: string | null = null
  for (const w of others) {
    if (w.nodeIds.includes(draggedNodeId)) {
      currentWrapperId = w.id
      break
    }
  }

  const joinWrapperId = joinTarget?.id ?? null
  const leaveWrapperId = currentWrapperId
  if (joinWrapperId === leaveWrapperId) {
    return { draggedNodeId, joinWrapperId: null, leaveWrapperId: null }
  }
  return { draggedNodeId, joinWrapperId, leaveWrapperId }
}

/** Apply a membership patch to a WorkflowDefinition. Returns prevDef by
 * reference when no change is needed so React `useEffect` short-circuits. */
export function applyMembershipPatch(
  prevDef: WorkflowDefinition,
  patch: MembershipPatch,
): WorkflowDefinition {
  if (patch.joinWrapperId === null && patch.leaveWrapperId === null) return prevDef
  let touched = false
  const nodes = prevDef.nodes.map((n) => {
    if (!isWrapperKind(n.kind)) return n
    if (n.id !== patch.joinWrapperId && n.id !== patch.leaveWrapperId) return n
    const rec = n as Record<string, unknown>
    const prevIds = Array.isArray(rec.nodeIds)
      ? (rec.nodeIds as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    let nextIds = prevIds
    if (n.id === patch.leaveWrapperId) {
      nextIds = nextIds.filter((s) => s !== patch.draggedNodeId)
    }
    if (n.id === patch.joinWrapperId) {
      if (!nextIds.includes(patch.draggedNodeId)) nextIds = [...nextIds, patch.draggedNodeId]
    }
    if (nextIds === prevIds) return n
    touched = true
    // Drop persisted size so the next fit pass recalculates — unless the user
    // has locked the size via manual resize.
    const sizeRec = rec.size as { sizeLocked?: unknown } | undefined
    const sizeLocked = sizeRec !== undefined && sizeRec.sizeLocked === true
    const next: Record<string, unknown> = { ...rec, nodeIds: nextIds }
    if (!sizeLocked) {
      delete next.size
    }
    return next as unknown as WorkflowNode
  })
  if (!touched) return prevDef
  return { ...prevDef, nodes }
}
