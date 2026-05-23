// RFC-016: compute the rendered group rectangle for a wrapper node from the
// absolute positions of its inner nodes (workflow.nodeIds projected against
// definition.nodes). Returns width/height (with header + padding) and the
// offset by which the wrapper's render anchor needs to shift so inner nodes
// land inside `padding` of the visible rect.
//
// Pure: no mutation, no DOM access. The editor calls this on first render of
// a wrapper that has no persisted `size`, on inner-node add/remove, and on
// "Fit to children" right-click.

import type { NodeKind, WorkflowNode } from '@agent-workflow/shared'

/** Default fallback dimensions per node kind. Used when the inner node has no
 * recorded `size` AND xyflow has not yet measured it. Values err on the
 * generous side so the wrapper fit doesn't squeeze ports under-neighbours
 * before measurements arrive — once xyflow measures real dimensions, the
 * projection layer prefers those over these. */
export const DEFAULT_NODE_SIZE_BY_KIND: Record<NodeKind, { width: number; height: number }> = {
  'agent-single': { width: 280, height: 180 },
  'agent-multi': { width: 280, height: 200 },
  input: { width: 220, height: 120 },
  output: { width: 220, height: 140 },
  review: { width: 280, height: 180 },
  clarify: { width: 240, height: 140 },
  // RFC-056 — cross-clarify shares clarify's default footprint (1 input + 2
  // outputs but visually compact like its sibling).
  'clarify-cross-agent': { width: 240, height: 160 },
  'wrapper-git': { width: 240, height: 160 },
  'wrapper-loop': { width: 240, height: 160 },
  // RFC-060 — wrapper-fanout matches sibling wrapper container footprint.
  'wrapper-fanout': { width: 240, height: 160 },
}

/** Header strip height (matches `.canvas-node__header`). */
export const WRAPPER_HEADER_HEIGHT = 22
/** Default padding around inner content within the wrapper rect. Bumped from
 * 24 → 40 so a wrapper holding several agent nodes still has comfortable
 * room around the outer edges for handle dots + edge connection visuals. */
export const WRAPPER_DEFAULT_PADDING = 40
/** Minimum rendered size when a wrapper holds zero inner nodes. */
export const WRAPPER_EMPTY_MIN_WIDTH = 200
export const WRAPPER_EMPTY_MIN_HEIGHT = 120

interface XY {
  x: number
  y: number
}

interface FitBounds {
  width: number
  height: number
  /** Suggested wrapper top-left so inner-nodes land at padding/padding+header. */
  offset: XY
}

function nodeSize(
  node: WorkflowNode,
  measuredSizes?: Map<string, { width: number; height: number }>,
): { width: number; height: number } {
  // RFC-016: prefer xyflow's measured size when available — DEFAULT estimates
  // are conservative and miss handle protrusion (RFC-006 pins handles at -14px
  // from the node edge) + per-node port-row growth. Without using the
  // measured value, wrappers under-grow after drag-in and the child nodes'
  // ports visually overlap each other.
  const measured = measuredSizes?.get(node.id)
  if (measured !== undefined && measured.width > 0 && measured.height > 0) {
    return measured
  }
  const rec = node as Record<string, unknown>
  const size = rec.size as { width?: unknown; height?: unknown } | undefined
  if (
    size !== undefined &&
    typeof size.width === 'number' &&
    typeof size.height === 'number' &&
    size.width > 0 &&
    size.height > 0
  ) {
    return { width: size.width, height: size.height }
  }
  return DEFAULT_NODE_SIZE_BY_KIND[node.kind] ?? { width: 200, height: 100 }
}

export function computeFitBounds(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number = WRAPPER_DEFAULT_PADDING,
  measuredSizes?: Map<string, { width: number; height: number }>,
): FitBounds {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const inner = allNodes.filter((n) => idSet.has(n.id))

  if (inner.length === 0) {
    const pos = wrapper.position ?? { x: 0, y: 0 }
    return {
      width: WRAPPER_EMPTY_MIN_WIDTH,
      height: WRAPPER_EMPTY_MIN_HEIGHT,
      offset: { x: pos.x, y: pos.y },
    }
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const n of inner) {
    const p = n.position ?? { x: 0, y: 0 }
    const size = nodeSize(n, measuredSizes)
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x + size.width > maxX) maxX = p.x + size.width
    if (p.y + size.height > maxY) maxY = p.y + size.height
  }

  // Extra slack so handles (rendered at -14px outside the node edge per
  // RFC-006) and edge connection visuals don't graze the wrapper border.
  const HANDLE_SLACK = 16
  const width = Math.max(
    WRAPPER_EMPTY_MIN_WIDTH,
    Math.round(maxX - minX + padding * 2 + HANDLE_SLACK * 2),
  )
  const height = Math.max(
    WRAPPER_EMPTY_MIN_HEIGHT,
    Math.round(maxY - minY + padding * 2 + WRAPPER_HEADER_HEIGHT),
  )
  const offset: XY = {
    x: Math.round(minX - padding - HANDLE_SLACK),
    y: Math.round(minY - padding - WRAPPER_HEADER_HEIGHT),
  }
  return { width, height, offset }
}
