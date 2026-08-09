// RFC-257 UI 修订 — 触发器面板（/webhooks 单页的 triggers tab；原独立路由
// /webhook-triggers 并入）。列表 + 新建/编辑 Dialog，全公共原语。输入映射按
// 目标 workflow 的 input kind 感知渲染（git kind = 固定「分支来自事件」，
// text = 模板输入，其余提示不可映射——保存由后端三层校验兜底）。
import {
  CODE_HOST_EVENT_TYPES,
  type CodeHostEventType,
  type WebhookEndpoint,
  type WebhookInputMapping,
  type WebhookLaunchKind,
  type WebhookTrigger,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { buildResourceOptionLabeler } from '@/lib/resource-option-label'
import { Card } from '@/components/Card'
import { ChoiceCards } from '@/components/ChoiceCards'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Checkbox, Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { ChipsInput } from '@/components/ChipsInput'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { QueryState } from '@/components/QueryState'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { Stepper } from '@/components/Stepper'
import { TableViewport } from '@/components/TableViewport'
import {
  TemplateVarChips,
  applyTemplateVarInsertion,
  webhookVarGroupsForDisplay,
} from '@/components/TemplateVarChips'
import { isAdminAtRequest, useIsAdmin } from '@/hooks/useActor'

type RepoScopeKind = 'all' | 'prefix' | 'exact'
type ExecutionSpace = 'event-repo' | 'scratch'

interface AdminRequest<T> {
  session: number
  input: T
}

function isScratchPayload(payload: unknown): payload is { scratch: true } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'scratch' in payload &&
    payload.scratch === true
  )
}

interface Draft {
  id: string | null
  name: string
  endpointId: string
  enabled: boolean
  scopeKind: RepoScopeKind
  scopePrefix: string
  scopePaths: string[]
  eventTypes: CodeHostEventType[]
  branchFilter: string
  commandPrefix: string
  ignoreUsernames: string[]
  launchKind: WebhookLaunchKind
  launchRefId: string
  space: ExecutionSpace
  /** workflow 面：inputKey → 映射；agent/workgroup 面用下面两个字段。 */
  inputMappings: Record<string, WebhookInputMapping>
  description: string
  goal: string
  maxConsecutiveFires: number
  autoRegisterRepos: boolean
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  endpointId: '',
  enabled: true,
  scopeKind: 'prefix',
  scopePrefix: '',
  scopePaths: [],
  eventTypes: ['mr_opened', 'mr_updated'],
  branchFilter: '',
  commandPrefix: '',
  ignoreUsernames: [],
  launchKind: 'workflow',
  launchRefId: '',
  space: 'event-repo',
  inputMappings: {},
  description: '',
  goal: '',
  maxConsecutiveFires: 3,
  autoRegisterRepos: true,
}

function draftFromRow(row: WebhookTrigger): Draft {
  const scope = row.repoScope
  const payload = (row.launchPayload ?? {}) as {
    inputs?: Record<string, WebhookInputMapping> | Record<string, string>
    description?: string
    goal?: string
    scratch?: true
  }
  return {
    id: row.id,
    name: row.name,
    endpointId: row.endpointId,
    enabled: row.enabled,
    scopeKind: scope?.kind ?? 'all',
    scopePrefix: scope?.kind === 'prefix' ? scope.prefix : '',
    scopePaths: scope?.kind === 'exact' ? scope.paths : [],
    eventTypes: row.eventTypes ?? [],
    branchFilter: row.branchFilter ?? '',
    commandPrefix: row.commandPrefix ?? '',
    ignoreUsernames: row.ignoreUsernames ?? [],
    launchKind: row.launchKind,
    launchRefId: row.launchRefId,
    space: payload.scratch === true ? 'scratch' : 'event-repo',
    inputMappings:
      row.launchKind === 'workflow'
        ? ((payload.inputs ?? {}) as Record<string, WebhookInputMapping>)
        : {},
    description: row.launchKind === 'agent' ? (payload.description ?? '') : '',
    goal: row.launchKind === 'workgroup' ? (payload.goal ?? '') : '',
    maxConsecutiveFires: row.maxConsecutiveFires,
    autoRegisterRepos: row.autoRegisterRepos,
  }
}

function payloadOf(draft: Draft): unknown {
  const space = draft.space === 'scratch' ? { scratch: true as const } : {}
  if (draft.launchKind === 'workflow') return { inputs: draft.inputMappings, ...space }
  if (draft.launchKind === 'agent') {
    return draft.description.trim() === '' ? space : { description: draft.description, ...space }
  }
  return { goal: draft.goal, ...space }
}

function bodyOf(draft: Draft): Record<string, unknown> {
  return {
    name: draft.name,
    endpointId: draft.endpointId,
    enabled: draft.enabled,
    repoScope:
      draft.scopeKind === 'all'
        ? { kind: 'all' }
        : draft.scopeKind === 'prefix'
          ? { kind: 'prefix', prefix: draft.scopePrefix }
          : { kind: 'exact', paths: draft.scopePaths },
    eventTypes: draft.eventTypes,
    ...(draft.branchFilter.trim() !== '' ? { branchFilter: draft.branchFilter.trim() } : {}),
    ...(draft.commandPrefix.trim() !== '' ? { commandPrefix: draft.commandPrefix.trim() } : {}),
    ignoreUsernames: draft.ignoreUsernames,
    launchKind: draft.launchKind,
    launchRefId: draft.launchRefId,
    launchPayload: payloadOf(draft),
    maxConsecutiveFires: draft.maxConsecutiveFires,
    autoRegisterRepos: draft.space === 'scratch' ? false : draft.autoRegisterRepos,
  }
}

type WorkflowRow = { id: string; name: string }
type WorkflowDetail = {
  definition?: { inputs?: Array<{ key: string; kind: string; required?: boolean }> } | null
}
type AgentRow = { id: string; name: string }
type WorkgroupRow = { id: string; name: string }

/** RFC-260：isAdmin=false 渲染只读视图（无新建/编辑/删除/开关/重置；fires 查看保留）。 */
export function TriggersPanel({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const liveIsAdmin = useIsAdmin()
  const canAdmin = isAdmin && liveIsAdmin
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [firesFor, setFiresFor] = useState<WebhookTrigger | null>(null)
  const adminSessionRef = useRef(0)
  const previousCanAdminRef = useRef(canAdmin)
  const resetMutationsRef = useRef<() => void>(() => {})

  const triggers = useQuery({
    queryKey: ['webhook-triggers'],
    queryFn: ({ signal }) => api.get<WebhookTrigger[]>('/api/webhook-triggers', undefined, signal),
    refetchInterval: 30_000,
  })
  const endpoints = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: ({ signal }) =>
      api.get<Array<WebhookEndpoint & { ingressUrl: string | null }>>(
        '/api/webhook-endpoints',
        undefined,
        signal,
      ),
    // RFC-260 起读面全员开放（掩码响应）；retry:false 只为异常时快速降级。
    retry: false,
  })
  const workflowOptions = useQuery({
    queryKey: ['workflows', 'list'],
    queryFn: ({ signal }) => api.get<WorkflowRow[]>('/api/workflows', undefined, signal),
    retry: false,
  })
  const agentOptions = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: ({ signal }) => api.get<AgentRow[]>('/api/agents', undefined, signal),
    retry: false,
  })
  const workgroupOptions = useQuery({
    queryKey: ['workgroups', 'list'],
    queryFn: ({ signal }) => api.get<WorkgroupRow[]>('/api/workgroups', undefined, signal),
    retry: false,
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['webhook-triggers'] })
  const requestIsCurrent = (session: number): boolean =>
    session === adminSessionRef.current && isAdminAtRequest(qc)

  const save = useMutation({
    mutationFn: ({ input: d, session }: AdminRequest<Draft>) => {
      if (!requestIsCurrent(session)) throw new Error('Webhook admin session ended')
      return d.id === null
        ? api.post<WebhookTrigger>('/api/webhook-triggers', bodyOf(d))
        : api.put<WebhookTrigger>(`/api/webhook-triggers/${encodeURIComponent(d.id)}`, {
            ...bodyOf(d),
            // kind/endpoint 不可变：PUT 不带这两个键（后端提供时才校验相等）。
            launchKind: undefined,
            endpointId: undefined,
          })
    },
    onSuccess: (_saved, request) => {
      if (!requestIsCurrent(request.session)) return
      setError(null)
      setDraft(null)
      invalidate()
    },
    onError: (nextError, request) => {
      if (requestIsCurrent(request.session)) setError(nextError)
    },
  })
  const toggle = useMutation({
    mutationFn: ({ input, session }: AdminRequest<{ id: string; enabled: boolean }>) => {
      if (!requestIsCurrent(session)) throw new Error('Webhook admin session ended')
      return api.put<WebhookTrigger>(`/api/webhook-triggers/${encodeURIComponent(input.id)}`, {
        enabled: input.enabled,
      })
    },
    onSuccess: (_saved, request) => {
      if (requestIsCurrent(request.session)) invalidate()
    },
    onError: (nextError, request) => {
      if (requestIsCurrent(request.session)) setError(nextError)
    },
  })
  const remove = useMutation({
    mutationFn: ({ input: id, session }: AdminRequest<string>) => {
      if (!requestIsCurrent(session)) throw new Error('Webhook admin session ended')
      return api.delete(`/api/webhook-triggers/${encodeURIComponent(id)}`)
    },
    onSuccess: (_deleted, request) => {
      if (!requestIsCurrent(request.session)) return
      setError(null)
      invalidate()
    },
    onError: (nextError, request) => {
      if (requestIsCurrent(request.session)) setError(nextError)
    },
  })
  resetMutationsRef.current = () => {
    save.reset()
    toggle.reset()
    remove.reset()
  }

  useLayoutEffect(() => {
    const lostAdmin = previousCanAdminRef.current && !canAdmin
    previousCanAdminRef.current = canAdmin
    if (!canAdmin) {
      if (lostAdmin) adminSessionRef.current += 1
      setDraft(null)
      setError(null)
      resetMutationsRef.current()
    }
  }, [canAdmin])

  const adminSession = adminSessionRef.current

  const rows = triggers.data ?? []
  const isInitialEmpty = !triggers.isLoading && triggers.data !== undefined && rows.length === 0
  const targetNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const row of workflowOptions.data ?? []) names.set(`workflow:${row.id}`, row.name)
    for (const row of agentOptions.data ?? []) names.set(`agent:${row.id}`, row.name)
    for (const row of workgroupOptions.data ?? []) names.set(`workgroup:${row.id}`, row.name)
    return names
  }, [agentOptions.data, workflowOptions.data, workgroupOptions.data])

  const newAction = (
    <button
      type="button"
      className="btn btn--primary"
      onClick={() => {
        if (!requestIsCurrent(adminSession)) return
        setError(null)
        save.reset()
        setDraft({ ...EMPTY_DRAFT, endpointId: endpoints.data?.[0]?.id ?? '' })
      }}
      disabled={endpoints.isLoading}
      data-testid="webhook-trigger-new"
    >
      {t('webhookTriggers.new')}
    </button>
  )

  return (
    <section className="webhook-panel" data-testid="webhook-triggers-panel">
      <div className="webhook-panel__intro">
        <div>
          <span className="webhook-panel__eyebrow">{t('webhookTriggers.eyebrow')}</span>
          <h2>{t('webhookTriggers.title')}</h2>
          <p>{t('webhookTriggers.subtitle')}</p>
        </div>
        {canAdmin && !isInitialEmpty && newAction}
      </div>

      <FeedbackStack variant="section">
        {error !== null && <ErrorBanner error={error} />}
        {triggers.error != null && <ErrorBanner error={triggers.error} />}
      </FeedbackStack>
      {triggers.isLoading && <LoadingState data-testid="webhook-triggers-loading" />}
      {isInitialEmpty && (
        <EmptyState
          title={t('webhookTriggers.empty')}
          description={
            canAdmin
              ? t('webhookTriggers.emptyDescription')
              : t('webhookTriggers.emptyReadonlyDescription')
          }
          action={canAdmin ? newAction : undefined}
          data-testid="webhook-triggers-empty"
        />
      )}
      {rows.length > 0 && (
        <div className="webhook-card-grid" data-testid="webhook-triggers-table">
          {rows.map((row) => {
            const scope =
              row.repoScope === null
                ? t('common.emDash')
                : row.repoScope.kind === 'all'
                  ? t('webhookTriggers.scopeAll')
                  : row.repoScope.kind === 'prefix'
                    ? t('webhookTriggers.scopePrefix', { prefix: row.repoScope.prefix })
                    : t('webhookTriggers.scopeExact', { n: row.repoScope.paths.length })
            const target =
              targetNames.get(`${row.launchKind}:${row.launchRefId}`) ?? row.launchRefId
            const scratch = isScratchPayload(row.launchPayload)
            return (
              <Card
                key={row.id}
                className="webhook-trigger-card"
                title={row.name}
                actions={
                  <div className="webhook-trigger-card__status">
                    {row.launchPayload === null && (
                      <StatusChip kind="warn" size="sm">
                        {t('webhookTriggers.corruptBadge')}
                      </StatusChip>
                    )}
                    {row.lastStatus !== null && (
                      <StatusChip
                        kind={row.lastStatus === 'failed' ? 'danger' : 'success'}
                        size="sm"
                      >
                        {t(`webhookTriggers.last.${row.lastStatus}`)}
                      </StatusChip>
                    )}
                  </div>
                }
                footer={
                  <div className="webhook-card__footer">
                    {canAdmin ? (
                      <Switch
                        checked={row.enabled}
                        onChange={(enabled) =>
                          toggle.mutate({
                            session: adminSession,
                            input: { id: row.id, enabled },
                          })
                        }
                        disabled={toggle.isPending}
                        label={t('webhookTriggers.enabledSwitch')}
                        data-testid={`webhook-trigger-enable-${row.id}`}
                      />
                    ) : (
                      <StatusChip kind={row.enabled ? 'success' : 'neutral'} size="sm">
                        {t(
                          row.enabled
                            ? 'webhookTriggers.enabledChip'
                            : 'webhookTriggers.disabledChip',
                        )}
                      </StatusChip>
                    )}
                    <div className="page__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setFiresFor(row)}
                        data-testid={`webhook-trigger-fires-${row.id}`}
                      >
                        {t('webhookTriggers.firesButton')}
                      </button>
                      {canAdmin && (
                        <>
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => {
                              if (!requestIsCurrent(adminSession)) return
                              setError(null)
                              save.reset()
                              setDraft(draftFromRow(row))
                            }}
                            data-testid={`webhook-trigger-edit-${row.id}`}
                          >
                            {t('common.edit')}
                          </button>
                          <ConfirmButton
                            label={t('common.delete')}
                            confirmLabel={t('webhookTriggers.deleteConfirm')}
                            variant="danger"
                            size="sm"
                            confirmationKey={row.id}
                            onConfirm={() =>
                              remove.mutateAsync({ session: adminSession, input: row.id })
                            }
                          />
                        </>
                      )}
                    </div>
                  </div>
                }
                data-testid={`webhook-trigger-${row.id}`}
              >
                <div className="webhook-trigger__flow" aria-label={t('webhookTriggers.flowAria')}>
                  <div>
                    <span>{t('webhookTriggers.flow.scope')}</span>
                    <strong>{scope}</strong>
                  </div>
                  <span className="webhook-trigger__flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <div>
                    <span>{t('webhookTriggers.flow.events')}</span>
                    <strong>
                      {t('webhookTriggers.eventCount', { count: row.eventTypes?.length ?? 0 })}
                    </strong>
                  </div>
                  <span className="webhook-trigger__flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <div>
                    <span>{t('webhookTriggers.flow.target')}</span>
                    <strong>{target}</strong>
                  </div>
                </div>
                <div className="webhook-chip-list">
                  {(row.eventTypes ?? []).map((eventType) => (
                    <StatusChip key={eventType} kind="neutral" size="sm">
                      {t(`webhookTriggers.events.${eventType}`)}
                    </StatusChip>
                  ))}
                  <StatusChip kind="info" size="sm">
                    {t(`webhookTriggers.kinds.${row.launchKind}`)}
                  </StatusChip>
                  {row.launchPayload !== null && (
                    <StatusChip
                      kind={scratch ? 'info' : 'neutral'}
                      size="sm"
                      data-testid={`webhook-trigger-space-${row.id}`}
                    >
                      {t(
                        scratch
                          ? 'webhookTriggers.spaces.scratch'
                          : 'webhookTriggers.spaces.eventRepo',
                      )}
                    </StatusChip>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {canAdmin && draft !== null && (
        <TriggerDialog
          draft={draft}
          endpoints={endpoints.data ?? []}
          saving={save.isPending}
          saveError={save.error}
          onChange={(nextDraft) => {
            save.reset()
            setDraft(nextDraft)
          }}
          onClose={() => setDraft(null)}
          onSave={() => save.mutate({ session: adminSession, input: draft })}
        />
      )}
      {firesFor !== null && (
        <FiresDialog trigger={firesFor} isAdmin={canAdmin} onClose={() => setFiresFor(null)} />
      )}
    </section>
  )
}

function TriggerDialog(props: {
  draft: Draft
  endpoints: Array<WebhookEndpoint & { ingressUrl: string | null }>
  saving: boolean
  saveError: unknown
  onChange: (d: Draft) => void
  onClose: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const { draft } = props
  const isNew = draft.id === null
  const [step, setStep] = useState(0)
  const [maxReachable, setMaxReachable] = useState(isNew ? 0 : 3)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [initialDraft] = useState(() => JSON.stringify(draft))
  const set = (patch: Partial<Draft>) => props.onChange({ ...draft, ...patch })

  const workflows = useQuery({
    queryKey: ['workflows', 'list'],
    queryFn: ({ signal }) => api.get<WorkflowRow[]>('/api/workflows', undefined, signal),
    enabled: draft.launchKind === 'workflow',
  })
  const agents = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: ({ signal }) => api.get<AgentRow[]>('/api/agents', undefined, signal),
    enabled: draft.launchKind === 'agent',
  })
  const workgroups = useQuery({
    queryKey: ['workgroups', 'list'],
    queryFn: ({ signal }) => api.get<WorkgroupRow[]>('/api/workgroups', undefined, signal),
    enabled: draft.launchKind === 'workgroup',
  })
  const workflowDetail = useQuery({
    queryKey: ['workflows', 'detail', draft.launchRefId],
    queryFn: ({ signal }) =>
      api.get<WorkflowDetail>(
        `/api/workflows/${encodeURIComponent(draft.launchRefId)}`,
        undefined,
        signal,
      ),
    enabled: draft.launchKind === 'workflow' && draft.launchRefId !== '',
  })
  const workflowInputs = useMemo(
    () => workflowDetail.data?.definition?.inputs ?? [],
    [workflowDetail.data],
  )

  // 模板变量插入（三种注入面共用一套 chips）：变量集 = 所选事件类型交集，
  // 组内 event_json 置顶。workflow 面是多输入网格 —— 记录最近聚焦的 text 输入作为
  // 插入目标，未聚焦过时落到第一个 text 输入。
  // RFC-263：变量表 13→30 后按「事件上下文 / API 定位」两组呈现，每个 chip 带说明。
  const templateVarGroups = useMemo(
    () =>
      webhookVarGroupsForDisplay(draft.eventTypes).map((group) => ({
        label: t(
          group.key === 'api'
            ? 'webhookTriggers.fields.varGroupApi'
            : 'webhookTriggers.fields.varGroupContext',
        ),
        vars: group.vars,
      })),
    [draft.eventTypes, t],
  )
  const templateVarsLabel = t('webhookTriggers.fields.templateVarsLabel')
  const templateVarTitle = useCallback(
    (name: string) => t(`webhookTriggers.fields.vars.${name}`),
    [t],
  )
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null)
  const goalRef = useRef<HTMLTextAreaElement | null>(null)
  const mappingInputRefs = useRef(new Map<string, HTMLInputElement>())
  const [focusedMappingKey, setFocusedMappingKey] = useState<string | null>(null)
  const textInputKeys = useMemo(
    () => workflowInputs.filter((input) => input.kind === 'text').map((input) => input.key),
    [workflowInputs],
  )
  const insertIntoMapping = (token: string) => {
    const key =
      focusedMappingKey !== null && textInputKeys.includes(focusedMappingKey)
        ? focusedMappingKey
        : textInputKeys[0]
    if (key === undefined) return
    const mapping = draft.inputMappings[key]
    const current = mapping?.kind === 'template' ? mapping.template : ''
    applyTemplateVarInsertion(mappingInputRefs.current.get(key) ?? null, current, token, (next) => {
      const nextMappings = { ...draft.inputMappings }
      if (next === '') delete nextMappings[key]
      else nextMappings[key] = { kind: 'template', template: next }
      set({ inputMappings: nextMappings })
    })
  }

  // RFC-264: a trigger binds one exact row by id, so same-name candidates must
  // be tellable apart — the shared builder appends an id suffix to those only.
  const targetRows: ReadonlyArray<{ id: string; name: string }> =
    draft.launchKind === 'workflow'
      ? (workflows.data ?? [])
      : draft.launchKind === 'agent'
        ? (agents.data ?? [])
        : (workgroups.data ?? [])
  const targetLabel = buildResourceOptionLabeler(targetRows)
  const targetOptions: Array<{ value: string; label: string }> = targetRows.map((row) => ({
    value: row.id,
    label: targetLabel(row),
  }))

  const scopeValid =
    (draft.scopeKind !== 'prefix' || draft.scopePrefix.trim() !== '') &&
    (draft.scopeKind !== 'exact' || draft.scopePaths.length > 0)
  const identityValid = draft.name.trim() !== '' && draft.endpointId !== '' && scopeValid
  const conditionsValid = draft.eventTypes.length > 0
  const requiredWorkflowInputsMapped =
    draft.launchKind !== 'workflow' ||
    workflowInputs.every(
      (input) => input.required !== true || draft.inputMappings[input.key] !== undefined,
    )
  const targetValid =
    draft.launchRefId !== '' &&
    requiredWorkflowInputsMapped &&
    (draft.launchKind !== 'workgroup' || draft.goal.trim() !== '')
  const protectionValid =
    Number.isInteger(draft.maxConsecutiveFires) &&
    draft.maxConsecutiveFires >= 1 &&
    draft.maxConsecutiveFires <= 100
  const canSave =
    draft.name.trim() !== '' &&
    draft.endpointId !== '' &&
    draft.launchRefId !== '' &&
    draft.eventTypes.length > 0 &&
    scopeValid &&
    targetValid &&
    protectionValid
  const stepValidity = [identityValid, conditionsValid, targetValid, protectionValid]
  const dirty = JSON.stringify(draft) !== initialDraft
  const requestClose = () => {
    if (props.saving) return
    if (dirty) setDiscardOpen(true)
    else props.onClose()
  }
  const navigate = (next: number) => {
    setStep(next)
    setMaxReachable((current) => Math.max(current, next))
  }
  const scopeSummary =
    draft.scopeKind === 'all'
      ? t('webhookTriggers.scopeAll')
      : draft.scopeKind === 'prefix'
        ? t('webhookTriggers.scopePrefix', { prefix: draft.scopePrefix })
        : t('webhookTriggers.scopeExact', { n: draft.scopePaths.length })
  const selectedTarget = targetOptions.find((option) => option.value === draft.launchRefId)?.label
  const targetQuery =
    draft.launchKind === 'workflow' ? workflows : draft.launchKind === 'agent' ? agents : workgroups

  return (
    <>
      <Dialog
        open
        onClose={requestClose}
        title={isNew ? t('webhookTriggers.dialogCreate') : t('webhookTriggers.dialogEdit')}
        size="lg"
        dismissDisabled={props.saving}
        panelClassName="webhook-trigger-dialog"
        data-testid="webhook-trigger-dialog"
      >
        <FeedbackStack variant="section">
          {props.saveError !== null && props.saveError !== undefined && (
            <ErrorBanner error={props.saveError} />
          )}
        </FeedbackStack>

        <Stepper
          steps={[
            { key: 'scope', title: t('webhookTriggers.steps.scope') },
            { key: 'events', title: t('webhookTriggers.steps.events') },
            { key: 'target', title: t('webhookTriggers.steps.target') },
            { key: 'review', title: t('webhookTriggers.steps.review') },
          ]}
          current={step}
          maxReachable={maxReachable}
          onNavigate={navigate}
          nextEnabled={stepValidity[step]}
          rootTestid="webhook-trigger-stepper"
          finalActions={
            <>
              <button type="button" className="btn" disabled={props.saving} onClick={requestClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canSave || props.saving}
                onClick={props.onSave}
                data-testid="webhook-trigger-save"
              >
                {props.saving ? t('common.saving') : t('webhookTriggers.saveAction')}
              </button>
            </>
          }
        >
          {step === 0 && (
            <div className="form-grid" data-testid="webhook-trigger-step-scope">
              <p className="webhook-step__lead">{t('webhookTriggers.stepLeads.scope')}</p>
              <div className="form-grid--cols-2">
                <Field label={t('webhookTriggers.fields.name')} required>
                  <TextInput
                    value={draft.name}
                    onChange={(name) => set({ name })}
                    data-testid="wt-name"
                  />
                </Field>
                <Field
                  label={t('webhookTriggers.fields.endpoint')}
                  hint={isNew ? undefined : t('webhookTriggers.fields.endpointImmutable')}
                  required
                >
                  <Select
                    value={draft.endpointId}
                    onChange={(endpointId) => set({ endpointId })}
                    disabled={!isNew}
                    options={props.endpoints.map((endpoint) => ({
                      value: endpoint.id,
                      label: endpoint.name,
                    }))}
                    placeholder={t('webhookTriggers.fields.endpointPlaceholder')}
                    ariaLabel={t('webhookTriggers.fields.endpoint')}
                    data-testid="wt-endpoint"
                  />
                </Field>
              </div>
              <Field
                label={t('webhookTriggers.fields.scope')}
                hint={t('webhookTriggers.fields.scopeHint')}
                group
                required
              >
                <Segmented<RepoScopeKind>
                  value={draft.scopeKind}
                  onChange={(scopeKind) => set({ scopeKind })}
                  ariaLabel={t('webhookTriggers.fields.scope')}
                  options={[
                    { value: 'all', label: t('webhookTriggers.scope.all') },
                    { value: 'prefix', label: t('webhookTriggers.scope.prefix') },
                    { value: 'exact', label: t('webhookTriggers.scope.exact') },
                  ]}
                />
                {draft.scopeKind === 'prefix' && (
                  <TextInput
                    value={draft.scopePrefix}
                    onChange={(scopePrefix) => set({ scopePrefix })}
                    placeholder="platform/"
                    data-testid="wt-scope-prefix"
                  />
                )}
                {draft.scopeKind === 'exact' && (
                  <ChipsInput
                    value={draft.scopePaths}
                    onChange={(scopePaths) => set({ scopePaths })}
                    placeholder={t('webhookTriggers.scope.exactPlaceholder')}
                    testidPrefix="wt-scope-paths"
                  />
                )}
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="form-grid" data-testid="webhook-trigger-step-events">
              <p className="webhook-step__lead">{t('webhookTriggers.stepLeads.events')}</p>
              <Field label={t('webhookTriggers.fields.events')} group required>
                <div className="webhook-event-grid">
                  {CODE_HOST_EVENT_TYPES.map((eventType) => (
                    <Checkbox
                      key={eventType}
                      checked={draft.eventTypes.includes(eventType)}
                      onChange={(checked) =>
                        set({
                          eventTypes: checked
                            ? [...draft.eventTypes, eventType]
                            : draft.eventTypes.filter((candidate) => candidate !== eventType),
                        })
                      }
                      label={t(`webhookTriggers.events.${eventType}`)}
                      data-testid={`wt-event-${eventType}`}
                    />
                  ))}
                </div>
              </Field>
              <div className="form-grid--cols-2">
                <Field
                  label={t('webhookTriggers.fields.branchFilter')}
                  hint={t('webhookTriggers.fields.branchFilterHint')}
                >
                  <TextInput
                    value={draft.branchFilter}
                    onChange={(branchFilter) => set({ branchFilter })}
                    placeholder="main / release/*"
                    data-testid="wt-branch-filter"
                  />
                </Field>
                {draft.eventTypes.includes('note') && (
                  <Field
                    label={t('webhookTriggers.fields.commandPrefix')}
                    hint={t('webhookTriggers.fields.commandPrefixHint')}
                  >
                    <TextInput
                      value={draft.commandPrefix}
                      onChange={(commandPrefix) => set({ commandPrefix })}
                      placeholder="/fix"
                      data-testid="wt-command-prefix"
                    />
                  </Field>
                )}
              </div>
              <Field
                label={t('webhookTriggers.fields.ignoreUsernames')}
                hint={t('webhookTriggers.fields.ignoreUsernamesHint')}
              >
                <ChipsInput
                  value={draft.ignoreUsernames}
                  onChange={(ignoreUsernames) => set({ ignoreUsernames })}
                  placeholder="aw-bot"
                  testidPrefix="wt-ignore"
                />
              </Field>
              <NoticeBanner tone="warning" size="compact">
                {t('webhookTriggers.fields.pipelineException')}
              </NoticeBanner>
            </div>
          )}

          {step === 2 && (
            <div className="form-grid" data-testid="webhook-trigger-step-target">
              <p className="webhook-step__lead">{t('webhookTriggers.stepLeads.target')}</p>
              <Field
                label={t('webhookTriggers.fields.launchKind')}
                hint={isNew ? undefined : t('webhookTriggers.fields.kindImmutable')}
                group
              >
                <ChoiceCards<WebhookLaunchKind>
                  value={draft.launchKind}
                  onChange={(launchKind) =>
                    isNew ? set({ launchKind, launchRefId: '', inputMappings: {} }) : undefined
                  }
                  disabled={!isNew}
                  ariaLabel={t('webhookTriggers.fields.launchKind')}
                  testidPrefix="wt-launch-kind"
                  options={[
                    {
                      value: 'workflow',
                      label: t('webhookTriggers.kinds.workflow'),
                      description: t('webhookTriggers.kindDescriptions.workflow'),
                    },
                    {
                      value: 'agent',
                      label: t('webhookTriggers.kinds.agent'),
                      description: t('webhookTriggers.kindDescriptions.agent'),
                    },
                    {
                      value: 'workgroup',
                      label: t('webhookTriggers.kinds.workgroup'),
                      description: t('webhookTriggers.kindDescriptions.workgroup'),
                    },
                  ]}
                />
              </Field>
              {targetQuery.error != null && <ErrorBanner error={targetQuery.error} />}
              <Field label={t('webhookTriggers.fields.target')} required>
                <Select
                  value={draft.launchRefId}
                  onChange={(launchRefId) => set({ launchRefId, inputMappings: {} })}
                  options={targetOptions}
                  placeholder={t('webhookTriggers.fields.targetPlaceholder')}
                  ariaLabel={t('webhookTriggers.fields.target')}
                  data-testid="wt-target"
                />
              </Field>
              <Field label={t('webhookTriggers.fields.executionSpace')} group required>
                <ChoiceCards<ExecutionSpace>
                  value={draft.space}
                  onChange={(space) =>
                    set(space === 'scratch' ? { space, autoRegisterRepos: false } : { space })
                  }
                  ariaLabel={t('webhookTriggers.fields.executionSpace')}
                  testidPrefix="wt-space"
                  options={[
                    {
                      value: 'event-repo',
                      label: t('webhookTriggers.spaces.eventRepo'),
                      description: t('webhookTriggers.spaceDescriptions.eventRepo'),
                    },
                    {
                      value: 'scratch',
                      label: t('webhookTriggers.spaces.scratch'),
                      description: t('webhookTriggers.spaceDescriptions.scratch'),
                    },
                  ]}
                />
              </Field>

              {draft.launchKind === 'workflow' && draft.launchRefId !== '' && (
                <Field
                  label={t('webhookTriggers.fields.inputMappings')}
                  hint={t(
                    draft.space === 'scratch'
                      ? 'webhookTriggers.fields.inputMappingsScratchHint'
                      : 'webhookTriggers.fields.inputMappingsHint',
                  )}
                  group
                >
                  {workflowDetail.isLoading ? (
                    <LoadingState size="compact" />
                  ) : workflowDetail.error != null ? (
                    <ErrorBanner error={workflowDetail.error} />
                  ) : workflowInputs.length === 0 ? (
                    <p className="muted">{t('webhookTriggers.fields.noInputs')}</p>
                  ) : (
                    <div className="form-grid">
                      {workflowInputs.map((input) => {
                        const mapping = draft.inputMappings[input.key]
                        const setMapping = (nextMapping: WebhookInputMapping | null) => {
                          const next = { ...draft.inputMappings }
                          if (nextMapping === null) delete next[input.key]
                          else next[input.key] = nextMapping
                          set({ inputMappings: next })
                        }
                        return (
                          <Field
                            key={input.key}
                            label={`${input.key}${input.required === true ? ' *' : ''}`}
                            hint={t(`webhookTriggers.inputKinds.${input.kind}`, {
                              defaultValue: input.kind,
                            })}
                          >
                            {input.kind === 'git' ? (
                              <Checkbox
                                checked={mapping?.kind === 'event-branch'}
                                onChange={(checked) =>
                                  setMapping(checked ? { kind: 'event-branch' } : null)
                                }
                                label={t('webhookTriggers.fields.eventBranch')}
                                data-testid={`wt-map-${input.key}`}
                              />
                            ) : input.kind === 'text' ? (
                              <TextInput
                                value={mapping?.kind === 'template' ? mapping.template : ''}
                                onChange={(template) =>
                                  setMapping(
                                    template === '' ? null : { kind: 'template', template },
                                  )
                                }
                                onFocus={() => setFocusedMappingKey(input.key)}
                                inputRef={(el) => {
                                  if (el === null) mappingInputRefs.current.delete(input.key)
                                  else mappingInputRefs.current.set(input.key, el)
                                }}
                                placeholder={t('webhookTriggers.fields.templatePlaceholder')}
                                data-testid={`wt-map-${input.key}`}
                              />
                            ) : (
                              <p className="muted">{t('webhookTriggers.fields.unmappable')}</p>
                            )}
                          </Field>
                        )
                      })}
                      {textInputKeys.length > 0 && (
                        <TemplateVarChips
                          groups={templateVarGroups}
                          label={templateVarsLabel}
                          onInsert={insertIntoMapping}
                          testidPrefix="wt-var"
                          titleOf={templateVarTitle}
                        />
                      )}
                    </div>
                  )}
                </Field>
              )}
              {draft.launchKind === 'agent' && (
                <>
                  <Field label={t('webhookTriggers.fields.description')}>
                    <TextArea
                      value={draft.description}
                      onChange={(description) => set({ description })}
                      rows={5}
                      monospace
                      textareaRef={descriptionRef}
                      data-testid="wt-description"
                    />
                  </Field>
                  <TemplateVarChips
                    groups={templateVarGroups}
                    label={templateVarsLabel}
                    onInsert={(token) =>
                      applyTemplateVarInsertion(
                        descriptionRef.current,
                        draft.description,
                        token,
                        (description) => set({ description }),
                      )
                    }
                    testidPrefix="wt-var"
                    titleOf={templateVarTitle}
                  />
                </>
              )}
              {draft.launchKind === 'workgroup' && (
                <>
                  <Field label={t('webhookTriggers.fields.goal')} required>
                    <TextArea
                      value={draft.goal}
                      onChange={(goal) => set({ goal })}
                      rows={5}
                      monospace
                      textareaRef={goalRef}
                      data-testid="wt-goal"
                    />
                  </Field>
                  <TemplateVarChips
                    groups={templateVarGroups}
                    label={templateVarsLabel}
                    onInsert={(token) =>
                      applyTemplateVarInsertion(goalRef.current, draft.goal, token, (goal) =>
                        set({ goal }),
                      )
                    }
                    testidPrefix="wt-var"
                    titleOf={templateVarTitle}
                  />
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="form-grid" data-testid="webhook-trigger-step-review">
              <p className="webhook-step__lead">{t('webhookTriggers.stepLeads.review')}</p>
              <dl className="wizard-summary">
                <div className="wizard-summary__row">
                  <dt>{t('webhookTriggers.review.endpoint')}</dt>
                  <dd>
                    {props.endpoints.find((endpoint) => endpoint.id === draft.endpointId)?.name ??
                      draft.endpointId}
                  </dd>
                </div>
                <div className="wizard-summary__row">
                  <dt>{t('webhookTriggers.review.scope')}</dt>
                  <dd>{scopeSummary}</dd>
                </div>
                <div className="wizard-summary__row">
                  <dt>{t('webhookTriggers.review.events')}</dt>
                  <dd>
                    {draft.eventTypes
                      .map((eventType) => t(`webhookTriggers.events.${eventType}`))
                      .join(t('webhookTriggers.review.separator'))}
                  </dd>
                </div>
                <div className="wizard-summary__row">
                  <dt>{t('webhookTriggers.review.target')}</dt>
                  <dd>
                    {t(`webhookTriggers.kinds.${draft.launchKind}`)} ·{' '}
                    {selectedTarget ?? draft.launchRefId}
                  </dd>
                </div>
                <div className="wizard-summary__row">
                  <dt>{t('webhookTriggers.review.space')}</dt>
                  <dd>
                    {t(
                      draft.space === 'scratch'
                        ? 'webhookTriggers.spaces.scratch'
                        : 'webhookTriggers.spaces.eventRepo',
                    )}
                  </dd>
                </div>
              </dl>
              <div className="form-grid--cols-2 webhook-protection-grid">
                <Field
                  label={t('webhookTriggers.fields.maxFires')}
                  hint={t('webhookTriggers.fields.maxFiresHint')}
                >
                  <NumberInput
                    value={draft.maxConsecutiveFires}
                    onChange={(value) => set({ maxConsecutiveFires: value ?? 3 })}
                    min={1}
                    max={100}
                    data-testid="wt-max-fires"
                  />
                </Field>
                {draft.space === 'event-repo' && (
                  <Field label={t('webhookTriggers.fields.autoRegister')} group>
                    <Switch
                      checked={draft.autoRegisterRepos}
                      onChange={(autoRegisterRepos) => set({ autoRegisterRepos })}
                      label={t('webhookTriggers.fields.autoRegisterLabel')}
                      data-testid="wt-auto-register"
                    />
                  </Field>
                )}
              </div>
              {draft.space === 'scratch' && (
                <NoticeBanner tone="info" size="compact" testid="wt-scratch-notice">
                  {t('webhookTriggers.fields.scratchNotice')}
                </NoticeBanner>
              )}
              <NoticeBanner tone="info" size="compact">
                {t('webhookTriggers.review.safetyNote', {
                  count: draft.maxConsecutiveFires,
                })}
              </NoticeBanner>
            </div>
          )}
        </Stepper>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        title={t('webhookTriggers.discardTitle')}
        description={t('webhookTriggers.discardDescription')}
        confirmLabel={t('webhookTriggers.discardAction')}
        tone="danger"
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => props.onClose()}
      />
    </>
  )
}

type FireRow = {
  id: string
  streamKey: string
  outcome: string
  supersededTaskId: string | null
  taskId: string | null
  error: string | null
  firedAt: number
}

function FiresDialog(props: { trigger: WebhookTrigger; isAdmin: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const adminSessionRef = useRef(0)
  const previousIsAdminRef = useRef(props.isAdmin)
  const fires = useQuery({
    queryKey: ['webhook-trigger-fires', props.trigger.id],
    queryFn: ({ signal }) =>
      api.get<FireRow[]>(
        `/api/webhook-triggers/${encodeURIComponent(props.trigger.id)}/fires`,
        undefined,
        signal,
      ),
  })
  const requestIsCurrent = (session: number): boolean =>
    session === adminSessionRef.current && isAdminAtRequest(qc)
  const reset = useMutation({
    mutationFn: ({ input: streamKey, session }: AdminRequest<string>) => {
      if (!requestIsCurrent(session)) throw new Error('Webhook admin session ended')
      return api.post(
        `/api/webhook-triggers/${encodeURIComponent(props.trigger.id)}/streams/reset`,
        {
          streamKey,
        },
      )
    },
    onSuccess: (_result, request) => {
      if (requestIsCurrent(request.session)) {
        void qc.invalidateQueries({ queryKey: ['webhook-trigger-fires', props.trigger.id] })
      }
    },
  })
  useLayoutEffect(() => {
    const lostAdmin = previousIsAdminRef.current && !props.isAdmin
    previousIsAdminRef.current = props.isAdmin
    if (lostAdmin) {
      adminSessionRef.current += 1
      reset.reset()
    }
  }, [props.isAdmin, reset])
  const adminSession = adminSessionRef.current
  const chipKind = (outcome: string) =>
    outcome === 'launched' ? 'success' : outcome === 'launch-failed' ? 'danger' : 'warn'
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('webhookTriggers.firesTitle', { name: props.trigger.name })}
      size="lg"
      data-testid="webhook-fires-dialog"
    >
      <QueryState query={fires} data={fires.data ?? []} emptyText={t('webhookTriggers.firesEmpty')}>
        {(rows) => (
          <TableViewport label={t('webhookTriggers.firesTitle', { name: props.trigger.name })}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('webhookTriggers.firesColumns.stream')}</th>
                  <th>{t('webhookTriggers.firesColumns.outcome')}</th>
                  <th>{t('webhookTriggers.firesColumns.time')}</th>
                  <th aria-label={t('common.ariaActions')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id} className="data-table__row">
                    <td>
                      <code>{f.streamKey}</code>
                    </td>
                    <td>
                      <StatusChip kind={chipKind(f.outcome)} size="sm">
                        {t(`webhookTriggers.outcomes.${f.outcome}`, { defaultValue: f.outcome })}
                      </StatusChip>
                      {f.error !== null && <div className="muted">{f.error}</div>}
                    </td>
                    <td className="muted">{new Date(f.firedAt).toLocaleString()}</td>
                    <td className="data-table__actions">
                      {props.isAdmin && f.outcome === 'skipped-circuit-open' && (
                        <button
                          type="button"
                          className="btn btn--xs"
                          onClick={() =>
                            reset.mutate({ session: adminSession, input: f.streamKey })
                          }
                          data-testid={`wt-reset-${f.id}`}
                        >
                          {t('webhookTriggers.resetCircuit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </QueryState>
    </Dialog>
  )
}
