import type { ReactNode } from 'react'
import type { WorkflowNodeFieldKey } from '@agent-workflow/shared'
import { workflowInspectorFieldId, workflowInspectorPortId } from '@/lib/workflow-inspector-target'

export function InspectorFieldAnchor({
  nodeId,
  field,
  children,
}: {
  nodeId: string
  field: WorkflowNodeFieldKey
  children: ReactNode
}) {
  return (
    <div
      id={workflowInspectorFieldId(nodeId, field)}
      className="inspector__field-anchor"
      data-inspector-field={field}
      tabIndex={-1}
    >
      {children}
    </div>
  )
}

export function InspectorPortAnchor({
  nodeId,
  direction,
  portName,
  className,
  children,
}: {
  nodeId: string
  direction: 'input' | 'output'
  portName: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      id={workflowInspectorPortId(nodeId, direction, portName)}
      className={className}
      data-inspector-port={`${direction}:${portName}`}
      tabIndex={-1}
    >
      {children}
    </div>
  )
}
