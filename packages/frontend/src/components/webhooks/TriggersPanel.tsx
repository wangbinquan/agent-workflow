// RFC-257 UI 修订 — 触发器面板（/webhooks 单页的 triggers tab；原独立路由
// /webhook-triggers 并入）。列表 + 新建/编辑 Dialog，全公共原语。输入映射按
// 目标 workflow 的 input kind 感知渲染（git kind = 固定「分支来自事件」，
// text = 模板输入，其余提示不可映射——保存由后端三层校验兜底）。
import {
  AGENT_LAUNCH_INPUT_MAX_LEN,
  CODE_HOST_EVENT_TYPES,
  webhookTemplateAuthorityKey,
  type Agent,
  type CodeHostEventType,
  type WebhookEndpoint,
  type WebhookInputMapping,
  type WebhookLaunchKind,
  type WebhookTrigger,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError } from '@/api/client'
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
import { useManagedLiveRegion } from '@/components/ManagedLiveRegion'
import { NoticeBanner } from '@/components/NoticeBanner'
import { OwnerLabel } from '@/components/OwnerLabel'
import { QueryState } from '@/components/QueryState'
import { RuntimeParameterPicker } from '@/components/RuntimeParameterPicker'
import { buildRuntimeParameterCatalog } from '@/components/runtime-parameters/catalog'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { Stepper } from '@/components/Stepper'
import { TableViewport } from '@/components/TableViewport'
import { currentActorAtRequest, useActor, type MeResponse } from '@/hooks/useActor'
import { useUserLookup } from '@/hooks/useUserLookup'
import {
  agentTargetPayloadHasContent,
  repairWebhookAgentPayload,
  resolveWebhookAgentShape,
  webhookAgentShapeError,
  type AgentTargetPayloadDraft,
} from './webhookAgentAuthoring'
import {
  acceptWebhookAgentResolution,
  applyWebhookAgentPending,
  initialWebhookAgentResolution,
  startWebhookAgentResolution,
  type WebhookAgentResolutionResult,
} from './webhookAgentResolution'
import { WebhookDraftHistory } from './webhookDraftHistory'

type RepoScopeKind = 'all' | 'prefix' | 'exact'
type ExecutionSpace = 'event-repo' | 'scratch'

interface TriggerRequest<T> {
  session: number
  input: T
}

type TriggerWritePermission =
  | 'webhook-triggers:create'
  | 'webhook-triggers:update'
  | 'webhook-triggers:delete'

function canCreateTrigger(actor: MeResponse | null | undefined): boolean {
  return (
    actor?.user.role === 'admin' || actor?.permissions.includes('webhook-triggers:create') === true
  )
}

function canWriteTrigger(
  actor: MeResponse | null | undefined,
  ownerUserId: string,
  permission: Exclude<TriggerWritePermission, 'webhook-triggers:create'>,
): boolean {
  return (
    actor?.user.role === 'admin' ||
    (actor?.user.id === ownerUserId && actor.permissions.includes(permission))
  )
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
  /** null 只用于尚未创建的新规则；编辑时用于锁定 owner 写边界。 */
  ownerUserId: string | null
  name: string
  endpointId: string
  enabled: boolean
  scopeKind: RepoScopeKind
  scopePrefix: string
  scopePaths: string[]
  eventTypes: CodeHostEventType[]
  cancelOnMrTerminal: boolean
  branchFilter: string
  commandPrefix: string
  ignoreUsernames: string[]
  launchKind: WebhookLaunchKind
  launchRefId: string
  space: ExecutionSpace
  /** workflow 面：inputKey → 映射；agent/workgroup 面用下面两个字段。 */
  inputMappings: Record<string, WebhookInputMapping>
  description: string
  agentInputs: Record<string, string>
  agentDescriptionPresent: boolean
  agentInputsPresent: boolean
  agentPayloadMode: 'opaque' | 'zero' | 'ported'
  goal: string
  workingBranch: string
  /**
   * 行里 launch payload 的原样副本。UI 只拥有它真正渲染的那几个键（见
   * `payloadOf`），其余合法字段必须原样带回——否则在界面上改个名字保存，就会
   * 把只能经 API 设置的键（agent 端口 `inputs`、`allowClarify`、`maxDurationMs`
   * / `maxTotalTokens`、事件仓的 `workingBranch` / `autoCommitPush`）静默删掉。
   */
  payloadBase: Record<string, unknown>
  maxConsecutiveFires: number
  autoRegisterRepos: boolean
}

const EMPTY_DRAFT: Draft = {
  id: null,
  ownerUserId: null,
  name: '',
  endpointId: '',
  enabled: true,
  scopeKind: 'prefix',
  scopePrefix: '',
  scopePaths: [],
  eventTypes: ['mr_opened', 'mr_updated'],
  cancelOnMrTerminal: false,
  branchFilter: '',
  commandPrefix: '',
  ignoreUsernames: [],
  launchKind: 'workflow',
  launchRefId: '',
  space: 'event-repo',
  inputMappings: {},
  description: '',
  agentInputs: {},
  agentDescriptionPresent: false,
  agentInputsPresent: false,
  agentPayloadMode: 'opaque',
  goal: '',
  workingBranch: '',
  payloadBase: {},
  maxConsecutiveFires: 3,
  autoRegisterRepos: true,
}

function draftEqual(left: Draft, right: Draft): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isEphemeralHistoryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-runtime-parameter-popover], .select__listbox--portal') !== null
  )
}

function webhookDraftTextTargetKey(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return null
  const panel = target.closest('.webhook-trigger-dialog')
  if (panel === null || target.disabled) return null
  if (target instanceof HTMLInputElement) {
    const excluded = new Set([
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ])
    if (excluded.has(target.type)) return null
  }
  const stable =
    target.dataset.testid ??
    target.id ??
    target.getAttribute('aria-label') ??
    target.getAttribute('name')
  if (stable !== null && stable !== '') return stable
  const controls = Array.from(panel.querySelectorAll('input, textarea'))
  return `draft-control:${controls.indexOf(target)}`
}

function isAgentDraftTarget(field: string | null): boolean {
  return field === 'wt-description' || field?.startsWith('wt-agent-input-') === true
}

class WebhookAgentDetailRequestError extends Error {
  readonly result: Extract<
    WebhookAgentResolutionResult<Agent>,
    { kind: 'query-error' | 'target-missing' }
  >
  readonly original: unknown

  constructor(
    result: Extract<
      WebhookAgentResolutionResult<Agent>,
      { kind: 'query-error' | 'target-missing' }
    >,
    original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original))
    this.name = 'WebhookAgentDetailRequestError'
    this.result = result
    this.original = original
  }
}

function draftFromRow(row: WebhookTrigger): Draft {
  const scope = row.repoScope
  const payload = (row.launchPayload ?? {}) as {
    inputs?: Record<string, WebhookInputMapping> | Record<string, string>
    description?: string
    goal?: string
    scratch?: true
  }
  const payloadBase = { ...((row.launchPayload ?? {}) as Record<string, unknown>) }
  const agentDescriptionPresent =
    row.launchKind === 'agent' && typeof payloadBase.description === 'string'
  const agentInputsPresent =
    row.launchKind === 'agent' &&
    payloadBase.inputs !== null &&
    typeof payloadBase.inputs === 'object' &&
    !Array.isArray(payloadBase.inputs)
  const agentInputs: Record<string, string> = {}
  if (agentInputsPresent) {
    for (const [key, value] of Object.entries(payloadBase.inputs as Record<string, unknown>)) {
      if (typeof value === 'string') agentInputs[key] = value
    }
  }
  if (row.launchKind === 'agent') {
    delete payloadBase.description
    delete payloadBase.inputs
  }
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    endpointId: row.endpointId,
    enabled: row.enabled,
    scopeKind: scope?.kind ?? 'all',
    scopePrefix: scope?.kind === 'prefix' ? scope.prefix : '',
    scopePaths: scope?.kind === 'exact' ? scope.paths : [],
    eventTypes: row.eventTypes ?? [],
    cancelOnMrTerminal: row.cancelOnMrTerminal ?? false,
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
    agentInputs,
    agentDescriptionPresent,
    agentInputsPresent,
    agentPayloadMode: 'opaque',
    goal: row.launchKind === 'workgroup' ? (payload.goal ?? '') : '',
    workingBranch:
      typeof (row.launchPayload as Record<string, unknown> | null)?.workingBranch === 'string'
        ? ((row.launchPayload as Record<string, unknown>).workingBranch as string)
        : '',
    payloadBase,
    maxConsecutiveFires: row.maxConsecutiveFires,
    autoRegisterRepos: row.autoRegisterRepos,
  }
}

/** scratch 与远端专属选项互斥（shared `scratch-remote-only-option`）——切空间时显式删除。 */
const SCRATCH_FORBIDDEN_KEYS = ['workingBranch', 'autoCommitPush'] as const

/**
 * 序列化只覆盖 UI 真正拥有的键，其余从 `payloadBase` 原样带回。
 * 早期实现是「按 kind 重新拼一个 payload」，于是只要在界面上保存一次，凡是
 * UI 不渲染的合法字段（agent 端口 `inputs` / `allowClarify` / 资源上限）就会被
 * 后端整体覆盖掉——RFC-268 实现门 P1（2026-08-09）实证，归属 RFC-257。
 */
function payloadOf(draft: Draft): unknown {
  const payload: Record<string, unknown> = { ...draft.payloadBase }
  if (draft.launchKind === 'workflow') {
    payload.inputs = draft.inputMappings
  } else if (draft.launchKind === 'agent') {
    if (draft.agentPayloadMode === 'zero') {
      delete payload.inputs
      payload.description = draft.description
    } else if (draft.agentPayloadMode === 'ported') {
      delete payload.description
      payload.inputs = draft.agentInputs
    } else {
      if (draft.agentDescriptionPresent) payload.description = draft.description
      else delete payload.description
      if (draft.agentInputsPresent) payload.inputs = draft.agentInputs
      else delete payload.inputs
    }
  } else {
    payload.goal = draft.goal
  }
  if (draft.space === 'scratch') {
    payload.scratch = true
    for (const key of SCRATCH_FORBIDDEN_KEYS) delete payload[key]
  } else {
    delete payload.scratch
    if (draft.workingBranch.trim() === '') delete payload.workingBranch
    else payload.workingBranch = draft.workingBranch
  }
  return payload
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
    cancelOnMrTerminal: draft.cancelOnMrTerminal,
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
type AgentRow = Pick<Agent, 'id' | 'name'>
type WorkgroupRow = { id: string; name: string }

/** RFC-283：admin 全局管理，manager 只管理自己的规则，其余规则只读。 */
export function TriggersPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actorQuery = useActor()
  const actor =
    actorQuery.status === 'success' && actorQuery.fetchStatus === 'idle'
      ? actorQuery.data
      : undefined
  const canCreate = canCreateTrigger(actor)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [firesFor, setFiresFor] = useState<WebhookTrigger | null>(null)
  const writeSessionRef = useRef(0)
  const previousCanCreateRef = useRef(canCreate)
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
  const requestIsCurrent = (
    session: number,
    permission: TriggerWritePermission,
    ownerUserId?: string,
  ): boolean => {
    if (session !== writeSessionRef.current) return false
    const requestActor = currentActorAtRequest(qc)
    if (permission === 'webhook-triggers:create') return canCreateTrigger(requestActor)
    return ownerUserId !== undefined && canWriteTrigger(requestActor, ownerUserId, permission)
  }

  const save = useMutation({
    mutationFn: ({ input: d, session }: TriggerRequest<Draft>) => {
      const permission = d.id === null ? 'webhook-triggers:create' : 'webhook-triggers:update'
      if (!requestIsCurrent(session, permission, d.ownerUserId ?? undefined)) {
        throw new Error('Webhook trigger write access ended')
      }
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
      const permission =
        request.input.id === null ? 'webhook-triggers:create' : 'webhook-triggers:update'
      if (!requestIsCurrent(request.session, permission, request.input.ownerUserId ?? undefined)) {
        return
      }
      setError(null)
      setDraft(null)
      invalidate()
    },
    onError: (nextError, request) => {
      const permission =
        request.input.id === null ? 'webhook-triggers:create' : 'webhook-triggers:update'
      if (requestIsCurrent(request.session, permission, request.input.ownerUserId ?? undefined)) {
        setError(nextError)
      }
    },
  })
  const toggle = useMutation({
    mutationFn: ({
      input,
      session,
    }: TriggerRequest<{ id: string; ownerUserId: string; enabled: boolean }>) => {
      if (!requestIsCurrent(session, 'webhook-triggers:update', input.ownerUserId)) {
        throw new Error('Webhook trigger write access ended')
      }
      return api.put<WebhookTrigger>(`/api/webhook-triggers/${encodeURIComponent(input.id)}`, {
        enabled: input.enabled,
      })
    },
    onSuccess: (_saved, request) => {
      if (requestIsCurrent(request.session, 'webhook-triggers:update', request.input.ownerUserId)) {
        invalidate()
      }
    },
    onError: (nextError, request) => {
      if (requestIsCurrent(request.session, 'webhook-triggers:update', request.input.ownerUserId)) {
        setError(nextError)
      }
    },
  })
  const remove = useMutation({
    mutationFn: ({ input, session }: TriggerRequest<{ id: string; ownerUserId: string }>) => {
      if (!requestIsCurrent(session, 'webhook-triggers:delete', input.ownerUserId)) {
        throw new Error('Webhook trigger write access ended')
      }
      return api.delete(`/api/webhook-triggers/${encodeURIComponent(input.id)}`)
    },
    onSuccess: (_deleted, request) => {
      if (
        !requestIsCurrent(request.session, 'webhook-triggers:delete', request.input.ownerUserId)
      ) {
        return
      }
      setError(null)
      invalidate()
    },
    onError: (nextError, request) => {
      if (requestIsCurrent(request.session, 'webhook-triggers:delete', request.input.ownerUserId)) {
        setError(nextError)
      }
    },
  })
  resetMutationsRef.current = () => {
    save.reset()
    toggle.reset()
    remove.reset()
  }

  useLayoutEffect(() => {
    const lostWriteAccess = previousCanCreateRef.current && !canCreate
    previousCanCreateRef.current = canCreate
    if (!canCreate) {
      if (lostWriteAccess) writeSessionRef.current += 1
      setDraft(null)
      setError(null)
      resetMutationsRef.current()
    }
  }, [canCreate])

  const writeSession = writeSessionRef.current

  const rows = triggers.data ?? []
  const owners = useUserLookup(rows.map((row) => row.ownerUserId))
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
        if (!requestIsCurrent(writeSession, 'webhook-triggers:create')) return
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
        {canCreate && !isInitialEmpty && newAction}
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
            canCreate
              ? t('webhookTriggers.emptyDescription')
              : t('webhookTriggers.emptyReadonlyDescription')
          }
          action={canCreate ? newAction : undefined}
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
            const isOwn = actor?.user.id === row.ownerUserId
            const canUpdate = canWriteTrigger(actor, row.ownerUserId, 'webhook-triggers:update')
            const canDelete = canWriteTrigger(actor, row.ownerUserId, 'webhook-triggers:delete')
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
                    {canUpdate ? (
                      <Switch
                        checked={row.enabled}
                        onChange={(enabled) =>
                          toggle.mutate({
                            session: writeSession,
                            input: { id: row.id, ownerUserId: row.ownerUserId, enabled },
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
                      {(canUpdate || canDelete) && (
                        <>
                          {canUpdate && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => {
                                if (
                                  !requestIsCurrent(
                                    writeSession,
                                    'webhook-triggers:update',
                                    row.ownerUserId,
                                  )
                                ) {
                                  return
                                }
                                setError(null)
                                save.reset()
                                setDraft(draftFromRow(row))
                              }}
                              data-testid={`webhook-trigger-edit-${row.id}`}
                            >
                              {t('common.edit')}
                            </button>
                          )}
                          {canDelete && (
                            <ConfirmButton
                              label={t('common.delete')}
                              confirmLabel={t('webhookTriggers.deleteConfirm')}
                              variant="danger"
                              size="sm"
                              confirmationKey={row.id}
                              onConfirm={() =>
                                remove.mutateAsync({
                                  session: writeSession,
                                  input: { id: row.id, ownerUserId: row.ownerUserId },
                                })
                              }
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                }
                data-testid={`webhook-trigger-${row.id}`}
              >
                <dl className="webhook-facts">
                  <div data-testid={`webhook-trigger-owner-${row.id}`}>
                    <dt>{t('webhookTriggers.ownerLabel')}</dt>
                    <dd>
                      <OwnerLabel
                        ownerUserId={row.ownerUserId}
                        owner={owners.get(row.ownerUserId) ?? null}
                        wrap
                      />
                      {isOwn && (
                        <StatusChip kind="info" size="sm">
                          {t('webhookTriggers.ownedByMe')}
                        </StatusChip>
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="webhook-trigger__flow" aria-label={t('webhookTriggers.flowAria')}>
                  <div role="group" aria-label={t('webhookTriggers.flow.scope')}>
                    <span>{t('webhookTriggers.flow.scope')}</span>
                    <strong>{scope}</strong>
                  </div>
                  <span className="webhook-trigger__flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <div role="group" aria-label={t('webhookTriggers.flow.events')}>
                    <span>{t('webhookTriggers.flow.events')}</span>
                    <strong>
                      {t('webhookTriggers.eventCount', { count: row.eventTypes?.length ?? 0 })}
                    </strong>
                    <div className="webhook-trigger__chips">
                      {(row.eventTypes ?? []).map((eventType) => (
                        <StatusChip key={eventType} kind="neutral" size="sm">
                          {t(`webhookTriggers.events.${eventType}`)}
                        </StatusChip>
                      ))}
                      {row.cancelOnMrTerminal && (
                        <StatusChip kind="info" size="sm">
                          {t('webhookTriggers.terminalProtectionChip')}
                        </StatusChip>
                      )}
                    </div>
                  </div>
                  <span className="webhook-trigger__flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <div role="group" aria-label={t('webhookTriggers.flow.target')}>
                    <span>{t('webhookTriggers.flow.target')}</span>
                    <strong>{target}</strong>
                    <div className="webhook-trigger__chips">
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
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {draft !== null &&
        (draft.id === null
          ? canCreate
          : draft.ownerUserId !== null &&
            canWriteTrigger(actor, draft.ownerUserId, 'webhook-triggers:update')) && (
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
            onSave={() => save.mutate({ session: writeSession, input: draft })}
          />
        )}
      {firesFor !== null && (
        <FiresDialog
          trigger={firesFor}
          canReset={canWriteTrigger(actor, firesFor.ownerUserId, 'webhook-triggers:update')}
          onClose={() => setFiresFor(null)}
        />
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
  const onChange = props.onChange
  const liveRegion = useManagedLiveRegion()
  const historyRef = useRef<WebhookDraftHistory<Draft> | null>(null)
  historyRef.current ??= new WebhookDraftHistory(props.draft, draftEqual)
  const history = historyRef.current
  const draft = history.current
  const isNew = draft.id === null
  const [step, setStep] = useState(0)
  const [maxReachable, setMaxReachable] = useState(isNew ? 0 : 3)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [pendingAgentTargetId, setPendingAgentTargetId] = useState<string | null>(null)
  const [initialDraft] = useState(() => JSON.stringify(draft))
  const [, refreshHistoryControls] = useReducer((version: number) => version + 1, 0)
  const draftRevisionRef = useRef(0)
  const composingDraftRef = useRef(false)
  const agentTargetEditingRef = useRef(false)
  const agentRequestGenerationRef = useRef(0)
  const [agentResolution, setAgentResolution] = useState(() =>
    initialWebhookAgentResolution<Agent>(),
  )
  const agentResolutionRef = useRef(agentResolution)
  agentResolutionRef.current = agentResolution
  const publishDraft = useCallback(
    (next: Draft) => {
      draftRevisionRef.current += 1
      onChange(next)
      refreshHistoryControls()
    },
    [onChange],
  )
  const set = (patch: Partial<Draft>) => {
    const next = { ...history.current, ...patch }
    const field = webhookDraftTextTargetKey(document.activeElement)
    const changed = history.apply(
      next,
      field === null ? { kind: 'atomic' } : { kind: 'typing', field },
    )
    if (changed) publishDraft(history.current)
  }
  const setDerived = useCallback(
    (patch: Partial<Draft>) => {
      if (history.replaceCurrent({ ...history.current, ...patch })) publishDraft(history.current)
    },
    [history, publishDraft],
  )
  const commitTyping = (field?: string) => {
    if (history.commitTyping(field)) refreshHistoryControls()
  }
  const undo = () => {
    const previous = history.undo()
    if (previous !== null) publishDraft(previous)
  }
  const redo = () => {
    const next = history.redo()
    if (next !== null) publishDraft(next)
  }
  const blockCompositionHistory = () => {
    const message = t('webhookTriggers.historyCompositionBlocked')
    liveRegion?.announce(message)
  }
  const handleHistoryShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    const key = event.key.toLocaleLowerCase()
    if (key !== 'z' && key !== 'y') return
    if (isEphemeralHistoryTarget(event.target)) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (composingDraftRef.current || event.nativeEvent.isComposing) {
      blockCompositionHistory()
      return
    }
    if (key === 'y' || event.shiftKey) redo()
    else undo()
  }
  const handleHistoryBeforeInput = (event: ReactFormEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as InputEvent
    if (native.inputType !== 'historyUndo' && native.inputType !== 'historyRedo') return
    if (isEphemeralHistoryTarget(event.target)) {
      event.stopPropagation()
      return
    }
    if (webhookDraftTextTargetKey(event.target) === null) return
    event.preventDefault()
    event.stopPropagation()
    if (composingDraftRef.current || native.isComposing) {
      blockCompositionHistory()
      return
    }
    if (native.inputType === 'historyRedo') redo()
    else undo()
  }
  const handleDraftBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const field = webhookDraftTextTargetKey(event.target)
    if (field !== null) commitTyping(field)
    if (isAgentDraftTarget(field)) {
      agentTargetEditingRef.current = false
      if (
        event.relatedTarget instanceof Element &&
        event.relatedTarget.closest('[data-testid="wt-agent-apply-definition"]') !== null
      ) {
        return
      }
      const captured = agentResolutionRef.current.pending?.identity
      if (captured !== undefined) {
        setAgentResolution((state) => applyWebhookAgentPending(state, captured))
      }
    }
  }

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
  const agentDetail = useQuery<WebhookAgentResolutionResult<Agent>, WebhookAgentDetailRequestError>(
    {
      queryKey: ['agents', 'detail', draft.launchRefId],
      queryFn: async ({ signal }) => {
        const agentId = draft.launchRefId
        const requestGeneration = ++agentRequestGenerationRef.current
        setAgentResolution((state) =>
          startWebhookAgentResolution(state, agentId, requestGeneration),
        )
        try {
          const agent = await api.get<Agent>(
            `/api/agents/${encodeURIComponent(agentId)}`,
            undefined,
            signal,
          )
          const shape = resolveWebhookAgentShape(agent, {
            description: '',
            descriptionPresent: false,
            inputs: {},
            inputsPresent: false,
          })
          return {
            kind: 'resolved',
            agentId,
            requestGeneration,
            detailRevision: agent.updatedAt,
            structureSignature: `${shape.kind}:${shape.signature}`,
            value: agent,
          }
        } catch (error) {
          const kind =
            error instanceof ApiError && error.status === 404 ? 'target-missing' : 'query-error'
          const result = {
            kind,
            agentId,
            requestGeneration,
            structureSignature: kind,
            error,
          } satisfies Extract<
            WebhookAgentResolutionResult<Agent>,
            { kind: 'query-error' | 'target-missing' }
          >
          throw new WebhookAgentDetailRequestError(result, error)
        }
      },
      enabled: draft.launchKind === 'agent' && draft.launchRefId !== '',
    },
  )
  const agentDetailData = agentDetail.data
  const agentDetailError = agentDetail.error
  const agentDetailFetching = agentDetail.isFetching
  const refetchAgentDetail = agentDetail.refetch
  const webhookCatalog = useMemo(
    () =>
      buildRuntimeParameterCatalog({
        audience: 'webhook-launch',
        surface: 'webhook-launch',
        eventTypes: draft.eventTypes,
        t,
      }),
    [draft.eventTypes, t],
  )
  const webhookCatalogEmptyMessage =
    draft.eventTypes.length === 0 ? t('runtimeParameters.selectEventsFirst') : undefined

  const goalRef = useRef<HTMLTextAreaElement | null>(null)
  const workingBranchRef = useRef<HTMLInputElement | null>(null)
  const mappingInputRefs = useRef(new Map<string, HTMLInputElement>())
  const agentInputRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const agentDescriptionRef = useRef<HTMLTextAreaElement | null>(null)
  const agentDraft = useMemo<AgentTargetPayloadDraft>(
    () => ({
      description: draft.description,
      descriptionPresent: draft.agentDescriptionPresent,
      inputs: draft.agentInputs,
      inputsPresent: draft.agentInputsPresent,
    }),
    [draft.agentDescriptionPresent, draft.agentInputs, draft.agentInputsPresent, draft.description],
  )
  const agentDraftsRef = useRef(new Map<string, AgentTargetPayloadDraft>())
  const initialAgentPayloadRef = useRef({
    targetId: draft.launchKind === 'agent' ? draft.launchRefId : '',
    value: JSON.stringify(agentDraft),
  })
  const acceptedAgentResult =
    agentResolution.targetId === draft.launchRefId ? agentResolution.current : null
  const acceptedAgent = acceptedAgentResult?.kind === 'resolved' ? acceptedAgentResult.value : null
  const acceptedAgentRevision =
    acceptedAgentResult?.kind === 'resolved' ? acceptedAgentResult.detailRevision : 0
  const agentResolutionError =
    acceptedAgentResult !== null && acceptedAgentResult.kind !== 'resolved'
      ? acceptedAgentResult.error
      : null
  const resolvedAgentShape = useMemo(
    () =>
      draft.launchKind === 'agent' && acceptedAgent?.id === draft.launchRefId
        ? resolveWebhookAgentShape(acceptedAgent, agentDraft)
        : null,
    [acceptedAgent, agentDraft, draft.launchKind, draft.launchRefId],
  )
  const agentDefinitionBusy =
    agentDetailFetching || agentResolution.refreshing || agentResolution.pending !== null
  const agentShapeIssue =
    resolvedAgentShape === null ? null : webhookAgentShapeError(resolvedAgentShape, agentDraft)
  const opaqueAgentPayloadUnchanged =
    initialAgentPayloadRef.current.targetId === draft.launchRefId &&
    initialAgentPayloadRef.current.value === JSON.stringify(agentDraft)

  const lastAcceptedAgentResultRef = useRef('')
  useEffect(() => {
    const result = agentDetailData ?? agentDetailError?.result
    if (result === undefined) return
    const identity = [
      result.agentId,
      result.requestGeneration,
      result.kind,
      result.detailRevision ?? '',
      result.structureSignature,
    ].join(':')
    if (identity === lastAcceptedAgentResultRef.current) return
    lastAcceptedAgentResultRef.current = identity
    const deferStructureChange = agentTargetEditingRef.current
    setAgentResolution((state) => acceptWebhookAgentResolution(state, result, deferStructureChange))
  }, [agentDetailData, agentDetailError])

  useEffect(() => {
    if (
      draft.launchKind !== 'agent' ||
      !(props.saveError instanceof ApiError) ||
      (props.saveError.status !== 404 && props.saveError.status !== 422)
    ) {
      return
    }
    void refetchAgentDetail()
  }, [draft.launchKind, props.saveError, refetchAgentDetail])

  useEffect(() => {
    if (draft.launchKind !== 'agent') return
    if (resolvedAgentShape !== null) {
      if (draft.agentPayloadMode !== resolvedAgentShape.kind) {
        setDerived({ agentPayloadMode: resolvedAgentShape.kind })
      }
      return
    }
    if (agentResolutionError != null && draft.agentPayloadMode !== 'opaque') {
      setDerived({ agentPayloadMode: 'opaque' })
    }
  }, [
    agentResolutionError,
    draft.agentPayloadMode,
    draft.launchKind,
    resolvedAgentShape,
    setDerived,
  ])

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
  const applyTargetChange = (launchRefId: string) => {
    if (draft.launchKind !== 'agent') {
      set({ launchRefId, inputMappings: {} })
      return
    }
    if (draft.launchRefId !== '') agentDraftsRef.current.set(draft.launchRefId, agentDraft)
    const restored = agentDraftsRef.current.get(launchRefId) ?? {
      description: '',
      descriptionPresent: false,
      inputs: {},
      inputsPresent: false,
    }
    set({
      launchRefId,
      inputMappings: {},
      description: restored.description,
      agentDescriptionPresent: restored.descriptionPresent,
      agentInputs: { ...restored.inputs },
      agentInputsPresent: restored.inputsPresent,
      agentPayloadMode: 'opaque',
    })
  }
  const requestTargetChange = (launchRefId: string) => {
    if (
      draft.launchKind === 'agent' &&
      launchRefId !== draft.launchRefId &&
      draft.launchRefId !== '' &&
      agentTargetPayloadHasContent(agentDraft)
    ) {
      setPendingAgentTargetId(launchRefId)
      return
    }
    applyTargetChange(launchRefId)
  }

  const scopeValid =
    (draft.scopeKind !== 'prefix' || draft.scopePrefix.trim() !== '') &&
    (draft.scopeKind !== 'exact' || draft.scopePaths.length > 0)
  const identityValid = draft.name.trim() !== '' && draft.endpointId !== '' && scopeValid
  const terminalProtectionValid =
    !draft.cancelOnMrTerminal ||
    (draft.eventTypes.includes('mr_opened') &&
      !draft.eventTypes.includes('mr_closed') &&
      !draft.eventTypes.includes('mr_merged'))
  const conditionsValid = draft.eventTypes.length > 0 && terminalProtectionValid
  const requiredWorkflowInputsMapped =
    draft.launchKind !== 'workflow' ||
    workflowInputs.every(
      (input) => input.required !== true || draft.inputMappings[input.key] !== undefined,
    )
  const agentTargetValid =
    draft.launchKind !== 'agent' ||
    (draft.launchRefId !== '' &&
      (resolvedAgentShape !== null
        ? agentShapeIssue === null && !agentDefinitionBusy
        : agentResolutionError != null && opaqueAgentPayloadUnchanged && !agentDefinitionBusy))
  const targetValid =
    draft.launchRefId !== '' &&
    requiredWorkflowInputsMapped &&
    (draft.launchKind !== 'workgroup' || draft.goal.trim() !== '') &&
    agentTargetValid
  const protectionValid =
    Number.isInteger(draft.maxConsecutiveFires) &&
    draft.maxConsecutiveFires >= 1 &&
    draft.maxConsecutiveFires <= 100
  const canSave =
    draft.name.trim() !== '' &&
    draft.endpointId !== '' &&
    draft.launchRefId !== '' &&
    draft.eventTypes.length > 0 &&
    terminalProtectionValid &&
    scopeValid &&
    targetValid &&
    protectionValid
  const commonOnlyAgentSave =
    draft.launchKind === 'agent' &&
    resolvedAgentShape === null &&
    agentResolutionError !== null &&
    opaqueAgentPayloadUnchanged &&
    !agentDefinitionBusy
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

        <div
          className="webhook-trigger-history"
          role="group"
          aria-label={t('webhookTriggers.historyActions')}
        >
          <button
            type="button"
            className="btn btn--xs btn--ghost"
            disabled={!history.canUndo || props.saving}
            onClick={undo}
            data-testid="webhook-trigger-undo"
          >
            {t('webhookTriggers.undo')}
          </button>
          <button
            type="button"
            className="btn btn--xs btn--ghost"
            disabled={!history.canRedo || props.saving}
            onClick={redo}
            data-testid="webhook-trigger-redo"
          >
            {t('webhookTriggers.redo')}
          </button>
        </div>

        <div
          onKeyDownCapture={handleHistoryShortcut}
          onBeforeInputCapture={handleHistoryBeforeInput}
          onBlurCapture={handleDraftBlur}
          onFocusCapture={(event) => {
            agentTargetEditingRef.current = isAgentDraftTarget(
              webhookDraftTextTargetKey(event.target),
            )
          }}
          onCompositionStartCapture={(event) => {
            if (webhookDraftTextTargetKey(event.target) !== null) composingDraftRef.current = true
          }}
          onCompositionEndCapture={(event) => {
            if (webhookDraftTextTargetKey(event.target) !== null) composingDraftRef.current = false
          }}
        >
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
            navigationDisabled={props.saving}
            nextEnabled={stepValidity[step]}
            rootTestid="webhook-trigger-stepper"
            finalActions={
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={props.saving}
                  onClick={requestClose}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!canSave || props.saving}
                  aria-describedby={commonOnlyAgentSave ? 'wt-agent-opaque-guidance' : undefined}
                  onClick={() => {
                    commitTyping()
                    props.onSave()
                  }}
                  data-testid="webhook-trigger-save"
                >
                  {props.saving
                    ? t('common.saving')
                    : commonOnlyAgentSave
                      ? t('webhookTriggers.commonOnlySaveAction')
                      : t('webhookTriggers.saveAction')}
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
                      disabled={props.saving}
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
                      disabled={!isNew || props.saving}
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
                    disabled={props.saving}
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
                      disabled={props.saving}
                      placeholder="platform/"
                      data-testid="wt-scope-prefix"
                    />
                  )}
                  {draft.scopeKind === 'exact' && (
                    <ChipsInput
                      value={draft.scopePaths}
                      onChange={(scopePaths) => set({ scopePaths })}
                      disabled={props.saving}
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
                        disabled={props.saving}
                        label={t(`webhookTriggers.events.${eventType}`)}
                        data-testid={`wt-event-${eventType}`}
                      />
                    ))}
                  </div>
                </Field>
                <Field
                  label={t('webhookTriggers.fields.cancelOnMrTerminal')}
                  hint={t('webhookTriggers.fields.cancelOnMrTerminalHint')}
                  group
                >
                  <Switch
                    checked={draft.cancelOnMrTerminal}
                    onChange={(cancelOnMrTerminal) => set({ cancelOnMrTerminal })}
                    disabled={props.saving}
                    label={t('webhookTriggers.fields.cancelOnMrTerminalLabel')}
                    data-testid="wt-cancel-on-mr-terminal"
                  />
                </Field>
                {!terminalProtectionValid && (
                  <NoticeBanner tone="warning" size="compact" testid="wt-terminal-policy-error">
                    {t('webhookTriggers.fields.cancelOnMrTerminalError')}
                  </NoticeBanner>
                )}
                <div className="form-grid--cols-2">
                  <Field
                    label={t('webhookTriggers.fields.branchFilter')}
                    hint={t('webhookTriggers.fields.branchFilterHint')}
                  >
                    <TextInput
                      value={draft.branchFilter}
                      onChange={(branchFilter) => set({ branchFilter })}
                      disabled={props.saving}
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
                        disabled={props.saving}
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
                    disabled={props.saving}
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
                      isNew
                        ? set({
                            launchKind,
                            launchRefId: '',
                            inputMappings: {},
                            description: '',
                            agentInputs: {},
                            agentDescriptionPresent: false,
                            agentInputsPresent: false,
                            agentPayloadMode: 'opaque',
                          })
                        : undefined
                    }
                    disabled={!isNew || props.saving}
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
                    onChange={requestTargetChange}
                    disabled={props.saving}
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
                    disabled={props.saving}
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
                {draft.space === 'event-repo' && (
                  <Field
                    label={t('launch.workingBranch.label')}
                    hint={t('webhookTriggers.fields.workingBranchTemplateHint')}
                    action={
                      <RuntimeParameterPicker
                        authority={webhookTemplateAuthorityKey(draft.launchKind, 'working-branch')}
                        entries={webhookCatalog}
                        emptyMessage={webhookCatalogEmptyMessage}
                        disabled={props.saving}
                        testId="wt-working-branch-parameter"
                        target={{
                          id: 'webhook:workingBranch',
                          label: t('launch.workingBranch.label'),
                          mode: 'insert-at-caret',
                          value: draft.workingBranch,
                          revision: `${draftRevisionRef.current}:workingBranch`,
                          element: () => workingBranchRef.current,
                          commit: (workingBranch) => set({ workingBranch }),
                        }}
                      />
                    }
                    group
                  >
                    <TextInput
                      value={draft.workingBranch}
                      onChange={(workingBranch) => set({ workingBranch })}
                      placeholder={t('launch.workingBranch.placeholder')}
                      inputRef={workingBranchRef}
                      disabled={props.saving}
                      data-testid="wt-working-branch"
                    />
                  </Field>
                )}

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
                              action={
                                input.kind === 'text' ? (
                                  <RuntimeParameterPicker
                                    authority="webhook:workflow:workflow-input-text"
                                    entries={webhookCatalog}
                                    emptyMessage={webhookCatalogEmptyMessage}
                                    disabled={props.saving}
                                    testId={`wt-map-${input.key}-parameter`}
                                    target={{
                                      id: `webhook:workflow-input:${input.key}`,
                                      label: input.key,
                                      mode: 'insert-at-caret',
                                      value: mapping?.kind === 'template' ? mapping.template : '',
                                      revision: `${draftRevisionRef.current}:mapping:${input.key}`,
                                      element: () =>
                                        mappingInputRefs.current.get(input.key) ?? null,
                                      commit: (template) =>
                                        setMapping(
                                          template === '' ? null : { kind: 'template', template },
                                        ),
                                    }}
                                  />
                                ) : undefined
                              }
                              group={input.kind === 'text'}
                            >
                              {input.kind === 'git' ? (
                                <Checkbox
                                  checked={mapping?.kind === 'event-branch'}
                                  onChange={(checked) =>
                                    setMapping(checked ? { kind: 'event-branch' } : null)
                                  }
                                  disabled={props.saving}
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
                                  inputRef={(el) => {
                                    if (el === null) mappingInputRefs.current.delete(input.key)
                                    else mappingInputRefs.current.set(input.key, el)
                                  }}
                                  disabled={props.saving}
                                  placeholder={t('webhookTriggers.fields.templatePlaceholder')}
                                  data-testid={`wt-map-${input.key}`}
                                />
                              ) : (
                                <p className="muted">{t('webhookTriggers.fields.unmappable')}</p>
                              )}
                            </Field>
                          )
                        })}
                      </div>
                    )}
                  </Field>
                )}
                {draft.launchKind === 'agent' && (
                  <div className="form-grid" data-testid="wt-agent-parameters">
                    {draft.launchRefId === '' ? null : resolvedAgentShape === null ? (
                      agentResolutionError === null ? (
                        <LoadingState
                          size="compact"
                          label={t('webhookTriggers.fields.agentLoading')}
                        />
                      ) : (
                        <>
                          <ErrorBanner
                            error={agentResolutionError}
                            onRetry={props.saving ? undefined : () => void agentDetail.refetch()}
                            retryLabel={t('webhookTriggers.fields.retryAgent')}
                            retryAriaLabel={t('webhookTriggers.fields.retryAgent')}
                          />
                          <NoticeBanner
                            tone="warning"
                            size="compact"
                            title={t('webhookTriggers.fields.agentUnavailableTitle')}
                            testid="wt-agent-opaque"
                          >
                            <div id="wt-agent-opaque-guidance">
                              <p>
                                {t('webhookTriggers.fields.agentUnavailableBody', {
                                  name: selectedTarget ?? draft.launchRefId,
                                  id: draft.launchRefId,
                                })}
                              </p>
                              <p>
                                {t('webhookTriggers.fields.agentOpaqueSummary', {
                                  description: draft.agentDescriptionPresent
                                    ? String(draft.description.length)
                                    : 'none',
                                  inputs: draft.agentInputsPresent
                                    ? Object.keys(draft.agentInputs).join(', ') || 'empty'
                                    : 'none',
                                })}
                              </p>
                              <p>{t('webhookTriggers.fields.agentCommonOnly')}</p>
                            </div>
                          </NoticeBanner>
                        </>
                      )
                    ) : (
                      <>
                        {agentResolution.pending !== null ? (
                          <NoticeBanner
                            tone="warning"
                            size="compact"
                            title={t('webhookTriggers.fields.agentDefinitionChangedTitle')}
                            testid="wt-agent-pending-reconcile"
                            action={
                              <button
                                type="button"
                                className="btn btn--sm"
                                disabled={props.saving}
                                onClick={() => {
                                  commitTyping()
                                  const captured = agentResolutionRef.current.pending?.identity
                                  if (captured !== undefined) {
                                    setAgentResolution((state) =>
                                      applyWebhookAgentPending(state, captured),
                                    )
                                  }
                                }}
                                data-testid="wt-agent-apply-definition"
                              >
                                {t('webhookTriggers.fields.agentApplyDefinition')}
                              </button>
                            }
                          >
                            {t('webhookTriggers.fields.agentDefinitionChangedBody')}
                          </NoticeBanner>
                        ) : agentDefinitionBusy ? (
                          <NoticeBanner tone="info" size="compact" testid="wt-agent-refreshing">
                            {t('webhookTriggers.fields.agentRefreshing')}
                          </NoticeBanner>
                        ) : null}
                        {resolvedAgentShape.blockers.length > 0 && (
                          <NoticeBanner
                            tone="error"
                            size="compact"
                            title={t('webhookTriggers.fields.agentBlockersTitle')}
                            testid="wt-agent-blockers"
                          >
                            <p>{t('webhookTriggers.fields.agentBlockersBody')}</p>
                            <ul>
                              {resolvedAgentShape.blockers.map((blocker) => (
                                <li key={`${blocker.kind}:${blocker.port}`}>
                                  <code>{blocker.port}</code> · <code>{blocker.agentKind}</code> ·{' '}
                                  {blocker.kind}
                                </li>
                              ))}
                            </ul>
                          </NoticeBanner>
                        )}
                        {resolvedAgentShape.repairs.length > 0 && (
                          <NoticeBanner
                            tone="warning"
                            size="compact"
                            title={t('webhookTriggers.fields.agentRepairsTitle')}
                            testid="wt-agent-repairs"
                            action={
                              <button
                                type="button"
                                className="btn btn--sm"
                                disabled={props.saving || agentDefinitionBusy}
                                onClick={() => {
                                  const repaired = repairWebhookAgentPayload(
                                    resolvedAgentShape,
                                    agentDraft,
                                  )
                                  set({
                                    description: repaired.description,
                                    agentDescriptionPresent: repaired.descriptionPresent,
                                    agentInputs: { ...repaired.inputs },
                                    agentInputsPresent: repaired.inputsPresent,
                                    agentPayloadMode: resolvedAgentShape.kind,
                                  })
                                }}
                                data-testid="wt-agent-repair"
                              >
                                {t('webhookTriggers.fields.agentRepairAction')}
                              </button>
                            }
                          >
                            <p>{t('webhookTriggers.fields.agentRepairsBody')}</p>
                            <ul>
                              {resolvedAgentShape.repairs.map((repair, index) => (
                                <li key={`${repair.kind}:${index}`}>
                                  <code>{repair.kind}</code>
                                  {'key' in repair ? (
                                    <>
                                      {' · '}
                                      <code>{repair.key}</code>: {repair.value}
                                    </>
                                  ) : null}
                                  {'keys' in repair && repair.keys.length > 0
                                    ? ` · ${repair.keys.join(', ')}`
                                    : null}
                                </li>
                              ))}
                            </ul>
                          </NoticeBanner>
                        )}
                        {resolvedAgentShape.kind === 'zero' ? (
                          <Field
                            label={t('webhookTriggers.fields.description')}
                            hint={t('webhookTriggers.fields.agentDescriptionHint')}
                            error={
                              agentShapeIssue === 'description-required'
                                ? t('webhookTriggers.fields.agentIssueDescriptionRequired')
                                : agentShapeIssue === 'description-too-long'
                                  ? t('webhookTriggers.fields.agentIssueDescriptionTooLong')
                                  : undefined
                            }
                            required
                            action={
                              <RuntimeParameterPicker
                                authority="webhook:agent:agent-description"
                                entries={webhookCatalog}
                                emptyMessage={webhookCatalogEmptyMessage}
                                disabled={props.saving || agentDefinitionBusy}
                                testId="wt-description-parameter"
                                target={{
                                  id: `webhook:agent:${draft.launchRefId}:description`,
                                  label: t('webhookTriggers.fields.description'),
                                  mode: 'insert-at-caret',
                                  value: draft.description,
                                  revision: `${acceptedAgentRevision}:${draftRevisionRef.current}:description`,
                                  element: () => agentDescriptionRef.current,
                                  commit: (description) =>
                                    set({ description, agentDescriptionPresent: true }),
                                }}
                              />
                            }
                            group
                          >
                            <TextArea
                              value={draft.description}
                              onChange={(description) =>
                                set({ description, agentDescriptionPresent: true })
                              }
                              rows={5}
                              monospace
                              disabled={props.saving}
                              maxLength={AGENT_LAUNCH_INPUT_MAX_LEN}
                              textareaRef={agentDescriptionRef}
                              data-testid="wt-description"
                            />
                          </Field>
                        ) : (
                          <div className="form-grid" data-testid="wt-agent-inputs">
                            {agentShapeIssue === 'required-inputs' && (
                              <NoticeBanner tone="warning" size="compact">
                                {t('webhookTriggers.fields.agentIssueRequiredInputs')}
                              </NoticeBanner>
                            )}
                            {resolvedAgentShape.inputs
                              .filter((input) => input.kind === 'text')
                              .map((input) => {
                                const value = draft.agentInputs[input.key] ?? ''
                                const requiredMissing =
                                  input.required === true && value.trim() === ''
                                const hint = t(
                                  input.presentation === 'chips'
                                    ? 'webhookTriggers.fields.agentInputListHint'
                                    : 'webhookTriggers.fields.agentInputHint',
                                  {
                                    kind: input.agentKind,
                                    description: input.description ?? '',
                                  },
                                )
                                return (
                                  <Field
                                    key={input.key}
                                    label={input.label}
                                    hint={hint}
                                    error={
                                      requiredMissing
                                        ? t('webhookTriggers.fields.agentIssueRequiredInputs')
                                        : undefined
                                    }
                                    required={input.required === true}
                                    action={
                                      <RuntimeParameterPicker
                                        authority="webhook:agent:agent-input"
                                        entries={webhookCatalog}
                                        emptyMessage={webhookCatalogEmptyMessage}
                                        disabled={props.saving || agentDefinitionBusy}
                                        testId={`wt-agent-input-${input.key}-parameter`}
                                        target={{
                                          id: `webhook:agent:${draft.launchRefId}:input:${input.key}`,
                                          label: input.label,
                                          mode: 'insert-at-caret',
                                          value,
                                          revision: `${acceptedAgentRevision}:${draftRevisionRef.current}:input:${input.key}`,
                                          element: () =>
                                            agentInputRefs.current.get(input.key) ?? null,
                                          commit: (next) =>
                                            set({
                                              agentInputs: {
                                                ...draft.agentInputs,
                                                [input.key]: next,
                                              },
                                              agentInputsPresent: true,
                                            }),
                                        }}
                                      />
                                    }
                                    group
                                  >
                                    <TextArea
                                      value={value}
                                      onChange={(next) =>
                                        set({
                                          agentInputs: {
                                            ...draft.agentInputs,
                                            [input.key]: next,
                                          },
                                          agentInputsPresent: true,
                                        })
                                      }
                                      rows={input.presentation === 'chips' ? 4 : 5}
                                      monospace
                                      disabled={props.saving}
                                      maxLength={input.maxLength}
                                      textareaRef={(element) => {
                                        if (element === null)
                                          agentInputRefs.current.delete(input.key)
                                        else agentInputRefs.current.set(input.key, element)
                                      }}
                                      data-testid={`wt-agent-input-${input.key}`}
                                    />
                                  </Field>
                                )
                              })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                {draft.launchKind === 'workgroup' && (
                  <Field
                    label={t('webhookTriggers.fields.goal')}
                    required
                    action={
                      <RuntimeParameterPicker
                        authority="webhook:workgroup:workgroup-goal"
                        entries={webhookCatalog}
                        emptyMessage={webhookCatalogEmptyMessage}
                        disabled={props.saving}
                        testId="wt-goal-parameter"
                        target={{
                          id: `webhook:workgroup:${draft.launchRefId}:goal`,
                          label: t('webhookTriggers.fields.goal'),
                          mode: 'insert-at-caret',
                          value: draft.goal,
                          revision: `${draftRevisionRef.current}:goal`,
                          element: () => goalRef.current,
                          commit: (goal) => set({ goal }),
                        }}
                      />
                    }
                    group
                  >
                    <TextArea
                      value={draft.goal}
                      onChange={(goal) => set({ goal })}
                      rows={5}
                      monospace
                      disabled={props.saving}
                      textareaRef={goalRef}
                      data-testid="wt-goal"
                    />
                  </Field>
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
                    <dt>{t('webhookTriggers.review.terminalProtection')}</dt>
                    <dd>
                      {t(
                        draft.cancelOnMrTerminal
                          ? 'webhookTriggers.review.terminalProtectionOn'
                          : 'webhookTriggers.review.terminalProtectionOff',
                      )}
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
                      disabled={props.saving}
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
                        disabled={props.saving}
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
        </div>
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
      <ConfirmDialog
        open={pendingAgentTargetId !== null}
        title={t('webhookTriggers.fields.agentTargetSwitchTitle')}
        description={t('webhookTriggers.fields.agentTargetSwitchDescription')}
        confirmLabel={t('webhookTriggers.fields.agentTargetSwitchAction')}
        onClose={() => setPendingAgentTargetId(null)}
        onConfirm={() => {
          const next = pendingAgentTargetId
          setPendingAgentTargetId(null)
          if (next !== null) applyTargetChange(next)
        }}
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

function FiresDialog(props: { trigger: WebhookTrigger; canReset: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const writeSessionRef = useRef(0)
  const previousCanResetRef = useRef(props.canReset)
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
    session === writeSessionRef.current &&
    canWriteTrigger(currentActorAtRequest(qc), props.trigger.ownerUserId, 'webhook-triggers:update')
  const reset = useMutation({
    mutationFn: ({ input: streamKey, session }: TriggerRequest<string>) => {
      if (!requestIsCurrent(session)) throw new Error('Webhook trigger write access ended')
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
    const lostResetAccess = previousCanResetRef.current && !props.canReset
    previousCanResetRef.current = props.canReset
    if (lostResetAccess) {
      writeSessionRef.current += 1
      reset.reset()
    }
  }, [props.canReset, reset])
  const writeSession = writeSessionRef.current
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
                      {props.canReset && f.outcome === 'skipped-circuit-open' && (
                        <button
                          type="button"
                          className="btn btn--xs"
                          onClick={() =>
                            reset.mutate({ session: writeSession, input: f.streamKey })
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
