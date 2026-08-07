// RFC-269 — code-host call node canvas renderer.
//
// A leaf card shaped like ScriptNode: the left side keeps the catch-all inbound
// handle (RFC-003) so an upstream edge has somewhere to land, the right side
// renders the two fixed outlets (`response` / `status`).
//
// The fact band shows the provider, HTTP method, and (when a custom title hides
// it) the action. An author scanning a canvas should be able to tell "this one
// merges an MR on GitLab" from "this one just reads a diff" without opening
// the drawer. Unsupported-provider and DELETE states stay explicit on-card.

import type { NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { NODE_GLYPHS } from '../nodePalette'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { CanvasNodeCard } from './CanvasNodeCard'
import { CanvasNodeFactBand } from './CanvasNodeFactBand'

export interface CodeHostCallNodeData extends CanvasNodeData {
  provider?: string
  action?: string
  method?: string
  /** true ⇒ the configured request itself uses DELETE. */
  destructive?: boolean
  /** true ⇒ the selected provider has no binding for this action. */
  unsupported?: boolean
}

interface Props extends NodeProps {
  data: CodeHostCallNodeData
}

export function CodeHostCallNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const provider =
    typeof data.provider === 'string' && data.provider.length > 0 ? data.provider : '—'
  const action = typeof data.action === 'string' && data.action.length > 0 ? data.action : '—'
  const providerLabel =
    provider === '—'
      ? provider
      : t(`codeHostProvider.${provider}`, {
          defaultValue: provider,
        })
  const actionLabel =
    action === '—'
      ? action
      : t(`codeHostAction.${action.replace('.', '_')}`, { defaultValue: action })
  const method = typeof data.method === 'string' && data.method.length > 0 ? data.method : null
  const showActionDetail = data.title !== actionLabel
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
      dataAttributes={{
        'data-code-host-provider': provider,
        'data-support-state': data.unsupported === true ? 'unsupported' : 'supported',
      }}
    >
      <CanvasNodeFactBand className="canvas-node__code-host-operation">
        <div className="canvas-node__code-host-meta">
          <span className="canvas-node__code-host-provider" data-testid="code-host-node-provider">
            {providerLabel}
          </span>
          {method !== null ? (
            <code className="canvas-node__code-host-method" data-testid="code-host-node-method">
              {method}
            </code>
          ) : null}
        </div>
        {showActionDetail ? (
          <span
            className="canvas-node__code-host-action"
            data-testid="code-host-node-action"
            title={actionLabel}
          >
            {actionLabel}
          </span>
        ) : null}
      </CanvasNodeFactBand>
      {data.unsupported === true || data.destructive === true ? (
        <div className="canvas-node__code-host-flags">
          {data.unsupported === true ? (
            <span className="canvas-node__code-host-flag" data-testid="code-host-node-unsupported">
              {t('codeHostNode.unsupported')}
            </span>
          ) : null}
          {data.destructive === true ? (
            <span className="canvas-node__code-host-flag" data-testid="code-host-node-destructive">
              {t('codeHostNode.destructive')}
            </span>
          ) : null}
        </div>
      ) : null}
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
