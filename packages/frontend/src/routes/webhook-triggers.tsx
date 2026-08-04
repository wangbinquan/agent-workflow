// RFC-257 T11 — webhook 触发器管理页（owner 制列表 + 新建/编辑 Dialog）。
// 复用公共原语：PageHeader / TableViewport / Dialog / Field / Select /
// Segmented / Checkbox / ChipsInput / NumberInput / Switch / StatusChip /
// QueryState 派生三态。输入映射按目标 workflow 的 input kind 感知渲染
//（design §7：git kind = 固定「分支来自事件」，text = 模板输入，其余提示
// 不可映射——保存由后端三层校验兜底，前端只做引导）。
import {
  CODE_HOST_EVENT_TYPES,
  type CodeHostEventType,
  type WebhookEndpoint,
  type WebhookInputMapping,
  type WebhookLaunchKind,
  type WebhookTrigger,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Checkbox, Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { ChipsInput } from '@/components/ChipsInput'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/webhook-triggers',
  component: WebhookTriggersPage,
})

type RepoScopeKind = 'all' | 'prefix' | 'exact'

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
  if (draft.launchKind === 'workflow') return { inputs: draft.inputMappings }
  if (draft.launchKind === 'agent') {
    return draft.description.trim() === '' ? {} : { description: draft.description }
  }
  return { goal: draft.goal }
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
    autoRegisterRepos: draft.autoRegisterRepos,
  }
}

type WorkflowRow = { id: string; name: string }
type WorkflowDetail = {
  definition?: { inputs?: Array<{ key: string; kind: string; required?: boolean }> } | null
}
type AgentRow = { id: string; name: string }
type WorkgroupRow = { id: string; name: string }

function WebhookTriggersPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [firesFor, setFiresFor] = useState<WebhookTrigger | null>(null)

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
    // 普通 owner 无 manage 权限（403）：endpoint 选择降级为手输 id 的空列表。
    retry: false,
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['webhook-triggers'] })

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id === null
        ? api.post<WebhookTrigger>('/api/webhook-triggers', bodyOf(d))
        : api.put<WebhookTrigger>(`/api/webhook-triggers/${encodeURIComponent(d.id)}`, {
            ...bodyOf(d),
            // kind/endpoint 不可变：PUT 不带这两个键（后端提供时才校验相等）。
            launchKind: undefined,
            endpointId: undefined,
          }),
    onSuccess: () => {
      setError(null)
      setDraft(null)
      invalidate()
    },
    onError: setError,
  })
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.put<WebhookTrigger>(`/api/webhook-triggers/${encodeURIComponent(input.id)}`, {
        enabled: input.enabled,
      }),
    onSuccess: invalidate,
    onError: setError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/webhook-triggers/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: setError,
  })

  const rows = triggers.data ?? []
  const isInitialEmpty = !triggers.isLoading && triggers.data !== undefined && rows.length === 0

  const newAction = (
    <button
      type="button"
      className="btn btn--primary"
      onClick={() => {
        setError(null)
        setDraft({ ...EMPTY_DRAFT, endpointId: endpoints.data?.[0]?.id ?? '' })
      }}
      data-testid="webhook-trigger-new"
    >
      {t('webhookTriggers.new')}
    </button>
  )

  return (
    <div className="page">
      <PageHeader
        title={t('webhookTriggers.title')}
        actions={isInitialEmpty ? undefined : newAction}
      >
        <p className="muted">{t('webhookTriggers.subtitle')}</p>
      </PageHeader>
      {error !== null && <ErrorBanner error={error} />}
      {triggers.error != null && <ErrorBanner error={triggers.error} />}
      {triggers.isLoading && <LoadingState data-testid="webhook-triggers-loading" />}
      {isInitialEmpty && (
        <EmptyState
          title={t('webhookTriggers.empty')}
          description={t('webhookTriggers.emptyDescription')}
          action={newAction}
          data-testid="webhook-triggers-empty"
        />
      )}
      {rows.length > 0 && (
        <TableViewport label={t('webhookTriggers.title')}>
          <table className="data-table" data-testid="webhook-triggers-table">
            <thead>
              <tr>
                <th>{t('webhookTriggers.columns.name')}</th>
                <th>{t('webhookTriggers.columns.rule')}</th>
                <th>{t('webhookTriggers.columns.target')}</th>
                <th>{t('webhookTriggers.columns.state')}</th>
                <th aria-label={t('common.ariaActions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="data-table__row"
                  data-testid={`webhook-trigger-${row.id}`}
                >
                  <td>
                    <strong>{row.name}</strong>
                    {row.launchPayload === null && (
                      <StatusChip kind="warn" size="sm">
                        {t('webhookTriggers.corruptBadge')}
                      </StatusChip>
                    )}
                  </td>
                  <td className="muted">
                    {row.repoScope === null
                      ? t('common.emDash')
                      : row.repoScope.kind === 'all'
                        ? t('webhookTriggers.scopeAll')
                        : row.repoScope.kind === 'prefix'
                          ? `${row.repoScope.prefix}*`
                          : t('webhookTriggers.scopeExact', { n: row.repoScope.paths.length })}
                    {' · '}
                    {(row.eventTypes ?? []).map((e) => t(`webhookTriggers.events.${e}`)).join(', ')}
                  </td>
                  <td className="muted">
                    {t(`webhookTriggers.kinds.${row.launchKind}`)} · {row.launchRefId}
                  </td>
                  <td>
                    <div className="page__actions">
                      <Switch
                        checked={row.enabled}
                        onChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
                        aria-label={t('webhookTriggers.enabledSwitch')}
                        data-testid={`webhook-trigger-enable-${row.id}`}
                      />
                      {row.lastStatus !== null && (
                        <StatusChip
                          kind={row.lastStatus === 'failed' ? 'danger' : 'success'}
                          size="sm"
                        >
                          {t(`webhookTriggers.last.${row.lastStatus}`)}
                        </StatusChip>
                      )}
                    </div>
                  </td>
                  <td className="data-table__actions">
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => setFiresFor(row)}
                      data-testid={`webhook-trigger-fires-${row.id}`}
                    >
                      {t('webhookTriggers.firesButton')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => {
                        setError(null)
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
                      onConfirm={() => remove.mutate(row.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}

      {draft !== null && (
        <TriggerDialog
          draft={draft}
          endpoints={endpoints.data ?? []}
          saving={save.isPending}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => save.mutate(draft)}
        />
      )}
      {firesFor !== null && <FiresDialog trigger={firesFor} onClose={() => setFiresFor(null)} />}
    </div>
  )
}

function TriggerDialog(props: {
  draft: Draft
  endpoints: Array<WebhookEndpoint & { ingressUrl: string | null }>
  saving: boolean
  onChange: (d: Draft) => void
  onClose: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const { draft } = props
  const isNew = draft.id === null
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

  const targetOptions: Array<{ value: string; label: string }> =
    draft.launchKind === 'workflow'
      ? (workflows.data ?? []).map((w) => ({ value: w.id, label: w.name }))
      : draft.launchKind === 'agent'
        ? (agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))
        : (workgroups.data ?? []).map((w) => ({ value: w.id, label: w.name }))

  const canSave =
    draft.name.trim() !== '' &&
    draft.endpointId !== '' &&
    draft.launchRefId !== '' &&
    draft.eventTypes.length > 0 &&
    (draft.scopeKind !== 'prefix' || draft.scopePrefix.trim() !== '') &&
    (draft.scopeKind !== 'exact' || draft.scopePaths.length > 0) &&
    (draft.launchKind !== 'workgroup' || draft.goal.trim() !== '')

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={isNew ? t('webhookTriggers.dialogCreate') : t('webhookTriggers.dialogEdit')}
      size="lg"
      data-testid="webhook-trigger-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave || props.saving}
            onClick={props.onSave}
            data-testid="webhook-trigger-save"
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('webhookTriggers.fields.name')} required>
          <TextInput value={draft.name} onChange={(name) => set({ name })} data-testid="wt-name" />
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
            options={props.endpoints.map((e) => ({ value: e.id, label: e.name }))}
            placeholder={t('webhookTriggers.fields.endpointPlaceholder')}
            ariaLabel={t('webhookTriggers.fields.endpoint')}
            data-testid="wt-endpoint"
          />
        </Field>
        <Field label={t('webhookTriggers.fields.scope')} group>
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
        <Field
          label={t('webhookTriggers.fields.events')}
          hint={t('webhookTriggers.fields.eventsHint')}
          group
          required
        >
          <div className="form-grid">
            {CODE_HOST_EVENT_TYPES.map((eventType) => (
              <Checkbox
                key={eventType}
                checked={draft.eventTypes.includes(eventType)}
                onChange={(checked) =>
                  set({
                    eventTypes: checked
                      ? [...draft.eventTypes, eventType]
                      : draft.eventTypes.filter((e) => e !== eventType),
                  })
                }
                label={t(`webhookTriggers.events.${eventType}`)}
                data-testid={`wt-event-${eventType}`}
              />
            ))}
          </div>
        </Field>
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
        <Field
          label={t('webhookTriggers.fields.launchKind')}
          hint={isNew ? undefined : t('webhookTriggers.fields.kindImmutable')}
          group
        >
          <Segmented<WebhookLaunchKind>
            value={draft.launchKind}
            onChange={(launchKind) =>
              isNew ? set({ launchKind, launchRefId: '', inputMappings: {} }) : undefined
            }
            ariaLabel={t('webhookTriggers.fields.launchKind')}
            options={[
              { value: 'workflow', label: t('webhookTriggers.kinds.workflow') },
              { value: 'agent', label: t('webhookTriggers.kinds.agent') },
              { value: 'workgroup', label: t('webhookTriggers.kinds.workgroup') },
            ]}
          />
        </Field>
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

        {draft.launchKind === 'workflow' && draft.launchRefId !== '' && (
          <Field
            label={t('webhookTriggers.fields.inputMappings')}
            hint={t('webhookTriggers.fields.inputMappingsHint')}
            group
          >
            {workflowInputs.length === 0 ? (
              <p className="muted">{t('webhookTriggers.fields.noInputs')}</p>
            ) : (
              <div className="form-grid">
                {workflowInputs.map((input) => {
                  const mapping = draft.inputMappings[input.key]
                  const setMapping = (m: WebhookInputMapping | null) => {
                    const next = { ...draft.inputMappings }
                    if (m === null) delete next[input.key]
                    else next[input.key] = m
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
                            setMapping(template === '' ? null : { kind: 'template', template })
                          }
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
          <Field
            label={t('webhookTriggers.fields.description')}
            hint={t('webhookTriggers.fields.templateVarsHint')}
          >
            <TextArea
              value={draft.description}
              onChange={(description) => set({ description })}
              rows={4}
              monospace
              data-testid="wt-description"
            />
          </Field>
        )}
        {draft.launchKind === 'workgroup' && (
          <Field
            label={t('webhookTriggers.fields.goal')}
            hint={t('webhookTriggers.fields.templateVarsHint')}
            required
          >
            <TextArea
              value={draft.goal}
              onChange={(goal) => set({ goal })}
              rows={4}
              monospace
              data-testid="wt-goal"
            />
          </Field>
        )}

        <Field
          label={t('webhookTriggers.fields.maxFires')}
          hint={t('webhookTriggers.fields.maxFiresHint')}
        >
          <NumberInput
            value={draft.maxConsecutiveFires}
            onChange={(v) => set({ maxConsecutiveFires: v ?? 3 })}
            min={1}
            max={100}
            data-testid="wt-max-fires"
          />
        </Field>
        <Field label={t('webhookTriggers.fields.autoRegister')} group>
          <Switch
            checked={draft.autoRegisterRepos}
            onChange={(autoRegisterRepos) => set({ autoRegisterRepos })}
            label={t('webhookTriggers.fields.autoRegisterLabel')}
          />
        </Field>
      </div>
    </Dialog>
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

function FiresDialog(props: { trigger: WebhookTrigger; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fires = useQuery({
    queryKey: ['webhook-trigger-fires', props.trigger.id],
    queryFn: ({ signal }) =>
      api.get<FireRow[]>(
        `/api/webhook-triggers/${encodeURIComponent(props.trigger.id)}/fires`,
        undefined,
        signal,
      ),
  })
  const reset = useMutation({
    mutationFn: (streamKey: string) =>
      api.post(`/api/webhook-triggers/${encodeURIComponent(props.trigger.id)}/streams/reset`, {
        streamKey,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['webhook-trigger-fires', props.trigger.id] }),
  })
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
                      {f.outcome === 'skipped-circuit-open' && (
                        <button
                          type="button"
                          className="btn btn--xs"
                          onClick={() => reset.mutate(f.streamKey)}
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
