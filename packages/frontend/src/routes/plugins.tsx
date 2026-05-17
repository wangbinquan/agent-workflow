// RFC-031 — /plugins list. Mirrors /agents, /skills, /mcps exactly: header
// row with title + primary "New plugin" Link, table of rows linking to
// /plugins/$id detail page. No inline editor — create / edit live on their
// own routes for parity with the other resources.
//
// Inline actions kept on each row:
//   - "Check for update" → POST /api/plugins/:id/check-update (no cache write)
//   - "Upgrade"          → POST /api/plugins/:id/upgrade (re-install + swap)
// Both stay here because they're per-row operations that don't require
// opening the detail page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plugin } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/plugins',
  component: PluginsPage,
})

function PluginsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Plugin[]>({
    queryKey: ['plugins'],
    queryFn: ({ signal }) => api.get('/api/plugins', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/plugins/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })

  const [updateInfo, setUpdateInfo] = useState<Record<string, { latest: string | null }>>({})

  const checkUpdate = useMutation({
    mutationFn: async (
      id: string,
    ): Promise<{ available: boolean; current: string | null; latest: string | null }> =>
      api.post(`/api/plugins/${encodeURIComponent(id)}/check-update`),
    onSuccess: (result, id) => setUpdateInfo((s) => ({ ...s, [id]: { latest: result.latest } })),
  })

  const upgrade = useMutation({
    mutationFn: async (id: string): Promise<Plugin> =>
      api.post<Plugin>(`/api/plugins/${encodeURIComponent(id)}/upgrade`),
    onSuccess: (_p, id) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      setUpdateInfo((s) => {
        const next = { ...s }
        delete next[id]
        return next
      })
    },
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('plugins.title')}</h1>
          <p className="page__hint">{t('plugins.hint')}</p>
        </div>
        <Link to="/plugins/new" className="btn btn--primary">
          {t('plugins.newButton')}
        </Link>
      </header>

      {isLoading && <LoadingState data-testid="plugins-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && del.error !== undefined && <ErrorBanner error={del.error} />}
      {checkUpdate.error !== null && checkUpdate.error !== undefined && (
        <ErrorBanner error={checkUpdate.error} />
      )}
      {upgrade.error !== null && upgrade.error !== undefined && (
        <ErrorBanner error={upgrade.error} />
      )}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('plugins.emptyList')} data-testid="plugins-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('plugins.colName')}</th>
              <th>{t('plugins.colSpec')}</th>
              <th>{t('plugins.colSource')}</th>
              <th>{t('plugins.colVersion')}</th>
              <th>{t('plugins.colEnabled')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => {
              const upd = updateInfo[p.id]
              const isCheckingThis = checkUpdate.isPending && checkUpdate.variables === p.id
              const isUpgradingThis = upgrade.isPending && upgrade.variables === p.id
              const updateAvailable =
                upd !== undefined && upd.latest !== null && upd.latest !== p.resolvedVersion
              return (
                <tr key={p.id} data-testid={`plugin-row-${p.name}`}>
                  <td className="data-table__nowrap">
                    <Link to="/plugins/$id" params={{ id: p.id }} className="data-table__link">
                      {p.name}
                    </Link>
                  </td>
                  <td className="data-table__truncate" title={p.spec}>
                    <code className="muted">{p.spec}</code>
                  </td>
                  <td className="data-table__nowrap">
                    <span className="chip chip--tight">{p.sourceKind}</span>
                  </td>
                  <td className="data-table__nowrap">
                    {p.resolvedVersion ?? t('common.emDash')}
                    {updateAvailable && (
                      <span className="chip chip--tight" data-testid={`plugin-update-${p.name}`}>
                        {' → '}
                        {upd.latest}
                      </span>
                    )}
                  </td>
                  <td>{p.enabled ? t('common.yes') : t('common.no')}</td>
                  <td className="data-table__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => checkUpdate.mutate(p.id)}
                      disabled={isCheckingThis}
                      data-testid={`plugin-check-update-${p.name}`}
                    >
                      {isCheckingThis ? t('plugins.checking') : t('plugins.checkUpdateButton')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => upgrade.mutate(p.id)}
                      disabled={isUpgradingThis || !updateAvailable}
                      data-testid={`plugin-upgrade-${p.name}`}
                    >
                      {isUpgradingThis ? t('plugins.upgrading') : t('plugins.upgradeButton')}
                    </button>
                    <Link to="/plugins/$id" params={{ id: p.id }} className="btn btn--sm">
                      {t('common.open')}
                    </Link>
                    <ConfirmButton
                      label={t('common.delete')}
                      onConfirm={() => del.mutateAsync(p.id)}
                      danger
                      disabled={del.isPending}
                      size="sm"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
