// Port-handle renderer for canvas nodes. RFC-006 reshapes the layout:
// the old version absolutely positioned each port as a chip on a strip
// that hung off the node's outer edge (left: -6px / right: -6px), and
// the chip text extended back into the node body — covering the title
// and node-id. We now render ports as inline rows INSIDE the node body
// (handle dot pinned to the row edge via CSS, label inside the row),
// so labels never overlap header text and node height grows naturally
// with port count. Long names truncate with ellipsis + native title
// tooltip. The RFC-003 catch-all left strip is preserved as a sibling
// of the rows container so fresh agent / wrapper-loop nodes still
// accept the first inbound edge anywhere along the left edge.
//
// Public API (Props.side / ports / catchAll) is unchanged so the four
// node components calling this stay identical.

import { Handle, Position } from '@xyflow/react'

interface Props {
  /** Side these handles attach to. */
  side: 'left' | 'right'
  ports: string[]
  /**
   * When set, render an extra invisible target Handle covering the full
   * left edge so the first edge into a fresh node has somewhere to
   * land. Only honored when `side === 'left'`. Named handles take hit
   * priority (z-index 1 > 0) so fan-in drops still hit the precise
   * port. See RFC-003.
   */
  catchAll?: { id: string }
}

export function PortHandles({ side, ports, catchAll }: Props) {
  const showCatchAll = side === 'left' && catchAll !== undefined
  if (ports.length === 0 && !showCatchAll) return null
  const position = side === 'left' ? Position.Left : Position.Right
  const type = side === 'left' ? 'target' : 'source'
  return (
    <>
      {showCatchAll && (
        <div className="canvas-node__inbound-catchall">
          <Handle
            type="target"
            position={Position.Left}
            id={catchAll!.id}
            className="canvas-node__handle canvas-node__handle--catchall"
            aria-hidden="true"
          />
        </div>
      )}
      {ports.length > 0 && (
        <div className={`canvas-node__port-rows canvas-node__port-rows--${side}`}>
          {ports.map((p) => (
            <div key={p} className={`canvas-node__port-row canvas-node__port-row--${side}`}>
              <Handle type={type} position={position} id={p} className="canvas-node__handle" />
              <span className="canvas-node__port-label" title={p}>
                {p}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
