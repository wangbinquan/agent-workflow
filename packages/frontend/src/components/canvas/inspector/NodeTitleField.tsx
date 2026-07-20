// Shared display-name input rendered above every kind-specific form.
// Writes go through onPatch so review/clarify (which already used the same
// `title` field) continue to roundtrip identically; agent-single / input /
// output / wrappers opt in via the same key.

import type { WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, TextInput } from '@/components/Form'
import {
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'

export function NodeTitleField({
  node,
  onPatch,
  onHistoryBoundary,
}: {
  node: WorkflowNode
  onPatch: (next: WorkflowNode, meta: InspectorChangeMeta) => void
  onHistoryBoundary: (meta: InspectorChangeMeta) => void
}) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const nodeTitle = typeof rec.title === 'string' ? rec.title : ''
  const meta = continuousNodeInspectorChange(node.id, 'title', t('inspector.fieldNodeTitle'))
  return (
    <InspectorFieldAnchor nodeId={node.id} field="title">
      <Field label={t('inspector.fieldNodeTitle')} hint={t('inspector.fieldNodeTitleHint')}>
        <InspectorHistoryBoundary meta={meta} onBoundary={onHistoryBoundary}>
          <TextInput
            value={nodeTitle}
            onChange={(v) => {
              // Strip the field entirely when the user blanks it so the canvas
              // falls back to the kind-specific derivation (agentName etc.).
              const next = { ...(node as Record<string, unknown>) }
              if (v.length === 0) delete next.title
              else next.title = v
              onPatch(next as unknown as WorkflowNode, meta)
            }}
          />
        </InspectorHistoryBoundary>
      </Field>
    </InspectorFieldAnchor>
  )
}
