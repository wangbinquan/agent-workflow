// RFC-242 PR-4 — call-workgroup canvas renderer. A leaf node that hands this
// DAG stage to a workgroup running as an independent child task. Unlike
// call-workflow (whose ports mirror the CHILD definition), its input ports
// are pure edge-derived prompt vars for the goalTemplate (agent-single
// precedent) and its output is the fixed `result` port declared by the
// shared PORT_DERIVERS table — this renderer stays dumb, same contract as
// AgentNode/CallWorkflowNode.
//
// Left side keeps the catch-all inbound handle (RFC-003): named target
// handles are visual-only (RFC-106), so without the catch-all there would be
// no drag affordance for wiring upstream edges at all. A drop mints a NEW
// deconflicted input name (dropTarget.acceptsNamedInputs includes this kind —
// the input set is OPEN, exactly like agent-single).

import { type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { NODE_GLYPHS } from '../nodePalette'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

export interface CallWorkgroupNodeData extends CanvasNodeData {
  /** Referenced workgroup name (authoritative selector, design §6.3). */
  workgroupName?: string
}

interface Props extends NodeProps {
  data: CallWorkgroupNodeData
}

export function CallWorkgroupNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const workgroupName = typeof data.workgroupName === 'string' ? data.workgroupName : ''
  return (
    <div
      className={
        'canvas-node canvas-node--call-workgroup' + (selected ? ' canvas-node--selected' : '')
      }
      data-status={data.status ?? 'default'}
      data-loop-body={data.loopBody ? 'true' : undefined}
      data-surface={data.surface}
    >
      <NodeValidationBadge data={data} />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {NODE_GLYPHS['call-workgroup']} {t('callWorkgroupNode.label')}
        </span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
      {/* Referenced-workgroup line — mirrors CallWorkflowNode's reference
          chrome so the card shows WHICH workgroup it calls at a glance. */}
      <div className="canvas-node__input-source muted">
        {workgroupName.length > 0 ? (
          <code>{workgroupName}</code>
        ) : (
          <span>{t('callWorkgroupNode.unsetWorkgroup')}</span>
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
