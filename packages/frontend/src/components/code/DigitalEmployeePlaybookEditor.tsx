import { buildDevelopmentConfigCreateBody } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Checkbox, Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { Select } from '@/components/Select'
import { AGENT_CAPABILITY_IDS } from '@/data/policyFactCatalog'
import {
  PLATFORM_ACTIONS,
  asRecord,
  asRecords,
  buildInitialEmployeePlaybook,
  employeePresetOf,
  exactRef,
  newBusinessStep,
  predicatesForTrigger,
  publishedRef,
  responsibilityPredicates,
  triggerOf,
  type BusinessProducerKind,
  type BusinessTrigger,
  type EmployeePreset,
  type PublishedResourceOption,
} from './employeePlaybook'

interface Props {
  draft: Record<string, unknown>
  onChange: (draft: Record<string, unknown>) => void
}

interface ResourcePage {
  items: PublishedResourceOption[]
}

interface AgentOption {
  id: string
  name: string
}

type InlineExecutorKind = 'agent' | 'script' | 'employee' | 'approval-system'

interface InlineExecutorRequest {
  kind: InlineExecutorKind
  onCreated: (resource: PublishedResourceOption) => void
}

function patchAt(
  values: Record<string, unknown>[],
  index: number,
  patch: Record<string, unknown>,
): Record<string, unknown>[] {
  return values.map((value, valueIndex) => (valueIndex === index ? { ...value, ...patch } : value))
}

function removeAt(values: Record<string, unknown>[], index: number): Record<string, unknown>[] {
  return values.filter((_, valueIndex) => valueIndex !== index)
}

function moveAt(
  values: Record<string, unknown>[],
  index: number,
  direction: -1 | 1,
): Record<string, unknown>[] {
  const target = index + direction
  if (target < 0 || target >= values.length) return values
  const next = [...values]
  const current = next[index]!
  next[index] = next[target]!
  next[target] = current
  return next
}

function idOf(value: unknown): string {
  return exactRef(value)?.id ?? ''
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function published(resources: readonly PublishedResourceOption[]): PublishedResourceOption[] {
  return resources.filter((resource) => resource.publishedRevision !== null)
}

function optionsOf(
  resources: readonly PublishedResourceOption[],
  emptyLabel?: string,
): { value: string; label: string }[] {
  return [
    ...(emptyLabel === undefined ? [] : [{ value: '', label: emptyLabel }]),
    ...published(resources).map((resource) => ({ value: resource.id, label: resource.name })),
  ]
}

function resourceRef(
  resources: readonly PublishedResourceOption[],
  id: string,
): { id: string; revision: number } | null {
  return publishedRef(resources.find((resource) => resource.id === id))
}

function producerKindOf(producer: Record<string, unknown>): BusinessProducerKind {
  const kind = producer.kind
  return kind === 'agent' ||
    kind === 'script' ||
    kind === 'digital-employee' ||
    kind === 'approval-prepare' ||
    kind === 'approval-submit' ||
    kind === 'approval-observe'
    ? kind
    : 'platform'
}

function defaultFailure(): Record<string, unknown> {
  return {
    retry: { sameScene: 1, freshScene: 1 },
    onExhausted: 'block',
    onRejected: null,
    onExpired: null,
  }
}

function defaultProducer(kind: BusinessProducerKind): Record<string, unknown> {
  switch (kind) {
    case 'platform':
      return { kind, capabilityId: 'repository.inspect' }
    case 'agent':
    case 'script':
      return { kind, implementationRef: { id: '', revision: 1 } }
    case 'digital-employee':
      return {
        kind,
        employeeRef: { id: '', revision: 1 },
        repository: { kind: 'fixed', repositoryId: '' },
        completion: 'ready-to-merge',
        deadlineMs: 86_400_000,
      }
    case 'approval-prepare':
      return {
        kind,
        executor: 'agent',
        implementationRef: { id: '', revision: 1 },
        approvalType: '',
      }
    case 'approval-submit':
      return { kind, adapterRef: { id: '', revision: 1 } }
    case 'approval-observe':
      return {
        kind,
        adapterRef: { id: '', revision: 1 },
        pollIntervalMs: 60_000,
        deadlineMs: 86_400_000,
        webhookSourceKey: null,
      }
  }
}

export function DigitalEmployeePlaybookEditor(props: Props): ReactElement {
  const { t } = useTranslation()
  const templates = useQuery<ResourcePage>({
    queryKey: ['code-config', 'action-templates'],
    queryFn: ({ signal }) => api.get('/api/code/action-templates', undefined, signal),
  })
  const employees = useQuery<ResourcePage>({
    queryKey: ['code-config', 'employees'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })
  const policies = useQuery<ResourcePage>({
    queryKey: ['code-policies'],
    queryFn: ({ signal }) => api.get('/api/code/automation-policies', undefined, signal),
  })
  const adapters = useQuery<ResourcePage>({
    queryKey: ['code-config', 'adapters'],
    queryFn: ({ signal }) => api.get('/api/integrations/development-adapters', undefined, signal),
  })
  const agents = useQuery<AgentOption[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })
  const [executorRequest, setExecutorRequest] = useState<InlineExecutorRequest | null>(null)

  const templateItems = templates.data?.items ?? []
  const employeeItems = employees.data?.items ?? []
  const policyItems = policies.data?.items ?? []
  const adapterItems = adapters.data?.items ?? []
  const approvalAdapters = adapterItems.filter((adapter) => adapter.purpose === 'approval-gateway')
  const requirementAdapters = adapterItems.filter(
    (adapter) => adapter.purpose === 'requirement-source',
  )
  const pipelineAdapters = adapterItems.filter((adapter) => adapter.purpose === 'pipeline-gate')
  const steps = asRecords(props.draft.steps)
  const problemTypes = asRecords(props.draft.problemTypes)
  const problemProducers = asRecords(props.draft.problemProducers)
  const problemHandlers = asRecords(props.draft.problemHandlers)

  const update = (patch: Record<string, unknown>): void => {
    props.onChange({ ...props.draft, ...patch })
  }
  const updateSteps = (next: Record<string, unknown>[]): void => update({ steps: next })
  const routeForImplementation = (
    implementationId: string,
  ): {
    implementationRef: { id: string; revision: number }
    capabilityRoutes: Record<string, unknown>[]
  } | null => {
    const implementation = templateItems.find((item) => item.id === implementationId)
    return implementation === undefined ? null : addImplementationRoute(implementation)
  }
  const addImplementationRoute = (
    implementation: PublishedResourceOption,
  ): {
    implementationRef: { id: string; revision: number }
    capabilityRoutes: Record<string, unknown>[]
  } | null => {
    const implementationRef = publishedRef(implementation)
    if (implementationRef === null || implementation.capabilityId === undefined) return null
    const routes = asRecords(props.draft.capabilityRoutes)
    const existing = routes.findIndex((route) => route.capabilityId === implementation.capabilityId)
    const route = {
      capabilityId: implementation.capabilityId,
      rules: [],
      fallbackTemplateRef: implementationRef,
    }
    return {
      implementationRef,
      capabilityRoutes: existing < 0 ? [...routes, route] : patchAt(routes, existing, route),
    }
  }
  const errors = [
    templates.error,
    employees.error,
    policies.error,
    adapters.error,
    agents.error,
  ].filter((error): error is Error => error instanceof Error)

  return (
    <div className="employee-playbook-editor" data-testid="employee-playbook-editor">
      {errors.length > 0 ? <ErrorBanner error={errors[0]} /> : null}

      <FormSection title={t('code.employeePlaybook.basics')}>
        <Field label={t('code.config.description')}>
          <TextArea
            value={textOf(props.draft.description)}
            onChange={(description) => update({ description })}
            rows={3}
            data-testid="config-edit-description"
          />
        </Field>
        <div className="form-grid form-grid--two">
          <Field label={t('code.employeePlaybook.preset')}>
            <Select
              value={employeePresetOf(props.draft)}
              onChange={(value) =>
                update({
                  supportedRepositoryFacts: responsibilityPredicates(value as EmployeePreset),
                })
              }
              options={[
                { value: 'general', label: t('code.employeePlaybook.presetGeneral') },
                { value: 'java', label: t('code.employeePlaybook.presetJava') },
                { value: 'cpp', label: t('code.employeePlaybook.presetCpp') },
              ]}
              data-testid="employee-preset"
            />
          </Field>
          <Field
            label={t('code.employeePlaybook.ruleSet')}
            hint={t('code.employeePlaybook.ruleSetHint')}
          >
            <Select
              value={idOf(props.draft.defaultPolicyRef)}
              onChange={(id) => {
                const next = resourceRef(policyItems, id)
                if (next !== null) update({ defaultPolicyRef: next })
              }}
              options={optionsOf(policyItems, t('code.employeePlaybook.chooseRuleSet'))}
              data-testid="employee-policy"
            />
          </Field>
        </div>
        <Switch
          checked={props.draft.businessStatus !== 'disabled'}
          label={t('code.employeePlaybook.enabled')}
          onChange={(checked) => update({ businessStatus: checked ? 'enabled' : 'disabled' })}
          data-testid="employee-enabled"
        />
      </FormSection>

      <FormSection title={t('code.employeePlaybook.steps')}>
        <p className="form-section__hint">{t('code.employeePlaybook.stepsHint')}</p>
        <div className="config-editor__items">
          {steps.map((step, index) => (
            <StepCard
              key={`${textOf(step.stepId)}-${index}`}
              index={index}
              total={steps.length}
              steps={steps}
              step={step}
              templates={templateItems}
              employees={employeeItems}
              approvalAdapters={approvalAdapters}
              onChange={(patch) => updateSteps(patchAt(steps, index, patch))}
              onImplementation={(implementationId) => {
                const selected = routeForImplementation(implementationId)
                if (selected !== null) {
                  props.onChange({
                    ...props.draft,
                    capabilityRoutes: selected.capabilityRoutes,
                    steps: patchAt(steps, index, {
                      producer: {
                        ...asRecord(step.producer),
                        implementationRef: selected.implementationRef,
                      },
                    }),
                  })
                }
              }}
              onCreateImplementation={(executorKind) =>
                setExecutorRequest({
                  kind: executorKind,
                  onCreated: (resource) => {
                    const selected = addImplementationRoute(resource)
                    if (selected === null) return
                    props.onChange({
                      ...props.draft,
                      capabilityRoutes: selected.capabilityRoutes,
                      steps: patchAt(steps, index, {
                        producer: {
                          ...asRecord(step.producer),
                          implementationRef: selected.implementationRef,
                        },
                      }),
                    })
                  },
                })
              }
              onCreateEmployee={() =>
                setExecutorRequest({
                  kind: 'employee',
                  onCreated: (resource) => {
                    const employeeRef = publishedRef(resource)
                    if (employeeRef === null) return
                    props.onChange({
                      ...props.draft,
                      steps: patchAt(steps, index, {
                        producer: { ...asRecord(step.producer), employeeRef },
                      }),
                    })
                  },
                })
              }
              onCreateApprovalSystem={() =>
                setExecutorRequest({
                  kind: 'approval-system',
                  onCreated: (resource) => {
                    const adapterRef = publishedRef(resource)
                    if (adapterRef === null) return
                    props.onChange({
                      ...props.draft,
                      steps: patchAt(steps, index, {
                        producer: { ...asRecord(step.producer), adapterRef },
                      }),
                    })
                  },
                })
              }
              onMove={(direction) => updateSteps(moveAt(steps, index, direction))}
              onRemove={() => updateSteps(removeAt(steps, index))}
            />
          ))}
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            updateSteps([
              ...steps,
              newBusinessStep(
                steps.length,
                t('code.employeePlaybook.stepNumber', { number: steps.length + 1 }),
              ),
            ])
          }
          data-testid="employee-step-add"
        >
          {t('code.employeePlaybook.addStep')}
        </button>
      </FormSection>

      <ProblemEditor
        types={problemTypes}
        producers={problemProducers}
        handlers={problemHandlers}
        templates={templateItems}
        steps={steps}
        onTypes={(next) => update({ problemTypes: next })}
        onProducers={(next) => update({ problemProducers: next })}
        onHandlers={(next) => update({ problemHandlers: next })}
        onCreateImplementation={(executorKind, onCreated) =>
          setExecutorRequest({ kind: executorKind, onCreated })
        }
      />

      <FormSection title={t('code.employeePlaybook.connections')}>
        <p className="form-section__hint">{t('code.employeePlaybook.connectionsHint')}</p>
        <div className="form-grid form-grid--two">
          <Field label={t('code.employeePlaybook.requirementSystem')}>
            <Select
              value={idOf(asRecords(props.draft.requirementSources)[0]?.adapterRef)}
              onChange={(id) => {
                const next = resourceRef(requirementAdapters, id)
                update({
                  requirementSources:
                    next === null
                      ? []
                      : [{ sourceKey: 'default', adapterRef: next, isDefault: true }],
                })
              }}
              options={optionsOf(requirementAdapters, t('code.employeePlaybook.noConnection'))}
            />
          </Field>
          <Field label={t('code.employeePlaybook.pipelineSystem')}>
            <Select
              value={idOf(asRecords(props.draft.pipelineProviders)[0]?.adapterRef)}
              onChange={(id) => {
                const next = resourceRef(pipelineAdapters, id)
                update({
                  pipelineProviders:
                    next === null ? [] : [{ providerKey: 'default', adapterRef: next }],
                })
              }}
              options={optionsOf(pipelineAdapters, t('code.employeePlaybook.noConnection'))}
            />
          </Field>
        </div>
      </FormSection>
      {executorRequest === null ? null : (
        <InlineExecutorCreateDialog
          request={executorRequest}
          policies={policyItems}
          implementations={templateItems}
          agents={agents.data ?? []}
          onClose={() => setExecutorRequest(null)}
          onCreated={(resource) => {
            executorRequest.onCreated(resource)
            setExecutorRequest(null)
          }}
        />
      )}
    </div>
  )
}

function StepCard(props: {
  index: number
  total: number
  steps: Record<string, unknown>[]
  step: Record<string, unknown>
  templates: PublishedResourceOption[]
  employees: PublishedResourceOption[]
  approvalAdapters: PublishedResourceOption[]
  onChange: (patch: Record<string, unknown>) => void
  onImplementation: (id: string) => void
  onCreateImplementation: (kind: 'agent' | 'script') => void
  onCreateEmployee: () => void
  onCreateApprovalSystem: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}): ReactElement {
  const { t } = useTranslation()
  const producer = asRecord(props.step.producer)
  const kind = producerKindOf(producer)
  const failure = { ...defaultFailure(), ...asRecord(props.step.onFailure) }
  const retry = asRecord(failure.retry)
  const join = asRecord(props.step.join)
  const joinEnabled = props.step.join !== null && props.step.join !== undefined
  const joinMembers = Array.isArray(join.memberStepIds)
    ? join.memberStepIds.filter((value): value is string => typeof value === 'string')
    : []
  const availableTemplates = props.templates.filter((template) =>
    kind === 'script' || (kind === 'approval-prepare' && producer.executor === 'script')
      ? template.executorKind === 'script'
      : template.executorKind !== 'script',
  )
  const implementationId = idOf(producer.implementationRef)
  const adapterId = idOf(producer.adapterRef)
  const stepTargetOptions = props.steps
    .filter((candidate) => candidate !== props.step)
    .map((candidate) => ({
      value: textOf(candidate.stepId),
      label: textOf(candidate.displayName, textOf(candidate.stepId)),
    }))
  const successTargetOptions = [
    ...stepTargetOptions,
    { value: 'reconcile', label: t('code.employeePlaybook.continueByRules') },
    { value: 'complete', label: t('code.employeePlaybook.finishCurrentPlaybook') },
  ]
  const failureTargetOptions = [
    ...stepTargetOptions,
    { value: 'block', label: t('code.employeePlaybook.blockAndAskHuman') },
    { value: 'handoff', label: t('code.employeePlaybook.handoffToHuman') },
  ]

  return (
    <Card
      title={t('code.employeePlaybook.stepNumber', { number: props.index + 1 })}
      className="employee-playbook-step"
      actions={
        <div className="data-table__actions">
          <button
            type="button"
            className="btn btn--xs"
            disabled={props.index === 0}
            onClick={() => props.onMove(-1)}
            aria-label={t('code.employeePlaybook.moveUp')}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn--xs"
            disabled={props.index + 1 === props.total}
            onClick={() => props.onMove(1)}
            aria-label={t('code.employeePlaybook.moveDown')}
          >
            ↓
          </button>
          <button type="button" className="btn btn--xs btn--danger" onClick={props.onRemove}>
            {t('common.remove')}
          </button>
        </div>
      }
    >
      <div className="form-grid form-grid--two">
        <Field label={t('code.employeePlaybook.stepName')} required>
          <TextInput
            value={textOf(props.step.displayName)}
            onChange={(displayName) => props.onChange({ displayName })}
          />
        </Field>
        <Field label={t('code.employeePlaybook.trigger')}>
          <Select
            value={triggerOf(props.step)}
            onChange={(value) =>
              props.onChange({ when: predicatesForTrigger(value as BusinessTrigger) })
            }
            options={[
              { value: 'always', label: t('code.employeePlaybook.triggerAlways') },
              {
                value: 'requirement-ready',
                label: t('code.employeePlaybook.triggerRequirementReady'),
              },
              {
                value: 'review-feedback',
                label: t('code.employeePlaybook.triggerReviewFeedback'),
              },
              {
                value: 'pipeline-failed',
                label: t('code.employeePlaybook.triggerPipelineFailed'),
              },
              {
                value: 'merge-conflict',
                label: t('code.employeePlaybook.triggerMergeConflict'),
              },
            ]}
          />
        </Field>
      </div>
      <Field label={t('code.employeePlaybook.stepDescription')}>
        <TextArea
          value={textOf(props.step.description)}
          onChange={(description) => props.onChange({ description })}
          rows={2}
        />
      </Field>
      <div className="form-grid form-grid--two">
        <Field label={t('code.employeePlaybook.executorType')}>
          <Select
            value={kind}
            onChange={(value) =>
              props.onChange({ producer: defaultProducer(value as BusinessProducerKind) })
            }
            options={[
              { value: 'platform', label: t('code.employeePlaybook.executorPlatform') },
              { value: 'agent', label: t('code.employeePlaybook.executorAgent') },
              { value: 'script', label: t('code.employeePlaybook.executorScript') },
              {
                value: 'digital-employee',
                label: t('code.employeePlaybook.executorEmployee'),
              },
              {
                value: 'approval-prepare',
                label: t('code.employeePlaybook.executorApprovalPrepare'),
              },
              {
                value: 'approval-submit',
                label: t('code.employeePlaybook.executorApprovalSubmit'),
              },
              {
                value: 'approval-observe',
                label: t('code.employeePlaybook.executorApprovalObserve'),
              },
            ]}
          />
        </Field>
        {kind === 'platform' ? (
          <Field label={t('code.employeePlaybook.platformAction')}>
            <div className="employee-step-executor-picker">
              <Select
                value={textOf(producer.capabilityId, 'repository.inspect')}
                onChange={(capabilityId) => props.onChange({ producer: { kind, capabilityId } })}
                options={PLATFORM_ACTIONS.map((action) => ({
                  value: action,
                  label: t(`code.employeePlaybook.platform.${action.replace('.', '_')}`),
                }))}
              />
              <ExecutorLibraryLinks />
            </div>
          </Field>
        ) : null}
        {kind === 'agent' || kind === 'script' ? (
          <Field label={t('code.employeePlaybook.executor')} required>
            <div className="employee-step-executor-picker">
              <Select
                value={implementationId}
                onChange={props.onImplementation}
                options={optionsOf(availableTemplates, t('code.employeePlaybook.chooseExecutor'))}
              />
              <ExecutorLibraryLinks onCreate={() => props.onCreateImplementation(kind)} />
            </div>
          </Field>
        ) : null}
      </div>

      {kind === 'digital-employee' ? (
        <div className="form-grid form-grid--two">
          <Field label={t('code.employeePlaybook.childEmployee')} required>
            <div className="employee-step-executor-picker">
              <Select
                value={idOf(producer.employeeRef)}
                onChange={(id) => {
                  const employeeRef = resourceRef(props.employees, id)
                  if (employeeRef !== null)
                    props.onChange({ producer: { ...producer, employeeRef } })
                }}
                options={optionsOf(props.employees, t('code.employeePlaybook.chooseEmployee'))}
              />
              <ExecutorLibraryLinks onCreate={props.onCreateEmployee} />
            </div>
          </Field>
          <Field label={t('code.employeePlaybook.targetRepository')} required>
            <TextInput
              value={textOf(asRecord(producer.repository).repositoryId)}
              onChange={(repositoryId) =>
                props.onChange({
                  producer: { ...producer, repository: { kind: 'fixed', repositoryId } },
                })
              }
            />
          </Field>
          <Field label={t('code.employeePlaybook.childCompletion')}>
            <Select
              value={textOf(producer.completion, 'ready-to-merge')}
              onChange={(completion) => props.onChange({ producer: { ...producer, completion } })}
              options={[
                {
                  value: 'automation-ready',
                  label: t('code.employeePlaybook.completionAutomationReady'),
                },
                {
                  value: 'ready-to-merge',
                  label: t('code.employeePlaybook.completionReadyToMerge'),
                },
                { value: 'merged', label: t('code.employeePlaybook.completionMerged') },
                { value: 'completed', label: t('code.employeePlaybook.completionCompleted') },
              ]}
            />
          </Field>
          <Field label={t('code.employeePlaybook.deadlineHours')}>
            <NumberInput
              value={Math.round(numberOf(producer.deadlineMs, 86_400_000) / 3_600_000)}
              min={1}
              max={720}
              onChange={(hours) =>
                props.onChange({
                  producer: { ...producer, deadlineMs: (hours ?? 24) * 3_600_000 },
                })
              }
            />
          </Field>
        </div>
      ) : null}

      {kind === 'approval-prepare' ? (
        <div className="form-grid form-grid--two">
          <Field label={t('code.employeePlaybook.approvalDraftExecutor')}>
            <Select
              value={textOf(producer.executor, 'agent')}
              onChange={(executor) =>
                props.onChange({
                  producer: {
                    ...producer,
                    executor,
                    implementationRef: { id: '', revision: 1 },
                  },
                })
              }
              options={[
                { value: 'agent', label: t('code.employeePlaybook.executorAgent') },
                { value: 'script', label: t('code.employeePlaybook.executorScript') },
              ]}
            />
          </Field>
          <Field label={t('code.employeePlaybook.executor')} required>
            <div className="employee-step-executor-picker">
              <Select
                value={implementationId}
                onChange={props.onImplementation}
                options={optionsOf(availableTemplates, t('code.employeePlaybook.chooseExecutor'))}
              />
              <ExecutorLibraryLinks
                onCreate={() =>
                  props.onCreateImplementation(producer.executor === 'script' ? 'script' : 'agent')
                }
              />
            </div>
          </Field>
          <Field label={t('code.employeePlaybook.approvalType')} required>
            <TextInput
              value={textOf(producer.approvalType)}
              onChange={(approvalType) =>
                props.onChange({ producer: { ...producer, approvalType } })
              }
            />
          </Field>
        </div>
      ) : null}

      {kind === 'approval-submit' || kind === 'approval-observe' ? (
        <div className="form-grid form-grid--two">
          <Field label={t('code.employeePlaybook.approvalSystem')} required>
            <div className="employee-step-executor-picker">
              <Select
                value={adapterId}
                onChange={(id) => {
                  const adapterRef = resourceRef(props.approvalAdapters, id)
                  if (adapterRef !== null) props.onChange({ producer: { ...producer, adapterRef } })
                }}
                options={optionsOf(
                  props.approvalAdapters,
                  t('code.employeePlaybook.chooseApprovalSystem'),
                )}
              />
              <ExecutorLibraryLinks onCreate={props.onCreateApprovalSystem} />
            </div>
          </Field>
          {kind === 'approval-observe' ? (
            <>
              <Field label={t('code.employeePlaybook.pollMinutes')}>
                <NumberInput
                  value={Math.round(numberOf(producer.pollIntervalMs, 60_000) / 60_000)}
                  min={1}
                  max={1_440}
                  onChange={(minutes) =>
                    props.onChange({
                      producer: {
                        ...producer,
                        pollIntervalMs: (minutes ?? 1) * 60_000,
                      },
                    })
                  }
                />
              </Field>
              <Field label={t('code.employeePlaybook.deadlineHours')}>
                <NumberInput
                  value={Math.round(numberOf(producer.deadlineMs, 86_400_000) / 3_600_000)}
                  min={1}
                  max={720}
                  onChange={(hours) =>
                    props.onChange({
                      producer: { ...producer, deadlineMs: (hours ?? 24) * 3_600_000 },
                    })
                  }
                />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="form-grid form-grid--two">
        <Field label={t('code.employeePlaybook.afterSuccess')}>
          <Select
            value={textOf(props.step.onSuccess, 'reconcile')}
            onChange={(onSuccess) => props.onChange({ onSuccess })}
            options={successTargetOptions}
          />
        </Field>
        <Field label={t('code.employeePlaybook.whenRetriesExhausted')}>
          <Select
            value={textOf(failure.onExhausted, 'block')}
            onChange={(onExhausted) => props.onChange({ onFailure: { ...failure, onExhausted } })}
            options={failureTargetOptions}
          />
        </Field>
      </div>
      <Switch
        checked={joinEnabled}
        label={t('code.employeePlaybook.waitForSeveralSteps')}
        onChange={(checked) =>
          props.onChange({
            join: checked
              ? {
                  groupId: `join-${textOf(props.step.stepId, String(props.index + 1))}`,
                  mode: 'all',
                  quorum: null,
                  memberStepIds: [textOf(props.step.stepId)],
                  deadlineMs: 86_400_000,
                  onDeadline: 'handoff',
                  onPartial: 'block',
                }
              : null,
          })
        }
      />
      {joinEnabled ? (
        <div className="employee-step-join">
          <Field label={t('code.employeePlaybook.stepsToWaitFor')} group>
            {props.steps.map((candidate) => {
              const candidateId = textOf(candidate.stepId)
              return (
                <Checkbox
                  key={candidateId}
                  checked={joinMembers.includes(candidateId)}
                  label={textOf(candidate.displayName, candidateId)}
                  onChange={(checked) =>
                    props.onChange({
                      join: {
                        ...join,
                        memberStepIds: checked
                          ? [...joinMembers, candidateId]
                          : joinMembers.filter((member) => member !== candidateId),
                      },
                    })
                  }
                />
              )
            })}
          </Field>
          <div className="form-grid form-grid--two">
            <Field label={t('code.employeePlaybook.waitCondition')}>
              <Select
                value={textOf(join.mode, 'all')}
                onChange={(mode) =>
                  props.onChange({
                    join: {
                      ...join,
                      mode,
                      quorum: mode === 'quorum' ? numberOf(join.quorum, 1) : null,
                    },
                  })
                }
                options={[
                  { value: 'all', label: t('code.employeePlaybook.waitAll') },
                  { value: 'any', label: t('code.employeePlaybook.waitAny') },
                  { value: 'quorum', label: t('code.employeePlaybook.waitQuorum') },
                ]}
              />
            </Field>
            {join.mode === 'quorum' ? (
              <Field label={t('code.employeePlaybook.quorumCount')}>
                <NumberInput
                  value={numberOf(join.quorum, 1)}
                  min={1}
                  max={Math.max(1, joinMembers.length)}
                  onChange={(quorum) => props.onChange({ join: { ...join, quorum: quorum ?? 1 } })}
                />
              </Field>
            ) : null}
            <Field label={t('code.employeePlaybook.deadlineHours')}>
              <NumberInput
                value={Math.round(numberOf(join.deadlineMs, 86_400_000) / 3_600_000)}
                min={1}
                max={720}
                onChange={(hours) =>
                  props.onChange({
                    join: { ...join, deadlineMs: (hours ?? 24) * 3_600_000 },
                  })
                }
              />
            </Field>
            <Field label={t('code.employeePlaybook.whenJoinDeadline')}>
              <Select
                value={textOf(join.onDeadline, 'handoff')}
                onChange={(onDeadline) => props.onChange({ join: { ...join, onDeadline } })}
                options={failureTargetOptions}
              />
            </Field>
            <Field label={t('code.employeePlaybook.whenJoinPartial')}>
              <Select
                value={textOf(join.onPartial, 'block')}
                onChange={(onPartial) => props.onChange({ join: { ...join, onPartial } })}
                options={failureTargetOptions}
              />
            </Field>
          </div>
        </div>
      ) : null}
      <div className="form-grid form-grid--two">
        <Field label={t('code.employeePlaybook.sameSceneRetries')}>
          <NumberInput
            value={numberOf(retry.sameScene, 1)}
            min={0}
            max={10}
            onChange={(sameScene) =>
              props.onChange({
                onFailure: { ...failure, retry: { ...retry, sameScene: sameScene ?? 0 } },
              })
            }
          />
        </Field>
        <Field label={t('code.employeePlaybook.freshSceneRetries')}>
          <NumberInput
            value={numberOf(retry.freshScene, 1)}
            min={0}
            max={5}
            onChange={(freshScene) =>
              props.onChange({
                onFailure: { ...failure, retry: { ...retry, freshScene: freshScene ?? 0 } },
              })
            }
          />
        </Field>
        <Field label={t('code.employeePlaybook.whenRejected')}>
          <Select
            value={textOf(failure.onRejected)}
            onChange={(onRejected) =>
              props.onChange({
                onFailure: { ...failure, onRejected: onRejected === '' ? null : onRejected },
              })
            }
            options={[
              { value: '', label: t('code.employeePlaybook.useExhaustedAction') },
              ...failureTargetOptions,
            ]}
          />
        </Field>
        <Field label={t('code.employeePlaybook.whenExpired')}>
          <Select
            value={textOf(failure.onExpired)}
            onChange={(onExpired) =>
              props.onChange({
                onFailure: { ...failure, onExpired: onExpired === '' ? null : onExpired },
              })
            }
            options={[
              { value: '', label: t('code.employeePlaybook.useExhaustedAction') },
              ...failureTargetOptions,
            ]}
          />
        </Field>
      </div>
    </Card>
  )
}

const CAPABILITY_LABEL_KEYS: Record<(typeof AGENT_CAPABILITY_IDS)[number], string> = {
  'requirement.analyze': 'capabilityRequirementAnalyze',
  'change.implement': 'capabilityChangeImplement',
  'change.review': 'capabilityChangeReview',
  'verification.repair': 'capabilityVerificationRepair',
  'mr.feedback.apply': 'capabilityFeedbackApply',
  'pipeline.repair': 'capabilityPipelineRepair',
  'conflict.repair': 'capabilityConflictRepair',
  'mr.review.external': 'capabilityExternalReview',
  'problem.classify': 'capabilityProblemClassify',
  'approval.prepare': 'capabilityApprovalPrepare',
}

function InlineExecutorCreateDialog(props: {
  request: InlineExecutorRequest
  policies: PublishedResourceOption[]
  implementations: PublishedResourceOption[]
  agents: AgentOption[]
  onClose: () => void
  onCreated: (resource: PublishedResourceOption) => void
}): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [capabilityId, setCapabilityId] = useState<(typeof AGENT_CAPABILITY_IDS)[number]>(
    props.request.kind === 'script' ? 'pipeline.repair' : 'change.implement',
  )
  const [agentId, setAgentId] = useState('')
  const [scriptLanguage, setScriptLanguage] = useState<'bash' | 'python' | 'node'>('bash')
  const [scriptRef, setScriptRef] = useState('')
  const [promptSupplement, setPromptSupplement] = useState('')
  const [preset, setPreset] = useState<EmployeePreset>('general')
  const [policyId, setPolicyId] = useState('')
  const [executableRef, setExecutableRef] = useState('')
  const publishedPolicies = published(props.policies)
  const effectivePolicyId = policyId || publishedPolicies[0]?.id || ''
  const selectedPolicy = publishedPolicies.find((policy) => policy.id === effectivePolicyId)
  const effectiveAgentId = agentId || props.agents[0]?.id || ''

  const create = useMutation({
    mutationFn: async (): Promise<PublishedResourceOption> => {
      if (props.request.kind === 'employee') {
        if (selectedPolicy === undefined) throw new Error(t('code.employeePlaybook.noRuleSet'))
        const created = await api.post<{ id: string; name: string }>(
          '/api/code/digital-employees',
          buildDevelopmentConfigCreateBody({
            kind: 'employees',
            name,
            employeeDraft: buildInitialEmployeePlaybook({
              description: '',
              preset,
              policy: selectedPolicy,
              implementations: published(props.implementations),
              stepName: (nameKey) => t(`code.employeePlaybook.standardStep.${nameKey}`),
            }),
          }),
        )
        const receipt = await api.post<{ revision: number }>(
          `/api/code/digital-employees/${encodeURIComponent(created.id)}/publish`,
          {},
        )
        return { ...created, publishedRevision: receipt.revision }
      }
      if (props.request.kind === 'approval-system') {
        const created = await api.post<{ id: string; name: string }>(
          '/api/integrations/development-adapters',
          buildDevelopmentConfigCreateBody({
            kind: 'adapters',
            name,
            purpose: 'approval-gateway',
            executableRef,
          }),
        )
        const receipt = await api.post<{ revision: number }>(
          `/api/integrations/development-adapters/${encodeURIComponent(created.id)}/publish`,
          {},
        )
        return {
          ...created,
          publishedRevision: receipt.revision,
          purpose: 'approval-gateway',
        }
      }
      const executor =
        props.request.kind === 'script'
          ? { kind: 'script' as const, language: scriptLanguage, scriptRef }
          : { kind: 'agent' as const, agentRef: effectiveAgentId }
      const created = await api.post<{ id: string; name: string }>(
        '/api/code/action-templates',
        buildDevelopmentConfigCreateBody({
          kind: 'action-templates',
          name,
          capabilityId,
          actionTemplateDraft: {
            schemaVersion: 1,
            capabilityId,
            capabilityContractVersion: 1,
            labels: [],
            compatibility: [],
            executor,
            runtimeProfileRef: 'default',
            promptSupplement,
            skillRefs: [],
            mcpRefs: [],
            readOnlyResourceRefs: [],
            contextProfileRef: null,
            writablePathPolicyRef: null,
            additionalProtectedPathClasses: [],
            verificationProfileRef: 'default',
            retryDefaults: { sameSession: 1, freshSession: 1 },
          },
        }),
      )
      const receipt = await api.post<{ revision: number }>(
        `/api/code/action-templates/${encodeURIComponent(created.id)}/publish`,
        {},
      )
      return {
        ...created,
        publishedRevision: receipt.revision,
        capabilityId,
        executorKind: props.request.kind,
      }
    },
    onSuccess: (resource) => {
      if (props.request.kind === 'employee') {
        void qc.invalidateQueries({ queryKey: ['code-config', 'employees'] })
      } else if (props.request.kind === 'approval-system') {
        void qc.invalidateQueries({ queryKey: ['code-config', 'adapters'] })
      } else {
        void qc.invalidateQueries({ queryKey: ['code-config', 'action-templates'] })
      }
      props.onCreated(resource)
    },
  })

  const valid =
    name.trim() !== '' &&
    (props.request.kind !== 'agent' || effectiveAgentId !== '') &&
    (props.request.kind !== 'script' || scriptRef.trim() !== '') &&
    (props.request.kind !== 'employee' || selectedPolicy !== undefined) &&
    (props.request.kind !== 'approval-system' || executableRef.trim() !== '')

  return (
    <Dialog
      open
      title={t('code.employeePlaybook.createExecutor')}
      closeOnOverlayClick={false}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!valid || create.isPending}
            onClick={() => create.mutate()}
            data-testid="inline-executor-create-submit"
          >
            {create.isPending
              ? t('code.config.publishing')
              : t('code.employeePlaybook.createPublishAndSelect')}
          </button>
        </>
      }
    >
      {create.isError ? <ErrorBanner error={create.error} /> : null}
      <p>{t('code.employeePlaybook.inlineExecutorHint')}</p>
      <Field label={t('code.employeePlaybook.executorName')} required>
        <TextInput value={name} onChange={setName} data-testid="inline-executor-create-name" />
      </Field>
      {props.request.kind === 'employee' ? (
        <>
          <Field label={t('code.employeePlaybook.preset')}>
            <Select
              value={preset}
              onChange={(value) => setPreset(value as EmployeePreset)}
              options={[
                { value: 'general', label: t('code.employeePlaybook.presetGeneral') },
                { value: 'java', label: t('code.employeePlaybook.presetJava') },
                { value: 'cpp', label: t('code.employeePlaybook.presetCpp') },
              ]}
            />
          </Field>
          <Field label={t('code.employeePlaybook.ruleSet')} required>
            <Select
              value={effectivePolicyId}
              onChange={setPolicyId}
              options={publishedPolicies.map((policy) => ({
                value: policy.id,
                label: policy.name,
              }))}
            />
          </Field>
        </>
      ) : null}
      {props.request.kind === 'agent' || props.request.kind === 'script' ? (
        <>
          <Field label={t('code.employeePlaybook.executorAbility')} required>
            <Select
              value={capabilityId}
              onChange={(value) => setCapabilityId(value as (typeof AGENT_CAPABILITY_IDS)[number])}
              options={AGENT_CAPABILITY_IDS.map((id) => ({
                value: id,
                label: t(`code.employeePlaybook.${CAPABILITY_LABEL_KEYS[id]}`),
              }))}
            />
          </Field>
          {props.request.kind === 'agent' ? (
            <Field label={t('code.employeePlaybook.selectAgent')} required>
              <Select
                value={effectiveAgentId}
                onChange={setAgentId}
                options={props.agents.map((agent) => ({ value: agent.id, label: agent.name }))}
              />
            </Field>
          ) : (
            <div className="form-grid form-grid--two">
              <Field label={t('code.employeePlaybook.programLanguage')} required>
                <Select
                  value={scriptLanguage}
                  onChange={(value) => setScriptLanguage(value as 'bash' | 'python' | 'node')}
                  options={[
                    { value: 'bash', label: 'Bash' },
                    { value: 'python', label: 'Python' },
                    { value: 'node', label: 'Node.js' },
                  ]}
                />
              </Field>
              <Field label={t('code.employeePlaybook.programPath')} required>
                <TextInput value={scriptRef} onChange={setScriptRef} />
              </Field>
            </div>
          )}
          <Field label={t('code.employeePlaybook.executorInstructions')}>
            <TextArea value={promptSupplement} onChange={setPromptSupplement} rows={4} />
          </Field>
        </>
      ) : null}
      {props.request.kind === 'approval-system' ? (
        <Field
          label={t('code.employeePlaybook.approvalProgramPath')}
          hint={t('code.employeePlaybook.approvalProgramHint')}
          required
        >
          <TextInput value={executableRef} onChange={setExecutableRef} />
        </Field>
      ) : null}
    </Dialog>
  )
}

function ExecutorLibraryLinks(props: { onCreate?: () => void }): ReactElement {
  const { t } = useTranslation()
  return (
    <span className="employee-step-executor-picker__actions">
      {props.onCreate === undefined ? null : (
        <button
          type="button"
          className="link link--button"
          onClick={props.onCreate}
          data-testid="employee-step-create-executor"
        >
          {t('code.employeePlaybook.createExecutor')}
        </button>
      )}
      <Link to="/code/executors" className="link">
        {t('code.employeePlaybook.openExecutorLibrary')}
      </Link>
    </span>
  )
}

function ProblemEditor(props: {
  types: Record<string, unknown>[]
  producers: Record<string, unknown>[]
  handlers: Record<string, unknown>[]
  templates: PublishedResourceOption[]
  steps: Record<string, unknown>[]
  onTypes: (next: Record<string, unknown>[]) => void
  onProducers: (next: Record<string, unknown>[]) => void
  onHandlers: (next: Record<string, unknown>[]) => void
  onCreateImplementation: (
    kind: 'agent' | 'script',
    onCreated: (resource: PublishedResourceOption) => void,
  ) => void
}): ReactElement {
  const { t } = useTranslation()
  const typeOptions = props.types.map((type) => ({
    value: textOf(type.typeId),
    label: textOf(type.displayName, textOf(type.typeId)),
  }))
  return (
    <FormSection title={t('code.employeePlaybook.problems')}>
      <p className="form-section__hint">{t('code.employeePlaybook.problemsHint')}</p>
      <h3>{t('code.employeePlaybook.problemTypes')}</h3>
      <div className="config-editor__items">
        {props.types.map((type, index) => (
          <Card
            key={`${textOf(type.typeId)}-${index}`}
            title={textOf(
              type.displayName,
              t('code.employeePlaybook.problemTypeNumber', { number: index + 1 }),
            )}
            actions={
              <button
                type="button"
                className="btn btn--xs btn--danger"
                onClick={() => props.onTypes(removeAt(props.types, index))}
              >
                {t('common.remove')}
              </button>
            }
          >
            <div className="form-grid form-grid--two">
              <Field label={t('code.employeePlaybook.problemName')} required>
                <TextInput
                  value={textOf(type.displayName)}
                  onChange={(displayName) =>
                    props.onTypes(patchAt(props.types, index, { displayName }))
                  }
                />
              </Field>
              <Field label={t('code.employeePlaybook.evidenceSource')}>
                <Select
                  value={textOf(type.evidenceDomain, 'pipeline')}
                  onChange={(evidenceDomain) =>
                    props.onTypes(patchAt(props.types, index, { evidenceDomain }))
                  }
                  options={[
                    { value: 'pipeline', label: t('code.employeePlaybook.evidencePipeline') },
                    {
                      value: 'verification',
                      label: t('code.employeePlaybook.evidenceVerification'),
                    },
                    { value: 'feedback', label: t('code.employeePlaybook.evidenceFeedback') },
                    { value: 'conflict', label: t('code.employeePlaybook.evidenceConflict') },
                    { value: 'mr', label: t('code.employeePlaybook.evidenceMr') },
                  ]}
                />
              </Field>
              <Field label={t('code.employeePlaybook.priority')}>
                <NumberInput
                  value={numberOf(type.priority, 100)}
                  min={0}
                  max={10_000}
                  onChange={(priority) =>
                    props.onTypes(patchAt(props.types, index, { priority: priority ?? 100 }))
                  }
                />
              </Field>
            </div>
            <Switch
              checked={type.repairable !== false}
              label={t('code.employeePlaybook.repairable')}
              onChange={(repairable) => props.onTypes(patchAt(props.types, index, { repairable }))}
            />
            <Switch
              checked={type.unknownFallback === true}
              label={t('code.employeePlaybook.unknownFallback')}
              onChange={(unknownFallback) =>
                props.onTypes(patchAt(props.types, index, { unknownFallback }))
              }
            />
          </Card>
        ))}
      </div>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          const ordinal = props.types.length + 1
          props.onTypes([
            ...props.types,
            {
              typeId: `problem-${ordinal}`,
              displayName: t('code.employeePlaybook.newProblemType', { number: ordinal }),
              evidenceDomain: 'pipeline',
              repairable: true,
              priority: ordinal * 100,
              unknownFallback: false,
            },
          ])
        }}
      >
        {t('code.employeePlaybook.addProblemType')}
      </button>

      <h3>{t('code.employeePlaybook.problemProducers')}</h3>
      <div className="config-editor__items">
        {props.producers.map((producer, index) => {
          const implementationRef = exactRef(producer.implementationRef)
          const kind = producer.kind === 'script' ? 'script' : 'agent'
          const allowed = Array.isArray(producer.allowedTypeIds)
            ? producer.allowedTypeIds.filter((value): value is string => typeof value === 'string')
            : []
          return (
            <Card
              key={`${textOf(producer.producerId)}-${index}`}
              title={textOf(
                producer.displayName,
                t('code.employeePlaybook.problemProducerNumber', { number: index + 1 }),
              )}
              actions={
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  onClick={() => props.onProducers(removeAt(props.producers, index))}
                >
                  {t('common.remove')}
                </button>
              }
            >
              <div className="form-grid form-grid--two">
                <Field label={t('code.employeePlaybook.producerName')} required>
                  <TextInput
                    value={textOf(producer.displayName)}
                    onChange={(displayName) =>
                      props.onProducers(patchAt(props.producers, index, { displayName }))
                    }
                  />
                </Field>
                <Field label={t('code.employeePlaybook.executorType')}>
                  <Select
                    value={kind}
                    onChange={(nextKind) =>
                      props.onProducers(
                        patchAt(props.producers, index, {
                          kind: nextKind,
                          implementationRef: { id: '', revision: 1 },
                        }),
                      )
                    }
                    options={[
                      { value: 'agent', label: t('code.employeePlaybook.executorAgent') },
                      { value: 'script', label: t('code.employeePlaybook.executorScript') },
                    ]}
                  />
                </Field>
                <Field label={t('code.employeePlaybook.executor')} required>
                  <div className="employee-step-executor-picker">
                    <Select
                      value={implementationRef?.id ?? ''}
                      onChange={(id) => {
                        const next = resourceRef(
                          props.templates.filter((template) =>
                            kind === 'script'
                              ? template.executorKind === 'script'
                              : template.executorKind !== 'script',
                          ),
                          id,
                        )
                        if (next !== null) {
                          props.onProducers(
                            patchAt(props.producers, index, { implementationRef: next }),
                          )
                        }
                      }}
                      options={optionsOf(
                        props.templates.filter((template) =>
                          kind === 'script'
                            ? template.executorKind === 'script'
                            : template.executorKind !== 'script',
                        ),
                        t('code.employeePlaybook.chooseExecutor'),
                      )}
                    />
                    <ExecutorLibraryLinks
                      onCreate={() =>
                        props.onCreateImplementation(kind, (resource) => {
                          const next = publishedRef(resource)
                          if (next !== null) {
                            props.onProducers(
                              patchAt(props.producers, index, { implementationRef: next }),
                            )
                          }
                        })
                      }
                    />
                  </div>
                </Field>
              </div>
              <Field label={t('code.employeePlaybook.producerCanReport')} group>
                {props.types.map((type) => {
                  const typeId = textOf(type.typeId)
                  return (
                    <Checkbox
                      key={typeId}
                      checked={allowed.includes(typeId)}
                      label={textOf(type.displayName, typeId)}
                      onChange={(checked) =>
                        props.onProducers(
                          patchAt(props.producers, index, {
                            allowedTypeIds: checked
                              ? [...allowed, typeId]
                              : allowed.filter((value) => value !== typeId),
                            evidenceDomains: [textOf(type.evidenceDomain, 'pipeline')],
                          }),
                        )
                      }
                    />
                  )
                })}
              </Field>
            </Card>
          )
        })}
      </div>
      <button
        type="button"
        className="btn btn--sm"
        disabled={props.types.length === 0}
        onClick={() => {
          const ordinal = props.producers.length + 1
          const firstType = props.types[0]!
          props.onProducers([
            ...props.producers,
            {
              producerId: `producer-${ordinal}`,
              displayName: t('code.employeePlaybook.newProducer', { number: ordinal }),
              kind: 'agent',
              implementationRef: { id: '', revision: 1 },
              evidenceDomains: [textOf(firstType.evidenceDomain, 'pipeline')],
              allowedTypeIds: [textOf(firstType.typeId)],
              when: [],
              retry: { sameScene: 1, freshScene: 1 },
              fallbackProducerId: null,
            },
          ])
        }}
      >
        {t('code.employeePlaybook.addProducer')}
      </button>

      <h3>{t('code.employeePlaybook.problemHandlers')}</h3>
      <div className="config-editor__items">
        {props.handlers.map((handler, index) => {
          const executor = asRecord(handler.handler)
          const kind = executor.kind === 'script' ? 'script' : 'agent'
          return (
            <Card
              key={`${textOf(handler.ruleId)}-${index}`}
              title={
                typeOptions.find((option) => option.value === handler.typeId)?.label ??
                t('code.employeePlaybook.problemHandlerNumber', { number: index + 1 })
              }
              actions={
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  onClick={() => props.onHandlers(removeAt(props.handlers, index))}
                >
                  {t('common.remove')}
                </button>
              }
            >
              <div className="form-grid form-grid--two">
                <Field label={t('code.employeePlaybook.problemType')} required>
                  <Select
                    value={textOf(handler.typeId)}
                    onChange={(typeId) =>
                      props.onHandlers(patchAt(props.handlers, index, { typeId }))
                    }
                    options={typeOptions}
                  />
                </Field>
                <Field label={t('code.employeePlaybook.executorType')}>
                  <Select
                    value={kind}
                    onChange={(nextKind) =>
                      props.onHandlers(
                        patchAt(props.handlers, index, {
                          handler: {
                            kind: nextKind,
                            implementationRef: { id: '', revision: 1 },
                          },
                        }),
                      )
                    }
                    options={[
                      { value: 'agent', label: t('code.employeePlaybook.executorAgent') },
                      { value: 'script', label: t('code.employeePlaybook.executorScript') },
                    ]}
                  />
                </Field>
                <Field label={t('code.employeePlaybook.executor')} required>
                  <div className="employee-step-executor-picker">
                    <Select
                      value={idOf(executor.implementationRef)}
                      onChange={(id) => {
                        const next = resourceRef(
                          props.templates.filter((template) =>
                            kind === 'script'
                              ? template.executorKind === 'script'
                              : template.executorKind !== 'script',
                          ),
                          id,
                        )
                        if (next !== null) {
                          props.onHandlers(
                            patchAt(props.handlers, index, {
                              handler: { kind, implementationRef: next },
                            }),
                          )
                        }
                      }}
                      options={optionsOf(
                        props.templates.filter((template) =>
                          kind === 'script'
                            ? template.executorKind === 'script'
                            : template.executorKind !== 'script',
                        ),
                        t('code.employeePlaybook.chooseExecutor'),
                      )}
                    />
                    <ExecutorLibraryLinks
                      onCreate={() =>
                        props.onCreateImplementation(kind, (resource) => {
                          const implementationRef = publishedRef(resource)
                          if (implementationRef !== null) {
                            props.onHandlers(
                              patchAt(props.handlers, index, {
                                handler: { kind, implementationRef },
                              }),
                            )
                          }
                        })
                      }
                    />
                  </div>
                </Field>
              </div>
              <Field label={t('code.employeePlaybook.verifyAfterRepair')} group>
                {props.steps.map((step) => {
                  const stepId = textOf(step.stepId)
                  const selected = Array.isArray(handler.verifyStepIds)
                    ? handler.verifyStepIds.includes(stepId)
                    : false
                  return (
                    <Checkbox
                      key={stepId}
                      checked={selected}
                      label={textOf(step.displayName, stepId)}
                      onChange={(checked) => {
                        const current = Array.isArray(handler.verifyStepIds)
                          ? handler.verifyStepIds.filter(
                              (value): value is string => typeof value === 'string',
                            )
                          : []
                        props.onHandlers(
                          patchAt(props.handlers, index, {
                            verifyStepIds: checked
                              ? [...current, stepId]
                              : current.filter((value) => value !== stepId),
                          }),
                        )
                      }}
                    />
                  )
                })}
              </Field>
            </Card>
          )
        })}
      </div>
      <button
        type="button"
        className="btn btn--sm"
        disabled={props.types.length === 0}
        onClick={() => {
          const ordinal = props.handlers.length + 1
          props.onHandlers([
            ...props.handlers,
            {
              ruleId: `handler-${ordinal}`,
              typeId: textOf(props.types[0]?.typeId),
              when: [],
              handler: { kind: 'agent', implementationRef: { id: '', revision: 1 } },
              verifyStepIds: [],
              retry: { sameScene: 1, freshScene: 1 },
              fallbackRuleId: null,
            },
          ])
        }}
      >
        {t('code.employeePlaybook.addHandler')}
      </button>
    </FormSection>
  )
}
