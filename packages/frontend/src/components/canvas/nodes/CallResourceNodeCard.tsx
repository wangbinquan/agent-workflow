import type { ReactNode } from 'react'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'
import { CanvasNodeReferenceBand } from './CanvasNodeReferenceBand'

interface CallResourceNodeCardProps {
  data: CanvasNodeData
  selected: boolean
  resourceKind: 'workflow' | 'workgroup'
  resourceIcon: ReactNode
  kindLabel: string
  referenceName: string
  unsetReferenceLabel: string
  /**
   * RFC-245: "click to open the child task" hint text. Rendered only when the
   * task-detail canvas marked this node clickable (`data.callNav`). Passed in
   * (rather than translated here) so this shared shell stays dumb — the same
   * contract CanvasNodeCard / CanvasNodeReferenceBand keep.
   */
  navHintLabel: string
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
  navHintLabel,
}: CallResourceNodeCardProps) {
  const hasReference = referenceName.length > 0
  const displayTitle = data.title || data.nodeId
  // RFC-245: the task-detail canvas marks the click target; clicking routes to
  // the child task. Absent on the editor canvas and on call nodes with no
  // reachable child (which are simply inert — no drawer fallback, design D1).
  const callNav = data.callNav

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
      dataAttributes={{
        'data-reference-state': hasReference ? 'resolved' : 'unset',
        ...(callNav === undefined ? {} : { 'data-call-nav': callNav }),
      }}
    >
      <CanvasNodeReferenceBand
        displayTitle={displayTitle}
        referenceName={referenceName}
        unsetReferenceLabel={unsetReferenceLabel}
      />
      <PortHandles
        side="left"
        ports={data.inputPorts}
        catchAll={{ id: INBOUND_HANDLE_ID }}
        previewPort={data.previewInputPort}
        reusePort={data.reuseInputPort}
      />
      <PortHandles side="right" ports={data.outputPorts} />
      {callNav !== undefined && <div className="canvas-node__call-nav muted">{navHintLabel}</div>}
    </CanvasNodeCard>
  )
}
