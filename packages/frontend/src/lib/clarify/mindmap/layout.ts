import type { MindmapNodeSummary } from './projection'
import type { MindmapBounds, MindmapPoint } from './geometry'

export interface MindmapLayoutNode extends MindmapPoint {
  id: string
  parentId: string | null
  depth: number
  side: -1 | 0 | 1
  width: number
  height: number
}
/** RFC-490: a parent whose children wrapped into several rows. The rows hang from
 *  one rail on the left; each row has its own bus the cards are tapped from. */
export interface MindmapLayoutBlock {
  parentId: string
  railX: number
  rows: { busY: number; childIds: string[] }[]
}
export interface MindmapLayout {
  nodes: MindmapLayoutNode[]
  blocks: MindmapLayoutBlock[]
  bounds: MindmapBounds
}
export type MindmapTopologyNode = Pick<MindmapNodeSummary, 'id' | 'parentId' | 'order'> &
  Partial<Pick<MindmapNodeSummary, 'kind'>>

export const MINDMAP_CARD_WIDTH = 236
export const MINDMAP_QUESTION_HEIGHT = 136
export const MINDMAP_GROUP_HEIGHT = 64
export const MINDMAP_COLUMN_GAP = 32
/** Parent to its first row, and one wrapped row to the next. */
export const MINDMAP_LEVEL_GAP = 28
export const MINDMAP_RAIL_INSET = 20
export const MINDMAP_BUS_RISE = 12
export const MINDMAP_READABLE_ZOOM = 0.85
export const MINDMAP_DEFAULT_COLUMNS = 3
export const MINDMAP_MAX_COLUMNS = 5

/** Two nested wrapped levels fit beside a full row; deeper ones narrow their rows. */
const MINDMAP_RAIL_RESERVE = MINDMAP_RAIL_INSET * 2

/** RFC-490: how many cards fit side by side at the readable scale in a stage this
 *  wide. Wider rows wrap, so reading never needs a horizontal pan. */
export function mindmapColumns(stageWidth: number): number {
  if (!(stageWidth > 0)) return MINDMAP_DEFAULT_COLUMNS
  const world = stageWidth / MINDMAP_READABLE_ZOOM - 48 - MINDMAP_RAIL_RESERVE
  return Math.max(
    1,
    Math.min(
      MINDMAP_MAX_COLUMNS,
      Math.floor((world + MINDMAP_COLUMN_GAP) / (MINDMAP_CARD_WIDTH + MINDMAP_COLUMN_GAP)),
    ),
  )
}

/** The widest a whole map gets while every level still has room for a card. */
export function mindmapRootWidth(columns: number): number {
  return (
    Math.max(1, Math.floor(columns)) * (MINDMAP_CARD_WIDTH + MINDMAP_COLUMN_GAP) -
    MINDMAP_COLUMN_GAP +
    MINDMAP_RAIL_RESERVE
  )
}

/** Iterative linear traversal: depth never consumes the JavaScript call stack. */
export function layoutMindmap(
  topology: readonly MindmapTopologyNode[],
  rootId: string,
  columns = MINDMAP_DEFAULT_COLUMNS,
): MindmapLayout {
  const byId = new Map(topology.map((node) => [node.id, node]))
  if (byId.size !== topology.length || !byId.has(rootId))
    throw new Error('mindmap-topology-invalid')
  const children = new Map<string, MindmapTopologyNode[]>()
  for (const node of topology) {
    if (node.id === rootId) {
      if (node.parentId !== null) throw new Error('mindmap-root-parent-invalid')
      continue
    }
    if (node.parentId === null || !byId.has(node.parentId))
      throw new Error('mindmap-parent-missing')
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const ordered: MindmapLayoutNode[] = []
  const visited = new Set<string>()
  // Width handed down the tree: a parent that may wrap keeps a rail's worth for itself,
  // so a wrapped block never grows wider than what its own parent set aside for it.
  const available = new Map<string, number>([[rootId, mindmapRootWidth(columns)]])
  const stack: MindmapLayoutNode[] = [
    {
      id: rootId,
      parentId: null,
      depth: 0,
      side: 0,
      x: 0,
      y: 0,
      width: MINDMAP_CARD_WIDTH,
      height: MINDMAP_GROUP_HEIGHT,
    },
  ]
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node.id)) throw new Error('mindmap-topology-cycle')
    visited.add(node.id)
    ordered.push(node)
    const siblings = children.get(node.id) ?? []
    const room = available.get(node.id)!
    const share =
      siblings.length > 1 ? Math.max(MINDMAP_CARD_WIDTH, room - MINDMAP_RAIL_INSET) : room
    for (let index = siblings.length - 1; index >= 0; index--) {
      const child = siblings[index]!
      available.set(child.id, share)
      stack.push({
        id: child.id,
        parentId: node.id,
        depth: node.depth + 1,
        side: 0,
        width: MINDMAP_CARD_WIDTH,
        height: child.kind === 'question' ? MINDMAP_QUESTION_HEIGHT : MINDMAP_GROUP_HEIGHT,
        x: 0,
        y: 0,
      })
    }
  }
  if (visited.size !== topology.length) throw new Error('mindmap-topology-disconnected')
  const positions = new Map(ordered.map((node) => [node.id, node]))
  interface Extent {
    /** The node with everything under it. */
    width: number
    height: number
    rows: { ids: string[]; width: number; height: number }[]
    blockWidth: number
  }
  const extents = new Map<string, Extent>()
  // Children first. Everything on one row when it fits; otherwise rows are filled until
  // the next whole subtree would pass the room left beside the rail.
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index]!
    const siblings = children.get(node.id) ?? []
    const room = available.get(node.id)!
    let single = -MINDMAP_COLUMN_GAP
    for (const child of siblings) single += MINDMAP_COLUMN_GAP + extents.get(child.id)!.width
    const limit = single <= room ? Infinity : room - MINDMAP_RAIL_INSET
    const rows: Extent['rows'] = []
    let row: Extent['rows'][number] | null = null
    for (const child of siblings) {
      const extent = extents.get(child.id)!
      if (row && row.width + MINDMAP_COLUMN_GAP + extent.width > limit) {
        rows.push(row)
        row = null
      }
      if (row) {
        row.ids.push(child.id)
        row.width += MINDMAP_COLUMN_GAP + extent.width
        row.height = Math.max(row.height, extent.height)
      } else row = { ids: [child.id], width: extent.width, height: extent.height }
    }
    if (row) rows.push(row)
    let widest = 0
    let below = 0
    for (const item of rows) {
      widest = Math.max(widest, item.width)
      below += item.height + MINDMAP_LEVEL_GAP
    }
    const blockWidth = rows.length > 1 ? widest + MINDMAP_RAIL_INSET : widest
    extents.set(node.id, {
      width: Math.max(node.width, blockWidth),
      height: node.height + below,
      rows,
      blockWidth,
    })
  }
  const blocks: MindmapLayoutBlock[] = []
  const bounds = { left: 0, top: 0, right: 0, bottom: 0 }
  for (const node of ordered) {
    const extent = extents.get(node.id)!
    bounds.left = Math.min(bounds.left, node.x - node.width / 2)
    bounds.right = Math.max(bounds.right, node.x + node.width / 2)
    bounds.top = Math.min(bounds.top, node.y - node.height / 2)
    bounds.bottom = Math.max(bounds.bottom, node.y + node.height / 2)
    if (!extent.rows.length) continue
    const wrapped = extent.rows.length > 1
    const blockLeft = node.x - extent.blockWidth / 2
    const block: MindmapLayoutBlock | null = wrapped
      ? { parentId: node.id, railX: blockLeft + 6, rows: [] }
      : null
    let top = node.y + node.height / 2 + MINDMAP_LEVEL_GAP
    for (const row of extent.rows) {
      // One row keeps the familiar centred fan; wrapped rows share a left edge.
      let cursor = wrapped ? blockLeft + MINDMAP_RAIL_INSET : node.x - row.width / 2
      for (const id of row.ids) {
        const point = positions.get(id)!
        const width = extents.get(id)!.width
        point.x = cursor + width / 2
        point.y = top + point.height / 2
        cursor += width + MINDMAP_COLUMN_GAP
      }
      block?.rows.push({ busY: top - MINDMAP_BUS_RISE, childIds: row.ids })
      top += row.height + MINDMAP_LEVEL_GAP
    }
    if (block) {
      blocks.push(block)
      bounds.left = Math.min(bounds.left, block.railX - 2)
    }
  }
  return { nodes: ordered, blocks, bounds }
}

/** Buckets make visible-point lookup independent of the total node count. */
export function indexMindmapLayout(layout: MindmapLayout) {
  const size = 256
  const buckets = new Map<string, MindmapLayoutNode[]>()
  for (const node of layout.nodes) {
    const key = `${Math.floor(node.x / size)}:${Math.floor(node.y / size)}`
    const bucket = buckets.get(key) ?? []
    bucket.push(node)
    buckets.set(key, bucket)
  }
  return {
    query(bounds: MindmapBounds): MindmapLayoutNode[] {
      const x0 = Math.floor(bounds.left / size),
        x1 = Math.floor(bounds.right / size)
      const y0 = Math.floor(bounds.top / size),
        y1 = Math.floor(bounds.bottom / size)
      // At overview scale scanning occupied buckets is cheaper than millions of empty cells.
      const candidates =
        (x1 - x0 + 1) * (y1 - y0 + 1) > buckets.size * 2
          ? layout.nodes
          : (() => {
              const found: MindmapLayoutNode[] = []
              for (let x = x0; x <= x1; x++)
                for (let y = y0; y <= y1; y++) found.push(...(buckets.get(`${x}:${y}`) ?? []))
              return found
            })()
      return candidates.filter(
        (node) =>
          node.x >= bounds.left &&
          node.x <= bounds.right &&
          node.y >= bounds.top &&
          node.y <= bounds.bottom,
      )
    },
  }
}
