import type { ReactNode } from 'react'

interface CanvasNodeFactBandProps {
  children: ReactNode
  className?: string
}

/**
 * Shared secondary-information band for card-shaped canvas nodes.
 *
 * Resource references and integration actions have different semantics, but
 * they need the same bounded, scan-friendly visual hierarchy. Keeping the
 * chrome here prevents each new node kind from inventing another badge row.
 */
export function CanvasNodeFactBand({ children, className }: CanvasNodeFactBandProps) {
  return (
    <div className={`canvas-node__fact-band${className === undefined ? '' : ` ${className}`}`}>
      <span className="canvas-node__fact-band-indicator" aria-hidden="true" />
      <div className="canvas-node__fact-band-content">{children}</div>
    </div>
  )
}
