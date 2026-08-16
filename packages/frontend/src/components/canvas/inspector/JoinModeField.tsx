// RFC-306 — how this node reacts when only SOME of its inbound edges carried a
// value. Rendered next to the display name for every kind that can sit
// downstream of a branch.
//
// Only shown when the node actually HAS two or more inbound dependencies:
// with one inbound edge the two modes are identical, and offering a choice that
// changes nothing is worse than offering none — the author would reasonably
// conclude the setting is broken.

import {
  joinModeOf,
  type JoinMode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { atomicNodeInspectorChange, type InspectorChangeMeta } from './historyMeta'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'

/** Inbound dependency count as the AUTHOR sees it: edges plus the implicit
 *  bindings review/output nodes carry (they have no edges of their own). */
function inboundCount(definition: WorkflowDefinition, node: WorkflowNode): number {
  const edges = definition.edges.filter((e) => e.target.nodeId === node.id).length
  const rec = node as unknown as Record<string, unknown>
  if (node.kind === 'review') return edges + (rec.inputSource === undefined ? 0 : 1)
  if (node.kind === 'output' && Array.isArray(rec.ports)) {
    return edges + (rec.ports as unknown[]).filter((p) => (p as { bind?: unknown })?.bind).length
  }
  return edges
}

export function JoinModeField({
  node,
  definition,
  onPatch,
}: {
  node: WorkflowNode
  definition: WorkflowDefinition
  onPatch: (next: WorkflowNode, meta: InspectorChangeMeta) => void
}) {
  const { t } = useTranslation()
  if (inboundCount(definition, node) < 2) return null
  const current = joinModeOf(node as { joinMode?: unknown })
  const set = (mode: JoinMode) => {
    const next = { ...(node as Record<string, unknown>) }
    // 'any' is the default — strip the field rather than persisting it, so a
    // definition that never touched this setting stays byte-identical.
    if (mode === 'any') delete next.joinMode
    else next.joinMode = mode
    onPatch(
      next as unknown as WorkflowNode,
      atomicNodeInspectorChange(node.id, 'joinMode', t('inspector.fieldJoinMode')),
    )
  }
  return (
    <InspectorFieldAnchor nodeId={node.id} field="join-mode">
      <Field label={t('inspector.fieldJoinMode')} hint={t('inspector.fieldJoinModeHint')}>
        <div className="segmented" role="group" aria-label={t('inspector.fieldJoinMode')}>
          <button
            type="button"
            className={current === 'any' ? 'is-active' : ''}
            aria-pressed={current === 'any'}
            onClick={() => set('any')}
            data-testid="node-join-mode-any"
          >
            {t('inspector.joinModeAny')}
          </button>
          <button
            type="button"
            className={current === 'all' ? 'is-active' : ''}
            aria-pressed={current === 'all'}
            onClick={() => set('all')}
            data-testid="node-join-mode-all"
          >
            {t('inspector.joinModeAll')}
          </button>
        </div>
      </Field>
    </InspectorFieldAnchor>
  )
}
