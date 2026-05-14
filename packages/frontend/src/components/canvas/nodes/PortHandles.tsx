// Shared port-handle stack rendered on either side of a node body.
// xyflow's <Handle> position requires absolute % coords; we space ports
// vertically and label them inline so the canvas is self-explanatory
// without a separate inspector.

import { Handle, Position } from '@xyflow/react'

interface Props {
  /** Side these handles attach to. */
  side: 'left' | 'right'
  ports: string[]
}

export function PortHandles({ side, ports }: Props) {
  if (ports.length === 0) return null
  const position = side === 'left' ? Position.Left : Position.Right
  const type = side === 'left' ? 'target' : 'source'
  // Distribute handles evenly across the node's vertical extent (5%..95%).
  const span = 90
  const step = ports.length === 1 ? 0 : span / (ports.length - 1)
  return (
    <div className={`canvas-node__ports canvas-node__ports--${side}`}>
      {ports.map((p, i) => {
        const top = ports.length === 1 ? 50 : 5 + step * i
        return (
          <div
            key={p}
            className={`canvas-node__port canvas-node__port--${side}`}
            style={{ top: `${top}%` }}
          >
            <Handle
              type={type}
              position={position}
              id={p}
              isConnectable={false}
              className="canvas-node__handle"
            />
            <span className="canvas-node__port-label">{p}</span>
          </div>
        )
      })}
    </div>
  )
}
