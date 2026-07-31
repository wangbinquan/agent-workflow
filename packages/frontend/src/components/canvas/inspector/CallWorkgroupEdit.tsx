// RFC-242 PR-4 — call-workgroup inspector branch. Picks the referenced
// workgroup (name = authoritative selector, id = resolution cache — same
// contract as CallWorkflowEdit / design §6.3), edits the required
// goalTemplate the parent renders into the child's literal goal, and the
// optional child-task limits.
//
// Differences from CallWorkflowEdit, both grounded in the design:
//   - no self-exclusion — workgroups are closure LEAVES (the dw validator
//     rejects call nodes inside generated DAGs), so a workgroup can never
//     re-open the call graph and "self reference" does not exist here;
//   - no child-port preview — the output is the FIXED `result` port
//     (shared PORT_DERIVERS), rendered as a read-only info line instead.

import type { Workgroup, WorkflowNode } from '@agent-workflow/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Field, NumberInput, TextArea } from '@/components/Form'
import { Select } from '@/components/Select'
import { useUserLookup } from '@/hooks/useUserLookup'
import { resourceOptionLabel } from '@/lib/resource-option-label'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'
import { InspectorSection } from './InspectorSection'
import type { EditProps } from './types'

interface CallLimits {
  maxDurationMs?: number
  maxTotalTokens?: number
}

function readLimits(rec: Record<string, unknown>): CallLimits {
  const raw = rec.limits as { maxDurationMs?: unknown; maxTotalTokens?: unknown } | undefined
  const out: CallLimits = {}
  if (typeof raw?.maxDurationMs === 'number') out.maxDurationMs = raw.maxDurationMs
  if (typeof raw?.maxTotalTokens === 'number') out.maxTotalTokens = raw.maxTotalTokens
  return out
}

export function CallWorkgroupEdit({ node, onPatch, onHistoryBoundary }: EditProps) {
  const { t } = useTranslation()
  // Shared ['workgroups'] cache key — same rows the /workgroups list page
  // (useResourceList) and the launch wizard (tasks.new) already fetch.
  const workgroupsQ = useQuery<Workgroup[]>({
    queryKey: ['workgroups'],
    queryFn: ({ signal }) => api.get('/api/workgroups', undefined, signal),
  })
  const workgroups = Array.isArray(workgroupsQ.data) ? workgroupsQ.data : []
  const isLoading = workgroupsQ.isLoading
  const rec = node as unknown as Record<string, unknown>
  const refName = typeof rec.workgroupName === 'string' ? rec.workgroupName : ''
  const refId = typeof rec.workgroupId === 'string' ? rec.workgroupId : ''
  const goalTemplate = typeof rec.goalTemplate === 'string' ? rec.goalTemplate : ''
  const limits = readLimits(rec)
  const owners = useUserLookup(workgroups.map((w) => w.ownerUserId))

  // Select value: prefer the cached id when it is offered; else re-resolve
  // through the authoritative name (covers YAML imports that carry no id).
  const selectedId =
    refId.length > 0 && workgroups.some((w) => w.id === refId)
      ? refId
      : (workgroups.find((w) => w.name === refName)?.id ?? '')
  // Dangling reference (loop-exit invalid-option pattern): keep the stored
  // name visible on the trigger instead of silently blanking it. Suppressed
  // while the list is still loading so a resolvable ref never flickers.
  const refMissing = refName.length > 0 && selectedId === '' && !isLoading
  const selectValue = selectedId !== '' ? selectedId : refMissing ? refName : ''

  function update(patch: Record<string, unknown>, meta: InspectorChangeMeta) {
    onPatch({ ...(node as Record<string, unknown>), ...patch } as unknown as WorkflowNode, meta)
  }

  function updateLimit(key: keyof CallLimits, v: number | undefined, meta: InspectorChangeMeta) {
    const next: CallLimits = { ...limits }
    if (v === undefined) delete next[key]
    else next[key] = Math.max(1, Math.trunc(v))
    // Keep the node clean: no limit set ⇒ no `limits` field at all (matches
    // the schema's fully-optional shape and YAML export minimalism).
    update({ limits: Object.keys(next).length === 0 ? undefined : next }, meta)
  }

  const goalMeta = continuousNodeInspectorChange(
    node.id,
    'goalTemplate',
    t('inspector.fieldCallGoalTemplate'),
  )

  return (
    <div className="inspector-sections">
      <InspectorSection title={t('inspector.sectionBasics')}>
        <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
        <InspectorFieldAnchor nodeId={node.id} field="call-ref">
          <Field
            label={t('inspector.fieldCallWorkgroup')}
            hint={t('inspector.fieldCallWorkgroupHint')}
            required
          >
            <Select<string>
              value={selectValue}
              placeholder={t('inspector.pickCallWorkgroup')}
              ariaLabel={t('inspector.fieldCallWorkgroup')}
              searchable
              data-testid="call-workgroup-ref-select"
              onChange={(v) => {
                const selected = workgroups.find((w) => w.id === v)
                // Unknown/cleared values must not wipe a persisted reference
                // (agent-selection writer rule, RFC-223 PR7 precedent).
                if (selected === undefined) return
                update(
                  { workgroupName: selected.name, workgroupId: selected.id },
                  atomicNodeInspectorChange(
                    node.id,
                    'workgroupName',
                    t('inspector.fieldCallWorkgroup'),
                  ),
                )
              }}
              options={[
                { value: '', label: t('inspector.pickCallWorkgroup') },
                ...workgroups.map((w) => ({
                  value: w.id,
                  label: resourceOptionLabel(
                    w.name,
                    owners.get(w.ownerUserId)?.displayName ?? w.ownerUserId ?? undefined,
                  ),
                })),
                // A dangling reference stays visible (and revertable by
                // picking something else) instead of silently blanking.
                // Its value is the raw name, never a candidate id, so the
                // onChange guard above makes re-picking it a no-op.
                ...(refMissing
                  ? [{ value: refName, label: t('inspector.missingOption', { value: refName }) }]
                  : []),
              ]}
            />
          </Field>
        </InspectorFieldAnchor>
        <InspectorFieldAnchor nodeId={node.id} field="call-goal-template">
          <Field
            label={t('inspector.fieldCallGoalTemplate')}
            hint={t('inspector.fieldCallGoalTemplateHint')}
            required
          >
            <InspectorHistoryBoundary meta={goalMeta} onBoundary={onHistoryBoundary}>
              <TextArea
                value={goalTemplate}
                onChange={(v) => update({ goalTemplate: v }, goalMeta)}
                rows={6}
                monospace
                data-testid="call-workgroup-goal-template"
              />
            </InspectorHistoryBoundary>
          </Field>
        </InspectorFieldAnchor>
        {/* Fixed output — no per-child preview to render (contrast
            call-workflow): every call-workgroup node exposes exactly one
            `result` text port. */}
        <div className="muted" data-testid="call-workgroup-result-info">
          {t('inspector.callWorkgroupResultInfo')}
        </div>
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionAdvanced')} collapsed>
        <InspectorFieldAnchor nodeId={node.id} field="call-limits">
          <Field
            label={t('inspector.fieldCallMaxDurationMs')}
            hint={t('inspector.fieldCallMaxDurationMsHint')}
          >
            <InspectorHistoryBoundary
              meta={continuousNodeInspectorChange(
                node.id,
                'limits.maxDurationMs',
                t('inspector.fieldCallMaxDurationMs'),
              )}
              onBoundary={onHistoryBoundary}
            >
              <NumberInput
                value={limits.maxDurationMs}
                onChange={(v) =>
                  updateLimit(
                    'maxDurationMs',
                    v,
                    continuousNodeInspectorChange(
                      node.id,
                      'limits.maxDurationMs',
                      t('inspector.fieldCallMaxDurationMs'),
                    ),
                  )
                }
                min={1}
                step={1}
                data-testid="call-workgroup-max-duration"
              />
            </InspectorHistoryBoundary>
          </Field>
          <Field
            label={t('inspector.fieldCallMaxTotalTokens')}
            hint={t('inspector.fieldCallMaxTotalTokensHint')}
          >
            <InspectorHistoryBoundary
              meta={continuousNodeInspectorChange(
                node.id,
                'limits.maxTotalTokens',
                t('inspector.fieldCallMaxTotalTokens'),
              )}
              onBoundary={onHistoryBoundary}
            >
              <NumberInput
                value={limits.maxTotalTokens}
                onChange={(v) =>
                  updateLimit(
                    'maxTotalTokens',
                    v,
                    continuousNodeInspectorChange(
                      node.id,
                      'limits.maxTotalTokens',
                      t('inspector.fieldCallMaxTotalTokens'),
                    ),
                  )
                }
                min={1}
                step={1}
                data-testid="call-workgroup-max-tokens"
              />
            </InspectorHistoryBoundary>
          </Field>
        </InspectorFieldAnchor>
      </InspectorSection>
    </div>
  )
}
