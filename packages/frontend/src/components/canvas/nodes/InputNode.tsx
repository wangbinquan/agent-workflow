// Input node — only an output handle on the right with the inputKey label.

import type { NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function InputNode({ data, selected }: Props) {
  const { t } = useTranslation()
  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className="canvas-node--io canvas-node--input"
      // RFC-306: IO nodes must carry their run status like every other kind —
      // a `skipped` output node (its branch was closed) has to read as not-run on
      // the canvas. Before this they rendered status-less, which was invisible
      // only because `skipped` had no producer.
      status={data.status ?? 'default'}
      icon={NODE_GLYPHS.input}
      kindLabel={t('ioNode.labelInput')}
      title={data.title}
      titleTooltip={data.title}
    >
      <PortHandles side="right" ports={data.outputPorts} />
    </CanvasNodeCard>
  )
}
