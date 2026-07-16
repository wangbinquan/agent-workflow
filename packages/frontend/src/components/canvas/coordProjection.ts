// RFC-016: project WorkflowDefinition absolute coordinates ⇄ xyflow
// parent/child relative coordinates. DB schema stays absolute; only the
// render layer sees relative positions (xyflow requires parentId-children
// to express position relative to their parent).
//
// Two pure entry points:
//   projectDefinitionForXyflow(definition, flowNodes)
//     — Given pre-built xyflow nodes (one per definition node, absolute
//       positions), set `parentId` and convert each wrapper child's
//       position to relative-to-parent. **Intentionally does NOT set
//       `extent: 'parent'`** — that xyflow flag physically clamps the
//       child to the parent's rect, which would make "drag-out =
//       remove from wrapper" impossible (the drag couldn't leave the
//       wrapper at all). Membership is enforced logically in
//       onNodeDragStop via the center-hit test instead. Also stamps
//       the wrapper's render style {width, height} from wrapper.size
//       (or computeFitBounds fallback).
//   projectXyflowPositionsToAbsolute(definition, flowNodes)
//     — Inverse: walk children, add their parent's absolute position back
//       so the caller can serialize back to definition.nodes with the
//       canonical absolute coordinates.
//
// xyflow requires parent nodes to appear *before* their children in the
// array; this module returns a stably-reordered list to satisfy that.

import type { Node } from '@xyflow/react'
import { isWrapperKind } from '@agent-workflow/shared'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { computeFitBounds } from './wrapperFit'
import { effectiveWorkflowNodePosition } from '../../lib/workflow-placement'

// flag-audit W0: the private wrapper-kind predicate that once lived here (and
// missed wrapper-fanout during the RFC-060 rollout — wrapper-sizing bug) is
// replaced by the shared single-source `isWrapperKind`.

/** Build the {nodeId → measured size} map that the projection layer uses to
 * pick wrapper fit dimensions over DEFAULT_NODE_SIZE_BY_KIND estimates.
 * xyflow populates `node.measured` after its ResizeObserver picks up the
 * rendered DOM size; before that we just have no entry, and the projection
 * falls back to the static defaults. */
export function buildMeasuredSizesFromXyflowNodes(
  flowNodes: Array<{
    id: string
    measured?: { width?: number; height?: number }
    width?: number | null
    height?: number | null
  }>,
): Map<string, { width: number; height: number }> {
  const m = new Map<string, { width: number; height: number }>()
  for (const fn of flowNodes) {
    const w = fn.measured?.width ?? fn.width ?? null
    const h = fn.measured?.height ?? fn.height ?? null
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      m.set(fn.id, { width: w, height: h })
    }
  }
  return m
}

interface WrapperResolved {
  id: string
  /** Absolute top-left position to render at (from offset of computeFitBounds
   * when wrapper.size is absent, or wrapper.position when size is set). */
  position: { x: number; y: number }
  width: number
  height: number
  /** Inner node ids — direct members only (no nested transitive flatten). */
  innerIds: string[]
}

/** Build a map of wrapperId → resolved rect + members, including the absolute
 * position the wrapper *renders at* (top-left of the visible group rect).
 *
 * `measuredSizes` (optional) is the live xyflow-measured size for each node;
 * when present, computeFitBounds uses those instead of the static
 * DEFAULT_NODE_SIZE_BY_KIND estimates — important so a wrapper that holds
 * agents with many ports actually grows to fit them. */
export function resolveWrappers(
  definition: WorkflowDefinition,
  measuredSizes?: Map<string, { width: number; height: number }>,
): Map<string, WrapperResolved> {
  const out = new Map<string, WrapperResolved>()
  for (const [index, n] of definition.nodes.entries()) {
    if (!isWrapperKind(n.kind)) continue
    const rec = n as unknown as Record<string, unknown>
    const ids = Array.isArray(rec.nodeIds)
      ? (rec.nodeIds as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    const sizeRec = rec.size as
      | { width?: unknown; height?: unknown; sizeLocked?: unknown }
      | undefined
    if (
      sizeRec !== undefined &&
      typeof sizeRec.width === 'number' &&
      typeof sizeRec.height === 'number'
    ) {
      const pos = effectiveWorkflowNodePosition(n, index)
      out.set(n.id, {
        id: n.id,
        position: { x: pos.x, y: pos.y },
        width: sizeRec.width,
        height: sizeRec.height,
        innerIds: ids,
      })
    } else {
      const fit = computeFitBounds(n, definition.nodes, undefined, measuredSizes)
      out.set(n.id, {
        id: n.id,
        position: { x: fit.offset.x, y: fit.offset.y },
        width: fit.width,
        height: fit.height,
        innerIds: ids,
      })
    }
  }
  return out
}

/** Return a node id → its direct wrapper id (or undefined if top-level). */
export function buildParentMap(wrappers: Map<string, WrapperResolved>): Map<string, string> {
  const m = new Map<string, string>()
  for (const w of wrappers.values()) {
    for (const innerId of w.innerIds) {
      // Last writer wins; the validator guarantees one-parent membership.
      m.set(innerId, w.id)
    }
  }
  return m
}

/** Sort so parents appear before their children — xyflow requirement. */
export function topoSortByParent(flowNodes: Node[], parentMap: Map<string, string>): Node[] {
  const indexById = new Map(flowNodes.map((n, i) => [n.id, i] as const))
  const depth = new Map<string, number>()
  function depthOf(id: string): number {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    const p = parentMap.get(id)
    const d = p === undefined ? 0 : depthOf(p) + 1
    depth.set(id, d)
    return d
  }
  for (const n of flowNodes) depthOf(n.id)
  const sorted = [...flowNodes]
  sorted.sort((a, b) => {
    const da = depth.get(a.id) ?? 0
    const db = depth.get(b.id) ?? 0
    if (da !== db) return da - db
    return (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0)
  })
  return sorted
}

/** Mutate flowNodes positions in-place — wrapper-child positions go from
 * absolute (DB form) to relative (xyflow form), and wrappers get
 * style.width/height stamped + their render anchor moved to the group's
 * top-left when wrapper.size is absent.
 *
 * `measuredSizes` — optional, when provided lets the fit-bounds computation
 * use xyflow's real measured dimensions instead of static estimates. The
 * caller (WorkflowCanvas) builds it from the current `nodes` state's
 * `node.measured` field, which xyflow populates via ResizeObserver. */
export function projectDefinitionForXyflow(
  definition: WorkflowDefinition,
  flowNodes: Node[],
  measuredSizes?: Map<string, { width: number; height: number }>,
): Node[] {
  const wrappers = resolveWrappers(definition, measuredSizes)
  const parentMap = buildParentMap(wrappers)
  const out: Node[] = []
  for (const fn of flowNodes) {
    // Step 1: figure out this node's absolute render anchor.
    // - Wrappers may carry a persisted size + position, or fall back to the
    //   computed fit offset; either way the absolute anchor was resolved in
    //   resolveWrappers above.
    // - Non-wrappers keep their own absolute position from flowNode.
    let absX = fn.position.x
    let absY = fn.position.y
    let style = fn.style
    let zIndex = fn.zIndex
    if (isWrapperKind(fn.type ?? '')) {
      const w = wrappers.get(fn.id)
      if (w !== undefined) {
        absX = w.position.x
        absY = w.position.y
        style = { ...(fn.style ?? {}), width: w.width, height: w.height }
        zIndex = -1
      }
    }
    // Step 2: if this node belongs to a wrapper, set parentId + relative pos.
    const parentId = parentMap.get(fn.id)
    if (parentId !== undefined) {
      const parent = wrappers.get(parentId)
      if (parent !== undefined) {
        out.push({
          ...fn,
          parentId,
          // No `extent: 'parent'` — RFC-016 §4.1 / drag-out membership.
          position: { x: absX - parent.position.x, y: absY - parent.position.y },
          style,
          ...(zIndex !== undefined ? { zIndex } : {}),
        })
        continue
      }
    }
    out.push({
      ...fn,
      position: { x: absX, y: absY },
      style,
      ...(zIndex !== undefined ? { zIndex } : {}),
    })
  }
  return topoSortByParent(out, parentMap)
}

/** Inverse: when xyflow hands us flowNodes (children carry relative position),
 * compute absolute coordinates so the caller can serialize back to
 * definition.nodes. Nested wrappers are children too, so their current
 * absolute render anchor must be resolved through the complete parent chain. */
export function projectXyflowPositionsToAbsolute(
  definition: WorkflowDefinition,
  flowNodes: Node[],
  measuredSizes?: Map<string, { width: number; height: number }>,
): Node[] {
  const wrapperMembership = buildParentMap(resolveWrappers(definition, measuredSizes))
  const flowById = new Map(flowNodes.map((node) => [node.id, node] as const))
  const absoluteById = new Map<string, { x: number; y: number }>()
  const resolving = new Set<string>()

  // Resolve from the *current* xyflow positions so moving any ancestor moves
  // all of its nested descendants when the canonical absolute coordinates are
  // persisted. The validator rejects cycles, but the guard keeps this pure
  // boundary total for malformed in-memory definitions.
  const resolveAbsolutePosition = (id: string): { x: number; y: number } | undefined => {
    const cached = absoluteById.get(id)
    if (cached !== undefined) return cached
    const node = flowById.get(id)
    if (node === undefined) return undefined
    if (resolving.has(id)) return undefined

    resolving.add(id)
    const parentId = wrapperMembership.get(id)
    const parentPosition = parentId === undefined ? undefined : resolveAbsolutePosition(parentId)
    resolving.delete(id)

    const absolute =
      parentId !== undefined && parentPosition !== undefined
        ? {
            x: node.position.x + parentPosition.x,
            y: node.position.y + parentPosition.y,
          }
        : { x: node.position.x, y: node.position.y }
    absoluteById.set(id, absolute)
    return absolute
  }

  return flowNodes.map((fn) => {
    const parentId = wrapperMembership.get(fn.id)
    if (parentId === undefined) return fn
    const absolute = resolveAbsolutePosition(fn.id)
    if (absolute === undefined) return fn
    return {
      ...fn,
      position: absolute,
    }
  })
}
