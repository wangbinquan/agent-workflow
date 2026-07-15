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
import { useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSwitch } from '@/components/LanguageSwitch'
import { UserMenu } from '@/components/UserMenu'
import { usePermission } from '@/hooks/useActor'
import { InboxDrawer } from '@/components/shell/InboxDrawer'
import { InboxFooterButton } from '@/components/shell/InboxFooterButton'
import { MemoryPendingBadge } from '@/components/shell/MemoryPendingBadge'
import { NavGroup } from '@/components/shell/NavGroup'
import { SettingsGearButton } from '@/components/shell/SettingsGearButton'
import { useApplyLanguage } from '@/hooks/useLanguage'
import { useApplyTheme } from '@/hooks/useTheme'
import { NAV_GROUPS, resolveActiveNav } from '@/lib/nav'
import { getToken, subscribeAuth } from '@/stores/auth'
import { setInboxOpen, toggleInboxOpen, useInboxOpen } from '@/stores/inbox'

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (location.pathname === '/auth') return
    if (getToken() === null) {
      // RFC-105: store the full relative href (pathname + search), not just
      // pathname, so a shared deep link with search params — e.g. a Markdown
      // preview `/tasks/t/preview?path=docs/report.md` — survives the login
      // round-trip instead of collapsing to the invalid-link state.
      throw redirect({ to: '/auth', search: { redirect: location.href } })
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
  const inboxTriggerRef = useRef<HTMLButtonElement>(null)
  // RFC-036 — the `#aw_session=` fragment from the OIDC callback is
  // consumed at module-init time inside @/stores/auth.ts (so the token
  // is set BEFORE TanStack Router's beforeLoad gate inspects it).
  // Nothing else to do here on cold boot.
  // RFC-032 PR2: inbox-drawer open state. Lifted into a module-level store
  // (stores/inbox.ts) so call sites outside the root subtree — typically
  // the Homepage's "Open Inbox" section link — can pop the drawer without
  // prop-drilling through the auth gate. Reviews + clarify pending-count
  // queries still live inside <InboxFooterButton> (keyed
  // `['reviews','pending-count']` and `['clarify','pending-count']`).
  const inboxOpen = useInboxOpen()

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
            <NavGroup
              key={group.key}
              group={group}
              active={active}
              // RFC-041 PR4 follow-up: only the memory group needs a per-row
              // badge today. NavGroup hands each sub-item to renderBadge so
              // the lookup stays declarative — adding more grouped badges
              // later just extends this switch.
              renderBadge={
                group.key === 'memory'
                  ? (item) => (item.to === '/memory' ? <MemoryPendingBadge /> : null)
                  : undefined
              }
            />
          ))}
        </nav>
        <InboxFooterButton ref={inboxTriggerRef} open={inboxOpen} onToggle={toggleInboxOpen} />
        <div className="sidebar__footer">
          <UserMenu />
          <div className="sidebar__footer-row">
            <LanguageSwitch />
            <AdminGear active={active.onSettings} />
          </div>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
      <InboxDrawer
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        triggerRef={inboxTriggerRef}
      />
    </div>
  )
}

/**
 * RFC-036 — gear icon is rendered only when the actor has settings:read
 * (admins only). Hooks must run unconditionally so this thin wrapper
 * encapsulates that. Regular-user sidebar has the LanguageSwitch +
 * UserMenu but no gear icon (matches the design spec: zero DOM, not
 * disabled).
 */
function AdminGear({ active }: { active: boolean }) {
  const allowed = usePermission('settings:read')
  if (!allowed) return null
  return <SettingsGearButton active={active} />
}
