import { resolveClarifyInteractionMode, type WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, TextArea } from '@/components/Form'
import { ChipsInput } from '@/components/ChipsInput'
import { Segmented } from '@/components/Segmented'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
} from './historyMeta'
import type { EditProps } from './types'

export function ClarifyModeEdit({
  node,
  onPatch,
  onHistoryBoundary,
}: Pick<EditProps, 'node' | 'onPatch' | 'onHistoryBoundary'>) {
  const { t } = useTranslation()
  const mode = resolveClarifyInteractionMode({ interactionMode: node.interactionMode })
  const raw =
    node.mindmap && typeof node.mindmap === 'object'
      ? (node.mindmap as Record<string, unknown>)
      : {}
  const config = {
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((value): value is string => typeof value === 'string')
      : [],
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
  }
  const patch = (delta: Record<string, unknown>, field: string, continuous = false) =>
    onPatch(
      { ...node, ...delta } as WorkflowNode,
      (continuous ? continuousNodeInspectorChange : atomicNodeInspectorChange)(
        node.id,
        field,
        t('mindmap.interactionMode'),
      ),
    )
  const meta = continuousNodeInspectorChange(
    node.id,
    'mindmap.instructions',
    t('mindmap.instructions'),
  )
  return (
    <>
      <Field label={t('mindmap.interactionMode')} hint={t('mindmap.interactionModeHint')} group>
        <Segmented
          value={mode}
          onChange={(interactionMode) =>
            patch(
              { interactionMode, ...(interactionMode === 'mindmap' ? { mindmap: config } : {}) },
              'interactionMode',
            )
          }
          ariaLabel={t('mindmap.interactionMode')}
          options={[
            { value: 'questions', label: t('mindmap.questionsMode') },
            { value: 'mindmap', label: t('mindmap.mindmapMode') },
          ]}
        />
      </Field>
      {mode === 'mindmap' && (
        <>
          <Field label={t('mindmap.categories')} hint={t('mindmap.categoriesHint')} group>
            <ChipsInput
              value={config.categories}
              ariaLabel={t('mindmap.categories')}
              validate={(token) =>
                token.length > 120 || config.categories.length >= 40
                  ? t('mindmap.categoryLimit')
                  : null
              }
              onChange={(categories) =>
                patch({ mindmap: { ...config, categories } }, 'mindmap.categories')
              }
            />
          </Field>
          <Field label={t('mindmap.instructions')}>
            <InspectorHistoryBoundary meta={meta} onBoundary={onHistoryBoundary}>
              <TextArea
                value={config.instructions}
                rows={3}
                maxLength={8000}
                onChange={(instructions) =>
                  patch({ mindmap: { ...config, instructions } }, 'mindmap.instructions', true)
                }
              />
            </InspectorHistoryBoundary>
          </Field>
        </>
      )}
    </>
  )
}
