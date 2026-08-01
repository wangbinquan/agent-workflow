// RFC-243 PR-3 — call-workflow canvas renderer. A leaf node that invokes
// another workflow as an independent child task; its data ports mirror the
// CHILD definition (inputs = child workflow inputs, outputs = child output
// nodes' port union) resolved by useWorkflowRefResolver and pre-computed
// into data.inputPorts/outputPorts by WorkflowCanvas.computePorts — this
// renderer stays dumb, same contract as AgentNode.
//
// Left side keeps the catch-all inbound handle (RFC-003): named target
// handles are visual-only (RFC-106), so without the catch-all there would be
// no drag affordance for wiring upstream edges at all. A drop defaults the
// target port to the source port name; the validator's call-port rules flag
// any name that is not one of the child's declared inputs.

import { type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { WORKFLOW_ICON } from '@/components/icons/resourceIcons'
import type { CanvasNodeData } from './types'
import { CallResourceNodeCard } from './CallResourceNodeCard'

export interface CallWorkflowNodeData extends CanvasNodeData {
  /** Referenced child workflow name (authoritative selector, design §5.1). */
  workflowName?: string
}

interface Props extends NodeProps {
  data: CallWorkflowNodeData
}

export function CallWorkflowNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const workflowName = typeof data.workflowName === 'string' ? data.workflowName : ''
  return (
    <CallResourceNodeCard
      data={data}
      selected={selected}
      resourceKind="workflow"
      resourceIcon={WORKFLOW_ICON}
      kindLabel={t('callWorkflowNode.label')}
      referenceName={workflowName}
      unsetReferenceLabel={t('callWorkflowNode.unsetWorkflow')}
    />
  )
}
