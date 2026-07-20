// Review node — RFC-005 PR-D T29; left-side input handle added in RFC-007.
//
// Visually similar to InputNode + OutputNode (the "IO" family) but in the
// "Human" category: shows the title, the id, the configured input source
// `nodeId.portName`, and the two output ports (`approved_doc`,
// `approval_meta`) on the right.
//
// RFC-007: a single named target Handle (id = `__review_input__`) is
// rendered on the left so the review's evaluation target can be wired by
// drag instead of forcing the user into the inspector. The connect
// handler in WorkflowCanvas writes both the edge AND `inputSource`
// atomically, so the schema-level "explicit upstream reference" guarantee
// (see review.ts ReviewNodeSchema.inputSource) is preserved.

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { REVIEW_INPUT_HANDLE_ID } from '../connectionSync'
import type { CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function ReviewNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const inputSource =
    (data as CanvasNodeData & { inputSource?: { nodeId: string; portName: string } }).inputSource ??
    null
  // RFC-158: task-detail canvas marks the click target; clicking routes to the
  // review page. Absent on the editor canvas and on non-clickable reviews.
  const reviewNav = data.reviewNav
  return (
    <div
      className={'canvas-node canvas-node--review' + (selected ? ' canvas-node--selected' : '')}
      data-status={data.status ?? 'default'}
      data-review-nav={reviewNav}
      data-surface={data.surface}
    >
      <NodeValidationBadge data={data} />
      <Handle
        type="target"
        position={Position.Left}
        id={REVIEW_INPUT_HANDLE_ID}
        className="canvas-node__handle canvas-node__handle--review-input"
        aria-label="review-input"
      />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {NODE_GLYPHS.review} {t('reviewNode.label')}
        </span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
      {inputSource !== null &&
        (inputSource.nodeId.length > 0 || inputSource.portName.length > 0) && (
          <div className="canvas-node__input-source muted">
            <code>
              {data.surface === 'editor'
                ? ((data as CanvasNodeData & { inputSourceTitle?: string }).inputSourceTitle ?? '?')
                : inputSource.nodeId || '?'}
            </code>
            <span>.</span>
            <code>{inputSource.portName || '?'}</code>
          </div>
        )}
      <PortHandles side="right" ports={data.outputPorts} />
      {reviewNav !== undefined && (
        <div className="canvas-node__review-nav muted">
          {reviewNav === 'awaiting' ? t('reviewNode.navAwaiting') : t('reviewNode.navDecided')}
        </div>
      )}
    </div>
  )
}
