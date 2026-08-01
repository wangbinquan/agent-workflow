import type { ReactNode } from 'react'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'
import { NodeValidationBadge } from './NodeValidationBadge'
import type { CanvasNodeData } from './types'

type DataAttributes = Partial<Record<`data-${string}`, string>>

interface CanvasNodeCardProps {
  data: CanvasNodeData
  selected: boolean
  className: string
  icon: ReactNode
  kindLabel: ReactNode
  title: ReactNode
  titleTooltip?: string
  status?: string
  loopBody?: boolean
  overlays?: ReactNode
  children?: ReactNode
  dataAttributes?: DataAttributes
  iconClassName?: string
  identityClassName?: string
}

/**
 * Shared visual and semantic shell for every card-shaped canvas node.
 *
 * Node renderers keep ownership of their ports and specialised controls;
 * this shell owns the repeated card chrome so a new kind cannot silently
 * fall back to the old text-only header again. Group wrappers are deliberately
 * excluded because they are resizable containers rather than cards.
 */
export function CanvasNodeCard({
  data,
  selected,
  className,
  icon,
  kindLabel,
  title,
  titleTooltip,
  status,
  loopBody,
  overlays,
  children,
  dataAttributes,
  iconClassName,
  identityClassName,
}: CanvasNodeCardProps) {
  return (
    <div
      className={`canvas-node canvas-node--card ${className}${selected ? ' canvas-node--selected' : ''}`}
      data-node-kind={data.kind}
      data-status={status}
      data-loop-body={loopBody ? 'true' : undefined}
      data-surface={data.surface}
      {...dataAttributes}
    >
      {overlays}
      <NodeValidationBadge data={data} />
      <div className="canvas-node__header">
        <span
          className={`canvas-node__icon${iconClassName ? ` ${iconClassName}` : ''}`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <span
          className={`canvas-node__identity${identityClassName ? ` ${identityClassName}` : ''}`}
        >
          <span className="canvas-node__kind">{kindLabel}</span>
          <span className="canvas-node__title" title={titleTooltip}>
            {title}
          </span>
        </span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
      {children}
    </div>
  )
}
