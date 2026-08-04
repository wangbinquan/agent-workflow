// RFC-016: compute the rendered group rectangle for a wrapper node from the
// absolute positions of its inner nodes (workflow.nodeIds projected against
// definition.nodes). Returns width/height (with header + padding) and the
// offset by which the wrapper's render anchor needs to shift so inner nodes
// land inside `padding` of the visible rect.
//
// Pure: no mutation, no DOM access. The editor calls this on first render of
// a wrapper that has no persisted `size`, on inner-node add/remove, and on
// "Fit to children" right-click.

import { isWrapperKind } from '@agent-workflow/shared'
import type { NodeKind, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { effectiveWorkflowNodePosition } from '../../lib/workflow-placement'

/** Default fallback dimensions per node kind. Used when the inner node has no
 * recorded `size` AND xyflow has not yet measured it. Values err on the
 * generous side so the wrapper fit doesn't squeeze ports under-neighbours
 * before measurements arrive — once xyflow measures real dimensions, the
 * projection layer prefers those over these. */
export const DEFAULT_NODE_SIZE_BY_KIND: Record<NodeKind, { width: number; height: number }> = {
  'agent-single': { width: 280, height: 180 },
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
  // RFC-243 — call-workflow renders agent-shaped (header + ref line + port
  // rows both sides), so it shares agent-single's generous default.
  'call-workflow': { width: 280, height: 180 },
  // RFC-243 PR-4 — call-workgroup shares the same agent-shaped card chrome.
  'call-workgroup': { width: 280, height: 180 },
  // RFC-253 — agent-shaped card (header + badge row + port rows on both
  // sides), so it shares agent-single's generous default.
  script: { width: 280, height: 180 },
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

export interface WrapperMinimumSize {
  width: number
  height: number
}

export type WrapperMinimumSizes = ReadonlyMap<string, WrapperMinimumSize>

// Wrapper-git / wrapper-loop output handles sit in one bottom row. These
// values mirror `.canvas-node__bottom-ports` and `.canvas-node__port-label`:
// 10px horizontal container padding, 16px gap, a 140px label cap, and 4px
// label padding on each side. The label font is 13px monospace; 8px per ASCII
// glyph (13px for wide Unicode glyphs) is a conservative layout estimate.
const BOTTOM_PORTS_HORIZONTAL_PADDING = 20
const BOTTOM_PORT_GAP = 16
const PORT_LABEL_HORIZONTAL_PADDING = 8
const PORT_LABEL_MAX_WIDTH = 140
const PORT_LABEL_ASCII_GLYPH_WIDTH = 8
const PORT_LABEL_WIDE_GLYPH_WIDTH = 13

// Wrapper-fanout boundary ports stack down each side. The rendered row is
// 22px high plus 2px padding and a 1px border on both vertical sides; the
// column starts 30px below the header, ends 6px above the bottom, and uses a
// 6px gap. Keep the wrapper tall enough for whichever side has more rows.
const SIDE_PORT_ROW_HEIGHT = 28
const SIDE_PORT_GAP = 6
const SIDE_PORT_TOP = 30
const SIDE_PORT_BOTTOM = 6

function portNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((port): port is string => typeof port === 'string')
    : []
}

function estimatedPortLabelWidth(port: string): number {
  let contentWidth = 0
  for (const glyph of Array.from(port)) {
    contentWidth += /^[\x20-\x7e]$/.test(glyph)
      ? PORT_LABEL_ASCII_GLYPH_WIDTH
      : PORT_LABEL_WIDE_GLYPH_WIDTH
  }
  return (
    Math.min(PORT_LABEL_MAX_WIDTH, Math.max(PORT_LABEL_ASCII_GLYPH_WIDTH, contentWidth)) +
    PORT_LABEL_HORIZONTAL_PADDING
  )
}

/** Derive intrinsic wrapper chrome constraints from the ports that the canvas
 * actually renders. This stays presentation-only: no workflow size, lock, or
 * undo state is mutated. */
export function buildWrapperPortMinimumSizes(
  flowNodes: ReadonlyArray<{
    id: string
    type?: string
    data: unknown
  }>,
): Map<string, WrapperMinimumSize> {
  const out = new Map<string, WrapperMinimumSize>()
  for (const node of flowNodes) {
    if (!isWrapperKind(node.type)) continue
    const data =
      node.data !== null && typeof node.data === 'object'
        ? (node.data as Record<string, unknown>)
        : {}
    const inputs = portNames(data.inputPorts)
    const outputs = portNames(data.outputPorts)
    let width = WRAPPER_EMPTY_MIN_WIDTH
    let height = WRAPPER_EMPTY_MIN_HEIGHT

    if (node.type === 'wrapper-fanout') {
      const sideCount = Math.max(inputs.length, outputs.length)
      if (sideCount > 0) {
        height = Math.max(
          height,
          SIDE_PORT_TOP +
            SIDE_PORT_BOTTOM +
            sideCount * SIDE_PORT_ROW_HEIGHT +
            Math.max(0, sideCount - 1) * SIDE_PORT_GAP,
        )
      }
    } else if (outputs.length > 0) {
      width = Math.max(
        width,
        BOTTOM_PORTS_HORIZONTAL_PADDING +
          outputs.reduce((sum, port) => sum + estimatedPortLabelWidth(port), 0) +
          Math.max(0, outputs.length - 1) * BOTTOM_PORT_GAP,
      )
    }

    if (width > WRAPPER_EMPTY_MIN_WIDTH || height > WRAPPER_EMPTY_MIN_HEIGHT) {
      out.set(node.id, { width: Math.round(width), height: Math.round(height) })
    }
  }
  return out
}

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

interface NodeRect extends XY {
  width: number
  height: number
}

function effectivePositionInDefinition(node: WorkflowNode, allNodes: readonly WorkflowNode[]): XY {
  const index = allNodes.findIndex((candidate) => candidate.id === node.id)
  return effectiveWorkflowNodePosition(node, index < 0 ? 0 : index)
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

function hasPersistedSize(node: WorkflowNode): boolean {
  const size = (node as Record<string, unknown>).size as
    | { width?: unknown; height?: unknown }
    | undefined
  return (
    size !== undefined &&
    typeof size.width === 'number' &&
    typeof size.height === 'number' &&
    size.width > 0 &&
    size.height > 0
  )
}

function hasLockedSize(node: WorkflowNode): boolean {
  const size = (node as Record<string, unknown>).size as { sizeLocked?: unknown } | undefined
  return size?.sizeLocked === true
}

function applyMinimumSize(
  node: WorkflowNode,
  size: { width: number; height: number },
  minimumSizes: WrapperMinimumSizes | undefined,
): { width: number; height: number } {
  if (!isWrapperKind(node.kind) || hasLockedSize(node)) return size
  const minimum = minimumSizes?.get(node.id)
  if (minimum === undefined) return size
  return {
    width: Math.max(size.width, minimum.width),
    height: Math.max(size.height, minimum.height),
  }
}

function applyMinimumFit(
  wrapper: WorkflowNode,
  fit: FitBounds,
  minimumSizes: WrapperMinimumSizes | undefined,
): FitBounds {
  const size = applyMinimumSize(wrapper, fit, minimumSizes)
  return size.width === fit.width && size.height === fit.height ? fit : { ...fit, ...size }
}

/** Resolve the rectangle a node actually occupies in canonical absolute
 * coordinates. Unsized wrappers do not render at their stale persisted
 * `position`; projection renders them at computeFitBounds' offset instead.
 * Recursing here keeps an outer wrapper's bbox aligned with that visual rect. */
function resolveNodeRect(
  node: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number,
  measuredSizes: Map<string, { width: number; height: number }> | undefined,
  resolvingWrappers: Set<string>,
  minimumSizes: WrapperMinimumSizes | undefined,
): NodeRect {
  if (isWrapperKind(node.kind) && !hasPersistedSize(node)) {
    if (!resolvingWrappers.has(node.id)) {
      resolvingWrappers.add(node.id)
      const fit = computeFitBoundsInternal(
        node,
        allNodes,
        padding,
        measuredSizes,
        resolvingWrappers,
        minimumSizes,
      )
      resolvingWrappers.delete(node.id)
      return { x: fit.offset.x, y: fit.offset.y, width: fit.width, height: fit.height }
    }
    // Invalid cyclic membership: use the conservative kind fallback rather
    // than recursing forever. Validated definitions never take this branch.
  }

  const position = effectivePositionInDefinition(node, allNodes)
  const size = applyMinimumSize(node, nodeSize(node, measuredSizes), minimumSizes)
  return { x: position.x, y: position.y, width: size.width, height: size.height }
}

function computeFitBoundsInternal(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number,
  measuredSizes: Map<string, { width: number; height: number }> | undefined,
  resolvingWrappers: Set<string>,
  minimumSizes: WrapperMinimumSizes | undefined,
): FitBounds {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const inner = allNodes.filter((n) => idSet.has(n.id))

  if (inner.length === 0) {
    const pos = effectivePositionInDefinition(wrapper, allNodes)
    return applyMinimumFit(
      wrapper,
      {
        width: WRAPPER_EMPTY_MIN_WIDTH,
        height: WRAPPER_EMPTY_MIN_HEIGHT,
        offset: { x: pos.x, y: pos.y },
      },
      minimumSizes,
    )
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of inner) {
    const rect = resolveNodeRect(
      node,
      allNodes,
      padding,
      measuredSizes,
      resolvingWrappers,
      minimumSizes,
    )
    if (rect.x < minX) minX = rect.x
    if (rect.y < minY) minY = rect.y
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height
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
  return applyMinimumFit(wrapper, { width, height, offset }, minimumSizes)
}

export function computeFitBounds(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number = WRAPPER_DEFAULT_PADDING,
  measuredSizes?: Map<string, { width: number; height: number }>,
  minimumSizes?: WrapperMinimumSizes,
): FitBounds {
  return computeFitBoundsInternal(
    wrapper,
    allNodes,
    padding,
    measuredSizes,
    new Set([wrapper.id]),
    minimumSizes,
  )
}

/** Target clearance from each inner-node edge to the wrapper's visible
 * border, enforced on drag-stop by `fitWrapperToInner`. Mirrors the
 * constants computeFitBounds uses on initial fit, so a wrapper that
 * re-fits after a drag ends up with the same breathing room as one that
 * was just rebuilt via "Fit to children".
 *
 * Why two horizontal numbers: handles are pinned at -14px outside the node
 * edge (RFC-006), so the visible inner-node bbox actually extends past
 * `node.x + node.width` by HANDLE_SLACK. The top number folds in the
 * wrapper header strip so the inner node doesn't tuck under the chip row.
 */
export const AUTO_FIT_HANDLE_SLACK = 16
export const AUTO_FIT_LEFT_CLEARANCE = WRAPPER_DEFAULT_PADDING + AUTO_FIT_HANDLE_SLACK
export const AUTO_FIT_RIGHT_CLEARANCE = WRAPPER_DEFAULT_PADDING + AUTO_FIT_HANDLE_SLACK
export const AUTO_FIT_TOP_CLEARANCE = WRAPPER_DEFAULT_PADDING + WRAPPER_HEADER_HEIGHT
export const AUTO_FIT_BOTTOM_CLEARANCE = WRAPPER_DEFAULT_PADDING

/** Snap the wrapper's persisted `position` + `size` so each side sits
 * exactly the target clearance from the inner-node bbox — grows when an
 * inner node has been dragged too close to the border, AND shrinks when
 * the nearest inner node sits too far from the border (e.g. after the
 * user drags a node back toward the wrapper centre). This is the
 * drag-stop counterpart to computeFitBounds' from-scratch fit; both
 * produce the same final rect for a given set of inner positions, so a
 * wrapper edited by either path is visually indistinguishable.
 *
 * Returns prevDef by reference when no change is needed so React effects
 * can short-circuit.
 *
 * Skips when:
 *   - the target id is missing / not a wrapper
 *   - `size.sizeLocked === true` (user has manually pinned the wrapper)
 *   - the wrapper has no persisted `size` yet (computeFitBounds already
 *     produces an adequately-padded rect for the initial render, so
 *     there is nothing to re-fit against)
 *   - the wrapper has zero inner nodes and already satisfies any intrinsic
 *     port-chrome minimum (there is no child bbox to anchor a shrink to)
 *   - the current rect already matches the target clearance
 *
 * Inner-node absolute positions are NOT moved — only the wrapper's
 * top-left + size shift. Because xyflow renders children at
 * (childAbs - wrapperAbs), shifting the wrapper top-left automatically
 * updates the child's parent-relative offset, keeping the visible
 * inner-node positions stable.
 */
export function fitWrapperToInner(
  prevDef: WorkflowDefinition,
  wrapperId: string,
  measuredSizes?: Map<string, { width: number; height: number }>,
  minimumSizes?: WrapperMinimumSizes,
): WorkflowDefinition {
  const target = prevDef.nodes.find((n) => n.id === wrapperId)
  if (target === undefined) return prevDef
  if (!isWrapperKind(target.kind)) return prevDef
  const rec = target as Record<string, unknown>
  const sizeRec = rec.size as
    | { width?: unknown; height?: unknown; sizeLocked?: unknown }
    | undefined
  if (sizeRec === undefined) return prevDef
  if (sizeRec.sizeLocked === true) return prevDef
  if (typeof sizeRec.width !== 'number' || typeof sizeRec.height !== 'number') return prevDef

  const innerIdsRaw = rec.nodeIds
  const innerIds = Array.isArray(innerIdsRaw)
    ? innerIdsRaw.filter((s): s is string => typeof s === 'string')
    : []
  if (innerIds.length === 0) {
    const minimum = minimumSizes?.get(wrapperId)
    if (
      minimum === undefined ||
      (sizeRec.width >= minimum.width && sizeRec.height >= minimum.height)
    ) {
      return prevDef
    }
    return {
      ...prevDef,
      nodes: prevDef.nodes.map((node) =>
        node.id === wrapperId
          ? ({
              ...(node as unknown as Record<string, unknown>),
              size: {
                width: Math.max(sizeRec.width as number, minimum.width),
                height: Math.max(sizeRec.height as number, minimum.height),
              },
            } as unknown as WorkflowNode)
          : node,
      ),
    }
  }
  const innerIdSet = new Set(innerIds)
  const inner = prevDef.nodes.filter((n) => innerIdSet.has(n.id))
  if (inner.length === 0) return prevDef

  // Inner-node bbox in absolute coordinates.
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const resolvingWrappers = new Set([target.id])
  for (const n of inner) {
    const rect = resolveNodeRect(
      n,
      prevDef.nodes,
      WRAPPER_DEFAULT_PADDING,
      measuredSizes,
      resolvingWrappers,
      minimumSizes,
    )
    if (rect.x < minX) minX = rect.x
    if (rect.y < minY) minY = rect.y
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height
  }

  // Snap each side to exactly inner_extreme ± clearance — bidirectional.
  const needLeft = minX - AUTO_FIT_LEFT_CLEARANCE
  const needTop = minY - AUTO_FIT_TOP_CLEARANCE
  let needRight = maxX + AUTO_FIT_RIGHT_CLEARANCE
  let needBottom = maxY + AUTO_FIT_BOTTOM_CLEARANCE
  const minimum = minimumSizes?.get(wrapperId)
  if (minimum !== undefined) {
    needRight = Math.max(needRight, needLeft + minimum.width)
    needBottom = Math.max(needBottom, needTop + minimum.height)
  }

  const pos = effectivePositionInDefinition(target, prevDef.nodes)
  const curLeft = pos.x
  const curTop = pos.y
  const curRight = pos.x + sizeRec.width
  const curBottom = pos.y + sizeRec.height
  if (
    needLeft === curLeft &&
    needTop === curTop &&
    needRight === curRight &&
    needBottom === curBottom
  ) {
    return prevDef
  }

  const newPos = { x: Math.round(needLeft), y: Math.round(needTop) }
  const newSize = {
    width: Math.round(needRight - needLeft),
    height: Math.round(needBottom - needTop),
  }
  const nextNodes = prevDef.nodes.map((n) => {
    if (n.id !== wrapperId) return n
    const r = n as Record<string, unknown>
    const prevSize = r.size as { sizeLocked?: unknown } | undefined
    const sizeLocked = prevSize?.sizeLocked === true
    return {
      ...r,
      position: newPos,
      size: sizeLocked ? { ...newSize, sizeLocked: true } : newSize,
    } as unknown as WorkflowNode
  })
  return { ...prevDef, nodes: nextNodes }
}
