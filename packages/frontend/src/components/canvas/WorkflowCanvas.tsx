// Thin xyflow wrapper that round-trips a WorkflowDefinition to/from the
// canvas. Pan/zoom/minimap/controls + Backspace/Delete remove the selection.
// Per-kind custom node renderers land in P-2-04; for now every node uses the
// xyflow default (a labeled rectangle).

import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition
  onChange?: (next: WorkflowDefinition) => void
  readOnly?: boolean
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({ definition, onChange, readOnly }: WorkflowCanvasProps) {
  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(definition.nodes))
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(definition.edges))
  // Track whether we're the ones driving the state vs. a parent push.
  const externalDefRef = useRef(definition)

  useEffect(() => {
    // Parent pushed a fresh definition (e.g. after server save) — replace
    // nodes/edges. Position-only updates we originated shouldn't trigger
    // this branch because the parent debounces saves.
    if (definition !== externalDefRef.current) {
      externalDefRef.current = definition
      setNodes(toFlowNodes(definition.nodes))
      setEdges(toFlowEdges(definition.edges))
    }
  }, [definition])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => {
        const next = applyNodeChanges(changes, prev)
        if (!readOnly && onChange !== undefined) {
          const stillReferenced = new Set(next.map((n) => n.id))
          const liveEdges = edges.filter(
            (e) => stillReferenced.has(e.source) && stillReferenced.has(e.target),
          )
          if (liveEdges.length !== edges.length) setEdges(liveEdges)
          onChange(toDefinition(definition, next, liveEdges))
        }
        return next
      })
    },
    [definition, edges, onChange, readOnly],
  )

  const handleEdgesChange = useCallback(
    (changes: Array<{ type: string; id?: string }>) => {
      if (readOnly === true) return
      setEdges((prev) => {
        const removed = new Set(
          changes
            .filter((c) => c.type === 'remove' && typeof c.id === 'string')
            .map((c) => c.id as string),
        )
        if (removed.size === 0) return prev
        const next = prev.filter((e) => !removed.has(e.id))
        if (onChange !== undefined) onChange(toDefinition(definition, nodes, next))
        return next
      })
    },
    [definition, nodes, onChange, readOnly],
  )

  const deleteKeyCodes = useMemo(() => ['Backspace', 'Delete'], [])

  return (
    <div className="workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        nodesDraggable={readOnly !== true}
        edgesFocusable={readOnly !== true}
        nodesConnectable={false /* connection editor lands in P-2-07 */}
        deleteKeyCode={readOnly === true ? null : deleteKeyCodes}
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <Background />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// definition <-> xyflow shape translation
// ---------------------------------------------------------------------------

const FALLBACK_X = (idx: number) => 80 + (idx % 4) * 240
const FALLBACK_Y = (idx: number) => 80 + Math.floor(idx / 4) * 160

function toFlowNodes(defNodes: WorkflowDefinition['nodes']): Node[] {
  return defNodes.map((n, idx) => {
    const pos = n.position
    return {
      id: n.id,
      type: 'default',
      position:
        pos !== undefined ? { x: pos.x, y: pos.y } : { x: FALLBACK_X(idx), y: FALLBACK_Y(idx) },
      data: {
        label: nodeLabel(n),
        kind: n.kind,
      },
    }
  })
}

function nodeLabel(n: WorkflowNode): string {
  const rec = n as unknown as Record<string, unknown>
  if (n.kind === 'agent-single' || n.kind === 'agent-multi') {
    const an = typeof rec.agentName === 'string' ? rec.agentName : '?'
    return `${n.kind === 'agent-multi' ? '🔀 ' : ''}${an}\n${n.id}`
  }
  if (n.kind === 'input') {
    const k = typeof rec.inputKey === 'string' ? rec.inputKey : '?'
    return `↳ input\n${k}`
  }
  if (n.kind === 'output') return `⤴ output\n${n.id}`
  if (n.kind === 'wrapper-git') return `⎈ git wrapper\n${n.id}`
  if (n.kind === 'wrapper-loop') return `⟳ loop wrapper\n${n.id}`
  return `${n.kind}\n${n.id}`
}

function toFlowEdges(defEdges: WorkflowDefinition['edges']): Edge[] {
  return defEdges.map((e) => ({
    id: e.id,
    source: e.source.nodeId,
    target: e.target.nodeId,
    sourceHandle: e.source.portName,
    targetHandle: e.target.portName,
    label: `${e.source.portName} → ${e.target.portName}`,
  }))
}

function toDefinition(
  prev: WorkflowDefinition,
  flowNodes: Node[],
  flowEdges: Edge[],
): WorkflowDefinition {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = flowNodes
    .map((fn) => {
      const orig = prevById.get(fn.id)
      if (orig === undefined) return null
      const out: WorkflowNode = {
        ...orig,
        position: { x: Math.round(fn.position.x), y: Math.round(fn.position.y) },
      }
      return out
    })
    .filter((n): n is WorkflowNode => n !== null)

  const stillIds = new Set(nextNodes.map((n) => n.id))
  const keptEdges = prev.edges.filter(
    (e) => stillIds.has(e.source.nodeId) && stillIds.has(e.target.nodeId),
  )
  // Drop edges that xyflow removed.
  const liveById = new Set(flowEdges.map((e) => e.id))
  const nextEdges: WorkflowEdge[] = keptEdges.filter((e) => liveById.has(e.id))

  return {
    ...prev,
    nodes: nextNodes,
    edges: nextEdges,
  }
}

// Test helpers (exported but underscored).
export const __testToFlowNodes = toFlowNodes
export const __testToFlowEdges = toFlowEdges
export const __testToDefinition = toDefinition
