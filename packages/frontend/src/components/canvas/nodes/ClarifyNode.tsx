// Clarify node (RFC-023) — leaf node with a single hard-coded input handle
// (`questions`) and a single output handle (`answers`). The reverse-drag
// interaction wires it to its asking agent via the agent's two system ports
// (`__clarify__` / `__clarify_response__`); see clarifyDragHelper.ts.
//
// Visual states (mapped to data.statusOverlay):
//   - pending         → neutral grey      (no session yet)
//   - awaiting_human  → amber             (clarify_session.status === 'awaiting_human')
//   - answered        → green             (session sealed; rerun mints fresh agent run)
//   - failed          → red               (envelope malformed / over-limit on agent side)
//
// `data.statusOverlay` overlays whatever status the runtime assigned; when
// undefined the node falls back to data.status (legacy CanvasNodeData
// behavior). The kind label is i18n-driven via data.kindLabel when the caller
// wants to override the default; with no override the renderer pulls the
// localized label through `t('clarifyNode.label')`. CanvasNodeCard owns the
// separate ⚡ icon tile shared with every other card-shaped node.

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { CLARIFY_INPUT_PORT_NAME, CLARIFY_OUTPUT_PORT_NAME } from '@agent-workflow/shared'
import { QuestionBadge } from './QuestionBadge'
import type { CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'

export type ClarifyStatus = 'pending' | 'awaiting_human' | 'answered' | 'failed'

export interface ClarifyNodeData extends CanvasNodeData {
  /** Overrides data.status with a clarify-specific palette. Optional. */
  statusOverlay?: ClarifyStatus
  /** Display label inside the kind line. Legacy callers may still prefix ⚡;
   *  the renderer strips it because CanvasNodeCard owns the icon tile. */
  kindLabel?: string
  /** Description (passes through from node config; rendered below the title). */
  description?: string
}

interface Props extends NodeProps {
  data: ClarifyNodeData
}

export function ClarifyNode({ data, selected }: Props) {
  const { t } = useTranslation()
  // Prefer the clarify-specific overlay when present; otherwise fall through
  // to the standard data.status (e.g. node-run-coloring on the task detail
  // canvas may pass through 'done' for the answered case).
  const status: ClarifyStatus = data.statusOverlay ?? mapFallbackStatus(data.status)
  const icon = NODE_GLYPHS.clarify
  const rawLabel = data.kindLabel ?? t('clarifyNode.label')
  const labelText = rawLabel.startsWith(icon) ? rawLabel.slice(icon.length).trimStart() : rawLabel
  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className={`canvas-node--clarify canvas-node--clarify-${status}`}
      icon={icon}
      kindLabel={labelText}
      title={data.title || data.nodeId}
      titleTooltip={data.title || data.nodeId}
      status={status}
      dataAttributes={
        data.clarifyNav === undefined ? undefined : { 'data-clarify-nav': data.clarifyNav }
      }
      overlays={
        <>
          <QuestionBadge data={data} />
          <Handle
            type="target"
            position={Position.Left}
            id={CLARIFY_INPUT_PORT_NAME}
            className="canvas-node__handle canvas-node__handle--clarify-input"
            aria-label="clarify-input"
          />
        </>
      }
    >
      {data.description !== undefined && data.description.length > 0 && (
        <div className="canvas-node__description muted">{data.description}</div>
      )}
      {/* RFC-161: task-detail canvas marks the click target; clicking routes to the
          clarify page. Absent on the editor canvas + non-clickable clarify nodes. */}
      {data.clarifyNav !== undefined && (
        <div className="canvas-node__clarify-nav muted">
          {data.clarifyNav === 'awaiting'
            ? t('clarifyNode.navAwaiting')
            : t('clarifyNode.navAnswered')}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        id={CLARIFY_OUTPUT_PORT_NAME}
        className="canvas-node__handle canvas-node__handle--clarify-output"
        aria-label="clarify-output"
      />
    </CanvasNodeCard>
  )
}

function mapFallbackStatus(status: CanvasNodeData['status']): ClarifyStatus {
  if (status === 'failed') return 'failed'
  if (status === 'done') return 'answered'
  // The task-detail canvas collapses node_run `awaiting_human` to the unified
  // 'awaiting' hint (canvasStatus); translate it back to this node's own
  // amber `awaiting_human` state so a clarify node parked for answers lights up.
  if (status === 'awaiting') return 'awaiting_human'
  if (status === 'running' || status === 'pending') return 'pending'
  return 'pending'
}
