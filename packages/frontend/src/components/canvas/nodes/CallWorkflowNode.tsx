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
import { NODE_GLYPHS } from '../nodePalette'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

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
    <div
      className={
        'canvas-node canvas-node--call-workflow' + (selected ? ' canvas-node--selected' : '')
      }
      data-status={data.status ?? 'default'}
      data-loop-body={data.loopBody ? 'true' : undefined}
      data-surface={data.surface}
    >
      <NodeValidationBadge data={data} />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {NODE_GLYPHS['call-workflow']} {t('callWorkflowNode.label')}
        </span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
      {/* Referenced-workflow line — mirrors ReviewNode's inputSource summary
          chrome so the card shows WHICH workflow it calls at a glance. */}
      <div className="canvas-node__input-source muted">
        {workflowName.length > 0 ? (
          <code>{workflowName}</code>
        ) : (
          <span>{t('callWorkflowNode.unsetWorkflow')}</span>
        )}
      </div>
      <PortHandles
        side="left"
        ports={data.inputPorts}
        catchAll={{ id: INBOUND_HANDLE_ID }}
        previewPort={data.previewInputPort}
        reusePort={data.reuseInputPort}
      />
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
