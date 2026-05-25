// RFC-061 follow-up — list page for open SignalKind suspensions.
//
// The unified replacement for the deleted /clarify and /reviews list
// routes. Renders every open suspension (across tasks) as a row with
// a signalKind chip + task / node context. Each row links to
// /suspensions/:id which holds the kind-specific answer form.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Route as RootRoute } from './__root'

export interface SuspensionRow {
  id: string
  taskId: string
  nodeRunId: string
  scope: { nodeId: string; loopIter: number; shardKey: string; iter: number }
  signalKind:
    | 'self-clarify'
    | 'cross-clarify'
    | 'review'
    | 'retry-pending-auto'
    | 'retry-pending-human'
    | 'await-external-data'
  awaitsActor: string
  body: unknown
  createdAt: number
  resolvedAt: number | null
  resolvedByEventId: string | null
}

interface SuspensionsResponse {
  rows: SuspensionRow[]
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/suspensions',
  component: SuspensionsPage,
})

function SuspensionsPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useQuery<SuspensionsResponse>({
    queryKey: ['suspensions', 'list'],
    queryFn: ({ signal }) => api.get('/api/suspensions', undefined, signal),
    refetchInterval: 15_000,
  })

  if (isLoading) return <LoadingState />
  if (error !== null && error !== undefined) return <ErrorBanner error={error} />

  const rows = (data?.rows ?? []).filter((r) => r.signalKind !== 'retry-pending-auto')
  if (rows.length === 0) {
    return (
      <main className="page">
        <header className="page__header">
          <h1>{t('suspensions.title')}</h1>
        </header>
        <EmptyState title={t('suspensions.empty')} />
      </main>
    )
  }

  return (
    <main className="page">
      <header className="page__header">
        <h1>{t('suspensions.title')}</h1>
        <p className="muted">{t('suspensions.hint')}</p>
      </header>
      <ul className="page__section suspensions__list">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              to="/suspensions/$id"
              params={{ id: r.id }}
              className="suspensions__row"
              data-testid={`suspension-row-${r.id}`}
            >
              <span className={`suspensions__kind suspensions__kind--${kindClass(r.signalKind)}`}>
                {kindLabel(t, r.signalKind)}
              </span>
              <span className="suspensions__node">{r.scope.nodeId}</span>
              <span className="muted">
                {t('suspensions.taskHint', { id: r.taskId.slice(0, 10) })}
              </span>
              <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}

export function kindLabel(t: (key: string) => string, k: SuspensionRow['signalKind']): string {
  switch (k) {
    case 'self-clarify':
      return t('nav.inbox.suspensionKindSelfClarify')
    case 'cross-clarify':
      return t('nav.inbox.suspensionKindCrossClarify')
    case 'review':
      return t('nav.inbox.suspensionKindReview')
    case 'retry-pending-auto':
      return t('nav.inbox.suspensionKindRetryAuto')
    case 'retry-pending-human':
      return t('nav.inbox.suspensionKindRetryHuman')
    case 'await-external-data':
      return t('nav.inbox.suspensionKindAwaitExternal')
  }
}

export function kindClass(k: SuspensionRow['signalKind']): string {
  if (k === 'review') return 'review'
  if (k.includes('clarify')) return 'clarify'
  if (k.startsWith('retry')) return 'retry'
  return 'other'
}
