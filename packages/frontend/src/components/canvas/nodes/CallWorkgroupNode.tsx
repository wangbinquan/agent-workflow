// RFC-243 PR-4 — call-workgroup canvas renderer. A leaf node that hands this
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
import { WORKGROUP_ICON } from '@/components/icons/resourceIcons'
import type { CanvasNodeData } from './types'
import { CallResourceNodeCard } from './CallResourceNodeCard'

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
    <CallResourceNodeCard
      data={data}
      selected={selected}
      resourceKind="workgroup"
      resourceIcon={WORKGROUP_ICON}
      kindLabel={t('callWorkgroupNode.label')}
      referenceName={workgroupName}
      unsetReferenceLabel={t('callWorkgroupNode.unsetWorkgroup')}
      navHintLabel={t('callNode.navChild')}
    />
  )
}
