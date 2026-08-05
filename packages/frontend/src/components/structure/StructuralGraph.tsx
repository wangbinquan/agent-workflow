// RFC-083 PR-F/PR-G — read-only structural diagram (xyflow). Two levels (the
// user toggles): PACKAGE overview (one box per package + aggregated edges — the
// readable architecture view, default) and CLASS detail (class cards grouped in
// package boxes). Edge kinds (inherits / references / calls) are filterable;
// all three are ON by default — 'calls' used to start unchecked as "noisiest",
// but with call edges hidden the graph rendered as unconnected boxes and read
// as broken (user feedback), so the default is now everything visible and the
// checkboxes are for pruning. Class cards have variable size, so the class
// flow measures them then re-runs dagre (else edges float).

import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StructuralDiff } from '@agent-workflow/shared'
import {
  buildStructureGraph,
  aggregatePackageGraph,
  layoutGraph,
  relatedMembers,
  edgesForNodeClick,
  groupMembersByVisibility,
  memberSignature,
  changeTypeColor,
  type EdgeKind,
  type GraphCard,
  type GraphCardEdge,
  type PkgGraphNode,
  type StructureGraph,
  type PackageGraph,
} from '@/lib/structureGraph'

// Member rows highlighted because an active edge links them (caller ↔ callee).
const HighlightedMembers = createContext<ReadonlySet<string>>(new Set())
// RFC-085 — opens the call-chain (5th tab) rooted at a changed method row (⎇);
// undefined when the host doesn't offer call chains (keeps the graph standalone).
// RFC-258 — graph→source linking: member rows offer a ‹› jump when a handler
// is mounted (the full-screen drilldown's source pane).
const OpenSourceEntry = createContext<
  ((target: { structuralPath: string; qualifiedName: string }) => void) | undefined
>(undefined)
const CallChainEntry = createContext<((root: { ref: string; label: string }) => void) | undefined>(
  undefined,
)
const GRAPH_CALLABLE = new Set<string>(['method', 'function', 'constructor'])
import { badgeSymbol } from '@/lib/structureView'
import { refFromMemberId } from '@/lib/callChain'
import { Segmented } from '@/components/Segmented'

const EDGE_KEYS: EdgeKind[] = ['inherits', 'references', 'calls']
const EDGE_LABEL: Record<EdgeKind, string> = {
  inherits: 'tasks.structGraphEdgeInherits',
  references: 'tasks.structGraphEdgeReferences',
  calls: 'tasks.structGraphEdgeCalls',
}

function CardNode({ data }: NodeProps) {
  const { t } = useTranslation()
  const card = data.card as GraphCard
  const hlMembers = useContext(HighlightedMembers)
  const openCallChain = useContext(CallChainEntry)
  const openSource = useContext(OpenSourceEntry)
  const ctClass = card.changeType !== undefined ? ` sg-card--ct-${card.changeType}` : ''
  const changedClass = card.isChanged ? ' sg-card--changed' : ' sg-card--caller'
  // RFC-086 — anonymous types (title already reads `«anonymous» <base>`) get a
  // muted/italic treatment so they read as synthetic, not a declared class.
  const anonClass = card.anonymous === true ? ' sg-card--anonymous' : ''
  return (
    <div className={`sg-card${changedClass}${ctClass}${anonClass}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="sg-card__header">
        <span className="sg-card__kind">{card.kind}</span>
        <span className="sg-card__title" title={`${card.title} · ${card.file}`}>
          {card.title}
        </span>
        {card.changeType !== undefined && (
          <span className="sg-card__badge">{badgeSymbol(card.changeType)}</span>
        )}
      </div>
      {card.members.length > 0 && (
        <ul className="sg-card__members">
          {groupMembersByVisibility(card.members).map((g) => (
            <li key={g.visibility} className="sg-card__group">
              <span className={`sg-card__vis sg-card__vis--${g.visibility}`}>
                {g.visibility === 'callers' ? t('tasks.structGraphCallers') : g.visibility}
              </span>
              <ul className="sg-card__members">
                {g.members.map((m) => {
                  const base =
                    m.role === 'changed'
                      ? `sg-card__member sg-card__member--ct-${m.changeType}`
                      : 'sg-card__member sg-card__member--caller'
                  return (
                    <li
                      key={m.id}
                      className={hlMembers.has(m.id) ? `${base} sg-card__member--hl` : base}
                      title={m.signature ?? m.label}
                    >
                      <span className="sg-card__member-badge">
                        {m.role === 'changed' && m.changeType !== undefined
                          ? badgeSymbol(m.changeType)
                          : '·'}
                      </span>
                      <span className="sg-card__member-name">
                        {m.role === 'changed' ? memberSignature(m.signature, m.label) : m.label}
                      </span>
                      {openCallChain !== undefined &&
                        m.role === 'changed' &&
                        GRAPH_CALLABLE.has(m.kind) && (
                          <button
                            type="button"
                            className="sg-card__callchain"
                            title={t('tasks.structCallChainEntry')}
                            aria-label={t('tasks.structCallChainEntry')}
                            onClick={(e) => {
                              e.stopPropagation() // don't trigger node-click edge highlight
                              // refFromMemberId strips `:kind:row` without splitting on
                              // '#' — a `#private` qn (RFC-087) contains a literal '#'.
                              openCallChain({ ref: refFromMemberId(m.id), label: `${m.label}()` })
                            }}
                          >
                            ⎇
                          </button>
                        )}
                      {openSource !== undefined && (
                        <button
                          type="button"
                          className="sg-card__callchain"
                          title={t('tasks.structOpenSource')}
                          aria-label={t('tasks.structOpenSource')}
                          onClick={(e) => {
                            e.stopPropagation()
                            const ref = refFromMemberId(m.id)
                            const hash = ref.indexOf('#')
                            openSource({
                              structuralPath: hash < 0 ? ref : ref.slice(0, hash),
                              qualifiedName: hash < 0 ? '' : ref.slice(hash + 1),
                            })
                          }}
                        >
                          ‹›
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

function PkgNode({ data }: NodeProps) {
  return (
    <div className="sg-pkg">
      <span className="sg-pkg__label">{String(data.label)}</span>
    </div>
  )
}

function PkgSummaryNode({ data }: NodeProps) {
  const { t } = useTranslation()
  const n = data.node as PkgGraphNode
  return (
    <div className="sg-pkgnode">
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="sg-pkgnode__name" title={n.id}>
        {n.label}
      </span>
      <span className="sg-pkgnode__count">
        {t('tasks.structGraphPkgClasses', { n: n.classCount })}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

const CLASS_NODE_TYPES = { card: CardNode, pkg: PkgNode }
const PKG_NODE_TYPES = { pkgnode: PkgSummaryNode }

function edgeFor(e: { id: string; source: string; target: string; kind: EdgeKind }): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    className: `sg-edge--${e.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed },
  }
}

/** Click highlighting shared by both flows: click an edge → highlight it; click
 *  a node's TOP half (input) → its incoming edges, BOTTOM half (output) → its
 *  outgoing edges; click the empty pane → clear. Highlighted edges pop, the rest
 *  dim. `rawEdges` is the source/target lookup; `baseEdges` the xyflow edges. */
function useEdgeHighlight(baseEdges: Edge[], rawEdges: ReadonlyArray<GraphCardEdge>) {
  const [hl, setHl] = useState<ReadonlySet<string>>(() => new Set())
  const onPaneClick = useCallback(() => setHl(new Set()), [])
  const onEdgeClick = useCallback((_: unknown, edge: { id: string }) => {
    setHl(new Set([edge.id]))
  }, [])
  const onNodeClick = useCallback(
    (event: { target: EventTarget | null; clientY: number }, node: { id: string }) => {
      const el = (event.target as HTMLElement | null)?.closest?.('.react-flow__node')
      const rect = el?.getBoundingClientRect()
      // vertical position of the click within the card (0=top, 1=bottom)
      const rel = rect === undefined ? 0.5 : (event.clientY - rect.top) / rect.height
      setHl(edgesForNodeClick(rawEdges, node.id, rel))
    },
    [rawEdges],
  )
  const edges = useMemo<Edge[]>(
    () =>
      baseEdges.map((e) => {
        const state = hl.size === 0 ? '' : hl.has(e.id) ? ' sg-edge--hl' : ' sg-edge--dim'
        return {
          ...e,
          className: `${e.className ?? ''}${state}`.trim(),
          zIndex: hl.has(e.id) ? 10 : 0,
        }
      }),
    [baseEdges, hl],
  )
  // member rows related to the active edges (precise caller↔callee for 'calls',
  // else the changed methods of both connected classes), to highlight too.
  const highlightedMembers = useMemo<ReadonlySet<string>>(
    () => relatedMembers(rawEdges, hl),
    [rawEdges, hl],
  )
  return { edges, highlightedMembers, onEdgeClick, onNodeClick, onPaneClick }
}

/** PACKAGE overview — fixed-size nodes, so no measure/re-layout dance needed. */
function PackageFlow({ graph }: { graph: PackageGraph }) {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'pkgnode',
    position: { x: n.x, y: n.y },
    data: { node: n },
    draggable: false,
    connectable: false,
    width: n.w,
    height: n.h,
  }))
  const baseEdges = useMemo(() => graph.edges.map(edgeFor), [graph])
  const { edges, onEdgeClick, onNodeClick, onPaneClick } = useEdgeHighlight(baseEdges, graph.edges)
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={PKG_NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onEdgeClick={onEdgeClick}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      fitViewOptions={{ maxZoom: 1.2, minZoom: 0.3 }}
      minZoom={0.15}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <MiniMap
        pannable
        zoomable
        ariaLabel={null}
        nodeColor={(n) =>
          ((n.data?.node as PkgGraphNode | undefined)?.classCount ?? 0) > 0
            ? 'var(--accent)'
            : 'var(--border)'
        }
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

/** CLASS detail — cards have variable size, so measure then re-layout. */
function ClassFlow({
  graph,
  onOpenCallChain,
  onOpenSource,
}: {
  graph: StructureGraph
  onOpenCallChain?: (root: { ref: string; label: string }) => void
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const initialNodes = useMemo<Node[]>(
    () => [
      ...graph.packages.map((p) => ({
        id: p.id,
        type: 'pkg',
        position: { x: p.x, y: p.y },
        data: { label: p.label },
        draggable: false,
        selectable: false,
        connectable: false,
        zIndex: 0,
        style: { width: p.w, height: p.h },
      })),
      ...graph.cards.map((c) => ({
        id: c.id,
        type: 'card',
        position: { x: c.x, y: c.y },
        data: { card: c },
        draggable: false,
        connectable: false,
        zIndex: 1,
      })),
    ],
    [graph],
  )
  // Edges are UNCONTROLLED (plain memo from the graph, never edge state) — the
  // same shape PackageFlow uses. Keeping them in xyflow-managed state caused
  // two real bugs: (a) xyflow dispatches edge-REMOVAL changes while nodes are
  // briefly unmeasured/absent, and once applied the edges never came back → a
  // permanently edge-less class graph; (b) the state was seeded once at mount,
  // so the 调用/继承/引用 checkboxes rebuilt the graph but the edge set never
  // re-synced. Deriving straight from `graph` fixes both; locked by
  // structure-graph-render.test.tsx.
  const initialEdges = useMemo<Edge[]>(() => graph.edges.map(edgeFor), [graph])
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const { edges, highlightedMembers, onEdgeClick, onNodeClick, onPaneClick } = useEdgeHighlight(
    initialEdges,
    graph.edges,
  )
  const initialized = useNodesInitialized()
  const { fitView } = useReactFlow()
  const laidOut = useRef(false)

  useEffect(() => {
    laidOut.current = false
    setNodes(initialNodes)
  }, [initialNodes, setNodes])

  useEffect(() => {
    if (!initialized || laidOut.current) return
    laidOut.current = true
    setNodes((nds) => {
      for (const c of graph.cards) {
        const measured = nds.find((n) => n.id === c.id)?.measured
        if (measured?.width) c.w = measured.width
        if (measured?.height) c.h = measured.height
      }
      layoutGraph(graph.cards, graph.edges, graph.packages)
      const cardPos = new Map(graph.cards.map((c) => [c.id, { x: c.x, y: c.y }]))
      const pkg = new Map(graph.packages.map((p) => [p.id, p]))
      return nds.map((n) => {
        if (n.type === 'pkg') {
          const p = pkg.get(n.id)
          return p === undefined
            ? n
            : { ...n, position: { x: p.x, y: p.y }, style: { ...n.style, width: p.w, height: p.h } }
        }
        return { ...n, position: cardPos.get(n.id) ?? n.position }
      })
    })
    requestAnimationFrame(() => fitView({ minZoom: 0.4, maxZoom: 1, padding: 0.12 }))
  }, [initialized, graph, setNodes, fitView])

  return (
    <HighlightedMembers.Provider value={highlightedMembers}>
      <OpenSourceEntry.Provider value={onOpenSource}>
        <CallChainEntry.Provider value={onOpenCallChain}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgeClick={onEdgeClick}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={CLASS_NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ maxZoom: 1, minZoom: 0.4 }}
            minZoom={0.15}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <MiniMap
              pannable
              zoomable
              ariaLabel={null}
              nodeColor={(n) =>
                n.type === 'card'
                  ? changeTypeColor((n.data?.card as GraphCard | undefined)?.changeType)
                  : 'transparent'
              }
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </CallChainEntry.Provider>
      </OpenSourceEntry.Provider>
    </HighlightedMembers.Provider>
  )
}

export function StructuralGraph({
  data,
  onOpenCallChain,
  onOpenSource,
}: {
  data: StructuralDiff
  /** RFC-085 — open the call chain rooted at a changed method row (⎇). */
  onOpenCallChain?: (root: { ref: string; label: string }) => void
  /** RFC-258 — open the split source pane at a member's definition (‹›). */
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const { t } = useTranslation()
  const [level, setLevel] = useState<'package' | 'class'>('package')
  const [edgeKinds, setEdgeKinds] = useState<Set<EdgeKind>>(
    () => new Set<EdgeKind>(['inherits', 'references', 'calls']),
  )
  const classGraph = useMemo(() => buildStructureGraph(data, edgeKinds), [data, edgeKinds])
  const pkgGraph = useMemo(() => aggregatePackageGraph(classGraph), [classGraph])
  if (classGraph.cards.length === 0) {
    return <div className="muted structure-graph__empty">{t('tasks.structGraphEmpty')}</div>
  }
  const toggleKind = (k: EdgeKind): void =>
    setEdgeKinds((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  return (
    <div className="structure-graph-wrap">
      <div className="structure-graph__controls">
        <Segmented<'package' | 'class'>
          value={level}
          onChange={setLevel}
          options={(['package', 'class'] as const).map((lv) => ({
            value: lv,
            label:
              lv === 'package'
                ? t('tasks.structGraphLevelPackage')
                : t('tasks.structGraphLevelClass'),
          }))}
          ariaLabel={t('tasks.structGraphLevelLabel')}
          className="structure-graph__level"
        />
        <span className="structure-graph__legend-sep" aria-hidden="true" />
        {EDGE_KEYS.map((k) => (
          <label key={k} className="structure-graph__edge-toggle">
            <input type="checkbox" checked={edgeKinds.has(k)} onChange={() => toggleKind(k)} />
            <span className={`structure-graph__edge-key structure-graph__edge-key--${k}`} />
            {t(EDGE_LABEL[k])}
          </label>
        ))}
        {level === 'class' && (
          <>
            <span className="structure-graph__legend-sep" aria-hidden="true" />
            <span className="structure-graph__legend-item">
              <span className="structure-graph__swatch structure-graph__swatch--ct-added" />
              {t('tasks.structGraphLegendAdded')}
            </span>
            <span className="structure-graph__legend-item">
              <span className="structure-graph__swatch structure-graph__swatch--ct-modified" />
              {t('tasks.structGraphLegendModified')}
            </span>
            <span className="structure-graph__legend-item">
              <span className="structure-graph__swatch structure-graph__swatch--ct-removed" />
              {t('tasks.structGraphLegendRemoved')}
            </span>
          </>
        )}
        <span className="structure-graph__legend-hint">{t('tasks.structGraphLegendHint')}</span>
      </div>
      <div className="structure-graph" data-testid="structure-graph">
        <ReactFlowProvider key={level}>
          {level === 'package' ? (
            <PackageFlow graph={pkgGraph} />
          ) : (
            <ClassFlow
              graph={classGraph}
              onOpenCallChain={onOpenCallChain}
              onOpenSource={onOpenSource}
            />
          )}
        </ReactFlowProvider>
      </div>
    </div>
  )
}
