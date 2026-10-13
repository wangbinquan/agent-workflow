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
export interface MindmapLayout {
  nodes: MindmapLayoutNode[]
  bounds: MindmapBounds
}
export type MindmapTopologyNode = Pick<MindmapNodeSummary, 'id' | 'parentId' | 'order'> &
  Partial<Pick<MindmapNodeSummary, 'kind'>>

export const MINDMAP_CARD_WIDTH = 236
export const MINDMAP_QUESTION_HEIGHT = 132
export const MINDMAP_GROUP_HEIGHT = 64

/** Iterative linear traversal: depth never consumes the JavaScript call stack. */
export function layoutMindmap(
  topology: readonly MindmapTopologyNode[],
  rootId: string,
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
    for (let index = siblings.length - 1; index >= 0; index--) {
      const child = siblings[index]!
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
  const widths = new Map<string, number>()
  // Reserve the entire subtree before positioning any sibling. Cards and hit areas
  // use the same dimensions, including long question previews and progress lines.
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index]!
    const siblings = children.get(node.id) ?? []
    widths.set(
      node.id,
      Math.max(
        node.width,
        siblings.reduce((sum, child) => sum + widths.get(child.id)!, 0) +
          Math.max(0, siblings.length - 1) * 32,
      ),
    )
  }
  for (const node of ordered) {
    let cursor = node.x - widths.get(node.id)! / 2
    for (const child of children.get(node.id) ?? []) {
      const point = positions.get(child.id)!
      const width = widths.get(child.id)!
      point.x = cursor + width / 2
      point.y = node.y + node.height / 2 + 28 + point.height / 2
      cursor += width + 32
    }
  }
  const bounds = { left: 0, top: 0, right: 0, bottom: 0 }
  for (const node of ordered) {
    bounds.left = Math.min(bounds.left, node.x - node.width / 2)
    bounds.right = Math.max(bounds.right, node.x + node.width / 2)
    bounds.top = Math.min(bounds.top, node.y - node.height / 2)
    bounds.bottom = Math.max(bounds.bottom, node.y + node.height / 2)
  }
  return { nodes: ordered, bounds }
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
