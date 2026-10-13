import type { MindmapNodeSummary } from './projection'

export interface MindmapOutlineRow {
  node: MindmapNodeSummary
  depth: number
  position: number
  siblings: number
  children: string[]
  parent: MindmapNodeSummary | undefined
  /** Visible ancestor rails only; bounded even when the actual tree is very deep. */
  guideDepths: number[]
}

/** A display index of the real tree. Appended follow-ups retain their parent and depth. */
export function indexMindmapNavigation(nodes: readonly MindmapNodeSummary[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const children = new Map<string | null, string[]>()
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node.id)
    children.set(node.parentId, siblings)
  }
  const rows: MindmapOutlineRow[] = []
  const stack = (children.get(null) ?? []).map((id) => ({
    id,
    depth: 0,
    position: 1,
    guideDepths: [] as number[],
  }))
  while (stack.length) {
    const { id, depth, position, guideDepths } = stack.pop()!
    const node = byId.get(id)!
    const childIds = children.get(id) ?? []
    const siblings = children.get(node.parentId)?.length ?? 1
    rows.push({
      node,
      depth,
      position,
      siblings,
      children: childIds,
      parent: node.parentId ? byId.get(node.parentId) : undefined,
      guideDepths,
    })
    const childGuides =
      depth > 1 && depth <= 5 && position < siblings ? [...guideDepths, depth - 1] : guideDepths
    for (let i = childIds.length - 1; i >= 0; i--)
      stack.push({ id: childIds[i]!, depth: depth + 1, position: i + 1, guideDepths: childGuides })
  }
  return { rows, byId, children, byRowId: new Map(rows.map((row) => [row.node.id, row])) }
}

export function mindmapAncestorPath(
  id: string,
  byId: ReadonlyMap<string, MindmapNodeSummary>,
): MindmapNodeSummary[] {
  const path: MindmapNodeSummary[] = []
  let node = byId.get(id)
  while (node?.parentId) {
    node = byId.get(node.parentId)
    if (node) path.push(node)
  }
  return path.reverse()
}

export function pendingMindmapDescendants(node: MindmapNodeSummary): number {
  return (
    node.counts.needs_detail +
    node.counts.needs_confirmation -
    (node.kind === 'question' && node.ownStatus !== 'done' ? 1 : 0)
  )
}
