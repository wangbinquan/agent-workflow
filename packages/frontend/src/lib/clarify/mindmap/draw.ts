import type { MindmapNodeStatus, MindmapNodeSummary } from './projection'
import { screenToWorld, worldToScreen, type MindmapCamera, type MindmapViewport } from './geometry'
import type { indexMindmapLayout } from './layout'
import { type MindmapLayout, type MindmapLayoutNode } from './layout'

export interface MindmapPalette {
  background: string
  surface: string
  text: string
  muted: string
  border: string
  accent: string
  status: Record<MindmapNodeStatus, string>
}
export interface MindmapHit {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}
export interface MindmapDrawing {
  hits: MindmapHit[]
  visible: number
}

function shorten(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  const chars = Array.from(text)
  let low = 0,
    high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= width) low = mid
    else high = mid - 1
  }
  return chars.slice(0, low).join('') + '…'
}
function mark(
  ctx: CanvasRenderingContext2D,
  status: MindmapNodeStatus,
  x: number,
  y: number,
  size: number,
) {
  ctx.beginPath()
  if (status === 'needs_detail') {
    ctx.moveTo(x, y - size)
    ctx.lineTo(x + size, y)
    ctx.lineTo(x, y + size)
    ctx.lineTo(x - size, y)
    ctx.closePath()
  } else if (status === 'needs_confirmation') ctx.rect(x - size, y - size, size * 2, size * 2)
  else ctx.arc(x, y, size, 0, Math.PI * 2)
  ctx.fill()
}

export function drawMindmap(input: {
  ctx: CanvasRenderingContext2D
  viewport: MindmapViewport
  camera: MindmapCamera
  layout: MindmapLayout
  index: ReturnType<typeof indexMindmapLayout>
  positions: ReadonlyMap<string, MindmapLayoutNode>
  nodes: ReadonlyMap<string, MindmapNodeSummary>
  selectedId: string | null
  highlightPending: boolean
  palette: MindmapPalette
}): MindmapDrawing {
  const {
    ctx,
    viewport,
    camera,
    layout,
    index,
    positions,
    nodes,
    selectedId,
    highlightPending,
    palette,
  } = input
  ctx.clearRect(0, 0, viewport.width, viewport.height)
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, viewport.width, viewport.height)
  const corner = screenToWorld({ x: -220, y: -60 }, camera)
  const end = screenToWorld({ x: viewport.width + 220, y: viewport.height + 60 }, camera)
  const visible = index.query({ left: corner.x, top: corner.y, right: end.x, bottom: end.y })
  const dim = (node: MindmapNodeSummary | undefined) =>
    highlightPending && node?.status === 'done' && node.id !== selectedId
  // Edges crossing the viewport must still appear when both endpoints are off screen.
  for (const item of layout.nodes) {
    if (!item.parentId) continue
    const parent = positions.get(item.parentId)
    if (!parent) continue
    const a = worldToScreen(parent, camera),
      b = worldToScreen(item, camera)
    if (
      Math.max(a.x, b.x) < 0 ||
      Math.min(a.x, b.x) > viewport.width ||
      Math.max(a.y, b.y) < 0 ||
      Math.min(a.y, b.y) > viewport.height
    )
      continue
    const node = nodes.get(item.id)
    ctx.globalAlpha = dim(node) ? 0.12 : 0.4
    ctx.strokeStyle = palette.status[node?.status ?? 'needs_detail']
    ctx.lineWidth = item.id === selectedId ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.bezierCurveTo((a.x + b.x) / 2, a.y, (a.x + b.x) / 2, b.y, b.x, b.y)
    ctx.stroke()
  }
  const hits: MindmapHit[] = []
  const occupied = new Map<string, MindmapHit[]>()
  const candidates = [...visible].sort((a, b) => {
    if (a.id === selectedId) return -1
    if (b.id === selectedId) return 1
    if (a.depth !== b.depth) return a.depth - b.depth
    const ap = nodes.get(a.id)?.status === 'done' ? 1 : 0
    const bp = nodes.get(b.id)?.status === 'done' ? 1 : 0
    return ap - bp
  })
  const labels: Array<{
    item: MindmapLayoutNode
    node: MindmapNodeSummary
    x: number
    y: number
    width: number
  }> = []
  for (const item of candidates) {
    const node = nodes.get(item.id)
    if (!node) continue
    const { x, y } = worldToScreen(item, camera)
    const color = palette.status[node.status]
    ctx.globalAlpha = dim(node) ? 0.22 : 1
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineWidth = 1.8
    const radius = camera.zoom < 0.2 ? 2 : 3.5
    mark(ctx, node.status, x, y, radius)
    hits.push({ id: item.id, left: x - 8, right: x + 8, top: y - 8, bottom: y + 8 })
    const primary = item.depth <= 1 || item.id === selectedId
    ctx.font = `${primary ? '600 ' : ''}12px system-ui, sans-serif`
    const width = Math.min(
      item.id === selectedId ? 196 : Math.max(72, Math.min(196, 240 * camera.zoom - 20)),
      Math.max(60, ctx.measureText(node.title).width + 28),
    )
    const left = x - width / 2,
      top = y - 14
    const rect = {
      id: item.id,
      left: left - 4,
      top: top - 3,
      right: left + width + 4,
      bottom: top + 31,
    }
    const keys: string[] = []
    for (let gx = Math.floor((left - 4) / 24); gx <= Math.floor((left + width + 4) / 24); gx++) {
      for (let gy = Math.floor((top - 3) / 16); gy <= Math.floor((top + 29) / 16); gy++)
        keys.push(`${gx}:${gy}`)
    }
    if (
      item.id !== selectedId &&
      (keys.some((key) =>
        occupied
          .get(key)
          ?.some(
            (other) =>
              rect.left < other.right &&
              rect.right > other.left &&
              rect.top < other.bottom &&
              rect.bottom > other.top,
          ),
      ) ||
        (camera.zoom < 0.12 && item.depth > 2 && node.status === 'done'))
    )
      continue
    for (const key of keys) {
      const entries = occupied.get(key) ?? []
      entries.push(rect)
      occupied.set(key, entries)
    }
    labels.push({ item, node, x, y, width })
  }
  // Labels are above all marks/edges; selected labels draw last and stay readable.
  for (const { item, node, x, y, width } of labels.reverse()) {
    const selected = item.id === selectedId
    const left = x - width / 2
    ctx.globalAlpha = dim(node) ? 0.3 : 1
    ctx.fillStyle = palette.surface
    ctx.strokeStyle = selected ? palette.accent : palette.border
    ctx.lineWidth = selected ? 2 : 1
    ctx.beginPath()
    ctx.roundRect(left, y - 14, width, 28, 6)
    ctx.fill()
    if (selected || item.depth <= 1) ctx.stroke()
    ctx.fillStyle = palette.status[node.status]
    ctx.strokeStyle = palette.status[node.status]
    mark(ctx, node.status, left + 10, y, 3)
    ctx.font = `${item.depth <= 1 || selected ? '600 ' : ''}12px system-ui, sans-serif`
    ctx.fillStyle = palette.text
    ctx.textBaseline = 'middle'
    ctx.fillText(shorten(ctx, node.title, width - 26), left + 20, y)
    hits.push({ id: item.id, left, top: y - 14, right: left + width, bottom: y + 14 })
  }
  ctx.globalAlpha = 1
  return { hits, visible: visible.length }
}

export function hitMindmap(hits: readonly MindmapHit[], x: number, y: number): string | null {
  for (let index = hits.length - 1; index >= 0; index--) {
    const hit = hits[index]!
    if (x >= hit.left && x <= hit.right && y >= hit.top && y <= hit.bottom) return hit.id
  }
  return null
}
