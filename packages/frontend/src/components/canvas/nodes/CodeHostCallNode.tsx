// RFC-269 — code-host call node canvas renderer.
//
// A leaf card shaped like ScriptNode: the left side keeps the catch-all inbound
// handle (RFC-003) so an upstream edge has somewhere to land, the right side
// renders the two fixed outlets (`response` / `status`).
//
// The badge row shows the two facts that decide **what this node does to the
// outside world** and are invisible from the title: which code host it acts on,
// and which action it performs. An author scanning a canvas should be able to
// tell "this one merges an MR on GitLab" from "this one just reads a diff"
// without opening the drawer.

import type { NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { NODE_GLYPHS } from '../nodePalette'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'

export interface CodeHostCallNodeData extends CanvasNodeData {
  provider?: string
  action?: string
  /** true ⇒ the node may issue destructive (DELETE) requests. */
  destructive?: boolean
}

interface Props extends NodeProps {
  data: CodeHostCallNodeData
}

export function CodeHostCallNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const provider =
    typeof data.provider === 'string' && data.provider.length > 0 ? data.provider : '—'
  const action = typeof data.action === 'string' && data.action.length > 0 ? data.action : '—'
  return (
    <CanvasNodeCard
      data={data}
      selected={selected}
      className="canvas-node--code-host"
      icon={NODE_GLYPHS['code-host-call']}
      kindLabel={t('codeHostNode.label')}
      title={data.title}
      titleTooltip={data.title}
      status={data.status}
      loopBody={data.loopBody}
    >
      <div className="canvas-node__script-badges">
        <span className="canvas-node__script-lang" data-testid="code-host-node-provider">
          {provider}
        </span>
        <span className="canvas-node__script-badge" data-testid="code-host-node-action">
          {t(`codeHostAction.${action.replace('.', '_')}`, { defaultValue: action })}
        </span>
        {data.destructive === true ? (
          <span
            className="canvas-node__script-badge canvas-node__script-badge--deny"
            data-testid="code-host-node-destructive"
          >
            {t('codeHostNode.destructive')}
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
