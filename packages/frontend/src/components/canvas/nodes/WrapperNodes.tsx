// Wrappers — placeholders for M2; full inner-graph rendering lands in M3
// (P-3-XX). The placeholder shows the wrapper kind, the count of inner
// nodes, and the wrapper's output ports.

import type { NodeProps } from '@xyflow/react'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'

interface Props extends NodeProps {
  data: CanvasNodeData & { innerCount?: number }
}

export function GitWrapperNode({ data, selected }: Props) {
  return (
    <div
      className={`canvas-node canvas-node--wrapper canvas-node--wrapper-git ${selected ? 'canvas-node--selected' : ''}`}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">⎈ git wrapper</span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      <div className="canvas-node__id">{data.innerCount ?? 0} inner node(s)</div>
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}

export function LoopWrapperNode({ data, selected }: Props) {
  return (
    <div
      className={`canvas-node canvas-node--wrapper canvas-node--wrapper-loop ${selected ? 'canvas-node--selected' : ''}`}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">⟳ loop wrapper</span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      <div className="canvas-node__id">{data.innerCount ?? 0} inner node(s)</div>
      <PortHandles side="left" ports={data.inputPorts} />
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
