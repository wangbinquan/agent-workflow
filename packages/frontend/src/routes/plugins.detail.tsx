// Plugin detail / edit page — the right rail of the /plugins split page.
//
// RFC-169 (T17): child route under the /plugins layout (path '/$id'), two tabs
// (Config / Updates). The check-update + upgrade actions moved here from the
// list row; check-update writes the shared ['plugins','updates'] cache (with a
// spec + resolvedVersion fingerprint) so the list card can light up its chip.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plugin } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PluginFields } from '@/components/PluginFields'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import {
  PLUGIN_UPDATES_KEY,
  pluginUpdateAvailable,
  type PluginUpdatesCache,
} from '@/lib/plugin-updates'
import {
  buildUpdatePayload,
  EMPTY_PLUGIN_FORM,
  pluginToForm,
  type PluginFormState,
} from '@/lib/plugin-form'
import { Route as pluginsRoute } from './plugins'

export const Route = createRoute({
  getParentRoute: () => pluginsRoute,
  path: '/$id',
  component: PluginDetailPage,
  remountDeps: ({ params }) => params,
})

type PluginTab = 'config' | 'updates'

function PluginDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { report } = useSplitDirty()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<PluginTab>('config')

  const query = useQuery<Plugin>({
    queryKey: ['plugins', id],
    queryFn: ({ signal }) => api.get(`/api/plugins/${encodeURIComponent(id)}`, undefined, signal),
  })

  const {
    draft: form,
    setDraft: setForm,
    loaded,
    dirty,
    commitSaved,
  } = useDraftFromQuery(query.data, pluginToForm, { followWhenClean: true })
  useReportSplitDirty(id, dirty)

  const dropUpdateEntry = () =>
    qc.setQueryData<PluginUpdatesCache>(PLUGIN_UPDATES_KEY, (prev) => {
      if (prev === undefined || prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })

  const save = useMutation({
    mutationFn: (snapshot: PluginFormState): Promise<Plugin> => {
      if (query.data === undefined) return Promise.reject(new Error('not loaded'))
      const built = buildUpdatePayload(snapshot, query.data)
      if (!built.ok) return Promise.reject(new Error('invalid form'))
      return api.put<Plugin>(`/api/plugins/${encodeURIComponent(id)}`, built.payload)
    },
    onSuccess: async (p, snapshot) => {
      await qc.cancelQueries({ queryKey: ['plugins', id], exact: true })
      qc.setQueryData(['plugins', id], p)
      await qc.cancelQueries({ queryKey: ['plugins'], exact: true })
      qc.setQueryData<Plugin[]>(['plugins'], (rows) =>
        rows === undefined ? rows : rows.map((r) => (r.id === id ? p : r)),
      )
      void qc.invalidateQueries({ queryKey: ['plugins'], exact: true })
      dropUpdateEntry() // spec may have changed → stale check
      commitSaved(snapshot, pluginToForm(p))
    },
  })

  function submitSave() {
    if (query.data === undefined || form === undefined) return
    const built = buildUpdatePayload(form, query.data)
    if (!built.ok) {
      setErrors(built.errors)
      save.reset()
      return
    }
    setErrors({})
    save.mutate(form)
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/plugins/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      report(id, false)
      await qc.cancelQueries({ queryKey: ['plugins'], exact: true })
      qc.setQueryData<Plugin[]>(['plugins'], (rows) =>
        rows === undefined ? rows : rows.filter((r) => r.id !== id),
      )
      void qc.invalidateQueries({ queryKey: ['plugins'], exact: true })
      dropUpdateEntry()
      navigate({ to: '/plugins' })
    },
  })

  const checkUpdate = useMutation({
    mutationFn: (): Promise<{
      available: boolean
      current: string | null
      latest: string | null
    }> => api.post(`/api/plugins/${encodeURIComponent(id)}/check-update`),
    onSuccess: (result) => {
      if (query.data === undefined) return
      qc.setQueryData<PluginUpdatesCache>(PLUGIN_UPDATES_KEY, (prev) => ({
        ...(prev ?? {}),
        [id]: {
          spec: query.data!.spec,
          resolvedVersion: query.data!.resolvedVersion,
          latest: result.latest,
        },
      }))
    },
  })

  const upgrade = useMutation({
    mutationFn: (): Promise<Plugin> =>
      api.post<Plugin>(`/api/plugins/${encodeURIComponent(id)}/upgrade`),
    onSuccess: (p) => {
      qc.setQueryData(['plugins', id], p)
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      dropUpdateEntry()
    },
  })

  if (form === undefined) {
    if (query.isLoading) return <LoadingState data-testid="plugin-detail-loading" />
    if (query.error !== null && query.error !== undefined)
      return <ErrorBanner error={query.error} />
    return null
  }

  const displayName = query.data?.name ?? id
  const updateCache = qc.getQueryData<PluginUpdatesCache>(PLUGIN_UPDATES_KEY) ?? {}
  const updateReady = query.data !== undefined && pluginUpdateAvailable(updateCache[id], query.data)

  const tabs: Array<TabDef<PluginTab>> = [
    { key: 'config', label: t('plugins.detailTabConfig'), testid: 'plugin-tab-config' },
    { key: 'updates', label: t('plugins.detailTabUpdates'), testid: 'plugin-tab-updates' },
  ]

  const updatesPanel = (
    <div className="plugin-updates">
      <div className="plugin-updates__row">
        <span className="muted">{t('plugins.colVersion')}</span>
        <code>{query.data?.resolvedVersion ?? t('common.emDash')}</code>
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => checkUpdate.mutate()}
          disabled={checkUpdate.isPending}
          data-testid="plugin-check-update"
        >
          {checkUpdate.isPending ? t('plugins.checking') : t('plugins.checkUpdateButton')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => upgrade.mutate()}
          disabled={upgrade.isPending || !updateReady}
          data-testid="plugin-upgrade"
        >
          {upgrade.isPending ? t('plugins.upgrading') : t('plugins.upgradeButton')}
        </button>
      </div>
      {updateReady && (
        <div className="plugin-updates__available" data-testid="plugin-update-latest">
          {t('plugins.updateAvailableChip')}: <code>{updateCache[id]?.latest}</code>
        </div>
      )}
      {(checkUpdate.error ?? upgrade.error) != null && (
        <ErrorBanner error={checkUpdate.error ?? upgrade.error} />
      )}
    </div>
  )

  return (
    <fieldset className="detail-freeze" disabled={del.isPending}>
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/plugins/${encodeURIComponent(id)}`,
          invalidateKey: ['plugins'],
        }}
        save={{
          label: save.isPending ? t('plugins.saving') : t('plugins.saveButton'),
          onClick: submitSave,
          disabled: save.isPending || !loaded,
          testid: 'plugin-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        errors={[save.error, del.error]}
      >
        <div>
          <h2>{displayName}</h2>
        </div>
      </DetailHeaderActions>

      <div className="agent-form">
        <TabBar tabs={tabs} active={tab} onSelect={setTab} ariaLabel={t('plugins.title')} />
        <TabPanels
          active={tab}
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
