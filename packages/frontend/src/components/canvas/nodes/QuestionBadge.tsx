// RFC-120 D13 — on-canvas per-node pending-question badge. Shared by the
// "asking" node renderers (agent / clarify / cross-clarify) so the count pill
// + click-to-jump behavior stays identical across all of them (one source of
// truth, no per-node fork). Renders nothing when the count is 0 / undefined, so
// a canvas with no counts is byte-for-byte unchanged (golden-lock).
//
// It is a real <button> (a11y: keyboard + screen-reader reachable) anchored
// absolutely to the node's top-right corner. The onClick stops propagation so a
// badge click does NOT also select the node behind it — clicking it jumps to the
// task questions board filtered to this source node via data.onQuestionBadgeClick.

import { useTranslation } from 'react-i18next'
import type { CanvasNodeData } from './types'

export function QuestionBadge({ data }: { data: CanvasNodeData }) {
  const { t } = useTranslation()
  const count = data.questionCount ?? 0
  if (count <= 0) return null
  return (
    <button
      type="button"
      className="canvas-node__qbadge"
      data-testid={`canvas-qbadge-${data.nodeId}`}
      aria-label={t('taskQuestions.nodeBadgeAria', { count })}
      onClick={(e) => {
        e.stopPropagation()
        data.onQuestionBadgeClick?.(data.nodeId)
      }}
    >
      {count}
    </button>
  )
}
