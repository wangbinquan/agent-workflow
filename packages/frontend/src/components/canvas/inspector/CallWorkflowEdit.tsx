// RFC-242 PR-3 — call-workflow inspector branch. Picks the referenced child
// workflow (name = authoritative selector, id = resolution cache, design
// §5.1), previews the child's declared ports through the shared
// useWorkflowRefResolver cache, and edits the optional child-task limits.
//
// Reference states (design §5.2): a resolvable child renders its
// inputs/outputs read-only; an unresolvable one shows the neutral
// "引用不可见或不存在" placeholder — the ACL-filtered list endpoint makes
// invisible and deleted references indistinguishable by design, so one
// same-shape message avoids leaking existence.

import type { WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, NumberInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'
import { useUserLookup } from '@/hooks/useUserLookup'
import { resourceOptionLabel } from '@/lib/resource-option-label'
import { useWorkflowRefResolver } from '../useWorkflowRefResolver'
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

export function CallWorkflowEdit({ node, workflowId, onPatch, onHistoryBoundary }: EditProps) {
  const { t } = useTranslation()
  const { workflowByRef, workflows, isLoading } = useWorkflowRefResolver()
  const rec = node as unknown as Record<string, unknown>
  const refName = typeof rec.workflowName === 'string' ? rec.workflowName : ''
  const refId = typeof rec.workflowId === 'string' ? rec.workflowId : ''
  const limits = readLimits(rec)
  const owners = useUserLookup(workflows.map((w) => w.ownerUserId))

  // Self-reference = the trivial call cycle (design §5.3) — the editor
  // simply never offers the workflow being edited as a target.
  const candidates = workflows.filter((w) => w.id !== workflowId)
  // Select value: prefer the cached id when it is offered; else re-resolve
  // through the authoritative name (covers YAML imports that carry no id).
  const selectedId =
    refId.length > 0 && candidates.some((w) => w.id === refId)
      ? refId
      : (candidates.find((w) => w.name === refName)?.id ?? '')
  // Dangling reference (loop-exit invalid-option pattern): keep the stored
  // name visible on the trigger instead of silently blanking it. Suppressed
  // while the list is still loading so a resolvable ref never flickers.
  const refMissing = refName.length > 0 && selectedId === '' && !isLoading
  const selectValue = selectedId !== '' ? selectedId : refMissing ? refName : ''

  const child = refName.length > 0 || refId.length > 0 ? workflowByRef(refName || refId) : null
  const childInputs =
    child === null || child === 'forbidden'
      ? []
      : child.inputs.flatMap((input) => {
          const row = input as { key?: unknown; kind?: unknown }
          return typeof row.key === 'string'
            ? [{ key: row.key, kind: typeof row.kind === 'string' ? row.kind : undefined }]
            : []
        })
  const childOutputs: string[] = []
  if (child !== null && child !== 'forbidden') {
    for (const n of child.nodes) {
      if (n.kind !== 'output') continue
      const ports = (n as unknown as { ports?: unknown }).ports
      if (!Array.isArray(ports)) continue
      for (const p of ports) {
        const name = (p as { name?: unknown } | null)?.name
        if (typeof name === 'string' && !childOutputs.includes(name)) childOutputs.push(name)
      }
    }
  }

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

  return (
    <div className="inspector-sections">
      <InspectorSection title={t('inspector.sectionBasics')}>
        <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
        <InspectorFieldAnchor nodeId={node.id} field="call-ref">
          <Field
            label={t('inspector.fieldCallWorkflow')}
            hint={t('inspector.fieldCallWorkflowHint')}
            required
          >
            <Select<string>
              value={selectValue}
              placeholder={t('inspector.pickCallWorkflow')}
              ariaLabel={t('inspector.fieldCallWorkflow')}
              searchable
              data-testid="call-workflow-ref-select"
              onChange={(v) => {
                const selected = candidates.find((w) => w.id === v)
                // Unknown/cleared values must not wipe a persisted reference
                // (agent-selection writer rule, RFC-223 PR7 precedent).
                if (selected === undefined) return
                update(
                  { workflowName: selected.name, workflowId: selected.id },
                  atomicNodeInspectorChange(
                    node.id,
                    'workflowName',
                    t('inspector.fieldCallWorkflow'),
                  ),
                )
              }}
              options={[
                { value: '', label: t('inspector.pickCallWorkflow') },
                ...candidates.map((w) => ({
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
        <InspectorFieldAnchor nodeId={node.id} field="call-ports">
          <Field
            label={t('inspector.callWorkflowPortsPreview')}
            hint={t('inspector.callWorkflowPortsPreviewHint')}
          >
            {refName.length === 0 && refId.length === 0 ? (
              <div className="muted">{t('inspector.callWorkflowNoRef')}</div>
            ) : child === null && isLoading ? (
              <LoadingState size="compact" />
            ) : child === null || child === 'forbidden' ? (
              <div className="muted" data-testid="call-workflow-ref-unavailable">
                {t('inspector.callWorkflowRefUnavailable')}
              </div>
            ) : (
              <div className="muted" data-testid="call-workflow-ports-preview">
                <div>
                  {t('inspector.callWorkflowChildInputs')}
                  {': '}
                  {childInputs.length === 0 ? (
                    t('inspector.none')
                  ) : (
                    <span>
                      {childInputs.map((input, i) => (
                        <span key={input.key}>
                          {i > 0 ? ', ' : ''}
                          <code>{input.key}</code>
                          {input.kind !== undefined ? <code>:{input.kind}</code> : null}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div>
                  {t('inspector.callWorkflowChildOutputs')}
                  {': '}
                  {childOutputs.length === 0 ? (
                    t('inspector.none')
                  ) : (
                    <span>
                      {childOutputs.map((name, i) => (
                        <span key={name}>
                          {i > 0 ? ', ' : ''}
                          <code>{name}</code>
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            )}
          </Field>
        </InspectorFieldAnchor>
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
                data-testid="call-workflow-max-duration"
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
                data-testid="call-workflow-max-tokens"
              />
            </InspectorHistoryBoundary>
          </Field>
        </InspectorFieldAnchor>
      </InspectorSection>
    </div>
  )
}
