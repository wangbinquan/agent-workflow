// One portal boundary for application UI.
//
// React Activity disconnects effects and hides ordinary host descendants, but
// a portal targeting document.body is outside that host tree. AppShell scopes
// routed content with RoutePortalScope so permission refreshes can remove every
// routed overlay/popover while preserving the owning component's local state.

import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const RoutePortalActiveContext = createContext(true)

export function RoutePortalScope({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <RoutePortalActiveContext.Provider value={active}>{children}</RoutePortalActiveContext.Provider>
  )
}

export function AppPortal({
  children,
  target,
}: {
  children: ReactNode
  target?: Element | DocumentFragment
}) {
  const active = useContext(RoutePortalActiveContext)
  if (!active || typeof document === 'undefined') return null
  return createPortal(children, target ?? document.body)
}
