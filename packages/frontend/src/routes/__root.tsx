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

import { Outlet, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { AppShell } from '@/components/shell/AppShell'
import { RouteTransitionState } from '@/components/shell/RouteTransitionState'
import { useApplyLanguage } from '@/hooks/useLanguage'
import { useApplyTheme } from '@/hooks/useTheme'
import { getToken, subscribeAuth } from '@/stores/auth'

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

export function RootComponent() {
  const token = useAuthToken()
  const location = useRouterState({
    select: (s) => ({ pathname: s.location.pathname, href: s.location.href }),
  })
  useApplyTheme()
  useApplyLanguage()
  // RFC-036 — the `#aw_session=` fragment from the OIDC callback is
  // consumed at module-init time inside @/stores/auth.ts (so the token
  // is set BEFORE TanStack Router's beforeLoad gate inspects it).
  // Nothing else to do here on cold boot.
  if (location.pathname !== '/auth' && token === null) {
    return <AuthLossRedirect redirect={location.href} />
  }
  return (
    <RootShell pathname={location.pathname} token={token}>
      <Outlet />
    </RootShell>
  )
}

function AuthLossRedirect({ redirect }: { redirect: string }) {
  const navigate = Route.useNavigate()
  useEffect(() => {
    void navigate({ to: '/auth', search: { redirect }, replace: true })
  }, [navigate, redirect])
  return (
    <BareShell>
      <RouteTransitionState />
    </BareShell>
  )
}

export function RootShell({
  pathname,
  token,
  children,
}: {
  pathname: string
  token: string | null
  children: ReactNode
}) {
  if (pathname === '/auth') {
    return <BareShell>{children}</BareShell>
  }
  if (token === null) {
    return (
      <BareShell>
        <RouteTransitionState />
      </BareShell>
    )
  }
  return <AppShell pathname={pathname}>{children}</AppShell>
}

function BareShell({ children }: { children: ReactNode }) {
  return <div className="app-shell app-shell--bare">{children}</div>
}
