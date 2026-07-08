// RFC-060 — wrapper-fanout inspector. Authors edit inputs[] (name +
// kind + isShardSource flag); inner nodeIds[] read-only (managed
// via canvas drag), outputs[] derived from inner aggregator agent
// (or implicit __done__ signal). Extracted verbatim from the NodeInspector
// EditForm switch by RFC-146 T3.

import type { WorkflowNode } from '@agent-workflow/shared'
import { deriveWrapperFanoutOutputs, tryParseKind } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, Switch, TextInput } from '@/components/Form'
import { KindSelect } from '@/components/KindSelect'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function WrapperFanoutEdit({ node, agents, definition, onPatch }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
  type FanoutInput = { name: string; kind: string; isShardSource?: boolean }
  const inputsList: FanoutInput[] = Array.isArray(rec.inputs)
    ? (rec.inputs as unknown[]).filter(
        (i): i is FanoutInput =>
          typeof i === 'object' &&
          i !== null &&
          typeof (i as Record<string, unknown>).name === 'string' &&
          typeof (i as Record<string, unknown>).kind === 'string',
      )
    : []
  const derivedOutputs = deriveWrapperFanoutOutputs(
    definition,
    node.id,
    new Map(agents.map((a) => [a.name, a])),
  )
  function update(patch: Record<string, unknown>) {
    onPatch({
      ...(node as Record<string, unknown>),
      ...patch,
    } as unknown as WorkflowNode)
  }
  function setInputs(next: FanoutInput[]) {
    update({ inputs: next })
  }
  function patchInput(idx: number, patch: Partial<FanoutInput>) {
    const next = inputsList.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    setInputs(next)
  }
  function removeInput(idx: number) {
    const next = inputsList.filter((_, i) => i !== idx)
    setInputs(next)
  }
  function addInput() {
    const next = [...inputsList, { name: `input_${inputsList.length + 1}`, kind: 'list<string>' }]
    // If no shardSource present, mark the first as shardSource so the
    // validator's wrapper-fanout-shard-source-missing rule doesn't
    // immediately flag the new wrapper.
    if (!inputsList.some((p) => p.isShardSource === true)) {
      next[next.length - 1] = { ...next[next.length - 1]!, isShardSource: true }
    }
    setInputs(next)
  }
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
        <div className="muted">
          {inner.length === 0 ? t('inspector.none') : inner.map((i) => <code key={i}>{i} </code>)}
        </div>
      </Field>
      <Field label={t('inspector.fanoutInputs')} hint={t('inspector.fanoutInputsHint')}>
        <div className="fanout-inputs-list">
          {inputsList.map((p, idx) => {
            const parsed = tryParseKind(p.kind)
            const isShardKindOk = parsed?.kind === 'list'
            // Find inbound edges wired to this port. The user asked us
            // NOT to split "inbound edges" into its own panel — surface
            // each edge inline on the corresponding input row so the
            // inputs[] list is the single source of truth.
            const wiredFrom = definition.edges.filter(
              (e) => e.target.nodeId === node.id && e.target.portName === p.name,
            )
            return (
              <div key={idx} className="fanout-input-row-wrap">
                <div className="fanout-input-row">
                  <TextInput
                    value={p.name}
                    onChange={(v) => patchInput(idx, { name: v })}
                    placeholder={t('inspector.fanoutInputNamePlaceholder')}
                  />
                  <KindSelect
                    value={p.kind}
                    onChange={(v) => patchInput(idx, { kind: v })}
                    testidPrefix={`fanout-input-kind-${idx}`}
                  />
                  <Switch
                    checked={p.isShardSource === true}
                    onChange={(v) => {
                      // Mark this one as shardSource and clear others (singleton invariant).
                      const next = inputsList.map((q, i) => ({
                        ...q,
                        isShardSource: i === idx ? v : false,
                      }))
                      setInputs(next)
                    }}
                    label={t('inspector.fanoutInputShardSource')}
                  />
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={() => removeInput(idx)}
                    aria-label={t('inspector.fanoutInputRemove')}
                  >
                    ×
                  </button>
                </div>
                {p.isShardSource === true && !isShardKindOk ? (
                  <div className="muted muted--warn">
                    {t('inspector.fanoutInputShardSourceMustBeList')}
                  </div>
                ) : null}
                <div className="fanout-input-wired">
                  {wiredFrom.length === 0 ? (
                    <span className="muted">{t('inspector.fanoutInputUnwired')}</span>
                  ) : (
                    wiredFrom.map((e) => (
                      <span key={e.id} className="fanout-input-wired__src">
                        ← <code>{e.source.nodeId}</code>
                        <span>.</span>
                        <code>{e.source.portName}</code>
                      </span>
                    ))
                  )}
                </div>
              </div>
            )
          })}
          <button type="button" className="btn btn--sm" onClick={addInput}>
            {t('inspector.fanoutInputAdd')}
          </button>
        </div>
      </Field>
      <Field
        label={t('inspector.fanoutDerivedOutputs')}
        hint={t('inspector.fanoutDerivedOutputsHint')}
      >
        <div className="muted">
          {derivedOutputs.map((o) => (
            <div key={o.name}>
              <code>{o.name}</code>
              <span> : </span>
              <code>{o.kind}</code>
            </div>
          ))}
        </div>
      </Field>
    </div>
  )
}
