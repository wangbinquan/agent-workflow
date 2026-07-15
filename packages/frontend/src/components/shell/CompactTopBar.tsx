// RFC-198 PR2 — compact shell bar. The menu and inbox are mutually exclusive
// in AppShell; this component stays presentation-only.

import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { InboxFooterButton } from './InboxFooterButton'

interface CompactTopBarProps {
  menuOpen: boolean
  onOpenMenu: () => void
  menuTriggerRef: RefObject<HTMLButtonElement | null>
  inboxOpen: boolean
  onToggleInbox: () => void
  inboxTriggerRef: RefObject<HTMLButtonElement | null>
}

export function CompactTopBar({
  menuOpen,
  onOpenMenu,
  menuTriggerRef,
  inboxOpen,
  onToggleInbox,
  inboxTriggerRef,
}: CompactTopBarProps) {
  const { t } = useTranslation()
  return (
    <header className="mobile-topbar" data-testid="mobile-topbar">
      <button
        ref={menuTriggerRef}
        type="button"
        className="mobile-topbar__menu"
        data-testid="mobile-menu-trigger"
        aria-label={t('nav.openMenu')}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={onOpenMenu}
      >
        <MenuIcon />
      </button>
      <div className="mobile-topbar__brand" aria-hidden="true">
        {t('nav.brand')}
      </div>
      <InboxFooterButton
        ref={inboxTriggerRef}
        variant="compact"
        open={inboxOpen}
        onToggle={onToggleInbox}
      />
    </header>
  )
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}
