// Output node — only input handles, one per declared port.

import type { NodeProps } from '@xyflow/react'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function OutputNode({ data, selected }: Props) {
  return (
    <div
      className={`canvas-node canvas-node--io canvas-node--output ${selected ? 'canvas-node--selected' : ''}`}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">⤴ output</span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      <PortHandles side="left" ports={data.inputPorts} />
    </div>
  )
}
