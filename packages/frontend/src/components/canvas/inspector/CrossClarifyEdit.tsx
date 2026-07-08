// RFC-056 cross-clarify node inspector — title + description (same as
// RFC-023) plus a segmented `sessionModeForQuestioner` selector. Mirrors
// the RFC-023 same-node clarify inspector's read-only status fields so the
// two detail panels stay visually aligned: linked questioner / linked
// designer / wrapper-loop containment. (The designer-rerun session toggle
// was removed by RFC-056 patch 2026-06-22 — it was dead config; the
// designer rerun is always isolated.) Extracted verbatim from the
// NodeInspector EditForm switch by RFC-146 T3.

import type { WorkflowNode } from '@agent-workflow/shared'
import {
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, TextArea } from '@/components/Form'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function CrossClarifyEdit({ node, definition, onPatch }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const description = typeof rec.description === 'string' ? rec.description : ''
  const sessionModeForQuestioner =
    typeof rec.sessionModeForQuestioner === 'string' &&
    (rec.sessionModeForQuestioner === 'inline' || rec.sessionModeForQuestioner === 'isolated')
      ? (rec.sessionModeForQuestioner as 'inline' | 'isolated')
      : 'isolated'

  // Linked questioner (auto-edge from questioner.__clarify__ →
  // cross.questions) and linked designer (manual edge from cross.to_designer
  // → designer.__external_feedback__) — same data-source the validator and
  // runtime use.
  const linkedQuestionerId = findQuestionerNodeForCrossClarify(definition, node.id) ?? null
  const linkedDesignerId = findDesignerNodeForCrossClarify(definition, node.id) ?? null

  // wrapper-loop containment, identical to the same-node clarify branch.
  const enclosingLoop = definition.nodes.find((n) => {
    if (n.kind !== 'wrapper-loop') return false
    const ids = (n as Record<string, unknown>).nodeIds
    return Array.isArray(ids) && ids.includes(node.id)
  })
  const inLoop = enclosingLoop !== undefined

  function patchCrossClarify(delta: Record<string, unknown>): void {
    onPatch({ ...(node as Record<string, unknown>), ...delta } as unknown as WorkflowNode)
  }

  return (
    <div className="form-grid" data-testid="cross-clarify-inspector">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field
        label={t('inspector.fieldClarifyDescription')}
        hint={t('inspector.fieldClarifyDescriptionHint')}
      >
        <TextArea
          value={description}
          rows={2}
          onChange={(v) => patchCrossClarify({ description: v })}
        />
      </Field>
      <Field label={t('crossClarify.inspector.fieldLinkedQuestioner')}>
        {linkedQuestionerId !== null ? (
          <div className="inspector__readonly">
            <code data-testid="cross-clarify-linked-questioner">{linkedQuestionerId}</code>
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--error"
            data-testid="cross-clarify-linked-questioner-missing"
          >
            {t('crossClarify.inspector.linkedQuestionerMissing')}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('crossClarify.inspector.linkedQuestionerHint')}
        </p>
      </Field>
      <Field label={t('crossClarify.inspector.fieldLinkedDesigner')}>
        {linkedDesignerId !== null ? (
          <div className="inspector__readonly">
            <code data-testid="cross-clarify-linked-designer">{linkedDesignerId}</code>
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--error"
            data-testid="cross-clarify-linked-designer-missing"
          >
            {t('crossClarify.inspector.linkedDesignerMissing')}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('crossClarify.inspector.linkedDesignerHint')}
        </p>
      </Field>
      <Field label={t('crossClarify.inspector.fieldInLoop')}>
        {inLoop ? (
          <div className="inspector__readonly" data-testid="cross-clarify-in-loop">
            {t('crossClarify.inspector.inLoopYes')}
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--warning"
            data-testid="cross-clarify-in-loop-warning"
          >
            {t('crossClarify.inspector.inLoopNo')}
          </div>
        )}
      </Field>
      <Field
        label={t('crossClarify.inspector.sessionModeForQuestioner')}
        hint={t('crossClarify.inspector.sessionModeHint')}
        group
      >
        <div
          className="segmented"
          role="radiogroup"
          aria-label={t('crossClarify.inspector.sessionModeForQuestioner')}
          data-testid="cross-clarify-session-mode-questioner"
        >
          {(['isolated', 'inline'] as const).map((mode) => {
            const active = sessionModeForQuestioner === mode
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                className={'segmented__option' + (active ? ' segmented__option--active' : '')}
                data-testid={`cross-clarify-session-mode-questioner-${mode}`}
                onClick={() => patchCrossClarify({ sessionModeForQuestioner: mode })}
              >
                {mode === 'isolated'
                  ? t('crossClarify.inspector.sessionModeIsolated')
                  : t('crossClarify.inspector.sessionModeInline')}
              </button>
            )
          })}
        </div>
      </Field>
    </div>
  )
}
