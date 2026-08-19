import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { ChipsInput } from '@/components/ChipsInput'
import { Field, Checkbox, NumberInput, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { Select } from '@/components/Select'
import { AGENT_CAPABILITY_IDS } from '@/data/policyFactCatalog'
import { DigitalEmployeePlaybookEditor } from './DigitalEmployeePlaybookEditor'

export type DevelopmentEditorKind =
  | 'employees'
  | 'action-templates'
  | 'verification-profiles'
  | 'adapters'

interface Props {
  kind: DevelopmentEditorKind
  draft: Record<string, unknown>
  identityCapabilityId?: string
  onChange: (draft: Record<string, unknown>) => void
}

type VersionedRef = { id: string; revision: number }

const ADAPTER_PURPOSES = [
  'requirement-source',
  'pipeline-gate',
  'pipeline-classifier',
  'approval-gateway',
] as const

const PURPOSE_OPERATIONS: Record<(typeof ADAPTER_PURPOSES)[number], readonly string[]> = {
  'requirement-source': ['acquire', 'questions.writeback', 'answers.collect'],
  'pipeline-gate': ['collect', 'trigger', 'rerun'],
  'pipeline-classifier': ['classify'],
  'approval-gateway': ['submit', 'lookup-by-idempotency-key', 'observe'],
}

const REQUIRED_OPERATION: Record<(typeof ADAPTER_PURPOSES)[number], string> = {
  'requirement-source': 'acquire',
  'pipeline-gate': 'collect',
  'pipeline-classifier': 'classify',
  'approval-gateway': 'submit',
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function versionedRef(value: unknown): VersionedRef {
  const ref = record(value)
  return {
    id: stringValue(ref.id),
    revision: numberValue(ref.revision, 1),
  }
}

function patchAt<T>(items: T[], index: number, patch: Partial<T>): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? ({ ...item, ...patch } as T) : item))
}

function removeAt<T>(items: T[], index: number): T[] {
  return items.filter((_, itemIndex) => itemIndex !== index)
}

function ItemActions(props: { onRemove: () => void }): ReactElement {
  const { t } = useTranslation()
  return (
    <button type="button" className="btn btn--xs btn--danger" onClick={props.onRemove}>
      {t('common.remove')}
    </button>
  )
}

function VersionedRefFields(props: {
  value: unknown
  onChange: (value: VersionedRef) => void
  testid: string
}): ReactElement {
  const { t } = useTranslation()
  const value = versionedRef(props.value)
  return (
    <div className="form-grid form-grid--two">
      <Field label={t('code.config.editor.resourceId')} required>
        <TextInput
          value={value.id}
          onChange={(id) => props.onChange({ ...value, id })}
          data-testid={`${props.testid}-id`}
        />
      </Field>
      <Field label={t('code.config.editor.revision')} required>
        <NumberInput
          value={value.revision}
          min={1}
          step={1}
          rangeHint={false}
          onChange={(revision) => props.onChange({ ...value, revision: revision ?? 1 })}
          data-testid={`${props.testid}-revision`}
        />
      </Field>
    </div>
  )
}

export function DevelopmentConfigEditor(props: Props): ReactElement {
  if (props.kind === 'employees') return <EmployeeEditor {...props} />
  if (props.kind === 'action-templates') return <TemplateEditor {...props} />
  if (props.kind === 'verification-profiles') return <VerificationEditor {...props} />
  return <AdapterEditor {...props} />
}

function EmployeeEditor(props: Props): ReactElement {
  const { t } = useTranslation()
  if (props.kind === 'employees') {
    return <DigitalEmployeePlaybookEditor draft={props.draft} onChange={props.onChange} />
  }
  const draft = props.draft
  const update = (patch: Record<string, unknown>) => props.onChange({ ...draft, ...patch })
  const routes = Array.isArray(draft.capabilityRoutes) ? draft.capabilityRoutes.map(record) : []
  const sources = Array.isArray(draft.requirementSources)
    ? draft.requirementSources.map(record)
    : []
  const providers = Array.isArray(draft.pipelineProviders)
    ? draft.pipelineProviders.map(record)
    : []

  return (
    <div className="config-editor" data-testid="config-guided-editor-employee">
      <FormSection title={t('code.config.editor.identitySection')}>
        <Field label={t('code.config.description')}>
          <TextArea
            value={stringValue(draft.description)}
            onChange={(description) => update({ description })}
            rows={3}
            data-testid="config-edit-description"
          />
        </Field>
        <Field
          label={t('code.config.defaultPolicy')}
          hint={t('code.config.editor.versionedRefHint')}
          group
        >
          <VersionedRefFields
            value={draft.defaultPolicyRef}
            testid="config-employee-policy"
            onChange={(defaultPolicyRef) => update({ defaultPolicyRef })}
          />
        </Field>
      </FormSection>

      <FormSection title={t('code.config.routesTitle')}>
        <p className="form-section__hint">{t('code.config.editor.routesHint')}</p>
        <div className="config-editor__items">
          {routes.map((route, index) => {
            const fallback = route.fallbackTemplateRef
            return (
              <div
                className="config-editor__item"
                key={`${stringValue(route.capabilityId)}-${index}`}
              >
                <div className="config-editor__item-header">
                  <strong>{t('code.config.editor.routeNumber', { number: index + 1 })}</strong>
                  <ItemActions
                    onRemove={() => update({ capabilityRoutes: removeAt(routes, index) })}
                  />
                </div>
                <Field label={t('code.config.colCapability')} required>
                  <Select
                    value={stringValue(route.capabilityId, AGENT_CAPABILITY_IDS[1])}
                    onChange={(capabilityId) =>
                      update({ capabilityRoutes: patchAt(routes, index, { capabilityId }) })
                    }
                    options={AGENT_CAPABILITY_IDS.map((id) => ({ value: id, label: id }))}
                    data-testid={`config-route-${index}-capability`}
                  />
                </Field>
                <Field
                  label={t('code.config.colFallback')}
                  hint={t('code.config.editor.fallbackHint')}
                  group
                >
                  <VersionedRefFields
                    value={fallback}
                    testid={`config-route-${index}-fallback`}
                    onChange={(fallbackTemplateRef) =>
                      update({
                        capabilityRoutes: patchAt(routes, index, { fallbackTemplateRef }),
                      })
                    }
                  />
                </Field>
                {Array.isArray(route.rules) && route.rules.length > 0 ? (
                  <p className="form-field__hint">
                    {t('code.config.editor.rulesPreserved', { count: route.rules.length })}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            update({
              capabilityRoutes: [
                ...routes,
                {
                  capabilityId: AGENT_CAPABILITY_IDS[1],
                  rules: [],
                  fallbackTemplateRef: null,
                },
              ],
            })
          }
          data-testid="config-route-add"
        >
          {t('code.config.editor.addRoute')}
        </button>
      </FormSection>

      <FormSection title={t('code.config.requirementSources')}>
        <p className="form-section__hint">{t('code.config.editor.requirementSourcesHint')}</p>
        <div className="config-editor__items">
          {sources.map((source, index) => (
            <div className="config-editor__item" key={`${stringValue(source.sourceKey)}-${index}`}>
              <div className="config-editor__item-header">
                <strong>{t('code.config.editor.sourceNumber', { number: index + 1 })}</strong>
                <ItemActions
                  onRemove={() => update({ requirementSources: removeAt(sources, index) })}
                />
              </div>
              <Field label={t('code.config.editor.sourceKey')} required>
                <TextInput
                  value={stringValue(source.sourceKey)}
                  onChange={(sourceKey) =>
                    update({ requirementSources: patchAt(sources, index, { sourceKey }) })
                  }
                  data-testid={`config-source-${index}-key`}
                />
              </Field>
              <Field label={t('code.config.editor.adapterRef')} group required>
                <VersionedRefFields
                  value={source.adapterRef}
                  testid={`config-source-${index}-adapter`}
                  onChange={(adapterRef) =>
                    update({ requirementSources: patchAt(sources, index, { adapterRef }) })
                  }
                />
              </Field>
              <Checkbox
                checked={source.isDefault === true}
                label={t('code.config.editor.defaultSource')}
                onChange={(isDefault) =>
                  update({
                    requirementSources: sources.map((item, itemIndex) => ({
                      ...item,
                      isDefault: isDefault
                        ? itemIndex === index
                        : itemIndex === index
                          ? false
                          : item.isDefault,
                    })),
                  })
                }
                data-testid={`config-source-${index}-default`}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            update({
              requirementSources: [
                ...sources,
                {
                  sourceKey: '',
                  adapterRef: { id: '', revision: 1 },
                  isDefault: sources.length === 0,
                },
              ],
            })
          }
          data-testid="config-source-add"
        >
          {t('code.config.editor.addSource')}
        </button>
      </FormSection>

      <FormSection title={t('code.config.pipelineProviders')}>
        <p className="form-section__hint">{t('code.config.editor.pipelineProvidersHint')}</p>
        <div className="config-editor__items">
          {providers.map((provider, index) => (
            <div
              className="config-editor__item"
              key={`${stringValue(provider.providerKey)}-${index}`}
            >
              <div className="config-editor__item-header">
                <strong>{t('code.config.editor.providerNumber', { number: index + 1 })}</strong>
                <ItemActions
                  onRemove={() => update({ pipelineProviders: removeAt(providers, index) })}
                />
              </div>
              <Field label={t('code.config.editor.providerKey')} required>
                <TextInput
                  value={stringValue(provider.providerKey)}
                  onChange={(providerKey) =>
                    update({ pipelineProviders: patchAt(providers, index, { providerKey }) })
                  }
                  data-testid={`config-provider-${index}-key`}
                />
              </Field>
              <Field label={t('code.config.editor.adapterRef')} group required>
                <VersionedRefFields
                  value={provider.adapterRef}
                  testid={`config-provider-${index}-adapter`}
                  onChange={(adapterRef) =>
                    update({ pipelineProviders: patchAt(providers, index, { adapterRef }) })
                  }
                />
              </Field>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            update({
              pipelineProviders: [
                ...providers,
                { providerKey: '', adapterRef: { id: '', revision: 1 } },
              ],
            })
          }
          data-testid="config-provider-add"
        >
          {t('code.config.editor.addProvider')}
        </button>
      </FormSection>
    </div>
  )
}

function TemplateEditor(props: Props): ReactElement {
  const { t } = useTranslation()
  const draft = props.draft
  const update = (patch: Record<string, unknown>) => props.onChange({ ...draft, ...patch })
  const executor = record(draft.executor)
  const kind = executor.kind === 'workgroup' || executor.kind === 'script' ? executor.kind : 'agent'
  const retry = record(draft.retryDefaults)
  const capabilityId =
    props.identityCapabilityId ?? stringValue(draft.capabilityId, AGENT_CAPABILITY_IDS[1])

  return (
    <div className="config-editor" data-testid="config-guided-editor-template">
      <FormSection title={t('code.config.editor.executionSection')}>
        <div className="form-grid form-grid--two">
          <Field
            label={t('code.config.colCapability')}
            hint={t('code.config.editor.capabilityLocked')}
          >
            <TextInput value={capabilityId} onChange={() => undefined} readOnly />
          </Field>
          <Field label={t('code.config.editor.contractVersion')} required>
            <NumberInput
              value={numberValue(draft.capabilityContractVersion, 1)}
              min={1}
              step={1}
              rangeHint={false}
              onChange={(capabilityContractVersion) =>
                update({ capabilityId, capabilityContractVersion: capabilityContractVersion ?? 1 })
              }
              data-testid="config-template-contract-version"
            />
          </Field>
        </div>
        <Field label={t('code.config.editor.executorKind')} required>
          <Select
            value={kind}
            onChange={(nextKind) =>
              update({
                executor:
                  nextKind === 'agent'
                    ? { kind: 'agent', agentRef: '' }
                    : nextKind === 'workgroup'
                      ? { kind: 'workgroup', workgroupRef: '' }
                      : { kind: 'script', language: 'bash', scriptRef: '' },
              })
            }
            options={[
              { value: 'agent', label: t('code.config.editor.agent') },
              { value: 'workgroup', label: t('code.config.editor.workgroup') },
              { value: 'script', label: t('code.employeePlaybook.executorScript') },
            ]}
            data-testid="config-template-executor-kind"
          />
        </Field>
        {kind === 'script' ? (
          <div className="form-grid form-grid--two">
            <Field label={t('code.employeePlaybook.programLanguage')} required>
              <Select
                value={stringValue(executor.language, 'bash')}
                onChange={(language) => update({ executor: { ...executor, kind, language } })}
                options={[
                  { value: 'bash', label: 'Bash' },
                  { value: 'python', label: 'Python' },
                  { value: 'node', label: 'Node.js' },
                ]}
              />
            </Field>
            <Field label={t('code.employeePlaybook.programPath')} required>
              <TextInput
                value={stringValue(executor.scriptRef)}
                onChange={(scriptRef) => update({ executor: { ...executor, kind, scriptRef } })}
                data-testid="config-template-executor-ref"
              />
            </Field>
          </div>
        ) : (
          <Field
            label={
              kind === 'agent' ? t('code.config.executor') : t('code.config.editor.workgroupRef')
            }
            required
          >
            <TextInput
              value={stringValue(kind === 'agent' ? executor.agentRef : executor.workgroupRef)}
              onChange={(ref) =>
                update({
                  executor:
                    kind === 'agent' ? { kind, agentRef: ref } : { kind, workgroupRef: ref },
                })
              }
              data-testid="config-template-executor-ref"
            />
          </Field>
        )}
        <div className="form-grid form-grid--two">
          <Field label={t('code.config.editor.runtimeProfile')} required>
            <TextInput
              value={stringValue(draft.runtimeProfileRef)}
              onChange={(runtimeProfileRef) => update({ runtimeProfileRef })}
              data-testid="config-template-runtime-profile"
            />
          </Field>
          <Field label={t('code.config.verificationProfile')} required>
            <TextInput
              value={stringValue(draft.verificationProfileRef)}
              onChange={(verificationProfileRef) => update({ verificationProfileRef })}
              data-testid="config-template-verification-profile"
            />
          </Field>
        </div>
        <Field label={t('code.config.promptSupplement')} hint={t('code.config.promptHint')}>
          <TextArea
            value={stringValue(draft.promptSupplement)}
            onChange={(promptSupplement) => update({ promptSupplement })}
            rows={6}
            monospace
            data-testid="config-edit-prompt"
          />
        </Field>
      </FormSection>

      <FormSection title={t('code.config.editor.resourcesSection')}>
        <Field label={t('code.config.editor.labels')}>
          <ChipsInput value={stringArray(draft.labels)} onChange={(labels) => update({ labels })} />
        </Field>
        <Field label={t('code.config.editor.skills')}>
          <ChipsInput
            value={stringArray(draft.skillRefs)}
            onChange={(skillRefs) => update({ skillRefs })}
          />
        </Field>
        <Field label={t('code.config.editor.mcps')}>
          <ChipsInput
            value={stringArray(draft.mcpRefs)}
            onChange={(mcpRefs) => update({ mcpRefs })}
          />
        </Field>
        <Field label={t('code.config.editor.readOnlyResources')}>
          <ChipsInput
            value={stringArray(draft.readOnlyResourceRefs)}
            onChange={(readOnlyResourceRefs) => update({ readOnlyResourceRefs })}
          />
        </Field>
        <div className="form-grid form-grid--two">
          <Field label={t('code.config.editor.contextProfile')}>
            <TextInput
              value={stringValue(draft.contextProfileRef)}
              onChange={(value) =>
                update({ contextProfileRef: value.trim() === '' ? null : value })
              }
            />
          </Field>
          <Field label={t('code.config.editor.writablePathPolicy')}>
            <TextInput
              value={stringValue(draft.writablePathPolicyRef)}
              onChange={(value) =>
                update({ writablePathPolicyRef: value.trim() === '' ? null : value })
              }
            />
          </Field>
        </div>
        <Field label={t('code.config.editor.protectedPathClasses')}>
          <ChipsInput
            value={stringArray(draft.additionalProtectedPathClasses)}
            onChange={(additionalProtectedPathClasses) =>
              update({ additionalProtectedPathClasses })
            }
          />
        </Field>
      </FormSection>

      <FormSection title={t('code.config.retryDefaults')}>
        <div className="form-grid form-grid--two">
          <Field label={t('code.config.editor.sameSessionRetries')} required>
            <NumberInput
              value={numberValue(retry.sameSession, 0)}
              min={0}
              max={5}
              step={1}
              onChange={(sameSession) =>
                update({ retryDefaults: { ...retry, sameSession: sameSession ?? 0 } })
              }
            />
          </Field>
          <Field label={t('code.config.editor.freshSessionRetries')} required>
            <NumberInput
              value={numberValue(retry.freshSession, 0)}
              min={0}
              max={3}
              step={1}
              onChange={(freshSession) =>
                update({ retryDefaults: { ...retry, freshSession: freshSession ?? 0 } })
              }
            />
          </Field>
        </div>
      </FormSection>
    </div>
  )
}

function VerificationEditor(props: Props): ReactElement {
  const { t } = useTranslation()
  const draft = props.draft
  const update = (patch: Record<string, unknown>) => props.onChange({ ...draft, ...patch })
  const steps = Array.isArray(draft.steps) ? draft.steps.map(record) : []

  return (
    <div className="config-editor" data-testid="config-guided-editor-verification">
      <FormSection title={t('code.config.editor.verificationStrategy')}>
        <div className="form-grid form-grid--two">
          <Field label={t('code.config.stopPolicy')} required>
            <Select
              value={stringValue(draft.stopPolicy, 'first-failure')}
              onChange={(stopPolicy) => update({ stopPolicy })}
              options={[
                { value: 'first-failure', label: t('code.config.editor.firstFailure') },
                { value: 'collect-all', label: t('code.config.editor.collectAll') },
              ]}
              data-testid="config-verification-stop-policy"
            />
          </Field>
          <Field label={t('code.config.editor.maxParallel')} required>
            <NumberInput
              value={numberValue(draft.maxParallel, 1)}
              min={1}
              max={8}
              step={1}
              onChange={(maxParallel) => update({ maxParallel: maxParallel ?? 1 })}
              data-testid="config-verification-max-parallel"
            />
          </Field>
        </div>
      </FormSection>
      <FormSection title={t('code.config.profileSummary')}>
        <p className="form-section__hint">{t('code.config.editor.verificationStepsHint')}</p>
        <div className="config-editor__items">
          {steps.map((step, index) => (
            <div className="config-editor__item" key={`${stringValue(step.stepId)}-${index}`}>
              <div className="config-editor__item-header">
                <strong>{t('code.config.editor.stepNumber', { number: index + 1 })}</strong>
                <ItemActions onRemove={() => update({ steps: removeAt(steps, index) })} />
              </div>
              <div className="form-grid form-grid--two">
                <Field label={t('code.config.colStep')} required>
                  <TextInput
                    value={stringValue(step.stepId)}
                    onChange={(stepId) => update({ steps: patchAt(steps, index, { stepId }) })}
                    data-testid={`config-step-${index}-id`}
                  />
                </Field>
                <Field label={t('code.config.colProgram')} required>
                  <TextInput
                    value={stringValue(step.programRef)}
                    onChange={(programRef) =>
                      update({ steps: patchAt(steps, index, { programRef }) })
                    }
                    data-testid={`config-step-${index}-program`}
                  />
                </Field>
                <Field label={t('code.config.editor.argsRef')}>
                  <TextInput
                    value={stringValue(step.argsRef)}
                    onChange={(value) =>
                      update({
                        steps: patchAt(steps, index, {
                          argsRef: value.trim() === '' ? null : value,
                        }),
                      })
                    }
                  />
                </Field>
                <Field label={t('code.config.editor.networkProfile')} required>
                  <TextInput
                    value={stringValue(step.networkProfileRef)}
                    onChange={(networkProfileRef) =>
                      update({ steps: patchAt(steps, index, { networkProfileRef }) })
                    }
                  />
                </Field>
                <Field label={t('code.config.colTimeout')} required>
                  <NumberInput
                    value={numberValue(step.timeoutMs, 120_000)}
                    min={1}
                    max={1_800_000}
                    step={1000}
                    unit="ms"
                    onChange={(timeoutMs) =>
                      update({ steps: patchAt(steps, index, { timeoutMs: timeoutMs ?? 120_000 }) })
                    }
                  />
                </Field>
              </div>
              <Field label={t('code.config.colExitCodes')}>
                <ChipsInput
                  value={(Array.isArray(step.successExitCodes) ? step.successExitCodes : [0]).map(
                    String,
                  )}
                  validate={(token) => {
                    const code = Number(token)
                    return Number.isInteger(code) && code >= 0 && code <= 255
                      ? null
                      : t('code.config.editor.exitCodeInvalid')
                  }}
                  onChange={(values) =>
                    update({
                      steps: patchAt(steps, index, {
                        successExitCodes: values.map(Number).filter(Number.isInteger),
                      }),
                    })
                  }
                />
              </Field>
              {Array.isArray(step.evidenceSelectors) && step.evidenceSelectors.length > 0 ? (
                <p className="form-field__hint">
                  {t('code.config.editor.evidenceSelectorsPreserved', {
                    count: step.evidenceSelectors.length,
                  })}
                </p>
              ) : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            update({
              steps: [
                ...steps,
                {
                  stepId: `step-${steps.length + 1}`,
                  programRef: '',
                  argsRef: null,
                  timeoutMs: 120_000,
                  networkProfileRef: 'network:none',
                  successExitCodes: [0],
                  evidenceSelectors: [],
                },
              ],
            })
          }
          data-testid="config-step-add"
        >
          {t('code.config.editor.addStep')}
        </button>
      </FormSection>
    </div>
  )
}

function AdapterEditor(props: Props): ReactElement {
  const { t } = useTranslation()
  const draft = props.draft
  const update = (patch: Record<string, unknown>) => props.onChange({ ...draft, ...patch })
  const purpose = ADAPTER_PURPOSES.includes(draft.purpose as (typeof ADAPTER_PURPOSES)[number])
    ? (draft.purpose as (typeof ADAPTER_PURPOSES)[number])
    : ADAPTER_PURPOSES[0]
  const operations = stringArray(draft.operations)
  const budget = record(draft.outputBudget)

  return (
    <div className="config-editor" data-testid="config-guided-editor-adapter">
      <FormSection title={t('code.config.editor.adapterProgramSection')}>
        <Field label={t('code.config.purpose')} required>
          <Select
            value={purpose}
            onChange={(nextPurpose) => {
              const typed = nextPurpose as (typeof ADAPTER_PURPOSES)[number]
              const allowed = new Set(PURPOSE_OPERATIONS[typed])
              const nextOperations = operations.filter((operation) => allowed.has(operation))
              if (!nextOperations.includes(REQUIRED_OPERATION[typed])) {
                nextOperations.unshift(REQUIRED_OPERATION[typed])
              }
              update({ purpose: typed, operations: nextOperations })
            }}
            options={ADAPTER_PURPOSES.map((value) => ({ value, label: value }))}
            data-testid="config-adapter-purpose"
          />
        </Field>
        <Field
          label={t('code.config.operations')}
          hint={t('code.config.editor.operationsHint')}
          group
          required
        >
          <div className="config-editor__checks">
            {PURPOSE_OPERATIONS[purpose].map((operation) => (
              <Checkbox
                key={operation}
                checked={operations.includes(operation)}
                disabled={operation === REQUIRED_OPERATION[purpose]}
                label={operation}
                onChange={(checked) =>
                  update({
                    operations: checked
                      ? [...operations, operation]
                      : operations.filter((candidate) => candidate !== operation),
                  })
                }
              />
            ))}
          </div>
        </Field>
        <Field label={t('code.config.executable')} required>
          <TextInput
            value={stringValue(draft.executableRef)}
            onChange={(executableRef) => update({ executableRef })}
            data-testid="config-adapter-executable"
          />
        </Field>
        <div className="form-grid form-grid--two">
          <Field label={t('code.config.editor.parameterSchema')}>
            <TextInput
              value={stringValue(draft.parameterSchemaRef)}
              onChange={(value) =>
                update({ parameterSchemaRef: value.trim() === '' ? null : value })
              }
            />
          </Field>
          <Field label={t('code.config.connection')}>
            <TextInput
              value={stringValue(draft.connectionRef)}
              onChange={(value) => update({ connectionRef: value.trim() === '' ? null : value })}
            />
          </Field>
        </div>
        <Field
          label={t('code.config.secretProjection')}
          hint={t('code.config.editor.secretKeysHint')}
        >
          <ChipsInput
            value={stringArray(draft.secretProjection)}
            onChange={(secretProjection) => update({ secretProjection })}
          />
        </Field>
      </FormSection>

      <FormSection title={t('code.config.outputBudget')}>
        <p className="form-section__hint">{t('code.config.editor.outputBudgetHint')}</p>
        <div className="form-grid form-grid--cols-3">
          <Field label={t('code.config.editor.maxFiles')} required>
            <NumberInput
              value={numberValue(budget.maxFiles, 200)}
              min={1}
              max={10_000}
              step={1}
              onChange={(maxFiles) =>
                update({ outputBudget: { ...budget, maxFiles: maxFiles ?? 1 } })
              }
            />
          </Field>
          <Field label={t('code.config.editor.maxFileBytes')} required>
            <NumberInput
              value={numberValue(budget.maxFileBytes, 32 * 1024 * 1024)}
              min={1}
              max={64 * 1024 * 1024 * 1024}
              step={1024}
              unit="bytes"
              onChange={(maxFileBytes) =>
                update({ outputBudget: { ...budget, maxFileBytes: maxFileBytes ?? 1 } })
              }
            />
          </Field>
          <Field label={t('code.config.editor.maxTotalBytes')} required>
            <NumberInput
              value={numberValue(budget.maxTotalBytes, 256 * 1024 * 1024)}
              min={1}
              max={64 * 1024 * 1024 * 1024}
              step={1024}
              unit="bytes"
              onChange={(maxTotalBytes) =>
                update({ outputBudget: { ...budget, maxTotalBytes: maxTotalBytes ?? 1 } })
              }
            />
          </Field>
        </div>
        <Field label={t('code.config.timeout')} required>
          <NumberInput
            value={numberValue(draft.timeoutMs, 120_000)}
            min={1_000}
            max={1_800_000}
            step={1000}
            unit="ms"
            onChange={(timeoutMs) => update({ timeoutMs: timeoutMs ?? 1000 })}
            data-testid="config-adapter-timeout"
          />
        </Field>
      </FormSection>
    </div>
  )
}
