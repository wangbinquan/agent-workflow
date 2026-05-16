// RFC-015 — fanout (agent-multi) node `sourcePort` drag-to-set helpers.
//
// `agent-multi.sourcePort = {nodeId, portName}` is an independent top-level
// field on the node (NOT an edge in `definition.edges[]`). scheduler reads
// it directly (packages/backend/src/services/scheduler.ts:737), and the dep
// graph synthesises a `sourcePort.nodeId → multi-node` dependency at :1320.
// The validator's `agent-multi-source-port-missing` rule checks the field,
// not edges.
//
// Pre-RFC-015 the only way to set this field was the inspector's two stacked
// dropdowns. The canvas had no entry point — RFC-003 catch-all drops all
// land on `__inbound__` and append to `edges[]`, never touching sourcePort.
// This RFC adds a dedicated top-side target Handle (`__multi_source_port__`,
// rendered by AgentNode on the fanout branch) and routes its drops through
// {@link applySourcePortConnection} below, which writes the field and
// returns early without touching edges.
//
// Three entry points feed in (mirroring connectionSync.ts conventions):
//   1. WorkflowCanvas.handleConnect    → applySourcePortConnection (top handle fast-path)
//   2. WorkflowCanvas.handleNodesChange→ clearSourcePortOnNodeRemoved (cascade clear)
//   3. WorkflowCanvas.isValidConnection→ isValidSourcePortConnection (drop guards)
//
// Two-way sync with NodeInspector is NOT needed: the form binds directly to
// node.sourcePort and re-renders on definition updates.
//
// All exports are pure functions; they return the input definition by
// reference when nothing changes so upstream React effects can short-circuit
// on `===`. Same trick as RFC-007 connectionSync + RFC-004 healLoadedDefinition.

import type { Connection, Edge } from '@xyflow/react'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

/**
 * Stable handle id for the agent-multi node's top-side sourcePort target
 * Handle. Distinct from RFC-003's `__inbound__` (left catch-all) and
 * RFC-007's `__review_input__` so the three drop targets never collide in
 * `handleConnect`'s fast-path discrimination.
 */
export const MULTI_SOURCE_PORT_HANDLE_ID = '__multi_source_port__'

/**
 * Prefix for synthetic xyflow Edge ids that represent a fanout node's
 * sourcePort visually on the canvas. These edges are NOT persisted in
 * `definition.edges[]`; they're added to the render layer only so the
 * user can see which upstream port currently feeds the multi-process
 * sharding. `toDefinition` filters edges by id against `prev.edges`,
 * so synthetic ids naturally drop out of round-tripping.
 */
export const SOURCE_PORT_EDGE_ID_PREFIX = '__sp__:'

type SourcePortRef = { nodeId: string; portName: string }
const EMPTY_SOURCE_PORT: SourcePortRef = { nodeId: '', portName: '' }

function readSourcePort(node: WorkflowNode): SourcePortRef | undefined {
  const sp = (node as Record<string, unknown>).sourcePort
  if (sp === null || typeof sp !== 'object') return undefined
  const rec = sp as Record<string, unknown>
  const nodeId = typeof rec.nodeId === 'string' ? rec.nodeId : ''
  const portName = typeof rec.portName === 'string' ? rec.portName : ''
  return { nodeId, portName }
}

function withSourcePort(node: WorkflowNode, sp: SourcePortRef): WorkflowNode {
  return { ...(node as object), sourcePort: sp } as unknown as WorkflowNode
}

/**
 * Top-handle drop → write `node.sourcePort` and return a new definition.
 * Non-top-handle drops, drops on a non-fanout target, or drops that don't
 * actually change the field all return the passed-in `def` by reference so
 * callers can fall through to the RFC-003/RFC-007 edge-creation path
 * (and skip the redundant commit, respectively).
 *
 * Replacement semantics: if the target node already has a sourcePort, it
 * is silently overwritten — the user dragging a fresh line IS the explicit
 * "I want to change the source" signal. No confirmation, no toast.
 */
export function applySourcePortConnection(
  def: WorkflowDefinition,
  conn: Connection,
): WorkflowDefinition {
  if (conn.targetHandle !== MULTI_SOURCE_PORT_HANDLE_ID) return def
  if (conn.source === null || conn.target === null) return def
  if (conn.sourceHandle === null) return def
  const idx = def.nodes.findIndex((n) => n.id === conn.target)
  if (idx === -1) return def
  const targetNode = def.nodes[idx]
  if (targetNode === undefined || targetNode.kind !== 'agent-multi') return def
  const cur = readSourcePort(targetNode)
  if (cur !== undefined && cur.nodeId === conn.source && cur.portName === conn.sourceHandle) {
    return def
  }
  const nextNode = withSourcePort(targetNode, {
    nodeId: conn.source,
    portName: conn.sourceHandle,
  })
  const nextNodes = [...def.nodes]
  nextNodes[idx] = nextNode
  return { ...def, nodes: nextNodes }
}

/**
 * Called from `handleNodesChange` after a remove change is applied: any
 * agent-multi node whose `sourcePort.nodeId` was in `removed` gets its
 * field reset to the empty ref so the validator's missing-source rule
 * fires immediately and the inspector dropdowns show "未选择". Returns
 * `def` by reference if no fanout node was affected.
 */
export function clearSourcePortOnNodeRemoved(
  def: WorkflowDefinition,
  removed: ReadonlyArray<string>,
): WorkflowDefinition {
  if (removed.length === 0) return def
  const removedSet = new Set(removed)
  let changed = false
  const nextNodes = def.nodes.map((n) => {
    if (n.kind !== 'agent-multi') return n
    const sp = readSourcePort(n)
    if (sp === undefined || sp.nodeId === '' || !removedSet.has(sp.nodeId)) return n
    changed = true
    return withSourcePort(n, EMPTY_SOURCE_PORT)
  })
  return changed ? { ...def, nodes: nextNodes } : def
}

/**
 * Pure validity check used by xyflow's `isValidConnection` before a top-handle
 * drop materialises. Rejects:
 *   - target node not found / not agent-multi
 *   - source === target (self-loop on fanout)
 *   - source node not found in the current definition
 *
 * Non-top-handle drops return `true` (pass-through, not our concern). The
 * caller still chains RFC-007's iterate lock; the two guards are
 * independent.
 *
 * Deliberately does NOT check that the source port kind is markdown/markdown_file
 * — scheduler doesn't require it, and adding an editor-side gate that the
 * validator doesn't enforce would create a UX/validator divergence trap.
 */
export function isValidSourcePortConnection(
  def: WorkflowDefinition,
  conn: { source: string | null; target: string | null; targetHandle: string | null },
): boolean {
  if (conn.targetHandle !== MULTI_SOURCE_PORT_HANDLE_ID) return true
  if (conn.source === null || conn.target === null) return false
  if (conn.source === conn.target) return false
  const target = def.nodes.find((n) => n.id === conn.target)
  if (target === undefined || target.kind !== 'agent-multi') return false
  const source = def.nodes.find((n) => n.id === conn.source)
  if (source === undefined) return false
  return true
}

/**
 * Build a list of synthetic xyflow Edges that visually connect each
 * agent-multi node's sourcePort upstream port to its top-side handle.
 * The user asked for a visible line so they can spot the sharding source
 * on the canvas without opening the inspector.
 *
 * Contract: synthetic edges are render-only.
 *  - id prefix `__sp__:<targetNodeId>` keeps them out of `toDefinition`'s
 *    `liveById` filter (no matching entry in `prev.edges` ever).
 *  - `selectable: false` + `deletable: false` prevents the user from
 *    accidentally trying to delete a line that has no persisted backing;
 *    to "remove" the connection they drag a fresh source onto the top
 *    handle (replace) or clear the inspector field.
 *  - `data.synthetic = 'sourcePort'` lets future logic discriminate.
 *  - dashed accent style differentiates from real persisted edges.
 *
 * Only emits an edge when both endpoints exist in `def.nodes` so xyflow
 * doesn't log a "handle not found" warning when the user clears one half
 * (validator 'agent-multi-source-port-missing' already surfaces the
 * misconfiguration in the inspector).
 */
export function buildSourcePortDisplayEdges(def: WorkflowDefinition): Edge[] {
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]))
  const out: Edge[] = []
  for (const n of def.nodes) {
    if (n.kind !== 'agent-multi') continue
    const sp = readSourcePort(n)
    if (sp === undefined || sp.nodeId === '' || sp.portName === '') continue
    if (!nodesById.has(sp.nodeId)) continue
    out.push({
      id: `${SOURCE_PORT_EDGE_ID_PREFIX}${n.id}`,
      source: sp.nodeId,
      sourceHandle: sp.portName,
      target: n.id,
      targetHandle: MULTI_SOURCE_PORT_HANDLE_ID,
      style: { stroke: 'var(--accent)', strokeDasharray: '4 4', strokeWidth: 1.5 },
      selectable: false,
      deletable: false,
      focusable: false,
      data: { synthetic: 'sourcePort' },
    })
  }
  return out
}
