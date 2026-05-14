// Thin xyflow wrapper that round-trips a WorkflowDefinition to/from the
// canvas. Pan/zoom/minimap/controls + Backspace/Delete remove the selection.
//
// Per-kind node components register via the `nodeTypes` prop (P-2-04).
// Each node receives a pre-computed `CanvasNodeData` so the renderer
// doesn't have to crawl the workflow definition or an agents lookup.

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
import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { AgentNode } from './nodes/AgentNode'
import { InputNode } from './nodes/InputNode'
import { OutputNode } from './nodes/OutputNode'
import type { CanvasNodeData } from './nodes/types'
import { GitWrapperNode, LoopWrapperNode } from './nodes/WrapperNodes'

const NODE_TYPES = {
  'agent-single': AgentNode,
  'agent-multi': AgentNode,
  input: InputNode,
  output: OutputNode,
  'wrapper-git': GitWrapperNode,
  'wrapper-loop': LoopWrapperNode,
}

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition
  /** Used to look up agent.outputs when rendering agent nodes. Optional. */
  agents?: Agent[]
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

function CanvasInner({ definition, agents, onChange, readOnly }: WorkflowCanvasProps) {
  const agentByName = useMemo(() => {
    const m = new Map<string, Agent>()
    for (const a of agents ?? []) m.set(a.name, a)
    return m
  }, [agents])

  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(definition, agentByName))
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(definition.edges))
  const externalDefRef = useRef(definition)

  useEffect(() => {
    if (definition !== externalDefRef.current) {
      externalDefRef.current = definition
      setNodes(toFlowNodes(definition, agentByName))
      setEdges(toFlowEdges(definition.edges))
    }
  }, [definition, agentByName])

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
        nodeTypes={NODE_TYPES}
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

const FALLBACK_X = (idx: number) => 80 + (idx % 4) * 280
const FALLBACK_Y = (idx: number) => 80 + Math.floor(idx / 4) * 200

interface PortInventory {
  inputs: string[]
  outputs: string[]
}

export function computePorts(
  node: WorkflowNode,
  agentByName: Map<string, Agent>,
  definition: WorkflowDefinition,
): PortInventory {
  const rec = node as unknown as Record<string, unknown>
  const inputs: string[] = []
  const outputs: string[] = []

  // Inputs derived from inbound edges (any target node) so users can see
  // which prompt vars / output ports are wired up on this node.
  for (const e of definition.edges) {
    if (e.target.nodeId === node.id && !inputs.includes(e.target.portName)) {
      inputs.push(e.target.portName)
    }
  }

  switch (node.kind) {
    case 'input': {
      const key = typeof rec.inputKey === 'string' ? rec.inputKey : 'out'
      outputs.push(key)
      break
    }
    case 'output': {
      const ports = Array.isArray(rec.ports) ? (rec.ports as Array<{ name?: unknown }>) : []
      for (const p of ports) {
        if (typeof p.name === 'string' && !inputs.includes(p.name)) inputs.push(p.name)
      }
      break
    }
    case 'agent-single':
    case 'agent-multi': {
      const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
      const agent = agentByName.get(agentName)
      for (const o of agent?.outputs ?? []) outputs.push(o)
      if (node.kind === 'agent-multi') outputs.push('errors')
      break
    }
    case 'wrapper-git':
      outputs.push('git_diff')
      break
    case 'wrapper-loop': {
      const bindings = Array.isArray(rec.outputBindings)
        ? (rec.outputBindings as Array<{ name?: unknown }>)
        : []
      for (const b of bindings) {
        if (typeof b.name === 'string') outputs.push(b.name)
      }
      break
    }
  }
  return { inputs, outputs }
}

function toFlowNodes(definition: WorkflowDefinition, agentByName: Map<string, Agent>): Node[] {
  return definition.nodes.map((n, idx) => {
    const pos = n.position
    const ports = computePorts(n, agentByName, definition)
    const data: CanvasNodeData = {
      nodeId: n.id,
      kind: n.kind,
      title: nodeTitle(n),
      inputPorts: ports.inputs,
      outputPorts: ports.outputs,
    }
    if (n.kind === 'wrapper-git' || n.kind === 'wrapper-loop') {
      const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
      ;(data as CanvasNodeData & { innerCount?: number }).innerCount = inner?.length ?? 0
    }
    return {
      id: n.id,
      type: n.kind,
      position:
        pos !== undefined ? { x: pos.x, y: pos.y } : { x: FALLBACK_X(idx), y: FALLBACK_Y(idx) },
      data,
    }
  })
}

function nodeTitle(n: WorkflowNode): string {
  const rec = n as unknown as Record<string, unknown>
  if (n.kind === 'agent-single' || n.kind === 'agent-multi') {
    return typeof rec.agentName === 'string' ? rec.agentName : '(unset agent)'
  }
  if (n.kind === 'input') {
    return typeof rec.inputKey === 'string' ? rec.inputKey : '(unset key)'
  }
  return n.id
}

function toFlowEdges(defEdges: WorkflowDefinition['edges']): Edge[] {
  return defEdges.map((e) => ({
    id: e.id,
    source: e.source.nodeId,
    target: e.target.nodeId,
    sourceHandle: e.source.portName,
    targetHandle: e.target.portName,
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
  const liveById = new Set(flowEdges.map((e) => e.id))
  const nextEdges: WorkflowEdge[] = keptEdges.filter((e) => liveById.has(e.id))

  return {
    ...prev,
    nodes: nextNodes,
    edges: nextEdges,
  }
}

// Test helpers (exported but underscored).
export const __testToFlowNodes = (
  defNodes: WorkflowDefinition['nodes'],
  agents: Agent[] = [],
  edges: WorkflowEdge[] = [],
): Node[] => {
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: defNodes,
    edges,
  }
  const map = new Map<string, Agent>()
  for (const a of agents) map.set(a.name, a)
  return toFlowNodes(def, map)
}
export const __testToFlowEdges = toFlowEdges
export const __testToDefinition = toDefinition
export const __testComputePorts = computePorts
