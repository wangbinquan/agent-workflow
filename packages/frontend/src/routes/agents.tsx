// Agents list page. Each row links to the detail editor.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents',
  component: AgentsPage,
})

function AgentsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/agents/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('agents.title')}</h1>
          <p className="page__hint">{t('agents.hint')}</p>
        </div>
        <Link to="/agents/new" className="btn btn--primary">
          {t('agents.newButton')}
        </Link>
      </header>

      {isLoading && <LoadingState data-testid="agents-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('agents.emptyList')} data-testid="agents-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('agents.colName')}</th>
              <th>{t('agents.colDescription')}</th>
              <th>{t('agents.colOutputs')}</th>
              <th>{t('agents.colReadonly')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td className="data-table__nowrap">
                  <Link to="/agents/$name" params={{ name: a.name }} className="data-table__link">
                    {a.name}
                  </Link>
                </td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={a.description || undefined}
                >
                  {a.description || t('common.emDash')}
                </td>
                <td>
                  {a.outputs.length === 0 ? (
                    <span className="muted">{t('common.emDash')}</span>
                  ) : (
                    <span className="chip-row">
                      {a.outputs.map((o) => (
                        <span className="chip chip--tight" key={o}>
                          {o}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td>{a.readonly ? t('common.yes') : t('common.no')}</td>
                <td className="data-table__actions">
                  <Link to="/agents/$name" params={{ name: a.name }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <ConfirmButton
                    label={t('common.delete')}
                    onConfirm={() => del.mutateAsync(a.name)}
                    danger
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
