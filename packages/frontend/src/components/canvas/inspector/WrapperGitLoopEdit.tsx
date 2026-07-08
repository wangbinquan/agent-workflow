// wrapper-git / wrapper-loop inspector branch (RFC-016 candidate-driven
// selects) — extracted verbatim from the NodeInspector EditForm switch by
// RFC-146 T3. One component serves both kinds, matching the historical
// shared case: wrapper-git renders the read-only inner list only; the loop
// adds maxIterations / exitCondition / outputBindings.

import type { WorkflowNode } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, NumberInput, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { loopMemberCandidates } from '../wrapperCandidates'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function WrapperGitLoopEdit({ node, agents, definition, onPatch }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
  const isLoop = node.kind === 'wrapper-loop'
  if (!isLoop) {
    return (
      <div className="form-grid">
        <NodeTitleField node={node} onPatch={onPatch} />
        <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
          <div className="muted">
            {inner.length === 0 ? t('inspector.none') : inner.map((i) => <code key={i}>{i} </code>)}
          </div>
        </Field>
      </div>
    )
  }
  const exitCondRaw = (rec.exitCondition as Record<string, unknown> | undefined) ?? {}
  const exitKind = typeof exitCondRaw.kind === 'string' ? exitCondRaw.kind : 'port-empty'
  const exitNodeId = typeof exitCondRaw.nodeId === 'string' ? exitCondRaw.nodeId : ''
  const exitPortName = typeof exitCondRaw.portName === 'string' ? exitCondRaw.portName : ''
  const exitValue = typeof exitCondRaw.value === 'string' ? exitCondRaw.value : ''
  const exitN = typeof exitCondRaw.n === 'number' ? exitCondRaw.n : 1
  const exitSeparator = typeof exitCondRaw.separator === 'string' ? exitCondRaw.separator : ''
  const bindings = Array.isArray(rec.outputBindings)
    ? (rec.outputBindings as Array<{
        name: string
        bind: { nodeId: string; portName: string }
      }>)
    : []
  function update(patch: Record<string, unknown>) {
    onPatch({
      ...(node as Record<string, unknown>),
      ...patch,
    } as unknown as WorkflowNode)
  }
  function updateExit(patch: Record<string, unknown>) {
    update({
      exitCondition: { ...exitCondRaw, ...patch },
    })
  }
  function setBindings(next: typeof bindings) {
    update({ outputBindings: next })
  }
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} />
      <div className="info-box info-box--muted">{t('inspector.loopBanner')}</div>
      <Field label={t('inspector.fieldMaxIterations')} required>
        <NumberInput
          value={typeof rec.maxIterations === 'number' ? rec.maxIterations : undefined}
          onChange={(v) => update({ maxIterations: v ?? 1 })}
          min={1}
          step={1}
        />
      </Field>
      <Field
        label={t('inspector.fieldExitConditionKind')}
        hint={t('inspector.fieldExitConditionKindHint')}
      >
        <Select<string>
          value={exitKind}
          ariaLabel={t('inspector.fieldExitConditionKind')}
          onChange={(v) => updateExit({ kind: v })}
          options={[
            { value: 'port-empty', label: 'port-empty' },
            { value: 'port-not-empty', label: 'port-not-empty' },
            { value: 'port-equals', label: 'port-equals' },
            { value: 'port-count-lt', label: 'port-count-lt' },
          ]}
        />
      </Field>
      <Field
        label={t('inspector.fieldExitConditionTarget')}
        hint={t('inspector.fieldExitConditionTargetHint')}
      >
        {(() => {
          // RFC-016 T7: candidate-driven selects replace the bare
          // TextInputs. Candidates are computed from the wrapper's
          // current nodeIds + each member's declared output ports so a
          // node moved out of the loop can no longer be referenced.
          const candidates = loopMemberCandidates(node, definition, agents)
          const currentCand = candidates.find((c) => c.nodeId === exitNodeId)
          const nodeIdInvalid = exitNodeId.length > 0 && currentCand === undefined
          const portCandidates = currentCand?.outputPorts ?? []
          const portInvalid = exitPortName.length > 0 && !portCandidates.includes(exitPortName)
          return (
            <div className="form-grid form-grid--two">
              <div>
                <Select<string>
                  className={nodeIdInvalid ? 'form-input--invalid' : undefined}
                  value={exitNodeId}
                  ariaLabel={t('inspector.loopExitNodeIdSelect')}
                  onChange={(v) => updateExit({ nodeId: v })}
                  data-testid="loop-exit-node-select"
                  options={[
                    { value: '', label: t('inspector.loopExitNodeIdSelect') },
                    ...candidates.map((c) => ({
                      value: c.nodeId,
                      label: c.title.length > 0 ? `${c.title} (${c.nodeId})` : c.nodeId,
                    })),
                    ...(nodeIdInvalid
                      ? [
                          {
                            value: exitNodeId,
                            label: t('inspector.missingOption', { value: exitNodeId }),
                          },
                        ]
                      : []),
                  ]}
                />
                {nodeIdInvalid ? (
                  <div className="form-input__error">
                    {t('inspector.loopExitInvalidNodeId', { nodeId: exitNodeId })}
                  </div>
                ) : null}
              </div>
              <div>
                <Select<string>
                  className={portInvalid ? 'form-input--invalid' : undefined}
                  value={exitPortName}
                  ariaLabel={t('inspector.loopExitPortNameSelect')}
                  onChange={(v) => updateExit({ portName: v })}
                  disabled={exitNodeId.length === 0}
                  data-testid="loop-exit-port-select"
                  options={[
                    { value: '', label: t('inspector.loopExitPortNameSelect') },
                    ...portCandidates.map((p) => ({ value: p, label: p })),
                    ...(portInvalid
                      ? [
                          {
                            value: exitPortName,
                            label: t('inspector.missingOption', { value: exitPortName }),
                          },
                        ]
                      : []),
                  ]}
                />
                {portInvalid ? (
                  <div className="form-input__error">
                    {t('inspector.loopExitInvalidPortName', { portName: exitPortName })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })()}
      </Field>
      {exitKind === 'port-equals' && (
        <Field label={t('inspector.fieldExitConditionValue')}>
          <TextInput value={exitValue} onChange={(v) => updateExit({ value: v })} />
        </Field>
      )}
      {exitKind === 'port-count-lt' && (
        <>
          <Field label={t('inspector.fieldExitConditionN')}>
            <NumberInput
              value={exitN}
              onChange={(v) => updateExit({ n: v ?? 1 })}
              min={1}
              step={1}
            />
          </Field>
          <Field label={t('inspector.fieldExitConditionSeparator')}>
            <TextInput
              value={exitSeparator}
              onChange={(v) => updateExit({ separator: v })}
              placeholder="\\n"
            />
          </Field>
        </>
      )}
      <Field
        label={t('inspector.fieldOutputBindings')}
        hint={t('inspector.fieldOutputBindingsHint')}
      >
        <ul className="inspector__output-ports">
          {bindings.map((b, i) => {
            // RFC-016 T7: same candidate-driven select pattern used in
            // exitCondition target — each binding row references an
            // inner member node + its declared output port.
            const candidates = loopMemberCandidates(node, definition, agents)
            const currentCand = candidates.find((c) => c.nodeId === b.bind.nodeId)
            const bindNodeInvalid = b.bind.nodeId.length > 0 && currentCand === undefined
            const bindPortCandidates = currentCand?.outputPorts ?? []
            const bindPortInvalid =
              b.bind.portName.length > 0 && !bindPortCandidates.includes(b.bind.portName)
            return (
              <li key={i} className="inspector__output-port-row">
                <input
                  className="form-input"
                  value={b.name}
                  onChange={(e) => {
                    const copy = [...bindings]
                    copy[i] = { ...b, name: e.target.value }
                    setBindings(copy)
                  }}
                  placeholder={t('inspector.outputNamePlaceholder')}
                />
                <Select<string>
                  className={`form-input--mono${bindNodeInvalid ? ' form-input--invalid' : ''}`}
                  value={b.bind.nodeId}
                  ariaLabel={t('inspector.loopExitNodeIdSelect')}
                  onChange={(v) => {
                    const copy = [...bindings]
                    copy[i] = { ...b, bind: { ...b.bind, nodeId: v } }
                    setBindings(copy)
                  }}
                  options={[
                    { value: '', label: t('inspector.loopExitNodeIdSelect') },
                    ...candidates.map((c) => ({
                      value: c.nodeId,
                      label: c.title.length > 0 ? `${c.title} (${c.nodeId})` : c.nodeId,
                    })),
                    ...(bindNodeInvalid
                      ? [
                          {
                            value: b.bind.nodeId,
                            label: t('inspector.missingOption', { value: b.bind.nodeId }),
                          },
                        ]
                      : []),
                  ]}
                />
                <Select<string>
                  className={`form-input--mono${bindPortInvalid ? ' form-input--invalid' : ''}`}
                  value={b.bind.portName}
                  ariaLabel={t('inspector.loopExitPortNameSelect')}
                  onChange={(v) => {
                    const copy = [...bindings]
                    copy[i] = { ...b, bind: { ...b.bind, portName: v } }
                    setBindings(copy)
                  }}
                  disabled={b.bind.nodeId.length === 0}
                  options={[
                    { value: '', label: t('inspector.loopExitPortNameSelect') },
                    ...bindPortCandidates.map((p) => ({ value: p, label: p })),
                    ...(bindPortInvalid
                      ? [
                          {
                            value: b.bind.portName,
                            label: t('inspector.missingOption', { value: b.bind.portName }),
                          },
                        ]
                      : []),
                  ]}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setBindings(bindings.filter((_, j) => j !== i))}
                >
                  {t('inspector.remove')}
                </button>
              </li>
            )
          })}
        </ul>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            setBindings([
              ...bindings,
              {
                name: `out_${bindings.length + 1}`,
                bind: { nodeId: '', portName: '' },
              },
            ])
          }
        >
          {t('inspector.addBinding')}
        </button>
      </Field>
      <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
        <div className="muted">
          {inner.length === 0 ? t('inspector.none') : inner.map((i) => <code key={i}>{i} </code>)}
        </div>
      </Field>
    </div>
  )
}
