// RFC-023 — only `title` and `description` are user-editable; the
// asking agent is linked via reverse-drag in the canvas (the system
// ports `__clarify__` / `__clarify_response__` carry that link).
// Ports are hard-coded ('questions' / 'answers') so we do NOT expose
// a port editor. Extracted verbatim from the NodeInspector EditForm switch
// by RFC-146 T3.

import type { WorkflowNode } from '@agent-workflow/shared'
import { CLARIFY_SOURCE_PORT_NAME, resolveClarifySessionMode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, TextArea } from '@/components/Form'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function ClarifyEdit({ node, definition, onPatch }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const description = typeof rec.description === 'string' ? rec.description : ''

  // Find the linked agent (if any) by walking edges for a `__clarify__`
  // source whose target is this clarify node. There can be at most one
  // by validator rule `clarify-multiple-clarify-on-same-agent`.
  const linkedAgentEdge = definition.edges.find(
    (e) => e.source.portName === CLARIFY_SOURCE_PORT_NAME && e.target.nodeId === node.id,
  )
  const linkedAgentId = linkedAgentEdge?.source.nodeId ?? null

  // Detect whether this clarify node sits inside any wrapper-loop's body
  // (so the validator's `clarify-no-iteration-cap` warning lines up).
  const enclosingLoop = definition.nodes.find((n) => {
    if (n.kind !== 'wrapper-loop') return false
    const ids = (n as Record<string, unknown>).nodeIds
    return Array.isArray(ids) && ids.includes(node.id)
  })
  const inLoop = enclosingLoop !== undefined

  function patchClarify(delta: Record<string, unknown>): void {
    onPatch({ ...(node as Record<string, unknown>), ...delta } as unknown as WorkflowNode)
  }

  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field
        label={t('inspector.fieldClarifyDescription')}
        hint={t('inspector.fieldClarifyDescriptionHint')}
      >
        <TextArea value={description} rows={2} onChange={(v) => patchClarify({ description: v })} />
      </Field>
      <Field label={t('inspector.fieldClarifyLinkedAgent')}>
        {linkedAgentId !== null ? (
          <div className="inspector__readonly">
            <code data-testid="clarify-linked-agent">{linkedAgentId}</code>
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--error"
            data-testid="clarify-linked-agent-missing"
          >
            {t('inspector.clarifyLinkedAgentMissing')}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('inspector.clarifyLinkedAgentHint')}
        </p>
      </Field>
      <Field label={t('inspector.fieldClarifyInLoop')}>
        {inLoop ? (
          <div className="inspector__readonly" data-testid="clarify-in-loop">
            {t('inspector.clarifyInLoopYes')}
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--warning"
            data-testid="clarify-in-loop-warning"
          >
            {t('inspector.clarifyInLoopNo')}
          </div>
        )}
      </Field>
      {/* RFC-026: clarify session mode (isolated vs inline). Missing
          field is normalised to 'isolated' (RFC-023 byte-for-byte). */}
      <Field
        label={t('inspector.fieldClarifySessionMode')}
        hint={t('inspector.clarifySessionModeHint')}
        group
      >
        <div
          className="segmented"
          role="radiogroup"
          aria-label={t('inspector.fieldClarifySessionMode')}
          data-testid="clarify-session-mode"
        >
          {(['isolated', 'inline'] as const).map((mode) => {
            // flag-audit W0：缺省归一走 shared 单源（其 docstring 明言就是为了
            // 阻止 `?? 'isolated'` 在各消费点 sprinkle）。
            const active =
              resolveClarifySessionMode(node as Parameters<typeof resolveClarifySessionMode>[0]) ===
              mode
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                className={'segmented__option' + (active ? ' segmented__option--active' : '')}
                data-testid={`clarify-session-mode-${mode}`}
                onClick={() => {
                  // Explicit field write keeps roundtripping deterministic:
                  // even 'isolated' is stored when the user clicks it, so
                  // the workflow.definition surfaces the user's choice.
                  patchClarify({ sessionMode: mode })
                }}
              >
                {mode === 'isolated'
                  ? t('inspector.clarifySessionModeIsolated')
                  : t('inspector.clarifySessionModeInline')}
              </button>
            )
          })}
        </div>
      </Field>
    </div>
  )
}
