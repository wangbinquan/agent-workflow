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
// behavior). The header pill text is i18n-driven via data.kindLabel when the
// caller wants to override the default; with no override the renderer pulls
// the localized label through `t('clarifyNode.label')` so the chip aligns
// with the rest of the canvas (Chinese under zh-CN, English under en-US).

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { CLARIFY_INPUT_PORT_NAME, CLARIFY_OUTPUT_PORT_NAME } from '@agent-workflow/shared'
import { QuestionBadge } from './QuestionBadge'
import type { CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

export type ClarifyStatus = 'pending' | 'awaiting_human' | 'answered' | 'failed'

export interface ClarifyNodeData extends CanvasNodeData {
  /** Overrides data.status with a clarify-specific palette. Optional. */
  statusOverlay?: ClarifyStatus
  /** Display label inside the kind pill. When unset, the chip resolves
   *  to `⚡ {t('clarifyNode.label')}`. */
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
  const labelText = data.kindLabel ?? `${NODE_GLYPHS.clarify} ${t('clarifyNode.label')}`
  return (
    <div
      className={
        'canvas-node canvas-node--clarify' +
        (selected ? ' canvas-node--selected' : '') +
        ` canvas-node--clarify-${status}`
      }
      data-status={status}
      data-clarify-nav={data.clarifyNav}
      data-surface={data.surface}
    >
      <QuestionBadge data={data} />
      <NodeValidationBadge data={data} />
      <Handle
        type="target"
        position={Position.Left}
        id={CLARIFY_INPUT_PORT_NAME}
        className="canvas-node__handle canvas-node__handle--clarify-input"
        aria-label="clarify-input"
      />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">{labelText}</span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
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
    </div>
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
