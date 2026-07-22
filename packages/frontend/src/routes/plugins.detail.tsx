// Plugin detail: exact saved-revision Check/Upgrade UX (RFC-169 / RFC-201).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PluginOperationResource,
  PluginUpdateCheck,
  PluginUpgradeResult,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PluginFields, focusFirstPluginFieldError } from '@/components/PluginFields'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import {
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import {
  PLUGIN_UPDATES_KEY,
  pluginUpdateAvailable,
  pluginUpdateCacheKey,
  pluginUpdateEntry,
  type PluginUpdatesCache,
} from '@/lib/plugin-updates'
import {
  buildUpdatePayload,
  EMPTY_PLUGIN_FORM,
  pluginToForm,
  type PluginFormState,
} from '@/lib/plugin-form'
import { stableStringify } from '@/lib/stable-stringify'
import { Route as pluginsRoute } from './plugins'

export const Route = createRoute({
  getParentRoute: () => pluginsRoute,
  path: '/$id',
  component: PluginDetailPage,
  remountDeps: ({ params }) => params,
})

type PluginTab = 'config' | 'updates'
type OperationKind = 'check' | 'upgrade'
interface ActiveOperation {
  requestId: number
  expectedHash: string
  kind: OperationKind
}

const NOOP_RELEASE: SplitBusyRelease = () => {}
const EXACT_OPERATION_HASH_RE = /^[a-f0-9]{64}$/

function exactOperationHashOf(resource: PluginOperationResource | undefined): string | null {
  const candidate = (resource as { operationConfigHash?: unknown } | undefined)?.operationConfigHash
  return typeof candidate === 'string' && EXACT_OPERATION_HASH_RE.test(candidate) ? candidate : null
}

function PluginDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<PluginTab>('config')
  const [operationNotice, setOperationNotice] = useState<
    | 'update-ready'
    | 'no-change'
    | 'identity-unknown'
    | 'draft-changed'
    | 'stale'
    | 'upgraded'
    | null
  >(null)
  const [lastOperationKind, setLastOperationKind] = useState<OperationKind>('check')
  const operationSequence = useRef(0)
  const activeOperation = useRef<ActiveOperation | null>(null)

  const query = useQuery<PluginOperationResource>({
    queryKey: ['plugins', id],
    queryFn: ({ signal }) =>
      api.get<PluginOperationResource>(`/api/plugins/${encodeURIComponent(id)}`, undefined, signal),
  })

  const {
    draft: form,
    setDraft: setForm,
    loaded,
    dirty,
    commitSaved,
  } = useDraftFromQuery(query.data, pluginToForm, { followWhenClean: true })
  const formRef = useRef(form)
  formRef.current = form
  useReportSplitDirty(id, dirty)

  const dropUpdateEntries = () =>
    qc.setQueryData<PluginUpdatesCache>(PLUGIN_UPDATES_KEY, (previous) => {
      if (previous === undefined) return previous
      const next = Object.fromEntries(
        Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`)),
      )
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })

  const publishResource = (resource: PluginOperationResource) => {
    qc.setQueryData<PluginOperationResource>(['plugins', id], resource)
    qc.setQueryData<PluginOperationResource[]>(['plugins'], (rows) =>
      rows === undefined ? rows : rows.map((row) => (row.id === id ? resource : row)),
    )
  }

  const handleOperationError = (error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== 'resource-operation-stale') return
    setOperationNotice('stale')
    dropUpdateEntries()
    void qc.invalidateQueries({ queryKey: ['plugins', id], exact: true })
    void qc.invalidateQueries({ queryKey: ['plugins'], exact: true })
  }

  const save = useMutation({
    mutationFn: ({ snapshot }: { snapshot: PluginFormState; release: SplitBusyRelease }) => {
      if (query.data === undefined) return Promise.reject(new Error('not loaded'))
      const built = buildUpdatePayload(snapshot, query.data)
      if (!built.ok) return Promise.reject(new Error('invalid form'))
      return api.put<PluginOperationResource>(
        `/api/plugins/${encodeURIComponent(id)}`,
        built.payload,
      )
    },
    onSuccess: async (resource, { snapshot }) => {
      await qc.cancelQueries({ queryKey: ['plugins', id], exact: true })
      await qc.cancelQueries({ queryKey: ['plugins'], exact: true })
      publishResource(resource)
      void qc.invalidateQueries({ queryKey: ['plugins'], exact: true })
      dropUpdateEntries()
      commitSaved(snapshot, pluginToForm(resource))
    },
    onSettled: (_resource, _error, { release }) => release(),
  })

  const del = useMutation({
    mutationFn: ({ confirm, release: _release }: { confirm: string; release: SplitBusyRelease }) =>
      api.deleteJson(`/api/plugins/${encodeURIComponent(id)}`, { confirm }),
    onSuccess: async (_deleted, { release }) => {
      report(id, false)
      await qc.cancelQueries({ queryKey: ['plugins'], exact: true })
      qc.setQueryData<PluginOperationResource[]>(['plugins'], (rows) =>
        rows === undefined ? rows : rows.filter((row) => row.id !== id),
      )
      void qc.invalidateQueries({ queryKey: ['plugins'], exact: true })
      dropUpdateEntries()
      release()
      navigate({ to: '/plugins' })
    },
    onSettled: (_deleted, _error, { release }) => release(),
  })

  const checkUpdate = useMutation({
    mutationFn: (variables: ActiveOperation & { release: SplitBusyRelease }) =>
      api.post<PluginUpdateCheck>(`/api/plugins/${encodeURIComponent(id)}/check-update`, {
        expectedConfigHash: variables.expectedHash,
      }),
    onSuccess: (receipt, variables) => {
      const active = activeOperation.current
      const current = qc.getQueryData<PluginOperationResource>(['plugins', id])
      if (
        active?.requestId !== variables.requestId ||
        active.kind !== 'check' ||
        active.expectedHash !== variables.expectedHash ||
        receipt.configHashUsed !== variables.expectedHash ||
        current?.operationConfigHash !== receipt.configHashUsed
      ) {
        setOperationNotice('stale')
        void qc.invalidateQueries({ queryKey: ['plugins', id], exact: true })
        return
      }
      qc.setQueryData<PluginUpdatesCache>(PLUGIN_UPDATES_KEY, (previous) => ({
        ...(previous ?? {}),
        [pluginUpdateCacheKey(id, receipt.configHashUsed)]: {
          configHashUsed: receipt.configHashUsed,
          available: receipt.available,
          latest: receipt.latest,
          identityStatus: receipt.identityStatus,
        },
      }))
      setOperationNotice(
        receipt.identityStatus === 'unknown'
          ? 'identity-unknown'
          : receipt.available
            ? 'update-ready'
            : 'no-change',
      )
    },
    onError: handleOperationError,
    onSettled: (_receipt, _error, variables) => {
      if (activeOperation.current?.requestId === variables.requestId) activeOperation.current = null
      variables.release()
    },
  })

  const upgrade = useMutation({
    mutationFn: (variables: ActiveOperation & { release: SplitBusyRelease }) =>
      api.post<PluginUpgradeResult>(`/api/plugins/${encodeURIComponent(id)}/upgrade`, {
        expectedConfigHash: variables.expectedHash,
      }),
    onSuccess: (receipt, variables) => {
      const active = activeOperation.current
      let accepted = false
      qc.setQueryData<PluginOperationResource>(['plugins', id], (current) => {
        if (
          active?.requestId !== variables.requestId ||
          active.kind !== 'upgrade' ||
          active.expectedHash !== variables.expectedHash ||
          receipt.configHashUsed !== variables.expectedHash ||
          current?.operationConfigHash !== receipt.configHashUsed
        ) {
          return current
        }
        accepted = true
        return receipt.resource
      })
      if (!accepted) {
        setOperationNotice('stale')
        void qc.invalidateQueries({ queryKey: ['plugins', id], exact: true })
        return
      }
      qc.setQueryData<PluginOperationResource[]>(['plugins'], (rows) =>
        rows?.map((row) =>
          row.id === id && row.operationConfigHash === receipt.configHashUsed
            ? receipt.resource
            : row,
        ),
      )
      dropUpdateEntries()
      setOperationNotice('upgraded')
      void qc.invalidateQueries({ queryKey: ['plugins'], exact: true })
    },
    onError: handleOperationError,
    onSettled: (_receipt, _error, variables) => {
      if (activeOperation.current?.requestId === variables.requestId) activeOperation.current = null
      variables.release()
    },
  })

  const operationBusy = checkUpdate.isPending || upgrade.isPending

  function validateSnapshot(snapshot: PluginFormState): boolean {
    if (query.data === undefined) return false
    const built = buildUpdatePayload(snapshot, query.data)
    if (built.ok) {
      setErrors({})
      return true
    }
    setErrors(built.errors)
    setTab('config')
    save.reset()
    focusFirstPluginFieldError(built.errors)
    return false
  }

  function submitSave() {
    if (
      query.data === undefined ||
      form === undefined ||
      save.isPending ||
      del.isPending ||
      operationBusy
    )
      return
    if (!validateSnapshot(form)) return
    save.mutate({ snapshot: form, release: beginBusy(id) })
  }

  async function runCheck(): Promise<void> {
    if (
      query.data === undefined ||
      form === undefined ||
      save.isPending ||
      del.isPending ||
      operationBusy ||
      query.data.sourceKind === 'file'
    )
      return
    const release = beginBusy(id)
    let basis = query.data
    if (dirty) {
      const snapshot = form
      if (!validateSnapshot(snapshot)) {
        release()
        return
      }
      try {
        basis = await save.mutateAsync({ snapshot, release: NOOP_RELEASE })
      } catch {
        release()
        return
      }
      if (stableStringify(formRef.current) !== stableStringify(snapshot)) {
        setOperationNotice('draft-changed')
        release()
        return
      }
    }
    const expectedHash = exactOperationHashOf(basis)
    if (expectedHash === null) {
      setOperationNotice('stale')
      void qc.invalidateQueries({ queryKey: ['plugins', id], exact: true })
      release()
      return
    }
    const request: ActiveOperation = {
      requestId: ++operationSequence.current,
      expectedHash,
      kind: 'check',
    }
    activeOperation.current = request
    setLastOperationKind('check')
    setOperationNotice(null)
    try {
      await checkUpdate.mutateAsync({ ...request, release })
    } catch {
      // ErrorBanner renders the exact mutation error; onSettled releases busy.
    }
  }

  function runUpgrade() {
    const current = query.data
    const expectedHash = exactOperationHashOf(current)
    if (
      current === undefined ||
      expectedHash === null ||
      dirty ||
      save.isPending ||
      del.isPending ||
      operationBusy ||
      current.sourceKind === 'file'
    )
      return
    const request: ActiveOperation = {
      requestId: ++operationSequence.current,
      expectedHash,
      kind: 'upgrade',
    }
    activeOperation.current = request
    setLastOperationKind('upgrade')
    setOperationNotice(null)
    upgrade.mutate({ ...request, release: beginBusy(id) })
  }

  if (form === undefined) {
    if (query.isLoading) return <LoadingState data-testid="plugin-detail-loading" />
    if (query.error !== null && query.error !== undefined)
      return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
    return null
  }

  const resource = query.data
  const displayName = resource?.name ?? id
  const exactResourceHash = exactOperationHashOf(resource)
  const updateCache = qc.getQueryData<PluginUpdatesCache>(PLUGIN_UPDATES_KEY) ?? {}
  const currentUpdate =
    resource === undefined || exactResourceHash === null
      ? undefined
      : pluginUpdateEntry(updateCache, resource)
  const updateReady = resource !== undefined && pluginUpdateAvailable(currentUpdate, resource)
  const canRebaseline = currentUpdate?.identityStatus === 'unknown'

  const tabs: Array<TabDef<PluginTab>> = [
    { key: 'config', label: t('plugins.detailTabConfig'), testid: 'plugin-tab-config' },
    { key: 'updates', label: t('plugins.detailTabUpdates'), testid: 'plugin-tab-updates' },
  ]

  const updatesPanel = (
    <div className="plugin-updates">
      {resource !== undefined && (
        <NoticeBanner
          tone={dirty ? 'warning' : 'info'}
          title={
            dirty ? t('plugins.executionBasisDirtyTitle') : t('plugins.executionBasisSavedTitle')
          }
          size="compact"
        >
          {dirty ? t('plugins.executionBasisDirtyBody') : t('plugins.executionBasisSavedBody')}{' '}
          <code>{exactResourceHash?.slice(0, 12) ?? t('common.emDash')}</code>
        </NoticeBanner>
      )}
      <div className="plugin-updates__row">
        <span className="muted">{t('plugins.colVersion')}</span>
        <code>{resource?.resolvedVersion ?? t('common.emDash')}</code>
      </div>

      {resource?.sourceKind === 'file' ? (
        <NoticeBanner tone="info" size="compact" title={t('plugins.externalManagedTitle')}>
          {t('plugins.externalManagedBody')}
        </NoticeBanner>
      ) : (
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void runCheck()}
            disabled={
              save.isPending ||
              del.isPending ||
              operationBusy ||
              (!dirty && exactResourceHash === null)
            }
            data-testid="plugin-check-update"
          >
            {checkUpdate.isPending
              ? t('plugins.checking')
              : dirty
                ? t('plugins.saveAndCheckButton')
                : t('plugins.checkUpdateButton')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={runUpgrade}
            disabled={
              dirty ||
              save.isPending ||
              del.isPending ||
              operationBusy ||
              exactResourceHash === null ||
              (!updateReady && !canRebaseline)
            }
            data-testid="plugin-upgrade"
          >
            {upgrade.isPending
              ? t('plugins.upgrading')
              : canRebaseline
                ? t('plugins.reinstallBaselineButton')
                : t('plugins.upgradeButton')}
          </button>
        </div>
      )}

      {operationBusy && <LoadingState size="compact" data-testid="plugin-operation-loading" />}
      {!operationBusy &&
        operationNotice === null &&
        checkUpdate.error == null &&
        upgrade.error == null &&
        resource?.sourceKind !== 'file' && (
          <EmptyState
            size="compact"
            title={t('plugins.notCheckedTitle')}
            description={t('plugins.notCheckedBody')}
            data-testid="plugin-update-empty"
          />
        )}
      {operationNotice === 'update-ready' && (
        <NoticeBanner tone="success" size="compact" title={t('plugins.updateReadyTitle')}>
          {t('plugins.updateReadyBody', { version: currentUpdate?.latest ?? t('common.emDash') })}
        </NoticeBanner>
      )}
      {operationNotice === 'no-change' && (
        <NoticeBanner tone="success" size="compact">
          {t('plugins.noUpdateAvailable')}
        </NoticeBanner>
      )}
      {operationNotice === 'identity-unknown' && (
        <NoticeBanner tone="warning" size="compact" title={t('plugins.identityUnknownTitle')}>
          {t('plugins.identityUnknownBody')}
        </NoticeBanner>
      )}
      {operationNotice === 'draft-changed' && (
        <NoticeBanner tone="warning" size="compact">
          {t('plugins.draftChangedDuringSave')}
        </NoticeBanner>
      )}
      {operationNotice === 'stale' && (
        <NoticeBanner tone="warning" size="compact">
          {t('plugins.staleOperationResult')}
        </NoticeBanner>
      )}
      {operationNotice === 'upgraded' && (
        <NoticeBanner tone="success" size="compact">
          {t('plugins.upgradeSuccess')}
        </NoticeBanner>
      )}
      {(checkUpdate.error ?? upgrade.error) != null && (
        <ErrorBanner
          error={checkUpdate.error ?? upgrade.error}
          onRetry={() => (lastOperationKind === 'check' ? void runCheck() : runUpgrade())}
        />
      )}
    </div>
  )

  return (
    <fieldset className="detail-freeze" disabled={del.isPending}>
      <DetailHeaderActions
        title={displayName}
        headingLevel={2}
        acl={{
          resourceBaseUrl: `/api/plugins/${encodeURIComponent(id)}`,
          invalidateKey: ['plugins'],
        }}
        save={{
          label: save.isPending ? t('plugins.saving') : t('plugins.saveButton'),
          onClick: submitSave,
          disabled: save.isPending || del.isPending || operationBusy || !loaded,
          testid: 'plugin-save-button',
        }}
        del={{
          label: t('common.delete'),
          confirmName: displayName,
          resourceType: 'plugin',
          onConfirm: (ctx) => {
            if (save.isPending || del.isPending || operationBusy) return Promise.resolve()
            return del.mutateAsync({ confirm: ctx?.typedConfirm ?? '', release: beginBusy(id) })
          },
          disabled: del.isPending || save.isPending || operationBusy,
        }}
        errors={[save.error, del.error]}
      />

      {query.error !== null && query.error !== undefined && (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      )}

      <div className="agent-form">
        <TabBar
          tabs={tabs}
          active={tab}
          onSelect={setTab}
          ariaLabel={t('plugins.title')}
          idPrefix="plugins-detail"
        />
        <TabPanels
          active={tab}
          idPrefix="plugins-detail"
          className="split__detail-body agent-form__panel"
          panels={[
            {
              key: 'config',
              testid: 'plugin-panel-config',
              content: (
                <PluginFields
                  value={form ?? EMPTY_PLUGIN_FORM}
                  onChange={setForm}
                  nameLocked
                  errors={errors}
                />
              ),
            },
            { key: 'updates', testid: 'plugin-panel-updates', content: updatesPanel },
          ]}
        />
      </div>
    </fieldset>
  )
}
