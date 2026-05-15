// Thin xyflow wrapper that round-trips a WorkflowDefinition to/from the
// canvas. Pan/zoom/minimap/controls + Backspace/Delete remove the selection.
//
// Per-kind node components register via the `nodeTypes` prop (P-2-04).
// Each node receives a pre-computed `CanvasNodeData` so the renderer
// doesn't have to crawl the workflow definition or an agents lookup.

import {
  Background,
  type Connection,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { AgentNode } from './nodes/AgentNode'
import { applyPaste, buildSlice, getClipboard, setClipboard } from './canvasClipboard'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { InputNode } from './nodes/InputNode'
import { deserialize, makeNode, PALETTE_MIME } from './nodePalette'
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
  /** Receives the currently-selected node id or null when nothing is selected. */
  onSelect?: (nodeId: string | null) => void
  readOnly?: boolean
  /**
   * Map of nodeId → status. Wired into the per-kind renderers'
   * `data-status` attribute so the existing CSS overlay picks the color.
   * Used by the task-detail status view (P-2-12).
   */
  nodeStatuses?: Record<string, CanvasNodeData['status'] | undefined>
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({
  definition,
  agents,
  onChange,
  onSelect,
  readOnly,
  nodeStatuses,
}: WorkflowCanvasProps) {
  const { t } = useTranslation()
  const agentByName = useMemo(() => {
    const m = new Map<string, Agent>()
    for (const a of agents ?? []) m.set(a.name, a)
    return m
  }, [agents])
  const rf = useReactFlow()
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({
    nodes: [],
    edges: [],
  })
  const [menu, setMenu] = useState<{
    x: number
    y: number
    nodeId: string | null
  } | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const [nodes, setNodes] = useState<Node[]>(() =>
    toFlowNodes(definition, agentByName, nodeStatuses),
  )
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(definition.edges))
  const externalDefRef = useRef(definition)
  const externalStatusesRef = useRef(nodeStatuses)

  useEffect(() => {
    const defChanged = definition !== externalDefRef.current
    const statusChanged = nodeStatuses !== externalStatusesRef.current
    if (defChanged || statusChanged) {
      externalDefRef.current = definition
      externalStatusesRef.current = nodeStatuses
      setNodes(toFlowNodes(definition, agentByName, nodeStatuses))
      if (defChanged) setEdges(toFlowEdges(definition.edges))
    }
  }, [definition, agentByName, nodeStatuses])

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

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (readOnly === true || onChange === undefined) return
      const built = buildEdgeFromConnection(definition, conn)
      if (built === null) return
      onChange({ ...definition, edges: [...definition.edges, built] })
    },
    [definition, onChange, readOnly],
  )

  // ---- Clipboard / shortcuts (P-2-07) ----

  const copySelection = useCallback(() => {
    if (selection.nodes.length === 0) return
    const slice = buildSlice(definition, selection.nodes)
    if (slice !== null) setClipboard(slice)
  }, [definition, selection.nodes])

  const pasteFromClipboard = useCallback(
    (at: { x: number; y: number }) => {
      const slice = getClipboard()
      if (slice === null || onChange === undefined || readOnly === true) return
      const { definition: next, newNodeIds } = applyPaste(definition, slice, at)
      onChange(next)
      setSelection({ nodes: newNodeIds, edges: [] })
    },
    [definition, onChange, readOnly],
  )

  const selectAll = useCallback(() => {
    setSelection({
      nodes: definition.nodes.map((n) => n.id),
      edges: definition.edges.map((e) => e.id),
    })
  }, [definition])

  // Keyboard shortcuts — bound to the canvas wrapper to avoid hijacking
  // input fields elsewhere on the page.
  useEffect(() => {
    if (readOnly === true) return
    const el = wrapperRef.current
    if (el === null) return
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'c' || e.key === 'C') {
        copySelection()
      } else if (e.key === 'v' || e.key === 'V') {
        // Paste in the visible viewport center so the user sees the result.
        const box = el!.getBoundingClientRect()
        const center = rf.screenToFlowPosition({
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        })
        pasteFromClipboard(center)
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        selectAll()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [copySelection, pasteFromClipboard, readOnly, rf, selectAll])

  const deleteSelected = useCallback(() => {
    if (onChange === undefined || readOnly === true) return
    if (selection.nodes.length === 0 && selection.edges.length === 0) return
    const removedNodes = new Set(selection.nodes)
    const removedEdges = new Set(selection.edges)
    const keptNodes = definition.nodes.filter((n) => !removedNodes.has(n.id))
    const stillIds = new Set(keptNodes.map((n) => n.id))
    const keptEdges = definition.edges.filter(
      (e) =>
        !removedEdges.has(e.id) && stillIds.has(e.source.nodeId) && stillIds.has(e.target.nodeId),
    )
    onChange({ ...definition, nodes: keptNodes, edges: keptEdges })
    setSelection({ nodes: [], edges: [] })
  }, [definition, onChange, readOnly, selection.edges, selection.nodes])

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const slice = buildSlice(definition, [nodeId])
      if (slice === null || onChange === undefined || readOnly === true) return
      const at = { x: slice.anchor.x + 40, y: slice.anchor.y + 40 }
      const { definition: next, newNodeIds } = applyPaste(definition, slice, at)
      onChange(next)
      setSelection({ nodes: newNodeIds, edges: [] })
    },
    [definition, onChange, readOnly],
  )

  // P-3-04: wrap the current selection in a new wrapper-git / wrapper-loop
  // node. The wrapper's position is just behind the topmost-leftmost
  // selected node so it visually overlaps the group it owns.
  const wrapSelection = useCallback(
    (kind: 'wrapper-git' | 'wrapper-loop') => {
      if (onChange === undefined || readOnly === true) return
      const inner = selection.nodes
      if (inner.length === 0) return
      const innerSet = new Set(inner)
      const innerNodes = definition.nodes.filter((n) => innerSet.has(n.id))
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      for (const n of innerNodes) {
        const p = n.position ?? { x: 0, y: 0 }
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
      }
      if (!Number.isFinite(minX)) minX = 0
      if (!Number.isFinite(minY)) minY = 0
      const wrapperId = `${kind.replace('wrapper-', 'wrap_')}_${ulid().slice(-6).toLowerCase()}`
      const base = {
        id: wrapperId,
        kind,
        position: { x: Math.round(minX - 30), y: Math.round(minY - 30) },
        nodeIds: inner,
      }
      const wrapper =
        kind === 'wrapper-loop'
          ? { ...base, maxIterations: 3, exitCondition: { kind: 'port-empty' } }
          : base
      onChange({
        ...definition,
        nodes: [...definition.nodes, wrapper as WorkflowNode],
      })
      setSelection({ nodes: [wrapperId], edges: [] })
    },
    [definition, onChange, readOnly, selection.nodes],
  )

  const decomposeWrapper = useCallback(
    (wrapperId: string) => {
      if (onChange === undefined || readOnly === true) return
      const node = definition.nodes.find((n) => n.id === wrapperId)
      if (node === undefined) return
      if (node.kind !== 'wrapper-git' && node.kind !== 'wrapper-loop') return
      const inner = (node as Record<string, unknown>).nodeIds
      const innerIds = Array.isArray(inner)
        ? inner.filter((s): s is string => typeof s === 'string')
        : []
      onChange({
        ...definition,
        nodes: definition.nodes.filter((n) => n.id !== wrapperId),
      })
      setSelection({ nodes: innerIds, edges: [] })
    },
    [definition, onChange, readOnly],
  )

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly === true) return
    if (
      e.dataTransfer.types.includes(PALETTE_MIME) ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly === true) return
    if (onChange === undefined) return
    const raw = e.dataTransfer.getData(PALETTE_MIME) || e.dataTransfer.getData('text/plain')
    if (raw === '') return
    const item = deserialize(raw)
    if (item === null) return
    e.preventDefault()
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const existingIds = new Set(definition.nodes.map((n) => n.id))
    const newNode = makeNode(item, pos, { agents, existingIds })
    onChange({ ...definition, nodes: [...definition.nodes, newNode] })
  }

  function handleNodeContextMenu(e: React.MouseEvent, node: Node) {
    if (readOnly === true) return
    e.preventDefault()
    e.stopPropagation()
    const box = wrapperRef.current?.getBoundingClientRect()
    const x = box === undefined ? e.clientX : e.clientX - box.left
    const y = box === undefined ? e.clientY : e.clientY - box.top
    setMenu({ x, y, nodeId: node.id })
    // Make sure the right-clicked node is part of the selection.
    if (!selection.nodes.includes(node.id)) {
      setSelection({ nodes: [node.id], edges: [] })
    }
  }

  function handlePaneContextMenu(e: MouseEvent | React.MouseEvent) {
    if (readOnly === true) return
    e.preventDefault()
    const box = wrapperRef.current?.getBoundingClientRect()
    const x = box === undefined ? e.clientX : e.clientX - box.left
    const y = box === undefined ? e.clientY : e.clientY - box.top
    setMenu({ x, y, nodeId: null })
  }

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (menu === null) return []
    if (menu.nodeId === null) {
      // Pane menu — paste / select-all.
      return [
        {
          label: t('editor.menuPaste'),
          disabled: getClipboard() === null,
          onSelect: () => {
            if (wrapperRef.current === null) return
            const box = wrapperRef.current.getBoundingClientRect()
            pasteFromClipboard(
              rf.screenToFlowPosition({ x: box.left + menu.x, y: box.top + menu.y }),
            )
          },
        },
        { label: t('editor.menuSelectAll'), onSelect: selectAll },
      ]
    }
    return [
      {
        label: t('editor.menuDuplicate'),
        onSelect: () => menu.nodeId !== null && duplicateNode(menu.nodeId),
      },
      {
        label: t('editor.menuCopy'),
        onSelect: copySelection,
        disabled: selection.nodes.length === 0,
      },
      {
        label: t('editor.menuWrapGit'),
        disabled: selection.nodes.length === 0,
        onSelect: () => wrapSelection('wrapper-git'),
      },
      // wrapper-loop is M4 territory; we still expose it so users can
      // pre-author workflows but the scheduler will reject runs.
      {
        label: t('editor.menuWrapLoop'),
        disabled: selection.nodes.length === 0,
        onSelect: () => wrapSelection('wrapper-loop'),
      },
      {
        label: t('editor.menuDecompose'),
        disabled: !isWrapperNode(definition, menu.nodeId),
        onSelect: () => menu.nodeId !== null && decomposeWrapper(menu.nodeId),
      },
      { label: t('common.delete'), danger: true, onSelect: deleteSelected },
    ]
  }, [
    copySelection,
    decomposeWrapper,
    definition,
    deleteSelected,
    duplicateNode,
    menu,
    pasteFromClipboard,
    rf,
    selectAll,
    selection.nodes.length,
    t,
    wrapSelection,
  ])

  return (
    <div
      ref={wrapperRef}
      className="workflow-canvas"
      tabIndex={0}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onSelectionChange={(s) => {
          const ns = s.nodes.map((n) => n.id)
          const es = s.edges.map((e) => e.id)
          setSelection({ nodes: ns, edges: es })
          if (onSelect !== undefined) onSelect(ns[0] ?? null)
        }}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        nodesDraggable={readOnly !== true}
        edgesFocusable={readOnly !== true}
        nodesConnectable={readOnly !== true}
        deleteKeyCode={readOnly === true ? null : deleteKeyCodes}
        multiSelectionKeyCode={['Shift', 'Meta']}
        selectionOnDrag={readOnly !== true}
        panOnDrag={readOnly === true ? true : [1, 2]}
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <Background />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
        header={
          menu?.nodeId !== undefined && menu?.nodeId !== null ? (
            <code>{menu.nodeId}</code>
          ) : (
            <span>{selection.nodes.length} selected</span>
          )
        }
      />
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

function toFlowNodes(
  definition: WorkflowDefinition,
  agentByName: Map<string, Agent>,
  statuses?: Record<string, CanvasNodeData['status'] | undefined>,
): Node[] {
  const loopBodyIds = new Set<string>()
  for (const n of definition.nodes) {
    if (n.kind !== 'wrapper-loop') continue
    const inner = (n as unknown as { nodeIds?: string[] }).nodeIds
    if (Array.isArray(inner)) for (const id of inner) loopBodyIds.add(id)
  }
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
    if (statuses !== undefined) {
      const s = statuses[n.id]
      if (s !== undefined) data.status = s
    }
    if (loopBodyIds.has(n.id)) data.loopBody = true
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

/**
 * Validate an xyflow Connection event against the current definition and
 * convert it to a WorkflowEdge. Returns null when:
 *   - either side is missing nodeId or handle/port
 *   - it's a self-loop (target.nodeId === source.nodeId)
 *   - an identical edge already exists (same source+target port pair)
 *
 * Port name correctness is left to P-2-01's validator; the canvas just
 * captures the wire and lets save-time validation surface mismatches.
 */
export function buildEdgeFromConnection(
  def: WorkflowDefinition,
  conn: {
    source?: string | null
    target?: string | null
    sourceHandle?: string | null
    targetHandle?: string | null
  },
): WorkflowEdge | null {
  const source = conn.source ?? ''
  const target = conn.target ?? ''
  const sourcePort = conn.sourceHandle ?? ''
  const targetPort = conn.targetHandle ?? ''
  if (source === '' || target === '' || sourcePort === '' || targetPort === '') return null
  if (source === target) return null
  const duplicate = def.edges.some(
    (e) =>
      e.source.nodeId === source &&
      e.source.portName === sourcePort &&
      e.target.nodeId === target &&
      e.target.portName === targetPort,
  )
  if (duplicate) return null
  return {
    id: `edge_${ulid().slice(-6).toLowerCase()}`,
    source: { nodeId: source, portName: sourcePort },
    target: { nodeId: target, portName: targetPort },
  }
}

function isWrapperNode(def: WorkflowDefinition, nodeId: string | null): boolean {
  if (nodeId === null) return false
  const n = def.nodes.find((x) => x.id === nodeId)
  return n !== undefined && (n.kind === 'wrapper-git' || n.kind === 'wrapper-loop')
}

// Test helpers (exported but underscored).
export const __testToFlowNodes = (
  defNodes: WorkflowDefinition['nodes'],
  agents: Agent[] = [],
  edges: WorkflowEdge[] = [],
  statuses?: Record<string, CanvasNodeData['status'] | undefined>,
): Node[] => {
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: defNodes,
    edges,
  }
  const map = new Map<string, Agent>()
  for (const a of agents) map.set(a.name, a)
  return toFlowNodes(def, map, statuses)
}
export const __testToFlowEdges = toFlowEdges
export const __testToDefinition = toDefinition
export const __testComputePorts = computePorts
