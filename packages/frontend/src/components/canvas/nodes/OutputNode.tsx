// Output node — one named target handle per declared port, PLUS a catch-all
// left strip (RFC-007) so a freshly-dropped output node (`ports: []`) still
// has somewhere to land an inbound edge. Drops on the catch-all auto-create
// a new port named after the upstream output port; see
// `applyConnectionForReviewOutput` in components/canvas/connectionSync.ts.

import type { NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { NodeValidationBadge } from './NodeValidationBadge'
import { NodeConfigurationSummary } from './NodeConfigurationSummary'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function OutputNode({ data, selected }: Props) {
  const { t } = useTranslation()
  return (
    <div
      className={`canvas-node canvas-node--io canvas-node--output ${selected ? 'canvas-node--selected' : ''}`}
      data-surface={data.surface}
    >
      <NodeValidationBadge data={data} />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">
          {NODE_GLYPHS.output} {t('ioNode.labelOutput')}
        </span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      {data.surface === 'editor' ? (
        <NodeConfigurationSummary data={data} />
      ) : (
        <div className="canvas-node__id">{data.nodeId}</div>
      )}
      <PortHandles
        side="left"
        ports={data.inputPorts}
        catchAll={{ id: INBOUND_HANDLE_ID }}
        previewPort={data.previewInputPort}
        reusePort={data.reuseInputPort}
      />
    </div>
  )
}
