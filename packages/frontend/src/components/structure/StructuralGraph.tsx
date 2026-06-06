// RFC-083 PR-F — read-only class-collaboration diagram (xyflow). Each node is a
// CARD (class / file) rendered by CardNode: a header (kind + name, change badge)
// over a list of member rows — changed members colored + badged, caller members
// muted. Edges run caller-card → changed-card. Fully non-interactive. All model
// logic is in lib/structureGraph (unit-tested); this is the xyflow adapter.

import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from 'react-i18next'
import type { StructuralDiff } from '@agent-workflow/shared'
import { buildStructureGraph, type GraphCard } from '@/lib/structureGraph'
import { badgeSymbol } from '@/lib/structureView'

function CardNode({ data }: NodeProps) {
  const card = data.card as GraphCard
  const ctClass = card.changeType !== undefined ? ` sg-card--ct-${card.changeType}` : ''
  const changedClass = card.isChanged ? ' sg-card--changed' : ' sg-card--caller'
  return (
    <div className={`sg-card${changedClass}${ctClass}`} style={{ width: card.w }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
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
          {card.members.map((m) => (
            <li
              key={m.id}
              className={
                m.role === 'changed'
                  ? `sg-card__member sg-card__member--ct-${m.changeType}`
                  : 'sg-card__member sg-card__member--caller'
              }
            >
              <span className="sg-card__member-badge">
                {m.role === 'changed' && m.changeType !== undefined
                  ? badgeSymbol(m.changeType)
                  : '·'}
              </span>
              <span className="sg-card__member-name">{m.label}</span>
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}

const NODE_TYPES = { card: CardNode }

export function StructuralGraph({ data }: { data: StructuralDiff }) {
  const { t } = useTranslation()
  const graph = buildStructureGraph(data)
  if (graph.cards.length === 0) {
    return <div className="muted structure-graph__empty">{t('tasks.structGraphEmpty')}</div>
  }
  const nodes: Node[] = graph.cards.map((c) => ({
    id: c.id,
    type: 'card',
    position: { x: c.x, y: c.y },
    data: { card: c },
    draggable: false,
    connectable: false,
    width: c.w,
    height: c.h,
  }))
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
  return (
    <div className="structure-graph-wrap">
      <div className="structure-graph__legend">
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
        <span className="structure-graph__legend-item">
          <span className="structure-graph__swatch structure-graph__swatch--caller" />
          {t('tasks.structGraphLegendCaller')}
        </span>
        <span className="structure-graph__legend-hint">{t('tasks.structGraphLegendHint')}</span>
      </div>
      <div className="structure-graph" data-testid="structure-graph">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ maxZoom: 1, minZoom: 0.4 }}
            minZoom={0.15}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}
