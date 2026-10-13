import type { MindmapNodeStatus, MindmapNodeSummary } from './projection'
import { pendingMindmapDescendants } from './navigation'
import { screenToWorld, worldToScreen, type MindmapCamera, type MindmapViewport } from './geometry'
import {
  MINDMAP_CARD_WIDTH,
  MINDMAP_QUESTION_HEIGHT,
  type indexMindmapLayout,
  type MindmapLayout,
  type MindmapLayoutNode,
} from './layout'

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
/** Wrapping operates on code points; only the final preview line is abbreviated. */
function previewLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  count: number,
): string[] {
  const chars = Array.from(text.replace(/\s+/g, ' '))
  const lines: string[] = []
  let offset = 0
  while (offset < chars.length && lines.length < count) {
    if (lines.length === count - 1) {
      lines.push(shorten(ctx, chars.slice(offset).join(''), width))
      break
    }
    let end = offset + 1
    while (
      end < chars.length &&
      ctx.measureText(chars.slice(offset, end + 1).join('')).width <= width
    )
      end++
    lines.push(chars.slice(offset, end).join(''))
    offset = end
  }
  return lines
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
const overlaps = (a: MindmapHit, b: MindmapHit) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

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
  labels?: {
    status: Record<MindmapNodeStatus, string>
    pending(count: number): string
    confirmed: string
  }
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
  const labels = input.labels ?? {
    status: { done: 'Confirmed', needs_detail: 'Needs detail', needs_confirmation: 'To confirm' },
    pending: (count: number) => `${count} follow-ups pending`,
    confirmed: 'confirmed',
  }
  ctx.clearRect(0, 0, viewport.width, viewport.height)
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, viewport.width, viewport.height)
  // Query centers with the same world-space dimensions used by layout and hit testing.
  const corner = screenToWorld({ x: 0, y: 0 }, camera)
  const end = screenToWorld({ x: viewport.width, y: viewport.height }, camera)
  const marginX = Math.max(MINDMAP_CARD_WIDTH / 2, 110 / camera.zoom)
  const marginY = Math.max(MINDMAP_QUESTION_HEIGHT / 2, 18 / camera.zoom)
  const visible = index.query({
    left: corner.x - marginX,
    top: corner.y - marginY,
    right: end.x + marginX,
    bottom: end.y + marginY,
  })
  const dim = (node: MindmapNodeSummary | undefined) =>
    highlightPending && node?.status === 'done' && node.id !== selectedId
  for (const item of layout.nodes) {
    if (!item.parentId) continue
    const parent = positions.get(item.parentId)
    if (!parent) continue
    const a = worldToScreen({ x: parent.x, y: parent.y + parent.height / 2 }, camera)
    const b = worldToScreen({ x: item.x, y: item.y - item.height / 2 }, camera)
    if (
      Math.max(a.x, b.x) < 0 ||
      Math.min(a.x, b.x) > viewport.width ||
      Math.max(a.y, b.y) < 0 ||
      Math.min(a.y, b.y) > viewport.height
    )
      continue
    const node = nodes.get(item.id)
    ctx.globalAlpha = dim(node) ? 0.16 : 0.5
    ctx.strokeStyle = palette.status[node?.status ?? 'needs_detail']
    ctx.lineWidth = item.id === selectedId ? 2 : 1.3
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.bezierCurveTo(a.x, (a.y + b.y) / 2, b.x, (a.y + b.y) / 2, b.x, b.y)
    ctx.stroke()
  }
  const hits: MindmapHit[] = []
  ctx.textBaseline = 'middle'
  if (camera.zoom >= 0.6) {
    for (const item of visible) {
      const node = nodes.get(item.id)
      if (!node) continue
      const { x, y } = worldToScreen(item, camera)
      const scale = camera.zoom,
        width = item.width * scale,
        height = item.height * scale
      const left = x - width / 2,
        top = y - height / 2,
        inset = 16 * scale
      const selected = item.id === selectedId
      ctx.globalAlpha = dim(node) ? 0.38 : 1
      ctx.fillStyle = palette.surface
      ctx.strokeStyle = selected ? palette.accent : palette.border
      ctx.lineWidth = selected ? 2 : 1
      ctx.beginPath()
      ctx.roundRect(left, top, width, height, 10 * scale)
      ctx.fill()
      ctx.stroke()
      const own = node.ownStatus ?? node.status
      ctx.fillStyle = palette.status[own]
      mark(ctx, own, left + inset, top + 19 * scale, 3.5 * scale)
      ctx.font = `500 ${14 * scale}px system-ui, sans-serif`
      if (node.kind === 'question')
        ctx.fillText(
          `Q${node.order + 1} · ${labels.status[own]}`,
          left + 26 * scale,
          top + 19 * scale,
        )
      ctx.font = `${node.kind === 'group' ? '600' : '500'} ${15 * scale}px system-ui, sans-serif`
      ctx.fillStyle = palette.text
      const lines = previewLines(
        ctx,
        node.title,
        width - inset * 2 - (node.kind === 'group' ? 10 * scale : 0),
        node.kind === 'question' ? 3 : 1,
      )
      lines.forEach((line, i) =>
        ctx.fillText(
          line,
          left + inset + (node.kind === 'group' ? 10 * scale : 0),
          top + (node.kind === 'group' ? 19 : 45 + i * 21) * scale,
        ),
      )
      ctx.font = `${12.5 * scale}px system-ui, sans-serif`
      ctx.fillStyle = palette.muted
      const pending = pendingMindmapDescendants(node)
      const total = node.counts.done + node.counts.needs_confirmation + node.counts.needs_detail
      const footer =
        node.kind === 'group'
          ? `${node.counts.done} / ${total} ${labels.confirmed}`
          : pending
            ? labels.pending(pending)
            : ''
      if (footer)
        ctx.fillText(
          shorten(ctx, footer, width - inset * 2),
          left + inset,
          top + height - 16 * scale,
        )
      hits.push({ id: node.id, left, top, right: left + width, bottom: top + height })
    }
  } else {
    // Overview preserves every status mark, with collision-free readable labels.
    const occupied = new Map<string, MindmapHit[]>()
    const candidates = [...visible].sort((a, b) =>
      a.id === selectedId ? -1 : b.id === selectedId ? 1 : a.depth - b.depth,
    )
    const previews: Array<{ item: MindmapLayoutNode; node: MindmapNodeSummary; rect: MindmapHit }> =
      []
    for (const item of candidates) {
      const node = nodes.get(item.id)
      if (!node) continue
      const { x, y } = worldToScreen(item, camera)
      ctx.globalAlpha = dim(node) ? 0.25 : 1
      ctx.fillStyle = palette.status[node.status]
      mark(ctx, node.status, x, y, camera.zoom < 0.2 ? 2 : 4)
      hits.push({ id: node.id, left: x - 6, top: y - 6, right: x + 6, bottom: y + 6 })
      if (camera.zoom < 0.12 && item.depth > 2 && item.id !== selectedId) continue
      ctx.font = '500 12px system-ui, sans-serif'
      const width = Math.max(
        40,
        Math.min(200, item.width * camera.zoom - 8, ctx.measureText(node.title).width + 28),
      )
      const rect = {
        id: node.id,
        left: x - width / 2,
        right: x + width / 2,
        top: y - 15,
        bottom: y + 15,
      }
      const keys: string[] = []
      for (let gx = Math.floor((rect.left - 4) / 64); gx <= Math.floor((rect.right + 4) / 64); gx++)
        for (
          let gy = Math.floor((rect.top - 4) / 32);
          gy <= Math.floor((rect.bottom + 4) / 32);
          gy++
        )
          keys.push(`${gx}:${gy}`)
      const padded = {
        ...rect,
        left: rect.left - 4,
        top: rect.top - 4,
        right: rect.right + 4,
        bottom: rect.bottom + 4,
      }
      if (keys.some((key) => occupied.get(key)?.some((other) => overlaps(padded, other)))) continue
      for (const key of keys) {
        const bucket = occupied.get(key) ?? []
        bucket.push(padded)
        occupied.set(key, bucket)
      }
      previews.push({ item, node, rect })
    }
    for (const { item, node, rect } of previews.reverse()) {
      ctx.globalAlpha = dim(node) ? 0.38 : 1
      ctx.fillStyle = palette.surface
      ctx.strokeStyle = item.id === selectedId ? palette.accent : palette.border
      ctx.lineWidth = item.id === selectedId ? 2 : 1
      ctx.beginPath()
      ctx.roundRect(rect.left, rect.top, rect.right - rect.left, 30, 6)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = palette.status[node.status]
      mark(ctx, node.status, rect.left + 10, rect.top + 15, 3)
      ctx.fillStyle = palette.text
      ctx.font = '500 12px system-ui, sans-serif'
      ctx.fillText(
        shorten(ctx, node.title, rect.right - rect.left - 28),
        rect.left + 20,
        rect.top + 15,
      )
      hits.push(rect)
    }
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
