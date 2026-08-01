// Renderer for agent-single nodes. (RFC-060 PR-E removed agent-multi.)

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { QuestionBadge } from './QuestionBadge'
import { ClarifyDirectiveToggle } from './ClarifyDirectiveToggle'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function AgentNode({ data, selected }: Props) {
  const { t } = useTranslation()
  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className="canvas-node--agent"
      icon={NODE_GLYPHS['agent-single']}
      kindLabel={t('agentNode.label')}
      title={data.title}
      titleTooltip={data.title}
      status={data.status ?? 'default'}
      loopBody={data.loopBody}
      overlays={<QuestionBadge data={data} />}
    >
      {/* RFC-122: per-(task, asking-node) clarify directive toggle — only on
          asking-agent nodes in the task canvas (data.clarifyDirective set). */}
      <ClarifyDirectiveToggle data={data} />
      <PortHandles
        side="left"
        ports={data.inputPorts}
        catchAll={{ id: INBOUND_HANDLE_ID }}
        previewPort={data.previewInputPort}
        reusePort={data.reuseInputPort}
      />
      <PortHandles side="right" ports={data.outputPorts} />
      {/* xyflow needs at least one Handle of each type for valid drag flows;
          the right-side PortHandles cover outputs but agent-single also needs
          a no-op top handle so future re-additions don't fight xyflow's
          handle caching. */}
      <Handle type="target" position={Position.Top} id="__noop_top__" style={{ opacity: 0 }} />
    </CanvasNodeCard>
  )
}
