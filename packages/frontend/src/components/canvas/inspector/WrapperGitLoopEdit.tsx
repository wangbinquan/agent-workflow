// wrapper-git / wrapper-loop inspector branch — extracted verbatim from the
// NodeInspector EditForm switch by RFC-146 T3. One component serves both
// kinds, matching the historical shared case: wrapper-git renders the
// read-only inner list only; the loop adds maxIterations / exitCondition.
//
// RFC-354 (schema v6): a loop's RETURN VALUES are its `wrapper-output` edges
// (body member port → loop return port, authored on the canvas exactly like a
// fan-out's promoted outlets) and its exit condition names one of its OWN
// return ports — so the inspector shows the returns read-only and offers the
// return ports as the exit target (the v5 member/port pair is gone).

import {
  LOOP_EXIT_CONDITION_KINDS,
  readContinueOnMaxIterations,
  wrapperOutputPortNames,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
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

/**
 * RFC-354 — the wrapper's parameters and their hand-off into the body, read
 * straight off the edges (a parameter is declared by an ordinary inbound edge;
 * a `wrapper-input` boundary edge hands it to an inner consumer). Read-only:
 * both are authored on the canvas, exactly like an agent's inputs.
 */
function WrapperParameterList({ node, definition }: Pick<EditProps, 'node' | 'definition'>) {
  const { t } = useTranslation()
  const params = definition.edges.filter(
    (edge) => edge.target.nodeId === node.id && edge.boundary === undefined,
  )
  const handoffs = definition.edges.filter(
    (edge) => edge.boundary === 'wrapper-input' && edge.source.nodeId === node.id,
  )
  return (
    <Field label={t('inspector.wrapperParams')} hint={t('inspector.wrapperParamsHint')}>
      <div className="muted" data-testid="wrapper-parameter-list">
        {params.length === 0
          ? t('inspector.wrapperParamsNone')
          : params.map((edge) => (
              <div key={edge.id}>
                <code>{edge.target.portName}</code> ← <code>{edge.source.nodeId}</code>.
                <code>{edge.source.portName}</code>
                {handoffs
                  .filter((handoff) => handoff.source.portName === edge.target.portName)
                  .map((handoff) => (
                    <span key={handoff.id}>
                      {' '}
                      → <code>{handoff.target.nodeId}</code>.<code>{handoff.target.portName}</code>
                    </span>
                  ))}
              </div>
            ))}
      </div>
    </Field>
  )
}

/**
 * RFC-354 — the loop's return values, read straight off its `wrapper-output`
 * edges (return port ← member.port). Read-only: returns are authored on the
 * canvas by dropping a member's output on the loop's right-side return strip.
 */
function LoopReturnList({ node, definition }: Pick<EditProps, 'node' | 'definition'>) {
  const { t } = useTranslation()
  const returns = definition.edges.filter(
    (edge) => edge.boundary === 'wrapper-output' && edge.target.nodeId === node.id,
  )
  return (
    <Field label={t('inspector.loopReturns')} hint={t('inspector.loopReturnsHint')}>
      <div className="muted" data-testid="loop-return-list">
        {returns.length === 0
          ? t('inspector.loopReturnsNone')
          : returns.map((edge) => (
              <div key={edge.id}>
                <code>{edge.target.portName}</code> ← <code>{edge.source.nodeId}</code>.
                <code>{edge.source.portName}</code>
              </div>
            ))}
      </div>
    </Field>
  )
}

export function WrapperGitLoopEdit({ node, definition, onPatch, onHistoryBoundary }: EditProps) {
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
          <WrapperParameterList node={node} definition={definition} />
        </InspectorSection>
      </div>
    )
  }
  const exitCondRaw = (rec.exitCondition as Record<string, unknown> | undefined) ?? {}
  const exitKind = typeof exitCondRaw.kind === 'string' ? exitCondRaw.kind : 'port-empty'
  const exitPortName = typeof exitCondRaw.portName === 'string' ? exitCondRaw.portName : ''
  // RFC-354: the exit target is one of the loop's own return ports.
  const returnPorts = wrapperOutputPortNames(definition, node.id)
  const exitValue = typeof exitCondRaw.value === 'string' ? exitCondRaw.value : ''
  const exitN =
    typeof exitCondRaw.n === 'number' && Number.isInteger(exitCondRaw.n) && exitCondRaw.n >= 1
      ? exitCondRaw.n
      : 1
  const exitSeparator = typeof exitCondRaw.separator === 'string' ? exitCondRaw.separator : ''
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
        <InspectorFieldAnchor nodeId={node.id} field="loop-continue-on-max-iterations">
          <Switch
            checked={readContinueOnMaxIterations(node) === true}
            onChange={(checked) =>
              update(
                { continueOnMaxIterations: checked },
                atomicNodeInspectorChange(
                  node.id,
                  'continueOnMaxIterations',
                  t('inspector.fieldContinueOnMaxIterations'),
                ),
              )
            }
            label={t('inspector.fieldContinueOnMaxIterations')}
            hint={t('inspector.fieldContinueOnMaxIterationsHint')}
            data-testid="loop-continue-on-max-iterations"
          />
        </InspectorFieldAnchor>
      </InspectorSection>
      <InspectorSection title={t('inspector.sectionFlow')}>
        <WrapperParameterList node={node} definition={definition} />
        <LoopReturnList node={node} definition={definition} />
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
              options={LOOP_EXIT_CONDITION_KINDS.map((kind) => ({ value: kind, label: kind }))}
            />
          </Field>
        </InspectorFieldAnchor>
        <Field
          label={t('inspector.fieldExitConditionTarget')}
          hint={t('inspector.fieldExitConditionTargetHint')}
        >
          {(() => {
            // RFC-354: the options are the loop's own return ports (one per
            // `wrapper-output` edge); a stale value is kept visible + flagged.
            const portInvalid = exitPortName.length > 0 && !returnPorts.includes(exitPortName)
            return (
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
                  disabled={returnPorts.length === 0 && !portInvalid}
                  data-testid="loop-exit-port-select"
                  options={[
                    { value: '', label: t('inspector.loopExitPortNameSelect') },
                    ...returnPorts.map((p) => ({ value: p, label: p })),
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
