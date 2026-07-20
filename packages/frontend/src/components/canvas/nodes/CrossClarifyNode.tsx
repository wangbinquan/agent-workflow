// Cross-clarify node (RFC-056) — leaf node, 1 input handle + 2 output handles:
//
//   - input    `questions`       (target side, left edge)
//   - output   `to_questioner`   (source side, right edge — auto-wired sibling)
//   - output   `to_designer`     (source side, right edge — manual edge)
//
// The reverse-drag interaction wires the questioner side via the agent's two
// system ports (__clarify__ / __clarify_response__); the user manually drags
// `to_designer` onto an upstream designer agent. See crossClarifyDragHelper.ts.
//
// Visual states (statusOverlay):
//   - pending         → neutral grey      (no session yet OR persistent-stop pass-through)
//   - awaiting_human  → amber             (cross_clarify_sessions.status='awaiting_human')
//   - answered        → green             (submit / reject sealed)
//   - abandoned       → red               (CR-1 invariant flipped status='abandoned')
//   - failed          → red               (envelope malformed)
//
// The kind pill defaults to '⚡ cross-clarify'.

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
} from '@agent-workflow/shared'
import { QuestionBadge } from './QuestionBadge'
import type { CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

export type CrossClarifyStatus = 'pending' | 'awaiting_human' | 'answered' | 'abandoned' | 'failed'

export interface CrossClarifyNodeData extends CanvasNodeData {
  statusOverlay?: CrossClarifyStatus
  kindLabel?: string
  description?: string
}

interface Props extends NodeProps {
  data: CrossClarifyNodeData
}

export function CrossClarifyNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const status: CrossClarifyStatus = data.statusOverlay ?? mapFallbackStatus(data.status)
  const labelText =
    data.kindLabel ?? `${NODE_GLYPHS['clarify-cross-agent']} ${t('crossClarifyNode.label')}`
  const toQuestionerLabel = t('crossClarify.canvas.handleLabel.toQuestioner')
  const toDesignerLabel = t('crossClarify.canvas.handleLabel.toDesigner')
  return (
    <div
      className={
        'canvas-node canvas-node--clarify-cross-agent' +
        (selected ? ' canvas-node--selected' : '') +
        ` canvas-node--clarify-cross-agent-${status}`
      }
      data-status={status}
      data-clarify-nav={data.clarifyNav}
      data-surface={data.surface}
      data-testid={`canvas-node-cross-clarify-${data.nodeId}`}
    >
      <QuestionBadge data={data} />
      <NodeValidationBadge data={data} />
      <Handle
        type="target"
        position={Position.Left}
        id={CROSS_CLARIFY_INPUT_PORT_NAME}
        className="canvas-node__handle canvas-node__handle--cross-clarify-input"
        aria-label="cross-clarify-input"
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
          clarify page. Absent on the editor canvas + non-clickable clarify nodes.
          Reuses the same clarifyNode.* i18n keys (both kinds jump to /clarify). */}
      {data.clarifyNav !== undefined && (
        <div className="canvas-node__clarify-nav muted">
          {data.clarifyNav === 'awaiting'
            ? t('clarifyNode.navAwaiting')
            : t('clarifyNode.navAnswered')}
        </div>
      )}
      {/* Two output handles stacked on the right edge. The `to_questioner`
          handle pairs with the auto-edge built by reverse-drag; the
          `to_designer` handle is the user's manual wiring to an upstream
          designer. RFC-007 reverse-drag UX: dragging FROM either handle
          onto a peer agent fires the cross-clarify connection classifier.
          The two adjacent labels — only shown on this node — disambiguate
          which output is which (2026-05-22 bug report: 输出的两个节点没有
          标识). Labels are absolutely positioned to mirror the Handle's
          inline `top:` so they vertically line up. */}
      <div
        className="canvas-node__cross-clarify-handle-label canvas-node__cross-clarify-handle-label--to-questioner"
        data-testid="cross-clarify-handle-label-to-questioner"
      >
        {toQuestionerLabel}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id={CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT}
        className="canvas-node__handle canvas-node__handle--cross-clarify-to-questioner"
        aria-label="cross-clarify-to-questioner"
        style={{ top: '40%' }}
      />
      <div
        className="canvas-node__cross-clarify-handle-label canvas-node__cross-clarify-handle-label--to-designer"
        data-testid="cross-clarify-handle-label-to-designer"
      >
        {toDesignerLabel}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id={CROSS_CLARIFY_OUT_TO_DESIGNER_PORT}
        className="canvas-node__handle canvas-node__handle--cross-clarify-to-designer"
        aria-label="cross-clarify-to-designer"
        style={{ top: '70%' }}
      />
    </div>
  )
}

function mapFallbackStatus(status: CanvasNodeData['status']): CrossClarifyStatus {
  if (status === 'failed') return 'failed'
  if (status === 'done') return 'answered'
  // The task-detail canvas collapses node_run `awaiting_human` to the unified
  // 'awaiting' hint (canvasStatus); translate it back to this node's own amber
  // `awaiting_human` state so a cross-clarify node parked for answers lights up.
  if (status === 'awaiting') return 'awaiting_human'
  if (status === 'running' || status === 'pending') return 'pending'
  return 'pending'
}
