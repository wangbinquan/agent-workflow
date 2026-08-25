import {
  ADAPTER_CREATE_DEFAULTS,
  ADAPTER_REQUIRED_OPERATIONS,
  type AdapterPurpose,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import { api } from '@/api/client'
import { AclPanel } from '@/components/AclPanel'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { useActor, usePermission } from '@/hooks/useActor'

import type { LaneAdapterBinding, LaneAdapterSlot } from './types'
import { localized } from './types'

const ADAPTERS_BASE = '/api/integrations/development-adapters'

export interface LaneAdapterChoice {
  id: string
  name: string
  purpose: string
  publishedRevision: number | null
  archivedAt: number | null
  ownerUserId: string | null
}

interface AdapterDetail extends LaneAdapterChoice {
  draft: {
    schemaVersion: 1
    purpose: AdapterPurpose
    operations: string[]
    contractVersion: 1
    executableRef: string
    parameterSchemaRef: string | null
    connectionRef: string | null
    secretProjection: string[]
    outputBudget: {
      maxFiles: number
      maxFileBytes: number
      maxTotalBytes: number
    }
    timeoutMs: number
  }
}

type DialogView = 'binding' | 'resource' | 'acl'

interface LaneAdapterDialogBaseProps {
  open: boolean
  onClose: () => void
  language: string
  slot: LaneAdapterSlot
}

interface LaneAdapterBindingDialogProps extends LaneAdapterDialogBaseProps {
  laneId: string
  mode: 'job-default' | 'employee-override'
  value: LaneAdapterBinding | null
  inherited: LaneAdapterBinding | null
  onChange: (binding: LaneAdapterBinding | null) => void
}

type LaneAdapterDialogProps =
  | LaneAdapterBindingDialogProps
  | (LaneAdapterDialogBaseProps & { mode: 'resource-library' })

function bindingKey(binding: LaneAdapterBinding): string {
  return `${binding.laneId}/${binding.slotRef}`
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function LaneAdapterBindingDialog(props: LaneAdapterBindingDialogProps): ReactElement {
  return <LaneAdapterDialog {...props} />
}

export function LaneAdapterResourceDialog(props: LaneAdapterDialogBaseProps): ReactElement {
  return <LaneAdapterDialog {...props} mode="resource-library" />
}

function LaneAdapterDialog(props: LaneAdapterDialogProps): ReactElement {
  const zh = props.language.startsWith('zh')
  const qc = useQueryClient()
  const canCreate = usePermission('adapter-definitions:create')
  const canUpdate = usePermission('adapter-definitions:update')
  const canArchive = usePermission('adapter-definitions:archive')
  const canAuthorScripts = usePermission('scripts:author')
  const canBypassOwner = usePermission('resource-acl:bypass')
  const actor = useActor()
  // The inline action promises a usable published Adapter, so it needs both
  // create and publish authority. A create-only actor can still use the API to
  // create a draft, but this guided flow must not strand an unmanageable draft.
  const canCreateResource = canCreate && canUpdate && canAuthorScripts
  const canUpdateResource = canUpdate && canAuthorScripts
  const [view, setView] = useState<DialogView>('binding')
  const [source, setSource] = useState<'inherit' | 'override'>('override')
  const [selectedRef, setSelectedRef] = useState<{ id: string; revision: number } | null>(null)
  const [resourceId, setResourceId] = useState<string | null>(null)

  const choices = useQuery<{ items: LaneAdapterChoice[] }>({
    queryKey: ['digital-employee-adapters'],
    enabled: props.open,
    queryFn: ({ signal }) => api.get(ADAPTERS_BASE, undefined, signal),
  })
  const matchingChoices = useMemo(
    () =>
      (choices.data?.items ?? []).filter(
        (choice) =>
          choice.purpose === props.slot.purpose &&
          choice.publishedRevision !== null &&
          choice.archivedAt === null,
      ),
    [choices.data?.items, props.slot.purpose],
  )
  const libraryChoices = useMemo(
    () =>
      (choices.data?.items ?? []).filter(
        (choice) => choice.purpose === props.slot.purpose && choice.archivedAt === null,
      ),
    [choices.data?.items, props.slot.purpose],
  )
  const bindingValue = props.mode === 'resource-library' ? null : props.value
  const inheritedBinding = props.mode === 'resource-library' ? null : props.inherited
  const effectiveBinding = bindingValue ?? inheritedBinding
  const effectiveAdapterId = effectiveBinding?.adapterRef.id ?? null
  const effectiveAdapterRevision = effectiveBinding?.adapterRef.revision ?? null

  useEffect(() => {
    if (!props.open) return
    setView('binding')
    setResourceId(null)
    setSource(props.mode === 'employee-override' && bindingValue === null ? 'inherit' : 'override')
    setSelectedRef(
      effectiveAdapterId === null || effectiveAdapterRevision === null
        ? null
        : { id: effectiveAdapterId, revision: effectiveAdapterRevision },
    )
  }, [bindingValue, effectiveAdapterId, effectiveAdapterRevision, props.mode, props.open])

  const selectedChoice = matchingChoices.find((choice) => choice.id === selectedRef?.id)
  const canManageSelected =
    selectedChoice !== undefined &&
    (canBypassOwner || selectedChoice.ownerUserId === actor.data?.user.id)
  const selectedAvailable =
    selectedRef !== null &&
    (choices.data?.items ?? []).some(
      (choice) =>
        choice.id === selectedRef.id &&
        choice.purpose === props.slot.purpose &&
        choice.archivedAt === null &&
        choice.publishedRevision !== null,
    )

  const detail = useQuery<AdapterDetail>({
    queryKey: ['digital-employee-adapter', resourceId],
    enabled: props.open && view !== 'binding' && resourceId !== null,
    queryFn: ({ signal }) =>
      api.get(`${ADAPTERS_BASE}/${encodeURIComponent(resourceId ?? '')}`, undefined, signal),
  })

  const [resourceName, setResourceName] = useState('')
  const [executableRef, setExecutableRef] = useState('')
  const [operationsText, setOperationsText] = useState('')
  const [parameterSchemaRef, setParameterSchemaRef] = useState('')
  const [connectionRef, setConnectionRef] = useState('')
  const [secretProjectionText, setSecretProjectionText] = useState('')
  const [maxFiles, setMaxFiles] = useState(String(ADAPTER_CREATE_DEFAULTS.outputBudget.maxFiles))
  const [maxFileBytes, setMaxFileBytes] = useState(
    String(ADAPTER_CREATE_DEFAULTS.outputBudget.maxFileBytes),
  )
  const [maxTotalBytes, setMaxTotalBytes] = useState(
    String(ADAPTER_CREATE_DEFAULTS.outputBudget.maxTotalBytes),
  )
  const [timeoutMs, setTimeoutMs] = useState(String(ADAPTER_CREATE_DEFAULTS.timeoutMs))

  const resetResourceDraft = useCallback(() => {
    setResourceName('')
    setExecutableRef('')
    setOperationsText(ADAPTER_REQUIRED_OPERATIONS[props.slot.purpose].join(', '))
    setParameterSchemaRef('')
    setConnectionRef('')
    setSecretProjectionText('')
    setMaxFiles(String(ADAPTER_CREATE_DEFAULTS.outputBudget.maxFiles))
    setMaxFileBytes(String(ADAPTER_CREATE_DEFAULTS.outputBudget.maxFileBytes))
    setMaxTotalBytes(String(ADAPTER_CREATE_DEFAULTS.outputBudget.maxTotalBytes))
    setTimeoutMs(String(ADAPTER_CREATE_DEFAULTS.timeoutMs))
  }, [props.slot.purpose])

  useEffect(() => {
    if (view !== 'resource') return
    if (resourceId === null) {
      resetResourceDraft()
      return
    }
    if (detail.data === undefined || detail.data.id !== resourceId) return
    setResourceName(detail.data.name)
    setExecutableRef(detail.data.draft.executableRef)
    setOperationsText(detail.data.draft.operations.join(', '))
    setParameterSchemaRef(detail.data.draft.parameterSchemaRef ?? '')
    setConnectionRef(detail.data.draft.connectionRef ?? '')
    setSecretProjectionText(detail.data.draft.secretProjection.join('\n'))
    setMaxFiles(String(detail.data.draft.outputBudget.maxFiles))
    setMaxFileBytes(String(detail.data.draft.outputBudget.maxFileBytes))
    setMaxTotalBytes(String(detail.data.draft.outputBudget.maxTotalBytes))
    setTimeoutMs(String(detail.data.draft.timeoutMs))
  }, [detail.data, resetResourceDraft, resourceId, view])

  const saveResource = useMutation({
    mutationFn: async () => {
      const operations = operationsText
        .split(',')
        .map((operation) => operation.trim())
        .filter(Boolean)
      const draft = {
        schemaVersion: 1 as const,
        purpose: props.slot.purpose,
        operations,
        contractVersion: 1 as const,
        executableRef: executableRef.trim(),
        parameterSchemaRef: parameterSchemaRef.trim() || null,
        connectionRef: connectionRef.trim() || null,
        secretProjection: secretProjectionText
          .split(/[\n,]/)
          .map((key) => key.trim())
          .filter(Boolean),
        outputBudget: {
          maxFiles: positiveInteger(maxFiles, ADAPTER_CREATE_DEFAULTS.outputBudget.maxFiles),
          maxFileBytes: positiveInteger(
            maxFileBytes,
            ADAPTER_CREATE_DEFAULTS.outputBudget.maxFileBytes,
          ),
          maxTotalBytes: positiveInteger(
            maxTotalBytes,
            ADAPTER_CREATE_DEFAULTS.outputBudget.maxTotalBytes,
          ),
        },
        timeoutMs: positiveInteger(timeoutMs, ADAPTER_CREATE_DEFAULTS.timeoutMs),
      }
      let id = resourceId
      if (id === null) {
        const created = await api.post<{ id: string }>(ADAPTERS_BASE, {
          name: resourceName.trim(),
          purpose: props.slot.purpose,
          draft,
        })
        id = created.id
        // Preserve the newly created draft in the resource-management view if
        // validation or publication fails. The owner can correct it and retry
        // instead of silently creating an orphan and returning to a blank form.
        setResourceId(id)
      } else {
        await api.put(`${ADAPTERS_BASE}/${encodeURIComponent(id)}`, {
          name: resourceName.trim(),
          draft,
        })
      }
      const published = await api.post<{ revision: number }>(
        `${ADAPTERS_BASE}/${encodeURIComponent(id)}/publish`,
        {},
      )
      return { id, revision: published.revision }
    },
    onSuccess: async (adapterRef) => {
      await qc.invalidateQueries({ queryKey: ['digital-employee-adapters'] })
      await qc.invalidateQueries({ queryKey: ['digital-employee-adapter', adapterRef.id] })
      setSelectedRef(adapterRef)
      setSource('override')
      setView('binding')
    },
  })

  const archiveResource = useMutation({
    mutationFn: async () => {
      if (resourceId === null) return
      await api.post(`${ADAPTERS_BASE}/${encodeURIComponent(resourceId)}/archive`, {})
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digital-employee-adapters'] })
      if (resourceId !== null && selectedRef?.id === resourceId) setSelectedRef(null)
      setView('binding')
    },
  })

  const saveBinding = () => {
    if (props.mode === 'resource-library') return
    if (props.mode === 'employee-override' && source === 'inherit') {
      props.onChange(null)
      props.onClose()
      return
    }
    if (selectedRef === null) {
      props.onChange(null)
      props.onClose()
      return
    }
    props.onChange({
      laneId: props.laneId,
      slotRef: props.slot.slotRef,
      adapterRef: selectedRef,
    })
    props.onClose()
  }

  const resourceFormValid =
    resourceName.trim() !== '' &&
    executableRef.trim() !== '' &&
    operationsText.trim() !== '' &&
    (resourceId === null ? canCreateResource : canUpdateResource) &&
    !saveResource.isPending

  const title =
    view === 'binding'
      ? localized(props.slot.label, props.language)
      : view === 'acl'
        ? zh
          ? '连接可见范围'
          : 'Connection access'
        : resourceId === null
          ? zh
            ? '新建企业连接'
            : 'New enterprise connection'
          : zh
            ? '管理企业连接'
            : 'Manage enterprise connection'

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={title}
      size={view === 'resource' ? 'lg' : 'md'}
      closeOnOverlayClick={false}
      dismissDisabled={saveResource.isPending || archiveResource.isPending}
      panelClassName="lane-adapter-dialog"
      data-testid="lane-adapter-dialog"
      footer={
        view === 'binding' ? (
          props.mode === 'resource-library' ? (
            <button type="button" className="btn" onClick={props.onClose}>
              {zh ? '关闭' : 'Close'}
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={props.onClose}>
                {zh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  source === 'override' &&
                  (selectedRef === null || !selectedAvailable) &&
                  props.slot.requiredWhenLaneEnabled
                }
                onClick={saveBinding}
              >
                {props.mode === 'employee-override' && source === 'inherit'
                  ? zh
                    ? '恢复继承'
                    : 'Restore inherited'
                  : zh
                    ? '保存连接'
                    : 'Save connection'}
              </button>
            </>
          )
        ) : view === 'acl' && resourceId !== null ? null : (
          <>
            <button type="button" className="btn" onClick={() => setView('binding')}>
              {zh ? '返回' : 'Back'}
            </button>
            {resourceId !== null && canArchive ? (
              <ConfirmButton
                label={zh ? '归档' : 'Archive'}
                confirmLabel={zh ? '确认归档' : 'Confirm archive'}
                confirmationKey={resourceId}
                variant="danger"
                disabled={archiveResource.isPending}
                onConfirm={() => archiveResource.mutateAsync()}
              />
            ) : null}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!resourceFormValid}
              onClick={() => saveResource.mutate()}
            >
              {saveResource.isPending
                ? zh
                  ? '正在发布…'
                  : 'Publishing…'
                : zh
                  ? '保存并发布'
                  : 'Save and publish'}
            </button>
          </>
        )
      }
    >
      {view === 'binding' ? (
        props.mode === 'resource-library' ? (
          <section className="employee-node-panel" data-testid="lane-adapter-resource-library">
            <header>
              <div>
                <p>{localized(props.slot.description, props.language)}</p>
              </div>
              {canCreateResource ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    setResourceId(null)
                    setView('resource')
                  }}
                >
                  {zh ? '新建连接' : 'New connection'}
                </button>
              ) : (
                <StatusChip kind="neutral">{zh ? '只读' : 'Read only'}</StatusChip>
              )}
            </header>
            {choices.isPending ? <LoadingState /> : null}
            {choices.isError ? <ErrorBanner error={choices.error} /> : null}
            {!choices.isPending && !choices.isError ? (
              <div className="node-tool-list">
                {libraryChoices.length === 0 ? (
                  <p className="node-tool-list__empty">
                    {zh
                      ? '这个泳道还没有可用的企业连接。'
                      : 'No enterprise connection is available for this lane.'}
                  </p>
                ) : (
                  libraryChoices.map((choice) => {
                    const canManage =
                      canUpdateResource &&
                      (canBypassOwner || choice.ownerUserId === actor.data?.user.id)
                    return (
                      <article key={choice.id} className="node-tool-row">
                        <div>
                          <div className="node-tool-row__title">
                            <strong>{choice.name}</strong>
                            <StatusChip
                              kind={choice.publishedRevision === null ? 'neutral' : 'success'}
                              size="sm"
                            >
                              {choice.publishedRevision === null
                                ? zh
                                  ? '草稿'
                                  : 'Draft'
                                : zh
                                  ? `可用 · v${choice.publishedRevision}`
                                  : `Available · v${choice.publishedRevision}`}
                            </StatusChip>
                          </div>
                          <small>{choice.purpose}</small>
                        </div>
                        {canManage ? (
                          <div className="employee-summary-card__actions">
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => {
                                setResourceId(choice.id)
                                setView('resource')
                              }}
                            >
                              {zh ? '编辑' : 'Edit'}
                            </button>
                          </div>
                        ) : null}
                      </article>
                    )
                  })
                )}
              </div>
            ) : null}
          </section>
        ) : (
          <div className="employee-dialog-form">
            {props.mode === 'employee-override' ? (
              <Field label={zh ? '配置来源' : 'Configuration source'} group>
                <Segmented
                  value={source}
                  onChange={(next) => {
                    setSource(next)
                    setSelectedRef(
                      next === 'inherit'
                        ? (props.inherited?.adapterRef ?? null)
                        : (props.value?.adapterRef ?? selectedRef),
                    )
                  }}
                  ariaLabel={zh ? '配置来源' : 'Configuration source'}
                  options={[
                    {
                      value: 'inherit',
                      label: zh ? '继承岗位模板' : 'Inherit job default',
                      disabled: props.inherited === null,
                    },
                    { value: 'override', label: zh ? '员工覆盖' : 'Employee override' },
                  ]}
                />
              </Field>
            ) : null}
            <Field
              label={zh ? '企业系统连接' : 'Enterprise system connection'}
              hint={localized(props.slot.description, props.language)}
              required={props.slot.requiredWhenLaneEnabled}
            >
              <Select
                value={selectedRef?.id ?? ''}
                onChange={(id) => {
                  const choice = matchingChoices.find((candidate) => candidate.id === id)
                  setSelectedRef(
                    choice?.publishedRevision == null
                      ? null
                      : { id: choice.id, revision: choice.publishedRevision },
                  )
                  if (props.mode === 'employee-override') setSource('override')
                }}
                searchable
                disabled={props.mode === 'employee-override' && source === 'inherit'}
                placeholder={
                  choices.isPending
                    ? zh
                      ? '正在加载…'
                      : 'Loading…'
                    : zh
                      ? '选择已发布连接'
                      : 'Choose a published connection'
                }
                options={matchingChoices.map((choice) => ({
                  value: choice.id,
                  label: `${choice.name} · v${choice.publishedRevision}`,
                }))}
              />
            </Field>
            {choices.isError ? <ErrorBanner error={choices.error} /> : null}
            <div className="lane-adapter-dialog__status" data-testid="lane-adapter-binding-status">
              <div>
                <strong>
                  {selectedChoice?.name ?? selectedRef?.id ?? (zh ? '尚未配置' : 'Not set')}
                </strong>
                <small>
                  {props.slot.purpose}
                  {selectedRef === null ? '' : ` · v${selectedRef.revision}`}
                </small>
              </div>
              <StatusChip kind={selectedAvailable ? 'success' : 'warn'}>
                {selectedAvailable ? (zh ? '可用' : 'Available') : zh ? '缺失或不可用' : 'Missing'}
              </StatusChip>
            </div>
            {props.mode === 'employee-override' && source === 'inherit' ? (
              <NoticeBanner tone="info" title={zh ? '继承岗位模板' : 'Inherited from job'}>
                {props.inherited === null
                  ? zh
                    ? '岗位模板尚未设置这个连接。'
                    : 'The job template has not configured this connection.'
                  : zh
                    ? `员工会冻结岗位模板当前选择的精确版本 v${props.inherited.adapterRef.revision}。`
                    : `The employee will freeze the job template's exact revision v${props.inherited.adapterRef.revision}.`}
              </NoticeBanner>
            ) : null}
            {canCreateResource || canUpdateResource ? (
              <div className="lane-adapter-dialog__secondary-actions">
                {canCreateResource ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setResourceId(null)
                      setView('resource')
                    }}
                  >
                    {zh ? '新建连接' : 'New connection'}
                  </button>
                ) : null}
                {selectedRef !== null && canUpdateResource && canManageSelected ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setResourceId(selectedRef.id)
                      setView('resource')
                    }}
                  >
                    {zh ? '管理连接' : 'Manage connection'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      ) : view === 'acl' && resourceId !== null ? (
        <AclPanel
          resourceBaseUrl={`${ADAPTERS_BASE}/${encodeURIComponent(resourceId)}`}
          invalidateKey={['digital-employee-adapters']}
          onSaved={() => setView('resource')}
          onCancel={() => setView('resource')}
        />
      ) : resourceId !== null && detail.isPending ? (
        <LoadingState />
      ) : resourceId !== null && detail.isError ? (
        <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="employee-dialog-form">
          <NoticeBanner tone="info" title={zh ? '用途由泳道固定' : 'Purpose fixed by lane'}>
            {props.slot.purpose}
          </NoticeBanner>
          <Field label={zh ? '名称' : 'Name'} required>
            <TextInput value={resourceName} onChange={setResourceName} autoFocus />
          </Field>
          <Field
            label={zh ? '可执行文件 / 脚本路径' : 'Executable / script path'}
            hint={
              zh
                ? '填写 daemon 主机可直接启动的可执行文件，或 .ts/.js/.mjs/.cjs 脚本路径；这里不填写代码，也不支持带参数的 Shell 命令。凭据不会写入这里。'
                : 'Enter an executable available to the daemon host, or a path to a .ts/.js/.mjs/.cjs script. Do not enter source code or a shell command with arguments. Credentials are not stored here.'
            }
            required
          >
            <TextInput
              value={executableRef}
              onChange={setExecutableRef}
              placeholder="/opt/company-adapters/pipeline-gate.ts"
            />
          </Field>
          <details className="lane-adapter-dialog__advanced">
            <summary>{zh ? '高级设置' : 'Advanced settings'}</summary>
            <div className="employee-dialog-form">
              <Field label={zh ? '支持的操作' : 'Operations'} required>
                <TextInput value={operationsText} onChange={setOperationsText} />
              </Field>
              <Field label="connectionRef">
                <TextInput value={connectionRef} onChange={setConnectionRef} />
              </Field>
              <Field label="parameterSchemaRef">
                <TextInput value={parameterSchemaRef} onChange={setParameterSchemaRef} />
              </Field>
              <Field
                label={zh ? '允许投影的环境变量名' : 'Projected environment keys'}
                hint={
                  zh
                    ? '每行一个大写 key；这里只存 key 名，不显示或保存 secret value。'
                    : 'One uppercase key per line. Only names are stored; secret values are never shown.'
                }
              >
                <TextArea value={secretProjectionText} onChange={setSecretProjectionText} />
              </Field>
              <div className="lane-adapter-dialog__budget-grid">
                <Field label="maxFiles">
                  <TextInput type="number" value={maxFiles} onChange={setMaxFiles} />
                </Field>
                <Field label="maxFileBytes">
                  <TextInput type="number" value={maxFileBytes} onChange={setMaxFileBytes} />
                </Field>
                <Field label="maxTotalBytes">
                  <TextInput type="number" value={maxTotalBytes} onChange={setMaxTotalBytes} />
                </Field>
                <Field label="timeoutMs">
                  <TextInput type="number" value={timeoutMs} onChange={setTimeoutMs} />
                </Field>
              </div>
            </div>
          </details>
          {resourceId !== null ? (
            <div className="lane-adapter-dialog__secondary-actions">
              <button type="button" className="btn btn--sm" onClick={() => setView('acl')}>
                {zh ? '可见范围与授权' : 'Access and visibility'}
              </button>
            </div>
          ) : null}
          {saveResource.isError ? <ErrorBanner error={saveResource.error} /> : null}
          {archiveResource.isError ? <ErrorBanner error={archiveResource.error} /> : null}
        </div>
      )}
    </Dialog>
  )
}

export function adapterBindingAt(
  bindings: readonly LaneAdapterBinding[],
  laneId: string,
  slotRef: string,
): LaneAdapterBinding | null {
  return bindings.find((binding) => bindingKey(binding) === `${laneId}/${slotRef}`) ?? null
}
