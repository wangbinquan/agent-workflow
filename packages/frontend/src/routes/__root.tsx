// Root route — shared layout + auth gate.
//
// If no token is present in localStorage, every route except /auth redirects
// to /auth so the user can paste the daemon token. The daemon prints it at
// startup.

import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyPendingCount, ReviewPendingCount } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useApplyTheme } from '@/hooks/useTheme'
import { getToken, subscribeAuth } from '@/stores/auth'

type NavKey = 'agents' | 'skills' | 'workflows' | 'tasks' | 'reviews' | 'clarify' | 'settings'
const NAV: { to: string; key: NavKey }[] = [
  { to: '/agents', key: 'agents' },
  { to: '/skills', key: 'skills' },
  { to: '/workflows', key: 'workflows' },
  { to: '/tasks', key: 'tasks' },
  { to: '/reviews', key: 'reviews' },
  { to: '/clarify', key: 'clarify' },
  { to: '/settings', key: 'settings' },
]

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (location.pathname === '/auth') return
    if (getToken() === null) {
      throw redirect({ to: '/auth', search: { redirect: location.pathname } })
    }
  },
  component: RootComponent,
})

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

function RootComponent() {
  const token = useAuthToken()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { t } = useTranslation()
  useApplyTheme()
  // RFC-005: Reviews nav badge — periodically poll the pending-count endpoint.
  // Disabled when not signed in to avoid 401 spam.
  const pending = useQuery<ReviewPendingCount>({
    queryKey: ['reviews', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/reviews/pending-count', undefined, signal),
    enabled: token !== null,
    refetchInterval: 15000,
  })
  const pendingCount = pending.data?.count ?? 0
  // RFC-023: same pattern for clarify pending sessions.
  const clarifyPending = useQuery<ClarifyPendingCount>({
    queryKey: ['clarify', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/clarify/pending-count', undefined, signal),
    enabled: token !== null,
    refetchInterval: 15000,
  })
  const clarifyPendingCount = clarifyPending.data?.count ?? 0

  if (pathname === '/auth' || token === null) {
    return (
      <div className="app-shell app-shell--bare">
        <Outlet />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">{t('nav.brand')}</div>
        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="sidebar__link"
              activeProps={{ className: 'sidebar__link sidebar__link--active' }}
            >
              {t(`nav.${item.key}`)}
              {item.key === 'reviews' && pendingCount > 0 && (
                <span className="sidebar__badge" aria-label={`${pendingCount} pending reviews`}>
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
              {item.key === 'clarify' && clarifyPendingCount > 0 && (
                <span
                  className="sidebar__badge"
                  data-testid="clarify-nav-badge"
                  aria-label={t('clarify.nav.badgeTitle', { count: clarifyPendingCount })}
                >
                  {clarifyPendingCount > 99 ? '99+' : clarifyPendingCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
