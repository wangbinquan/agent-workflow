// Agents list page. Each row links to the detail editor.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ResourceNameCell } from '@/components/ResourceNameCell'
import { RUNTIMES_QUERY_KEY } from '@/components/RuntimeList'
import { StatusChip } from '@/components/StatusChip'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents',
  component: AgentsPage,
})

function AgentsPage() {
  const { t } = useTranslation()
  // RFC-151 PR-3 — shared list shell: query + delete mutation + owner lookup.
  const { data, isLoading, error, del, owners } = useResourceList<Agent>({
    queryKey: ['agents'],
    endpoint: '/api/agents',
    deleteBy: 'name',
  })

  // RFC-115: show each agent's runtime; agents that didn't pick one fall back to
  // the global default runtime (config.defaultRuntime → the registry row flagged
  // isDefault). Reuse the same ['runtimes'] query key as the settings list.
  const runtimes = useQuery<{ runtimes: Array<{ name: string; isDefault: boolean }> }>({
    queryKey: RUNTIMES_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
  })
  const defaultRuntimeName = runtimes.data?.runtimes.find((r) => r.isDefault)?.name

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('agents.title')}</h1>
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
              <th>{t('agents.colRuntime')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <ResourceNameCell
                  to="/agents/$name"
                  params={{ name: a.name }}
                  name={a.name}
                  visibility={a.visibility}
                  ownerUserId={a.ownerUserId}
                  owners={owners}
                />
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
                <td className="data-table__nowrap">
                  {a.runtime ?? defaultRuntimeName ?? t('common.emDash')}
                  {a.runtime == null && defaultRuntimeName != null && (
                    <StatusChip kind="neutral" size="sm">
                      {t('agents.runtimeDefaultTag')}
                    </StatusChip>
                  )}
                </td>
                <td className="data-table__actions">
                  {a.builtin !== true && (
                    <Link
                      to="/tasks/new"
                      search={{ kind: 'agent', agent: a.name }}
                      className="btn btn--sm"
                      data-testid={`agent-row-launch-${a.name}`}
                    >
                      {t('taskWizard.launchEntry')}
                    </Link>
                  )}
                  <Link to="/agents/$name" params={{ name: a.name }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <ConfirmButton
                    label={t('common.delete')}
                    onConfirm={() => del.mutateAsync(a)}
                    variant="danger"
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
