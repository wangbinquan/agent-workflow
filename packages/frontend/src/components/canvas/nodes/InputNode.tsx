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
      icon={NODE_GLYPHS.input}
      kindLabel={t('ioNode.labelInput')}
      title={data.title}
      titleTooltip={data.title}
    >
      <PortHandles side="right" ports={data.outputPorts} />
    </CanvasNodeCard>
  )
}
