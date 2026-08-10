// RFC-253 — script node canvas renderer.
//
// A leaf card like InputNode: the left side keeps the catch-all inbound handle
// (RFC-003) so an upstream edge has somewhere to land, and the right side
// renders the declared outlets (`outputs`, or the implicit single `stdout`)
// that WorkflowCanvas.computePorts pre-computed from `declaredPorts`.
//
// The badge row surfaces the interpreter, dependency count and readonly mode,
// which are otherwise invisible in the body preview.

import type { NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { NODE_GLYPHS } from '../nodePalette'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'

export interface ScriptNodeData extends CanvasNodeData {
  language?: string
  dependencyCount?: number
  scriptReadonly?: boolean
}

interface Props extends NodeProps {
  data: ScriptNodeData
}

export function ScriptNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const language =
    typeof data.language === 'string' && data.language.length > 0 ? data.language : '—'
  const deps = typeof data.dependencyCount === 'number' ? data.dependencyCount : 0
  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className="canvas-node--script"
      icon={NODE_GLYPHS.script}
      kindLabel={t('scriptNode.label')}
      title={data.title}
      titleTooltip={data.title}
      status={data.status}
      loopBody={data.loopBody}
    >
      <div className="canvas-node__script-badges">
        <span className="canvas-node__script-lang" data-testid="script-node-language">
          {language}
        </span>
        {deps > 0 ? (
          <span className="canvas-node__script-badge" data-testid="script-node-deps">
            {t('scriptNode.dependencyCount', { count: deps })}
          </span>
        ) : null}
        {data.scriptReadonly === true ? (
          <span className="canvas-node__script-badge" data-testid="script-node-readonly">
            {t('scriptNode.readonly')}
          </span>
        ) : null}
      </div>
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
