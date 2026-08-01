import type { ReactNode } from 'react'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'

interface CallResourceNodeCardProps {
  data: CanvasNodeData
  selected: boolean
  resourceKind: 'workflow' | 'workgroup'
  resourceIcon: ReactNode
  kindLabel: string
  referenceName: string
  unsetReferenceLabel: string
}

/**
 * Shared canvas chrome for resource-call nodes.
 *
 * The call nodes intentionally keep the same PortHandles contract as an
 * AgentNode; this component only owns their visual hierarchy: resource icon,
 * call identity, configuration summary and the referenced-resource band.
 */
export function CallResourceNodeCard({
  data,
  selected,
  resourceKind,
  resourceIcon,
  kindLabel,
  referenceName,
  unsetReferenceLabel,
}: CallResourceNodeCardProps) {
  const hasReference = referenceName.length > 0
  const displayTitle = data.title || data.nodeId
  // nodeTitle() uses the referenced resource as the default canvas title.
  // Repeating that same value in the reference band adds no information; the
  // band is useful only for an explicit alias or for the actionable unset
  // state.
  const showReferenceBand = !hasReference || displayTitle !== referenceName

  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className={`canvas-node--call canvas-node--call-${resourceKind}`}
      icon={resourceIcon}
      iconClassName="canvas-node__call-icon"
      identityClassName="canvas-node__call-identity"
      kindLabel={kindLabel}
      title={displayTitle}
      titleTooltip={displayTitle}
      status={data.status ?? 'default'}
      loopBody={data.loopBody}
      dataAttributes={{ 'data-reference-state': hasReference ? 'resolved' : 'unset' }}
    >
      {showReferenceBand ? (
        <div className="canvas-node__call-reference">
          <span className="canvas-node__call-reference-indicator" aria-hidden="true" />
          {hasReference ? (
            <code title={referenceName}>{referenceName}</code>
          ) : (
            <span>{unsetReferenceLabel}</span>
          )}
        </div>
      ) : null}
      <PortHandles
        side="left"
        ports={data.inputPorts}
        catchAll={{ id: INBOUND_HANDLE_ID }}
        previewPort={data.previewInputPort}
        reusePort={data.reuseInputPort}
      />
      <PortHandles side="right" ports={data.outputPorts} />
    </CanvasNodeCard>
  )
}
