// Renderer for agent-single nodes. (RFC-060 PR-E removed agent-multi.)

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { QuestionBadge } from './QuestionBadge'
import { ClarifyDirectiveToggle } from './ClarifyDirectiveToggle'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function AgentNode({ data, selected }: Props) {
  const { t } = useTranslation()
  return (
    <div
      className={`canvas-node canvas-node--agent ${selected ? 'canvas-node--selected' : ''}`}
      data-status={data.status ?? 'default'}
      data-loop-body={data.loopBody ? 'true' : undefined}
      data-surface={data.surface}
    >
      <QuestionBadge data={data} />
      <NodeValidationBadge data={data} />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {NODE_GLYPHS['agent-single']} {t('agentNode.label')}
        </span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
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
    </div>
  )
}
