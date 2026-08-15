// RFC-304 — canvas renderer for the synthesized `code-round` node.
//
// This node is NEVER authored by a user: it is the single node of the workflow
// snapshot that `startCodeRoundTask` synthesizes, and the validator rejects the
// kind in any user-submitted definition. It still needs a renderer because the
// task detail page draws the snapshot of whatever task you are looking at —
// the same reason the synthesized agent-host nodes render.
//
// So the card is deliberately terse: it names the capability and the round, and
// says outright that the interesting structure lives one level down (the stage
// sequence, on the /code state view). Trying to reproduce the stage list here
// would duplicate that view and immediately drift from it.

import type { NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { NODE_GLYPHS } from '../nodePalette'
import { type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'
import { CanvasNodeFactBand } from './CanvasNodeFactBand'

export interface CodeRoundNodeData extends CanvasNodeData {
  /** Which capability this round runs (`mr-review` / `ci-fix` / …). */
  capability?: string
  /** 1-based round number within the work item. */
  roundSeq?: number
}

interface Props extends NodeProps {
  data: CodeRoundNodeData
}

export function CodeRoundNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const capability =
    typeof data.capability === 'string' && data.capability.length > 0 ? data.capability : '—'
  const capabilityLabel =
    capability === '—'
      ? capability
      : t(`codeCapability.${capability.replace('-', '_')}`, { defaultValue: capability })
  const roundSeq = typeof data.roundSeq === 'number' ? data.roundSeq : null
  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className="canvas-node--code-round"
      icon={NODE_GLYPHS['code-round']}
      kindLabel={t('codeRoundNode.label')}
      title={data.title}
      titleTooltip={data.title}
      status={data.status}
      loopBody={data.loopBody}
      dataAttributes={{ 'data-code-capability': capability }}
    >
      <CanvasNodeFactBand className="canvas-node__code-round-meta">
        <span
          className="canvas-node__code-round-capability"
          data-testid="code-round-node-capability"
        >
          {capabilityLabel}
        </span>
        {roundSeq !== null ? (
          <code className="canvas-node__code-round-seq" data-testid="code-round-node-seq">
            #{roundSeq}
          </code>
        ) : null}
      </CanvasNodeFactBand>
    </CanvasNodeCard>
  )
}
