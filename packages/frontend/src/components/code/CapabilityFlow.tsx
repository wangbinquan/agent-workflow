// RFC-307 — a capability's stage sequence, drawn.
//
// The user's report: "I have no flow I can execute or look at, I don't even
// know what it actually looks like." RFC-304 shipped four sequences of up to
// thirteen stages and the UI rendered them as one opaque box before a run and
// as an `<ol>` of plain text after one.
//
// Why this is its own component rather than `WorkflowCanvas`:
//
//   `WorkflowCanvas` renders a `WorkflowDefinition`, whose nodes carry a
//   `NodeKind`. Stage kinds are not node kinds, and the mapping is not merely
//   missing — it would be FALSE. A `program` stage is platform code that must
//   not dispatch an agent (constitution R2, enforced by a source-level scan);
//   there is no node kind that means that, and rendering it as `script` would
//   tell the reader something untrue about what runs. So this draws with the
//   same library and the same `.canvas-node` visual vocabulary, and keeps the
//   four stage kinds as themselves.
//
// What it does NOT do: hold any state about the sequence. Everything drawn here
// comes from `GET /api/code/capabilities/:capability/graph`, which is a pure
// projection of the platform contract. There is no second copy to drift.

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  STAGE_CARD_WIDTH,
  edgeHandles,
  layoutStageGraph,
  shouldFitOnResize,
  type StageLayoutKind,
  type StageLayoutNode,
} from './stageLayout'

export interface CapabilityGraphNode {
  name: string
  kind: StageLayoutKind
  index: number
  requires: readonly string[]
  produces: readonly string[]
  parallel: boolean
  injectable: readonly string[]
  terminal: readonly string[]
  agentSlot?: string
  scriptSlot?: string
  invokes?: { capability: string; from: string; to: string; stages: readonly string[] }
}

export interface CapabilityGraphEdge {
  id: string
  from: string
  to: string
  artifact: string
}

export type StageRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled' | 'skipped'

export interface StageRunState {
  status: StageRunStatus
  error?: string | null
}

interface Props {
  nodes: readonly CapabilityGraphNode[]
  edges: readonly CapabilityGraphEdge[]
  /**
   * Per-stage runtime state, keyed by stage name. Absent entirely on the
   * structural view; absent FOR A STAGE means it has not started, which is
   * rendered as `pending` rather than as a missing node — the sequence is
   * always complete, only the status is partial.
   */
  statuses?: Readonly<Record<string, StageRunState | undefined>>
  selected?: string | null
  onPick?: (stage: CapabilityGraphNode) => void
  /** Stages sharing the selected node's slot. Highlighted together (AC-4). */
  siblings?: readonly string[]
  height?: number
  /**
   * Namespace for the per-stage test anchors.
   *
   * Needed because RFC-169 keeps inactive tab panels MOUNTED: the Flow tab and
   * every round overlay on the Activity tab are all in the document at the same
   * time, and without a namespace they all publish `stage-node-<name>`. A
   * `getByTestId` then matches several elements and fails — and a reader
   * inspecting the DOM cannot tell which flow they are looking at.
   */
  testidPrefix?: string
}

interface StageNodeData extends Record<string, unknown> {
  testid: string
  stage: CapabilityGraphNode
  status?: StageRunState | undefined
  sibling: boolean
  /**
   * Selection carried in `data`, NOT through ReactFlow's `selected` node prop.
   *
   * Which stage is open is already this component's state (`openStage`), so
   * also handing ReactFlow a controlled `selected` on every node gives the same
   * fact two owners that have to be kept in step. One owner, one render path.
   */
  active: boolean
  label: string
  kindLabel: string
  slot?: string
}

const KIND_CLASS: Record<StageLayoutKind, string> = {
  program: 'stage-node--program',
  script: 'stage-node--script',
  ai: 'stage-node--ai',
  invoke: 'stage-node--invoke',
}

const KIND_GLYPH: Record<StageLayoutKind, string> = {
  program: '⚙',
  script: '❯',
  ai: '✦',
  invoke: '⤷',
}

function StageNode({ data }: NodeProps) {
  const d = data as StageNodeData
  const stage = d.stage
  return (
    <div
      className={`canvas-node canvas-node--card stage-node ${KIND_CLASS[stage.kind]}${
        d.active ? ' canvas-node--selected' : ''
      }${d.sibling ? ' stage-node--sibling' : ''}`}
      data-status={d.status?.status}
      data-testid={d.testid}
      data-stage-kind={stage.kind}
    >
      {/* Handles on all four sides: the layout wraps into rows and runs
          alternate rows right-to-left, so an edge may leave any side. */}
      <Handle type="target" position={Position.Left} id="left" isConnectable={false} />
      <Handle type="target" position={Position.Top} id="top" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="right" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="bottom" isConnectable={false} />
      <div className="canvas-node__header">
        <span className="canvas-node__icon" aria-hidden="true">
          {KIND_GLYPH[stage.kind]}
        </span>
        <div className="canvas-node__identity">
          <span className="canvas-node__kind">{d.kindLabel}</span>
          <span className="canvas-node__title">{stage.name}</span>
        </div>
      </div>
      <div className="stage-node__body">
        {d.slot !== undefined && <span className="stage-node__slot">{d.slot}</span>}
        {stage.parallel && <span className="stage-node__badge">{d.label}</span>}
      </div>
      {d.status?.error != null && d.status.error !== '' && (
        <p className="stage-node__error" title={d.status.error}>
          {d.status.error}
        </p>
      )}
    </div>
  )
}

const NODE_TYPES = { stage: StageNode }

/**
 * Re-fit the viewport the moment this canvas stops being hidden.
 *
 * Must live INSIDE `ReactFlowProvider` — `useReactFlow` reads the store the
 * provider owns. See `shouldFitOnResize` for why this exists at all: the panel
 * is mounted while its tab is hidden, so ReactFlow's own `fitView` runs against
 * a 0×0 container and the graph ends up jammed into a corner.
 */
function FitOnReveal({ host }: { host: RefObject<HTMLDivElement | null> }): null {
  const flow = useReactFlow()
  const previous = useRef<{ width: number; height: number } | null>(null)

  useEffect(() => {
    // THIS instance's wrapper, passed by ref rather than found with a document
    // query. Several of these are mounted at once — the Flow tab plus one per
    // round on the Activity tab — so a selector would hand every observer the
    // same first element and leave the rest never re-fitting.
    const element = host.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined) return
      const next = { width: box.width, height: box.height }
      if (shouldFitOnResize(previous.current, next)) {
        // Deferred a frame: ReactFlow measures its own nodes on the same tick
        // the container gains size, and fitting before that measurement lands
        // reproduces the very bug this is here to fix.
        requestAnimationFrame(() => {
          void flow.fitView({ padding: 0.15 })
        })
      }
      previous.current = next
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [flow, host])

  return null
}

export function CapabilityFlow({
  nodes,
  edges,
  statuses,
  selected,
  onPick,
  siblings,
  height = 460,
  testidPrefix = 'stage-node',
}: Props) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement | null>(null)

  const layout = useMemo(
    () => layoutStageGraph({ nodes, edges: edges.map((e) => ({ ...e })) }),
    [nodes, edges],
  )

  const flowNodes = useMemo<Node[]>(() => {
    const siblingSet = new Set(siblings ?? [])
    return layout.nodes.map((placed) => {
      const stage = nodes.find((n) => n.name === placed.name)
      if (stage === undefined) throw new Error(`layout produced unknown stage ${placed.name}`)
      const data: StageNodeData = {
        testid: `${testidPrefix}-${stage.name}`,
        stage,
        // A stage with no row has not started. Rendered `pending` rather than
        // omitted, so the picture is the whole sequence at every moment.
        status:
          statuses === undefined ? undefined : (statuses[stage.name] ?? { status: 'pending' }),
        sibling: siblingSet.has(stage.name),
        active: selected === stage.name,
        label: t('capabilityFlow.parallel'),
        kindLabel: t(`capabilityFlow.kind.${stage.kind}`),
        ...(stage.agentSlot !== undefined
          ? { slot: t('capabilityFlow.agentSlot', { slot: stage.agentSlot }) }
          : stage.scriptSlot !== undefined
            ? { slot: t('capabilityFlow.scriptSlot', { slot: stage.scriptSlot }) }
            : stage.invokes !== undefined
              ? { slot: t('capabilityFlow.invokes', { capability: stage.invokes.capability }) }
              : {}),
      }
      return {
        id: stage.name,
        type: 'stage',
        position: { x: placed.x, y: placed.y },
        data,
        draggable: false,
        connectable: false,
        width: STAGE_CARD_WIDTH,
      }
    })
  }, [layout.nodes, nodes, statuses, selected, siblings, testidPrefix, t])

  const flowEdges = useMemo<Edge[]>(() => {
    const byName = new Map<string, StageLayoutNode>(layout.nodes.map((n) => [n.name, n]))
    return layout.edges.flatMap((edge) => {
      const from = byName.get(edge.from)
      const to = byName.get(edge.to)
      if (from === undefined || to === undefined) return []
      const handles = edgeHandles(from, to)
      return [
        {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          sourceHandle: handles.source,
          targetHandle: handles.target,
          label: edge.artifact,
          type: 'smoothstep',
          className: edge.carried ? 'stage-edge stage-edge--carried' : 'stage-edge',
        },
      ]
    })
  }, [layout])

  return (
    <div ref={host} className="stage-flow" style={{ height }} data-testid={`${testidPrefix}-flow`}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={onPick !== undefined}
          panOnScroll
          fitView
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => {
            const stage = nodes.find((n) => n.name === node.id)
            if (stage !== undefined) onPick?.(stage)
          }}
        >
          <Background />
          <FitOnReveal host={host} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
