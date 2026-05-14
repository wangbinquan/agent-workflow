// In-memory clipboard for canvas nodes (P-2-07).
//
// "Paste" assigns fresh ids by suffixing each original id with a counter,
// re-rooting edges between them so internal connections survive. Edges
// crossing into nodes outside the clipboard slice are dropped — they'd be
// ambiguous on paste.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { ulid } from 'ulid'

export interface ClipboardSlice {
  nodes: WorkflowNode[]
  /** Edges entirely inside the slice. */
  edges: WorkflowEdge[]
  /** Position used as the anchor — paste offsets from this point. */
  anchor: { x: number; y: number }
}

let buffer: ClipboardSlice | null = null

/** Replace the clipboard. Pass `null` to clear. */
export function setClipboard(slice: ClipboardSlice | null): void {
  buffer = slice
}

export function getClipboard(): ClipboardSlice | null {
  return buffer
}

/**
 * Build a ClipboardSlice from a workflow + a selection of node ids.
 * Computes the top-left as anchor; only keeps edges with both endpoints
 * inside the selection.
 */
export function buildSlice(
  def: WorkflowDefinition,
  selectedNodeIds: Iterable<string>,
): ClipboardSlice | null {
  const ids = new Set(selectedNodeIds)
  const nodes = def.nodes.filter((n) => ids.has(n.id))
  if (nodes.length === 0) return null
  const edges = def.edges.filter((e) => ids.has(e.source.nodeId) && ids.has(e.target.nodeId))
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const n of nodes) {
    const p = n.position ?? { x: 0, y: 0 }
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  if (!Number.isFinite(minX)) minX = 0
  if (!Number.isFinite(minY)) minY = 0
  return {
    nodes: nodes.map((n) => structuredClone(n)),
    edges: edges.map((e) => structuredClone(e)),
    anchor: { x: minX, y: minY },
  }
}

/**
 * Paste a slice into a definition at `at` (canvas coordinates).
 * Returns the new definition plus the ids of newly-inserted nodes so the
 * caller can update its selection.
 */
export function applyPaste(
  def: WorkflowDefinition,
  slice: ClipboardSlice,
  at: { x: number; y: number },
): { definition: WorkflowDefinition; newNodeIds: string[] } {
  const existing = new Set(def.nodes.map((n) => n.id))
  const idRewrite = new Map<string, string>()
  const dx = at.x - slice.anchor.x
  const dy = at.y - slice.anchor.y

  const newNodes: WorkflowNode[] = slice.nodes.map((n) => {
    const rebased: WorkflowNode = structuredClone(n)
    const newId = uniqueId(n.id, existing, idRewrite)
    idRewrite.set(n.id, newId)
    rebased.id = newId
    const pos = n.position ?? { x: 0, y: 0 }
    rebased.position = { x: Math.round(pos.x + dx), y: Math.round(pos.y + dy) }
    return rebased
  })

  const newEdges: WorkflowEdge[] = slice.edges.map((e) => ({
    id: `edge_${ulid().slice(-6).toLowerCase()}`,
    source: {
      nodeId: idRewrite.get(e.source.nodeId) ?? e.source.nodeId,
      portName: e.source.portName,
    },
    target: {
      nodeId: idRewrite.get(e.target.nodeId) ?? e.target.nodeId,
      portName: e.target.portName,
    },
  }))

  return {
    definition: {
      ...def,
      nodes: [...def.nodes, ...newNodes],
      edges: [...def.edges, ...newEdges],
    },
    newNodeIds: newNodes.map((n) => n.id),
  }
}

function uniqueId(base: string, existing: Set<string>, rewrites: Map<string, string>): string {
  let candidate = `${base}_copy`
  let i = 2
  // Avoid both the existing canvas ids and ids we already minted this paste.
  while (existing.has(candidate) || [...rewrites.values()].includes(candidate)) {
    candidate = `${base}_copy_${i++}`
  }
  return candidate
}

// Test helpers.
export const __testApplyPaste = applyPaste
export const __testBuildSlice = buildSlice
export const __testReset = (): void => {
  buffer = null
}
