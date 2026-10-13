/** RFC-372: camera operations never change selection or design facts. */
export interface MindmapPoint {
  x: number
  y: number
}
export interface MindmapViewport {
  width: number
  height: number
}
export interface MindmapCamera extends MindmapPoint {
  zoom: number
}
export interface MindmapBounds {
  left: number
  top: number
  right: number
  bottom: number
}
export const MINDMAP_MAX_ZOOM = 2.5
export const MINDMAP_DRAG_THRESHOLD = 5

export function worldToScreen(point: MindmapPoint, camera: MindmapCamera): MindmapPoint {
  return { x: point.x * camera.zoom + camera.x, y: point.y * camera.zoom + camera.y }
}
export function screenToWorld(point: MindmapPoint, camera: MindmapCamera): MindmapPoint {
  return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom }
}
export function fitMindmap(bounds: MindmapBounds, viewport: MindmapViewport): MindmapCamera {
  const zoom = Math.min(
    1,
    Math.max(1, viewport.width - 96) / Math.max(1, bounds.right - bounds.left),
    Math.max(1, viewport.height - 96) / Math.max(1, bounds.bottom - bounds.top),
  )
  return {
    zoom,
    x: viewport.width / 2 - ((bounds.left + bounds.right) * zoom) / 2,
    y: viewport.height / 2 - ((bounds.top + bounds.bottom) * zoom) / 2,
  }
}
/** A whole graph can be arbitrarily wide/deep. Initial reading never shrinks text
 * below the readable card scale; the explicit overview control still fits all. */
export function readableMindmapCamera(
  bounds: MindmapBounds,
  viewport: MindmapViewport,
): MindmapCamera {
  const fit = fitMindmap(bounds, viewport)
  return fit.zoom >= 0.8 ? fit : { zoom: 0.85, x: viewport.width / 2, y: 64 }
}
export function zoomMindmapAt(
  camera: MindmapCamera,
  anchor: MindmapPoint,
  factor: number,
  minimum: number,
): MindmapCamera {
  if (!Number.isFinite(factor) || factor <= 0) return camera
  const world = screenToWorld(anchor, camera)
  const zoom = Math.min(MINDMAP_MAX_ZOOM, Math.max(minimum, camera.zoom * factor))
  return { zoom, x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom }
}
export function revealMindmapPoint(
  camera: MindmapCamera,
  point: MindmapPoint,
  viewport: MindmapViewport,
): MindmapCamera {
  const screen = worldToScreen(point, camera)
  const marginX = Math.min(140, viewport.width / 3)
  const marginY = Math.min(70, viewport.height / 3)
  if (
    screen.x >= marginX &&
    screen.x <= viewport.width - marginX &&
    screen.y >= marginY &&
    screen.y <= viewport.height - marginY
  )
    return camera
  return {
    ...camera,
    x: viewport.width / 2 - point.x * camera.zoom,
    y: viewport.height / 2 - point.y * camera.zoom,
  }
}
export function resizeMindmapCamera(
  camera: MindmapCamera,
  previous: MindmapViewport,
  next: MindmapViewport,
): MindmapCamera {
  return {
    ...camera,
    x: camera.x + (next.width - previous.width) / 2,
    y: camera.y + (next.height - previous.height) / 2,
  }
}
export function preserveMindmapAnchor(
  camera: MindmapCamera,
  before: MindmapPoint | undefined,
  after: MindmapPoint | undefined,
): MindmapCamera {
  return before && after
    ? {
        ...camera,
        x: camera.x + (before.x - after.x) * camera.zoom,
        y: camera.y + (before.y - after.y) * camera.zoom,
      }
    : camera
}

export interface MindmapPointerGesture {
  pointerId: number
  origin: MindmapPoint
  last: MindmapPoint
  nodeId: string | null
  pan: boolean
  dragged: boolean
}
export function moveMindmapGesture(
  gesture: MindmapPointerGesture,
  point: MindmapPoint,
): {
  gesture: MindmapPointerGesture
  delta: MindmapPoint
} {
  const dragged =
    gesture.dragged ||
    Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y) >= MINDMAP_DRAG_THRESHOLD
  return {
    gesture: { ...gesture, last: point, dragged },
    delta:
      dragged && gesture.pan
        ? { x: point.x - gesture.last.x, y: point.y - gesture.last.y }
        : { x: 0, y: 0 },
  }
}
