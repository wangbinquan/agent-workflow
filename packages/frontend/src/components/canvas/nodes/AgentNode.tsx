// Renderer for agent-single and agent-multi nodes. The multi-process
// glyph + fan-out badge highlights that the runtime shards the
// sourcePort. M3 will turn the glyph live.

import type { NodeProps } from '@xyflow/react'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function AgentNode({ data, selected }: Props) {
  const multi = data.kind === 'agent-multi'
  return (
    <div
      className={`canvas-node canvas-node--agent ${multi ? 'canvas-node--multi' : ''} ${selected ? 'canvas-node--selected' : ''}`}
      data-status={data.status ?? 'default'}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">{multi ? '🔀 agent-multi' : 'agent'}</span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      <PortHandles side="left" ports={data.inputPorts} />
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
