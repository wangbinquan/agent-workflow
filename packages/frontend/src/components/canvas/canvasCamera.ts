// RFC-250 T30/T31 — pure camera and zoom-band policy for the editable
// WorkflowCanvas. Keeping the thresholds here prevents camera commands,
// projected inline actions and tests from drifting apart.

export const TOPOLOGY_MAX_ZOOM = 0.55
export const READABLE_MIN_ZOOM = 1.1
export const OVERVIEW_MAX_ZOOM = 0.75
export const READABLE_FOCUS_ZOOM = 1.15
export const READABLE_FIT_MAX_ZOOM = 1.25
export const WRAPPER_HEADER_FOCUS_OFFSET = 36

export type CanvasCameraMode = 'readable-focus' | 'overview'
export type CanvasZoomBand = 'topology' | 'overview' | 'readable'

export interface CanvasFocusRect {
  x: number
  y: number
  width: number
  height: number
  kind?: string
}

export interface CanvasFocusPoint {
  x: number
  y: number
}

export interface CanvasScreenHorizontalBounds {
  left: number
  right: number
}

export type InitialCanvasCameraPlan =
  | { kind: 'none'; mode: 'readable-focus' }
  | { kind: 'fit-all'; mode: 'readable-focus'; maxZoom: number }
  | { kind: 'focus-node'; mode: 'readable-focus'; nodeId: string; zoom: number }

export function resolveCanvasZoomBand(zoom: number): CanvasZoomBand {
  if (zoom < TOPOLOGY_MAX_ZOOM) return 'topology'
  if (zoom < READABLE_MIN_ZOOM) return 'overview'
  return 'readable'
}

/**
 * Inline controls are projected in flow space, so their screen-space hit area
 * shrinks with zoom. If either axis would miss the active pointer target, the
 * control must leave the DOM (and therefore the Tab order).
 */
export function canShowCanvasInlineActions(
  zoom: number,
  coarsePointer: boolean,
  logicalSize = coarsePointer ? 44 : 26,
): boolean {
  const requiredScreenSize = coarsePointer ? 44 : 24
  return zoom > 0 && logicalSize * zoom >= requiredScreenSize
}

export function chooseCanvasFocalNode(
  nodeIds: readonly string[],
  entryNodeIds: readonly string[],
  preferredNodeId?: string,
): string | null {
  const available = new Set(nodeIds)
  if (preferredNodeId !== undefined && available.has(preferredNodeId)) return preferredNodeId
  for (const nodeId of entryNodeIds) if (available.has(nodeId)) return nodeId
  return nodeIds[0] ?? null
}

/** Wrapper focus targets the readable header, not the potentially huge body. */
export function canvasNodeFocusPoint(node: CanvasFocusRect): CanvasFocusPoint {
  const wrapper = node.kind?.startsWith('wrapper-') === true
  return {
    x: node.x + node.width / 2,
    y: wrapper
      ? node.y + Math.min(WRAPPER_HEADER_FOCUS_OFFSET, node.height / 2)
      : node.y + node.height / 2,
  }
}

/** Edge focus uses the midpoint between its two endpoint focus points. */
export function canvasEdgeFocusPoint(
  source: CanvasFocusPoint,
  target: CanvasFocusPoint,
): CanvasFocusPoint {
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 }
}

/**
 * A compact Inspector is a right-side overlay rather than a grid rail. Shift
 * the virtual flow-space focus point right by half of the covered screen width
 * so the real object lands in the centre of the canvas strip left visible.
 */
export function canvasFocusPointWithRightOcclusion(
  point: CanvasFocusPoint,
  zoom: number,
  canvas: CanvasScreenHorizontalBounds,
  occluder: CanvasScreenHorizontalBounds,
): CanvasFocusPoint {
  if (
    zoom <= 0 ||
    occluder.left <= canvas.left ||
    occluder.left >= canvas.right ||
    occluder.right < canvas.right
  ) {
    return point
  }
  const coveredScreenWidth = canvas.right - occluder.left
  return { x: point.x + coveredScreenWidth / (2 * zoom), y: point.y }
}

export function canvasNodesHaveMeasuredGeometry(
  nodes: readonly {
    width?: number
    height?: number
    measured?: { width?: number; height?: number }
  }[],
): boolean {
  return nodes.every(
    (node) =>
      (node.measured?.width ?? node.width ?? 0) > 0 &&
      (node.measured?.height ?? node.height ?? 0) > 0,
  )
}

/**
 * Initial camera policy: fit the whole graph only when that fit remains
 * readable. Complex graphs instead open on one stable business entry point.
 */
export function planInitialCanvasCamera(input: {
  allNodesFitZoom: number
  nodeIds: readonly string[]
  entryNodeIds: readonly string[]
  preferredNodeId?: string
}): InitialCanvasCameraPlan {
  if (input.nodeIds.length === 0) return { kind: 'none', mode: 'readable-focus' }
  if (input.allNodesFitZoom >= READABLE_MIN_ZOOM) {
    return {
      kind: 'fit-all',
      mode: 'readable-focus',
      maxZoom: READABLE_FIT_MAX_ZOOM,
    }
  }
  const nodeId = chooseCanvasFocalNode(input.nodeIds, input.entryNodeIds, input.preferredNodeId)
  return nodeId === null
    ? { kind: 'none', mode: 'readable-focus' }
    : {
        kind: 'focus-node',
        mode: 'readable-focus',
        nodeId,
        zoom: READABLE_FOCUS_ZOOM,
      }
}
