import type { MindmapNodeSummary } from './projection'
import type { MindmapBounds, MindmapPoint } from './geometry'

export interface MindmapLayoutNode extends MindmapPoint {
  id: string
  parentId: string | null
  depth: number
  side: -1 | 0 | 1
}
export interface MindmapLayout {
  nodes: MindmapLayoutNode[]
  bounds: MindmapBounds
}
export type MindmapTopologyNode = Pick<MindmapNodeSummary, 'id' | 'parentId' | 'order'>

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
  const stack: MindmapLayoutNode[] = [{ id: rootId, parentId: null, depth: 0, side: 0, x: 0, y: 0 }]
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node.id)) throw new Error('mindmap-topology-cycle')
    visited.add(node.id)
    ordered.push(node)
    const siblings = children.get(node.id) ?? []
    for (let index = siblings.length - 1; index >= 0; index--) {
      const child = siblings[index]!
      const side = node.side || (index % 2 === 0 ? 1 : -1)
      stack.push({
        id: child.id,
        parentId: node.id,
        depth: node.depth + 1,
        side,
        x: side * (node.depth + 1) * 240,
        y: 0,
      })
    }
  }
  if (visited.size !== topology.length) throw new Error('mindmap-topology-disconnected')
  const positions = new Map(ordered.map((node) => [node.id, node]))
  const cursors = { '-1': 0, '0': 0, '1': 0 }
  // Postorder places parents midway between their children; sibling order remains stable.
  for (let index = ordered.length - 1; index >= 1; index--) {
    const node = ordered[index]!
    const siblings = children.get(node.id) ?? []
    if (siblings.length) {
      node.y =
        (positions.get(siblings[0]!.id)!.y + positions.get(siblings[siblings.length - 1]!.id)!.y) /
        2
    } else {
      node.y = cursors[node.side]
      cursors[node.side] += 48
    }
  }
  for (const node of ordered) {
    if (node.side) node.y = Math.max(0, cursors[node.side] - 48) / 2 - node.y
  }
  const bounds = { left: -100, top: -28, right: 100, bottom: 28 }
  for (const node of ordered) {
    bounds.left = Math.min(bounds.left, node.x - 100)
    bounds.right = Math.max(bounds.right, node.x + 100)
    bounds.top = Math.min(bounds.top, node.y - 24)
    bounds.bottom = Math.max(bounds.bottom, node.y + 24)
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
