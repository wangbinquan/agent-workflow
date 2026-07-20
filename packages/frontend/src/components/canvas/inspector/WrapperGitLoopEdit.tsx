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

export function WrapperGitLoopEdit({
  node,
  agents,
  definition,
  onPatch,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const inner = Array.isArray(rec.nodeIds) ? (rec.nodeIds as string[]) : []
  const isLoop = node.kind === 'wrapper-loop'
  if (!isLoop) {
    return (
      <div className="inspector-sections">
        <InspectorSection title={t('inspector.sectionBasics')}>
          <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
        </InspectorSection>
        <InspectorSection title={t('inspector.sectionTechnical')} collapsed>
          <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
            <div className="muted">
              {inner.length === 0
                ? t('inspector.none')
                : inner.map((i) => <code key={i}>{i} </code>)}
            </div>
          </Field>
        </InspectorSection>
      </div>
    )
  }
  const exitCondRaw = (rec.exitCondition as Record<string, unknown> | undefined) ?? {}
  const exitKind = typeof exitCondRaw.kind === 'string' ? exitCondRaw.kind : 'port-empty'
  const exitNodeId = typeof exitCondRaw.nodeId === 'string' ? exitCondRaw.nodeId : ''
  const exitPortName = typeof exitCondRaw.portName === 'string' ? exitCondRaw.portName : ''
  const exitValue = typeof exitCondRaw.value === 'string' ? exitCondRaw.value : ''
  const exitN =
    typeof exitCondRaw.n === 'number' && Number.isInteger(exitCondRaw.n) && exitCondRaw.n >= 1
      ? exitCondRaw.n
      : 1
  const exitSeparator = typeof exitCondRaw.separator === 'string' ? exitCondRaw.separator : ''
  const bindings = Array.isArray(rec.outputBindings)
    ? (rec.outputBindings as Array<{
        name: string
        bind: { nodeId: string; portName: string }
      }>)
    : []
  function update(patch: Record<string, unknown>, meta: InspectorChangeMeta) {
    onPatch(
      {
        ...(node as Record<string, unknown>),
        ...patch,
      } as unknown as WorkflowNode,
      meta,
    )
  }
  function updateExit(patch: Record<string, unknown>, meta: InspectorChangeMeta) {
    update(
      {
        exitCondition: { ...exitCondRaw, ...patch },
      },
      meta,
    )
  }
  function setBindings(next: typeof bindings, meta: InspectorChangeMeta) {
    update({ outputBindings: next }, meta)
  }
  return (
    <div className="inspector-sections">
      <InspectorSection title={t('inspector.sectionBasics')}>
        <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
        <div className="info-box info-box--muted">{t('inspector.loopBanner')}</div>
        <InspectorFieldAnchor nodeId={node.id} field="loop-max-iterations">
          <Field label={t('inspector.fieldMaxIterations')} required>
            <InspectorHistoryBoundary
              meta={continuousNodeInspectorChange(
                node.id,
                'maxIterations',
                t('inspector.fieldMaxIterations'),
              )}
              onBoundary={onHistoryBoundary}
            >
              <NumberInput
                value={typeof rec.maxIterations === 'number' ? rec.maxIterations : undefined}
                onChange={(v) =>
                  update(
                    { maxIterations: v === undefined ? 1 : Math.max(1, Math.trunc(v)) },
                    continuousNodeInspectorChange(
                      node.id,
                      'maxIterations',
                      t('inspector.fieldMaxIterations'),
                    ),
                  )
                }
                min={1}
                step={1}
              />
            </InspectorHistoryBoundary>
          </Field>
        </InspectorFieldAnchor>
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionFlow')}>
        <InspectorFieldAnchor nodeId={node.id} field="loop-exit-condition">
          <Field
            label={t('inspector.fieldExitConditionKind')}
            hint={t('inspector.fieldExitConditionKindHint')}
          >
            <Select<string>
              value={exitKind}
              ariaLabel={t('inspector.fieldExitConditionKind')}
              onChange={(v) =>
                updateExit(
                  { kind: v, ...(v === 'port-count-lt' ? { n: exitN } : {}) },
                  atomicNodeInspectorChange(
                    node.id,
                    'exitCondition.kind',
                    t('inspector.fieldExitConditionKind'),
                  ),
                )
              }
              options={[
                { value: 'port-empty', label: 'port-empty' },
                { value: 'port-not-empty', label: 'port-not-empty' },
                { value: 'port-equals', label: 'port-equals' },
                { value: 'port-count-lt', label: 'port-count-lt' },
              ]}
            />
          </Field>
        </InspectorFieldAnchor>
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
                    onChange={(v) =>
                      updateExit(
                        { nodeId: v },
                        atomicNodeInspectorChange(
                          node.id,
                          'exitCondition.nodeId',
                          t('inspector.fieldExitConditionTarget'),
                        ),
                      )
                    }
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
                    onChange={(v) =>
                      updateExit(
                        { portName: v },
                        atomicNodeInspectorChange(
                          node.id,
                          'exitCondition.portName',
                          t('inspector.fieldExitConditionTarget'),
                        ),
                      )
                    }
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
            <InspectorHistoryBoundary
              meta={continuousNodeInspectorChange(
                node.id,
                'exitCondition.value',
                t('inspector.fieldExitConditionValue'),
              )}
              onBoundary={onHistoryBoundary}
            >
              <TextInput
                value={exitValue}
                onChange={(v) =>
                  updateExit(
                    { value: v },
                    continuousNodeInspectorChange(
                      node.id,
                      'exitCondition.value',
                      t('inspector.fieldExitConditionValue'),
                    ),
                  )
                }
              />
            </InspectorHistoryBoundary>
          </Field>
        )}
        {exitKind === 'port-count-lt' && (
          <>
            <Field label={t('inspector.fieldExitConditionN')}>
              <InspectorHistoryBoundary
                meta={continuousNodeInspectorChange(
                  node.id,
                  'exitCondition.n',
                  t('inspector.fieldExitConditionN'),
                )}
                onBoundary={onHistoryBoundary}
              >
                <NumberInput
                  value={exitN}
                  onChange={(v) =>
                    updateExit(
                      { n: v === undefined ? 1 : Math.max(1, Math.trunc(v)) },
                      continuousNodeInspectorChange(
                        node.id,
                        'exitCondition.n',
                        t('inspector.fieldExitConditionN'),
                      ),
                    )
                  }
                  min={1}
                  step={1}
                />
              </InspectorHistoryBoundary>
            </Field>
            <Field label={t('inspector.fieldExitConditionSeparator')}>
              <InspectorHistoryBoundary
                meta={continuousNodeInspectorChange(
                  node.id,
                  'exitCondition.separator',
                  t('inspector.fieldExitConditionSeparator'),
                )}
                onBoundary={onHistoryBoundary}
              >
                <TextInput
                  value={exitSeparator}
                  onChange={(v) =>
                    updateExit(
                      { separator: v },
                      continuousNodeInspectorChange(
                        node.id,
                        'exitCondition.separator',
                        t('inspector.fieldExitConditionSeparator'),
                      ),
                    )
                  }
                  placeholder="\\n"
                />
              </InspectorHistoryBoundary>
            </Field>
          </>
        )}
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionAdvanced')} collapsed>
        <InspectorFieldAnchor nodeId={node.id} field="loop-output-bindings">
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
                    <InspectorHistoryBoundary
                      meta={continuousNodeInspectorChange(
                        node.id,
                        `outputBindings.${i}.name`,
                        t('inspector.fieldOutputBindings'),
                      )}
                      onBoundary={onHistoryBoundary}
                    >
                      <input
                        className="form-input"
                        value={b.name}
                        onChange={(e) => {
                          const copy = [...bindings]
                          copy[i] = { ...b, name: e.target.value }
                          setBindings(
                            copy,
                            continuousNodeInspectorChange(
                              node.id,
                              `outputBindings.${i}.name`,
                              t('inspector.fieldOutputBindings'),
                            ),
                          )
                        }}
                        placeholder={t('inspector.outputNamePlaceholder')}
                      />
                    </InspectorHistoryBoundary>
                    <Select<string>
                      className={`form-input--mono${bindNodeInvalid ? ' form-input--invalid' : ''}`}
                      value={b.bind.nodeId}
                      ariaLabel={t('inspector.loopExitNodeIdSelect')}
                      onChange={(v) => {
                        const copy = [...bindings]
                        copy[i] = { ...b, bind: { ...b.bind, nodeId: v } }
                        setBindings(
                          copy,
                          atomicNodeInspectorChange(
                            node.id,
                            `outputBindings.${i}.bind.nodeId`,
                            t('inspector.fieldOutputBindings'),
                          ),
                        )
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
                        setBindings(
                          copy,
                          atomicNodeInspectorChange(
                            node.id,
                            `outputBindings.${i}.bind.portName`,
                            t('inspector.fieldOutputBindings'),
                          ),
                        )
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
                      onClick={() =>
                        setBindings(
                          bindings.filter((_, j) => j !== i),
                          atomicNodeInspectorChange(
                            node.id,
                            `outputBindings.${i}.remove`,
                            t('inspector.remove'),
                          ),
                        )
                      }
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
                setBindings(
                  [
                    ...bindings,
                    {
                      name: `out_${bindings.length + 1}`,
                      bind: { nodeId: '', portName: '' },
                    },
                  ],
                  atomicNodeInspectorChange(
                    node.id,
                    'outputBindings.add',
                    t('inspector.addBinding'),
                  ),
                )
              }
            >
              {t('inspector.addBinding')}
            </button>
          </Field>
        </InspectorFieldAnchor>
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionTechnical')} collapsed>
        <Field label={t('inspector.innerNodeIds')} hint={t('inspector.innerNodeIdsHint')}>
          <div className="muted">
            {inner.length === 0 ? t('inspector.none') : inner.map((i) => <code key={i}>{i} </code>)}
          </div>
        </Field>
      </InspectorSection>
    </div>
  )
}
