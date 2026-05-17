// Root route — shared layout + auth gate.
//
// If no token is present in localStorage, every route except /auth redirects
// to /auth so the user can paste the daemon token. The daemon prints it at
// startup.
//
// RFC-032 PR2: the workflows group no longer surfaces /reviews + /clarify
// as visible sub-items. Both are now reachable via the unified inbox drawer
// triggered by the footer button; detail-page deep links still get the
// workflows-group highlight via `resolveActiveNav`'s fallback.

import { Link, Outlet, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSwitch } from '@/components/LanguageSwitch'
import { InboxDrawer } from '@/components/shell/InboxDrawer'
import { InboxFooterButton } from '@/components/shell/InboxFooterButton'
import { NavGroup } from '@/components/shell/NavGroup'
import { SettingsGearButton } from '@/components/shell/SettingsGearButton'
import { useApplyLanguage } from '@/hooks/useLanguage'
import { useApplyTheme } from '@/hooks/useTheme'
import { NAV_GROUPS, resolveActiveNav } from '@/lib/nav'
import { getToken, subscribeAuth } from '@/stores/auth'

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
  useApplyLanguage()
  // RFC-032 PR2: inbox-drawer open state lifted here so the footer button
  // and the drawer can share it. Reviews + clarify pending-count queries
  // moved inside <InboxFooterButton> (still keyed `['reviews','pending-count']`
  // and `['clarify','pending-count']` so older tests + cached data align).
  const [inboxOpen, setInboxOpen] = useState(false)

  if (pathname === '/auth' || token === null) {
    return (
      <div className="app-shell app-shell--bare">
        <Outlet />
      </div>
    )
  }

  const active = resolveActiveNav(pathname)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <svg
            className="sidebar__brand-icon"
            viewBox="0 0 64 64"
            width="52"
            height="52"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="aw-stream-a"
                x1="0"
                y1="0"
                x2="64"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#10b981" />
                <stop offset="1" stopColor="#06b6d4" />
              </linearGradient>
              <linearGradient
                id="aw-stream-b"
                x1="0"
                y1="0"
                x2="64"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#3b82f6" />
                <stop offset="1" stopColor="#a855f7" />
              </linearGradient>
              <linearGradient
                id="aw-stream-c"
                x1="0"
                y1="0"
                x2="64"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ec4899" />
                <stop offset="1" stopColor="#f97316" />
              </linearGradient>
            </defs>
            <path
              d="M 6 22 Q 22 12, 32 22 T 58 22"
              fill="none"
              stroke="url(#aw-stream-a)"
              strokeWidth="4"
              strokeLinecap="round"
              opacity="0.95"
            />
            <path
              d="M 6 32 Q 22 22, 32 32 T 58 32"
              fill="none"
              stroke="url(#aw-stream-b)"
              strokeWidth="4"
              strokeLinecap="round"
              opacity="0.95"
            />
            <path
              d="M 6 42 Q 22 32, 32 42 T 58 42"
              fill="none"
              stroke="url(#aw-stream-c)"
              strokeWidth="4"
              strokeLinecap="round"
              opacity="0.95"
            />
          </svg>
          <span>{t('nav.brand')}</span>
        </div>
        <nav className="sidebar__nav">
          <Link
            to="/"
            className={`nav-item nav-item--home${active.onHome ? ' nav-item--active' : ''}`}
            activeOptions={{ exact: true }}
            activeProps={{ className: 'nav-item nav-item--home nav-item--active' }}
          >
            <span className="nav-item__label">{t('nav.home')}</span>
          </Link>
          {NAV_GROUPS.map((group) => (
            <NavGroup key={group.key} group={group} active={active} />
          ))}
        </nav>
        <InboxFooterButton open={inboxOpen} onToggle={() => setInboxOpen((v) => !v)} />
        <div className="sidebar__footer">
          <LanguageSwitch />
          <SettingsGearButton active={active.onSettings} />
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
      <InboxDrawer open={inboxOpen} onClose={() => setInboxOpen(false)} />
    </div>
  )
}
