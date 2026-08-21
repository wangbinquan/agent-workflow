import { type Agent } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ChoiceCards } from '@/components/ChoiceCards'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import {
  localized,
  type DigitalEmployeeDefinition,
  type EmployeeTypePackage,
  type LocalizedText,
  typeRefKey,
} from '@/components/digital-employees/types'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RuntimeParameterPicker } from '@/components/RuntimeParameterPicker'
import {
  buildRuntimeParameterCatalog,
  type RuntimeTriggerParameterContract,
} from '@/components/runtime-parameters/catalog'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import type { RuntimeTemplateAuthorityKey } from '@agent-workflow/shared'

type ExactRef = { id: string; revision: number }

export interface ResponseRuleEventCatalog {
  readonly sources: Array<{
    readonly sourceRef: ExactRef
    readonly displayName: LocalizedText
  }>
  readonly eventTypes: Array<{
    readonly eventTypeRef: ExactRef
    readonly sourceRef: ExactRef
    readonly subjectTypeId: string
    readonly displayName: LocalizedText
    readonly description: LocalizedText
    readonly triggerParameters: {
      readonly namespace: string
      readonly fields: Array<{
        readonly fieldId: string
        readonly displayName: LocalizedText
        readonly description: LocalizedText
      }>
    } | null
  }>
}

type TargetKind = 'workflow' | 'agent' | 'workgroup' | 'digital-employee'
type SubjectMatch = 'all' | 'exact' | 'prefix'

type EventResponseTarget =
  | {
      kind: 'workflow'
      refId: string
      nameTemplate: string
      inputs: Record<string, string>
    }
  | {
      kind: 'agent'
      refId: string
      nameTemplate: string
      descriptionTemplate: string | null
      inputs: Record<string, string>
    }
  | {
      kind: 'workgroup'
      refId: string
      nameTemplate: string
      goalTemplate: string
    }
  | {
      kind: 'digital-employee'
      refId: string
      intakeKind: 'body' | 'external-id'
      target: Record<string, string>
      valueTemplate: string
    }

interface EventResponseRule {
  id: string
  ownerUserId: string
  name: string
  enabled: boolean
  eventTypeRef: ExactRef
  sourceRef: ExactRef
  subjectTypeId: string
  subjectMatch: SubjectMatch
  subjectPattern: string | null
  target: EventResponseTarget
  lastFiredAt: number | null
  lastStatus: 'launched' | 'failed' | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

interface RuleDraft {
  id: string | null
  name: string
  enabled: boolean
  eventKey: string
  subjectMatch: SubjectMatch
  subjectPattern: string
  targetKind: TargetKind
  targetRefId: string
  nameTemplate: string
  inputs: Record<string, string>
  descriptionTemplate: string
  goalTemplate: string
  intakeKind: 'body' | 'external-id'
  employeeTarget: Record<string, string>
  valueTemplate: string
}

type WorkflowRow = { id: string; name: string }
type WorkflowDetail = {
  definition?: {
    inputs?: Array<{ key: string; kind: string; required?: boolean; description?: string }>
  } | null
}
type AgentRow = Pick<Agent, 'id' | 'name'>
type WorkgroupRow = { id: string; name: string }
type DigitalEmployeeList = { items: DigitalEmployeeDefinition[] }

function refKey(ref: ExactRef): string {
  return `${ref.id}@${ref.revision}`
}

function emptyDraft(eventKey: string): RuleDraft {
  return {
    id: null,
    name: '',
    enabled: true,
    eventKey,
    subjectMatch: 'all',
    subjectPattern: '',
    targetKind: 'workflow',
    targetRefId: '',
    nameTemplate: '事件响应任务',
    inputs: {},
    descriptionTemplate: '',
    goalTemplate: '',
    intakeKind: 'body',
    employeeTarget: {},
    valueTemplate: '',
  }
}

function draftOf(rule: EventResponseRule): RuleDraft {
  const base = {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    eventKey: refKey(rule.eventTypeRef),
    subjectMatch: rule.subjectMatch,
    subjectPattern: rule.subjectPattern ?? '',
    targetKind: rule.target.kind,
    targetRefId: rule.target.refId,
    nameTemplate: '事件响应任务',
    inputs: {},
    descriptionTemplate: '',
    goalTemplate: '',
    intakeKind: 'body' as const,
    employeeTarget: {},
    valueTemplate: '',
  }
  if (rule.target.kind === 'workflow') {
    return {
      ...base,
      nameTemplate: rule.target.nameTemplate,
      inputs: { ...rule.target.inputs },
    }
  }
  if (rule.target.kind === 'agent') {
    return {
      ...base,
      nameTemplate: rule.target.nameTemplate,
      inputs: { ...rule.target.inputs },
      descriptionTemplate: rule.target.descriptionTemplate ?? '',
    }
  }
  if (rule.target.kind === 'workgroup') {
    return {
      ...base,
      nameTemplate: rule.target.nameTemplate,
      goalTemplate: rule.target.goalTemplate,
    }
  }
  return {
    ...base,
    intakeKind: rule.target.intakeKind,
    employeeTarget: { ...rule.target.target },
    valueTemplate: rule.target.valueTemplate,
  }
}

function bodyOf(draft: RuleDraft, eventTypeRef: ExactRef) {
  const target: EventResponseTarget =
    draft.targetKind === 'workflow'
      ? {
          kind: 'workflow',
          refId: draft.targetRefId,
          nameTemplate: draft.nameTemplate,
          inputs: draft.inputs,
        }
      : draft.targetKind === 'agent'
        ? {
            kind: 'agent',
            refId: draft.targetRefId,
            nameTemplate: draft.nameTemplate,
            descriptionTemplate:
              draft.descriptionTemplate.trim() === '' ? null : draft.descriptionTemplate,
            inputs: draft.inputs,
          }
        : draft.targetKind === 'workgroup'
          ? {
              kind: 'workgroup',
              refId: draft.targetRefId,
              nameTemplate: draft.nameTemplate,
              goalTemplate: draft.goalTemplate,
            }
          : {
              kind: 'digital-employee',
              refId: draft.targetRefId,
              intakeKind: draft.intakeKind,
              target: draft.employeeTarget,
              valueTemplate: draft.valueTemplate,
            }
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    eventTypeRef,
    subjectMatch: draft.subjectMatch,
    subjectPattern: draft.subjectMatch === 'all' ? null : draft.subjectPattern.trim(),
    target,
  }
}

function TemplateControl(props: {
  readonly label: string
  readonly hint?: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly authority: RuntimeTemplateAuthorityKey
  readonly entries: ReturnType<typeof buildRuntimeParameterCatalog>
  readonly multiline?: boolean
  readonly required?: boolean
  readonly testId: string
}): ReactElement {
  const control =
    props.multiline === true ? (
      <TextArea
        rows={3}
        value={props.value}
        onChange={props.onChange}
        aria-label={props.label}
        data-testid={props.testId}
      />
    ) : (
      <TextInput
        value={props.value}
        onChange={props.onChange}
        aria-label={props.label}
        data-testid={props.testId}
      />
    )
  return (
    <Field
      label={props.label}
      hint={props.hint}
      required={props.required}
      group
      action={
        <RuntimeParameterPicker
          authority={props.authority}
          entries={props.entries}
          target={{
            id: props.testId,
            label: props.label,
            mode: 'insert-at-caret',
            value: props.value,
            revision: props.value,
            commit: props.onChange,
          }}
          testId={`${props.testId}-parameter`}
        />
      }
    >
      {control}
    </Field>
  )
}

export function EventResponseRulesPanel(props: {
  readonly catalog: ResponseRuleEventCatalog
  readonly language: string
  readonly canManage: boolean
}): ReactElement {
  const { t } = useTranslation()
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const eligibleEvents = useMemo(() => {
    const sourceOrder = new Map(
      props.catalog.sources.map((source, index) => [refKey(source.sourceRef), index] as const),
    )
    return props.catalog.eventTypes
      .filter((event) => event.triggerParameters !== null)
      .slice()
      .sort((left, right) => {
        const bySource =
          (sourceOrder.get(refKey(left.sourceRef)) ?? Number.MAX_SAFE_INTEGER) -
          (sourceOrder.get(refKey(right.sourceRef)) ?? Number.MAX_SAFE_INTEGER)
        if (bySource !== 0) return bySource
        return localized(left.displayName, props.language).localeCompare(
          localized(right.displayName, props.language),
          props.language,
        )
      })
  }, [props.catalog.eventTypes, props.catalog.sources, props.language])
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [error, setError] = useState<unknown>(null)

  const rules = useQuery<{ items: EventResponseRule[] }>({
    queryKey: ['event-center', 'response-rules'],
    queryFn: ({ signal }) => api.get('/api/event-center/response-rules', undefined, signal),
    refetchInterval: 10_000,
  })
  const workflows = useQuery<WorkflowRow[]>({
    queryKey: ['workflows', 'list'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
    retry: false,
  })
  const agents = useQuery<AgentRow[]>({
    queryKey: ['agents', 'list'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
    retry: false,
  })
  const workgroups = useQuery<WorkgroupRow[]>({
    queryKey: ['workgroups', 'list'],
    queryFn: ({ signal }) => api.get('/api/workgroups', undefined, signal),
    retry: false,
  })
  const employees = useQuery<DigitalEmployeeList>({
    queryKey: ['digital-employees', 'event-response-target-list'],
    queryFn: ({ signal }) => api.get('/api/digital-employees', undefined, signal),
    retry: false,
  })

  const selectedEvent =
    draft === null
      ? null
      : (eligibleEvents.find((event) => refKey(event.eventTypeRef) === draft.eventKey) ?? null)
  const workflowDetail = useQuery<WorkflowDetail>({
    queryKey: ['workflows', 'detail', draft?.targetRefId, 'event-response'],
    queryFn: ({ signal }) =>
      api.get(`/api/workflows/${encodeURIComponent(draft?.targetRefId ?? '')}`, undefined, signal),
    enabled: draft?.targetKind === 'workflow' && draft.targetRefId !== '',
    retry: false,
  })
  const agentDetail = useQuery<Agent>({
    queryKey: ['agents', 'detail', draft?.targetRefId, 'event-response'],
    queryFn: ({ signal }) =>
      api.get(`/api/agents/${encodeURIComponent(draft?.targetRefId ?? '')}`, undefined, signal),
    enabled: draft?.targetKind === 'agent' && draft.targetRefId !== '',
    retry: false,
  })
  const availableEmployees = useMemo(
    () =>
      (employees.data?.items ?? []).filter(
        (employee) => employee.publishedRevision !== null && employee.published?.enabled === true,
      ),
    [employees.data],
  )
  const selectedEmployee =
    draft?.targetKind === 'digital-employee'
      ? (availableEmployees.find((employee) => employee.id === draft.targetRefId) ?? null)
      : null
  const selectedEmployeeTypeRef =
    selectedEmployee === null ? null : typeRefKey(selectedEmployee.typeRef)
  const employeeType = useQuery<EmployeeTypePackage>({
    queryKey: ['digital-employee-type', selectedEmployeeTypeRef, 'event-response'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(selectedEmployeeTypeRef ?? '')}`,
        undefined,
        signal,
      ),
    enabled: selectedEmployeeTypeRef !== null,
    retry: false,
  })

  const selectedContract = selectedEvent?.triggerParameters ?? null
  const parameterCatalog = useMemo(() => {
    const contracts: RuntimeTriggerParameterContract[] =
      selectedEvent === null || selectedContract === null
        ? []
        : [
            {
              namespace: selectedContract.namespace,
              definitionRef: selectedEvent.eventTypeRef,
              sourceLabel: localized(selectedEvent.displayName, props.language),
              groupLabel: zh ? '事件输入' : 'Event inputs',
              sourceDescription: localized(selectedEvent.description, props.language),
              fields: selectedContract.fields.map((field) => ({
                fieldId: field.fieldId,
                label: localized(field.displayName, props.language),
                description: localized(field.description, props.language),
              })),
            },
          ]
    return buildRuntimeParameterCatalog({
      audience: 'webhook-launch',
      surface: 'webhook-launch',
      triggerContracts: contracts,
      t,
    })
  }, [props.language, selectedContract, selectedEvent, t, zh])

  const workflowInputs = useMemo(
    () => workflowDetail.data?.definition?.inputs ?? [],
    [workflowDetail.data],
  )
  const agentInputs = useMemo(() => agentDetail.data?.inputs ?? [], [agentDetail.data])
  const employeeIntake = employeeType.data?.workIntakeAuthoring

  useEffect(() => {
    if (draft === null) return
    const declared =
      draft.targetKind === 'workflow'
        ? workflowInputs.map((input) => input.key)
        : draft.targetKind === 'agent'
          ? agentInputs.map((input) => input.name)
          : null
    if (declared === null) return
    const next = Object.fromEntries(declared.map((key) => [key, draft.inputs[key] ?? '']))
    if (JSON.stringify(next) !== JSON.stringify(draft.inputs)) {
      setDraft((current) => (current === null ? null : { ...current, inputs: next }))
    }
  }, [agentInputs, draft, workflowInputs])

  useEffect(() => {
    if (draft?.targetKind !== 'digital-employee' || employeeIntake === undefined) return
    const supported = employeeIntake.acceptedKinds.filter(
      (kind): kind is 'body' | 'external-id' => kind === 'body' || kind === 'external-id',
    )
    const intakeKind = supported.includes(draft.intakeKind)
      ? draft.intakeKind
      : (supported[0] ?? 'body')
    const target = Object.fromEntries(
      employeeIntake.targetFields.map((field) => [
        field.fieldRef,
        draft.employeeTarget[field.fieldRef] ?? '',
      ]),
    )
    if (
      intakeKind !== draft.intakeKind ||
      JSON.stringify(target) !== JSON.stringify(draft.employeeTarget)
    ) {
      setDraft((current) =>
        current === null ? null : { ...current, intakeKind, employeeTarget: target },
      )
    }
  }, [draft, employeeIntake])

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['event-center', 'response-rules'] }),
      qc.invalidateQueries({ queryKey: ['event-center', 'subscriptions'] }),
      qc.invalidateQueries({ queryKey: ['event-center', 'catalog'] }),
    ])
  }
  const save = useMutation({
    mutationFn: (value: RuleDraft) => {
      const event = eligibleEvents.find(
        (candidate) => refKey(candidate.eventTypeRef) === value.eventKey,
      )
      if (event === undefined) throw new Error('selected event contract is unavailable')
      const body = bodyOf(value, event.eventTypeRef)
      return value.id === null
        ? api.post<EventResponseRule>('/api/event-center/response-rules', body)
        : api.put<EventResponseRule>(
            `/api/event-center/response-rules/${encodeURIComponent(value.id)}`,
            body,
          )
    },
    onSuccess: async () => {
      setDraft(null)
      setError(null)
      await invalidate()
    },
    onError: setError,
  })
  const toggle = useMutation({
    mutationFn: (rule: EventResponseRule) =>
      api.put<EventResponseRule>(
        `/api/event-center/response-rules/${encodeURIComponent(rule.id)}`,
        { ...bodyOf(draftOf(rule), rule.eventTypeRef), enabled: !rule.enabled },
      ),
    onSuccess: invalidate,
    onError: setError,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/event-center/response-rules/${encodeURIComponent(id)}`),
    onSuccess: invalidate,
    onError: setError,
  })

  if (rules.isPending) return <LoadingState data-testid="event-response-rules-loading" />
  if (rules.isError) return <ErrorBanner error={rules.error} />

  const resourceOptions =
    draft?.targetKind === 'workflow'
      ? (workflows.data ?? []).map((row) => ({ value: row.id, label: row.name }))
      : draft?.targetKind === 'agent'
        ? (agents.data ?? []).map((row) => ({ value: row.id, label: row.name }))
        : draft?.targetKind === 'workgroup'
          ? (workgroups.data ?? []).map((row) => ({ value: row.id, label: row.name }))
          : availableEmployees.map((employee) => ({
              value: employee.id,
              label: employee.published?.displayName ?? employee.name,
            }))
  const resourceName = (target: EventResponseTarget): string => {
    if (target.kind === 'workflow') {
      return workflows.data?.find((row) => row.id === target.refId)?.name ?? target.refId
    }
    if (target.kind === 'agent') {
      return agents.data?.find((row) => row.id === target.refId)?.name ?? target.refId
    }
    if (target.kind === 'workgroup') {
      return workgroups.data?.find((row) => row.id === target.refId)?.name ?? target.refId
    }
    const employee = availableEmployees.find((row) => row.id === target.refId)
    return employee?.published?.displayName ?? employee?.name ?? target.refId
  }
  const eventName = (ref: ExactRef): string => {
    const event = props.catalog.eventTypes.find(
      (candidate) => refKey(candidate.eventTypeRef) === refKey(ref),
    )
    return event === undefined ? ref.id : localized(event.displayName, props.language)
  }
  const valid = (() => {
    if (draft === null || selectedEvent === null) return false
    if (draft.name.trim() === '' || draft.targetRefId === '') return false
    if (!resourceOptions.some((option) => option.value === draft.targetRefId)) return false
    if (draft.subjectMatch !== 'all' && draft.subjectPattern.trim() === '') return false
    if (draft.targetKind === 'workflow') {
      return (
        workflowDetail.isSuccess &&
        draft.nameTemplate.trim() !== '' &&
        workflowInputs
          .filter((input) => input.required === true)
          .every((input) => (draft.inputs[input.key] ?? '').trim() !== '')
      )
    }
    if (draft.targetKind === 'agent') {
      return (
        agentDetail.isSuccess &&
        draft.nameTemplate.trim() !== '' &&
        agentInputs
          .filter((input) => input.required === true)
          .every((input) => (draft.inputs[input.name] ?? '').trim() !== '')
      )
    }
    if (draft.targetKind === 'workgroup') {
      return draft.nameTemplate.trim() !== '' && draft.goalTemplate.trim() !== ''
    }
    return (
      employeeType.isSuccess &&
      draft.valueTemplate.trim() !== '' &&
      (employeeIntake?.targetFields ?? [])
        .filter((field) => field.required)
        .every((field) => (draft.employeeTarget[field.fieldRef] ?? '').trim() !== '')
    )
  })()

  const newAction = props.canManage ? (
    <button
      type="button"
      className="btn btn--primary"
      disabled={eligibleEvents.length === 0}
      onClick={() => setDraft(emptyDraft(refKey(eligibleEvents[0]!.eventTypeRef)))}
      data-testid="event-response-rule-new"
    >
      {zh ? '新增响应规则' : 'New response rule'}
    </button>
  ) : undefined

  return (
    <div className="event-response-rules" data-testid="event-response-rules">
      <div className="webhook-panel__intro">
        <div>
          <span className="webhook-panel__eyebrow">
            {zh ? '标准事件响应' : 'Standard event response'}
          </span>
          <h3>{zh ? '事件发生后启动哪项工作' : 'Start work when an event occurs'}</h3>
          <p>
            {zh
              ? '事件来自统一目录；只显示已经声明任务输入契约的事件。Webhook、轮询和平台内部发布无需分别配置。'
              : 'Events come from the unified catalog. Only events with a declared task-input contract are selectable, regardless of observation mechanism.'}
          </p>
        </div>
        {(rules.data.items.length > 0 || eligibleEvents.length > 0) && newAction}
      </div>

      {error !== null ? <ErrorBanner error={error} /> : null}
      {eligibleEvents.length === 0 ? (
        <NoticeBanner
          tone="warning"
          title={zh ? '还没有可启动工作的事件' : 'No work-start events available'}
        >
          {zh
            ? '事件发布者需要先声明任务输入参数；仅用于唤醒已有关注的事件不会出现在这里。'
            : 'Publishers must declare task inputs. Events that only wake existing attention are intentionally omitted.'}
        </NoticeBanner>
      ) : rules.data.items.length === 0 ? (
        <EmptyState
          title={zh ? '还没有事件响应规则' : 'No event response rules'}
          description={
            zh
              ? '选择一个业务事件，再选择要启动的编排、Agent、工作组或数字员工。'
              : 'Choose a business event and the workflow, agent, workgroup, or employee it should start.'
          }
          action={newAction}
        />
      ) : (
        <div className="webhook-card-grid" data-testid="event-response-rule-list">
          {rules.data.items.map((rule) => (
            <Card
              key={rule.id}
              title={rule.name}
              actions={
                <div className="webhook-trigger-card__status">
                  {rule.lastStatus !== null ? (
                    <StatusChip
                      kind={rule.lastStatus === 'failed' ? 'danger' : 'success'}
                      size="sm"
                    >
                      {rule.lastStatus === 'failed'
                        ? zh
                          ? '上次启动失败'
                          : 'Last launch failed'
                        : zh
                          ? '上次已启动'
                          : 'Last launched'}
                    </StatusChip>
                  ) : null}
                </div>
              }
              footer={
                <div className="webhook-card__footer">
                  {props.canManage ? (
                    <Switch
                      checked={rule.enabled}
                      onChange={() => toggle.mutate(rule)}
                      disabled={toggle.isPending}
                      label={zh ? '启用规则' : 'Enable rule'}
                    />
                  ) : (
                    <StatusChip kind={rule.enabled ? 'success' : 'neutral'} size="sm">
                      {rule.enabled ? (zh ? '已启用' : 'Enabled') : zh ? '已停用' : 'Disabled'}
                    </StatusChip>
                  )}
                  {props.canManage ? (
                    <div className="page__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setDraft(draftOf(rule))}
                        data-testid={`event-response-rule-edit-${rule.id}`}
                      >
                        {zh ? '编辑' : 'Edit'}
                      </button>
                      <ConfirmButton
                        size="sm"
                        variant="danger"
                        label={zh ? '删除' : 'Delete'}
                        confirmLabel={zh ? '确认删除' : 'Confirm delete'}
                        confirmationKey={rule.id}
                        onConfirm={() => remove.mutateAsync(rule.id)}
                      />
                    </div>
                  ) : null}
                </div>
              }
            >
              <div className="webhook-card__body">
                <p>
                  <strong>{zh ? '事件' : 'Event'}</strong>
                  <span>{eventName(rule.eventTypeRef)}</span>
                </p>
                <p>
                  <strong>{zh ? '启动' : 'Starts'}</strong>
                  <span>{resourceName(rule.target)}</span>
                </p>
                <p>
                  <strong>{zh ? '对象范围' : 'Subject scope'}</strong>
                  <span>
                    {rule.subjectMatch === 'all'
                      ? zh
                        ? '全部对象'
                        : 'All subjects'
                      : `${rule.subjectMatch === 'exact' ? (zh ? '精确' : 'Exact') : zh ? '前缀' : 'Prefix'} · ${rule.subjectPattern ?? ''}`}
                  </span>
                </p>
                {rule.lastError !== null ? <small>{rule.lastError}</small> : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {draft !== null ? (
        <Dialog
          open
          onClose={() => setDraft(null)}
          title={
            draft.id === null
              ? zh
                ? '新增响应规则'
                : 'New response rule'
              : zh
                ? '编辑响应规则'
                : 'Edit response rule'
          }
          size="lg"
          dismissDisabled={save.isPending}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setDraft(null)}
                disabled={save.isPending}
              >
                {zh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!valid || save.isPending}
                onClick={() => save.mutate(draft)}
                data-testid="event-response-rule-save"
              >
                {save.isPending ? (zh ? '保存中…' : 'Saving…') : zh ? '保存规则' : 'Save rule'}
              </button>
            </>
          }
        >
          {error !== null ? <ErrorBanner error={error} /> : null}
          {workflowDetail.isError ? <ErrorBanner error={workflowDetail.error} /> : null}
          {agentDetail.isError ? <ErrorBanner error={agentDetail.error} /> : null}
          {employeeType.isError ? <ErrorBanner error={employeeType.error} /> : null}
          <div className="employee-dialog-form event-response-rule-editor">
            <section className="event-source-editor__section">
              <div>
                <span className="employee-node-panel__eyebrow">
                  {zh ? '发生了什么' : 'What happened'}
                </span>
                <h3>{zh ? '选择业务事件' : 'Choose a business event'}</h3>
                <p>
                  {zh
                    ? '这里选择的是稳定事实，不选择 Webhook 或轮询方式。'
                    : 'Choose a stable fact here, not a webhook or polling mechanism.'}
                </p>
              </div>
              <div className="form-grid">
                <Field label={zh ? '规则名称' : 'Rule name'} required>
                  <TextInput
                    value={draft.name}
                    onChange={(name) =>
                      setDraft((current) => (current === null ? null : { ...current, name }))
                    }
                    placeholder={
                      zh ? '例如：流水线失败后启动修复' : 'For example: Repair failed pipeline'
                    }
                    data-testid="event-response-rule-name"
                  />
                </Field>
                <Field label={zh ? '事件' : 'Event'} required>
                  <Select
                    searchable
                    value={draft.eventKey}
                    onChange={(eventKey) => {
                      const event = eligibleEvents.find(
                        (candidate) => refKey(candidate.eventTypeRef) === eventKey,
                      )
                      const contract = event?.triggerParameters ?? null
                      const token = contract?.fields[0]
                      const seed =
                        contract === null || token === undefined
                          ? ''
                          : `{{trigger.${contract.namespace}.${token.fieldId}}}`
                      setDraft((current) =>
                        current === null
                          ? null
                          : {
                              ...current,
                              eventKey,
                              nameTemplate: seed === '' ? current.nameTemplate : seed,
                              inputs: {},
                              descriptionTemplate: '',
                              goalTemplate: seed,
                              employeeTarget: {},
                              valueTemplate: seed,
                            },
                      )
                    }}
                    options={eligibleEvents.map((event) => {
                      const source = props.catalog.sources.find(
                        (candidate) => refKey(candidate.sourceRef) === refKey(event.sourceRef),
                      )
                      return {
                        value: refKey(event.eventTypeRef),
                        label: localized(event.displayName, props.language),
                        description: localized(event.description, props.language),
                        group:
                          source === undefined
                            ? event.sourceRef.id
                            : localized(source.displayName, props.language),
                      }
                    })}
                    ariaLabel={zh ? '选择事件' : 'Choose event'}
                    data-testid="event-response-rule-event"
                  />
                </Field>
                {selectedEvent !== null && selectedContract !== null ? (
                  <div className="event-response-contract" data-testid="event-response-contract">
                    <strong>{zh ? '该事件会注入' : 'This event injects'}</strong>
                    <div>
                      {selectedContract.fields.map((field) => (
                        <code
                          key={field.fieldId}
                        >{`{{trigger.${selectedContract.namespace}.${field.fieldId}}}`}</code>
                      ))}
                    </div>
                  </div>
                ) : null}
                <Field label={zh ? '关注对象' : 'Subject scope'} group required>
                  <Segmented<SubjectMatch>
                    value={draft.subjectMatch}
                    onChange={(subjectMatch) =>
                      setDraft((current) =>
                        current === null ? null : { ...current, subjectMatch },
                      )
                    }
                    options={[
                      { value: 'all', label: zh ? '全部' : 'All' },
                      { value: 'exact', label: zh ? '精确对象' : 'Exact' },
                      { value: 'prefix', label: zh ? '对象前缀' : 'Prefix' },
                    ]}
                    ariaLabel={zh ? '关注对象范围' : 'Subject scope'}
                  />
                  {draft.subjectMatch !== 'all' ? (
                    <TextInput
                      value={draft.subjectPattern}
                      onChange={(subjectPattern) =>
                        setDraft((current) =>
                          current === null ? null : { ...current, subjectPattern },
                        )
                      }
                      placeholder={
                        selectedEvent === null
                          ? ''
                          : `${selectedEvent.subjectTypeId} ${draft.subjectMatch === 'exact' ? (zh ? '唯一标识' : 'identity') : zh ? '标识前缀' : 'identity prefix'}`
                      }
                      data-testid="event-response-rule-subject"
                    />
                  ) : null}
                </Field>
              </div>
            </section>

            <section className="event-source-editor__section">
              <div>
                <span className="employee-node-panel__eyebrow">
                  {zh ? '接下来做什么' : 'What happens next'}
                </span>
                <h3>{zh ? '选择执行者并填写确定输入' : 'Choose an executor and map its inputs'}</h3>
                <p>
                  {zh
                    ? '只能从平台已有资源中选择；输入项来自所选资源的声明契约。'
                    : 'Choose an existing platform resource. Input fields come from that resource’s declared contract.'}
                </p>
              </div>
              <Field label={zh ? '执行方式' : 'Executor type'} group required>
                <ChoiceCards<TargetKind>
                  value={draft.targetKind}
                  onChange={(targetKind) =>
                    setDraft((current) =>
                      current === null
                        ? null
                        : {
                            ...current,
                            targetKind,
                            targetRefId: '',
                            inputs: {},
                            employeeTarget: {},
                          },
                    )
                  }
                  options={[
                    {
                      value: 'workflow',
                      label: zh ? '编排' : 'Workflow',
                      description: zh ? '运行一个已有工作流' : 'Run an existing workflow',
                    },
                    {
                      value: 'agent',
                      label: 'Agent',
                      description: zh ? '运行一个已有 Agent' : 'Run an existing agent',
                    },
                    {
                      value: 'workgroup',
                      label: zh ? '工作组' : 'Workgroup',
                      description: zh ? '运行一个已有工作组' : 'Run an existing workgroup',
                    },
                    {
                      value: 'digital-employee',
                      label: zh ? '数字员工' : 'Digital employee',
                      description: zh ? '交给另一个数字员工' : 'Delegate to another employee',
                    },
                  ]}
                  ariaLabel={zh ? '选择执行方式' : 'Choose executor type'}
                  testidPrefix="event-response-target-kind"
                />
              </Field>
              <Field label={zh ? '执行者' : 'Executor'} required>
                <Select
                  searchable
                  value={draft.targetRefId}
                  onChange={(targetRefId) =>
                    setDraft((current) =>
                      current === null
                        ? null
                        : { ...current, targetRefId, inputs: {}, employeeTarget: {} },
                    )
                  }
                  options={resourceOptions}
                  placeholder={zh ? '从已有资源中选择' : 'Choose an existing resource'}
                  ariaLabel={zh ? '选择执行者' : 'Choose executor'}
                  data-testid="event-response-rule-target"
                />
              </Field>

              {draft.targetKind !== 'digital-employee' ? (
                <TemplateControl
                  label={zh ? '任务名称' : 'Task name'}
                  hint={
                    zh
                      ? '可插入上方事件参数，执行时由平台确定性渲染。'
                      : 'Event parameters are rendered deterministically at launch.'
                  }
                  value={draft.nameTemplate}
                  onChange={(nameTemplate) =>
                    setDraft((current) => (current === null ? null : { ...current, nameTemplate }))
                  }
                  authority="event:work-start:name"
                  entries={parameterCatalog}
                  required
                  testId="event-response-name-template"
                />
              ) : null}

              {draft.targetKind === 'workflow'
                ? workflowInputs.map((input) => (
                    <TemplateControl
                      key={input.key}
                      label={input.key}
                      hint={`${input.kind}${input.description === undefined ? '' : ` · ${input.description}`}`}
                      value={draft.inputs[input.key] ?? ''}
                      onChange={(value) =>
                        setDraft((current) =>
                          current === null
                            ? null
                            : { ...current, inputs: { ...current.inputs, [input.key]: value } },
                        )
                      }
                      authority="event:workflow:input"
                      entries={parameterCatalog}
                      required={input.required === true}
                      testId={`event-response-workflow-input-${input.key}`}
                    />
                  ))
                : null}
              {draft.targetKind === 'agent' ? (
                <>
                  <TemplateControl
                    label={zh ? '任务说明' : 'Task description'}
                    hint={
                      zh
                        ? '作为 Agent 的本轮工作说明；留空表示只使用该 Agent 的固定定义。'
                        : 'Work description for this run; leave blank to use only the agent definition.'
                    }
                    value={draft.descriptionTemplate}
                    onChange={(descriptionTemplate) =>
                      setDraft((current) =>
                        current === null ? null : { ...current, descriptionTemplate },
                      )
                    }
                    authority="event:agent:description"
                    entries={parameterCatalog}
                    multiline
                    testId="event-response-agent-description"
                  />
                  {agentInputs.map((input) => (
                    <TemplateControl
                      key={input.name}
                      label={input.name}
                      hint={`${input.kind}${input.description === undefined ? '' : ` · ${input.description}`}`}
                      value={draft.inputs[input.name] ?? ''}
                      onChange={(value) =>
                        setDraft((current) =>
                          current === null
                            ? null
                            : { ...current, inputs: { ...current.inputs, [input.name]: value } },
                        )
                      }
                      authority="event:agent:input"
                      entries={parameterCatalog}
                      multiline
                      required={input.required === true}
                      testId={`event-response-agent-input-${input.name}`}
                    />
                  ))}
                </>
              ) : null}
              {draft.targetKind === 'workgroup' ? (
                <TemplateControl
                  label={zh ? '工作目标' : 'Work goal'}
                  value={draft.goalTemplate}
                  onChange={(goalTemplate) =>
                    setDraft((current) => (current === null ? null : { ...current, goalTemplate }))
                  }
                  authority="event:workgroup:goal"
                  entries={parameterCatalog}
                  multiline
                  required
                  testId="event-response-workgroup-goal"
                />
              ) : null}
              {draft.targetKind === 'digital-employee' && employeeIntake !== undefined ? (
                <>
                  <Field label={zh ? '工作材料形式' : 'Work material'} group required>
                    <Segmented<'body' | 'external-id'>
                      value={draft.intakeKind}
                      onChange={(intakeKind) =>
                        setDraft((current) =>
                          current === null ? null : { ...current, intakeKind, valueTemplate: '' },
                        )
                      }
                      options={employeeIntake.acceptedKinds
                        .filter(
                          (kind): kind is 'body' | 'external-id' =>
                            kind === 'body' || kind === 'external-id',
                        )
                        .map((kind) => ({
                          value: kind,
                          label:
                            kind === 'body'
                              ? zh
                                ? '正文'
                                : 'Body'
                              : zh
                                ? '外部 ID'
                                : 'External ID',
                        }))}
                      ariaLabel={zh ? '工作材料形式' : 'Work material kind'}
                    />
                  </Field>
                  {employeeIntake.targetFields.map((field) => (
                    <TemplateControl
                      key={field.fieldRef}
                      label={localized(field.label, props.language)}
                      hint={localized(field.description, props.language)}
                      value={draft.employeeTarget[field.fieldRef] ?? ''}
                      onChange={(value) =>
                        setDraft((current) =>
                          current === null
                            ? null
                            : {
                                ...current,
                                employeeTarget: {
                                  ...current.employeeTarget,
                                  [field.fieldRef]: value,
                                },
                              },
                        )
                      }
                      authority="event:digital-employee:target"
                      entries={parameterCatalog}
                      required={field.required}
                      testId={`event-response-employee-target-${field.fieldRef}`}
                    />
                  ))}
                  <TemplateControl
                    label={
                      draft.intakeKind === 'body'
                        ? localized(employeeIntake.body.label, props.language)
                        : localized(employeeIntake.externalId.label, props.language)
                    }
                    hint={
                      draft.intakeKind === 'body'
                        ? localized(employeeIntake.body.description, props.language)
                        : localized(employeeIntake.externalId.description, props.language)
                    }
                    value={draft.valueTemplate}
                    onChange={(valueTemplate) =>
                      setDraft((current) =>
                        current === null ? null : { ...current, valueTemplate },
                      )
                    }
                    authority={
                      draft.intakeKind === 'body'
                        ? 'event:digital-employee:body'
                        : 'event:digital-employee:external-id'
                    }
                    entries={parameterCatalog}
                    multiline={draft.intakeKind === 'body'}
                    required
                    testId="event-response-employee-value"
                  />
                </>
              ) : null}
            </section>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
