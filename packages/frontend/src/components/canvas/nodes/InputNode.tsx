// Input node — only an output handle on the right with the inputKey label.

import type { NodeProps } from '@xyflow/react'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function InputNode({ data, selected }: Props) {
  return (
    <div
      className={`canvas-node canvas-node--io canvas-node--input ${selected ? 'canvas-node--selected' : ''}`}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">↳ input</span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
