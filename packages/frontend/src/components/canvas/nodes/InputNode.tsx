// Input node — only an output handle on the right with the inputKey label.

import type { NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function InputNode({ data, selected }: Props) {
  const { t } = useTranslation()
  return (
    <div
      className={`canvas-node canvas-node--io canvas-node--input ${selected ? 'canvas-node--selected' : ''}`}
      data-surface={data.surface}
    >
      <NodeValidationBadge data={data} />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {NODE_GLYPHS.input} {t('ioNode.labelInput')}
        </span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
