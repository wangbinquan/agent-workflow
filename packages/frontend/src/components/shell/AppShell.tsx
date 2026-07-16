// RFC-198 PR2 — responsive authenticated application shell.
//
// Exactly one navigation/footer/inbox-trigger tree is mounted at a time. The
// 900px media query is the only shell breakpoint; content primitives retain
// their separate 720px stacking contract in CSS.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSwitch } from '@/components/LanguageSwitch'
import { UserMenu } from '@/components/UserMenu'
import { usePermission } from '@/hooks/useActor'
import { resolveActiveNav, type ActiveNav, type SubNavItem } from '@/lib/nav'
import { setInboxOpen, toggleInboxOpen, useInboxOpen } from '@/stores/inbox'
import { CompactTopBar } from './CompactTopBar'
import { InboxDrawer } from './InboxDrawer'
import { InboxFooterButton } from './InboxFooterButton'
import { MemoryPendingBadge } from './MemoryPendingBadge'
import { MobileNavDialog } from './MobileNavDialog'
import { RouteCommitFocus } from './RouteTransitionState'
import { SettingsGearButton } from './SettingsGearButton'
import { ShellNavigation } from './ShellNavigation'

const COMPACT_SHELL_QUERY = '(max-width: 900px)'

function compactSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(COMPACT_SHELL_QUERY).matches
}

function subscribeCompactShell(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(COMPACT_SHELL_QUERY)
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }
  media.addListener(onChange)
  return () => media.removeListener(onChange)
}

export function useCompactShell(): boolean {
  return useSyncExternalStore(subscribeCompactShell, compactSnapshot, () => false)
}

interface AppShellProps {
  pathname: string
  children: ReactNode
}

export function AppShell({ pathname, children }: AppShellProps) {
  const compact = useCompactShell()
  const active = resolveActiveNav(pathname)
  const inboxOpen = useInboxOpen()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const inboxTriggerRef = useRef<HTMLButtonElement | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const pendingNavigationRef = useRef<string | null>(null)
  const previousCompactRef = useRef(compact)

  const renderAccessory = useCallback(
    (item: SubNavItem) => (item.to === '/memory' ? <MemoryPendingBadge /> : null),
    [],
  )

  const openMobileNav = useCallback(() => {
    pendingNavigationRef.current = null
    setInboxOpen(false)
    setMobileNavOpen(true)
  }, [])

  const closeMobileNav = useCallback(() => {
    setMobileNavOpen(false)
  }, [])

  const prepareMobileNavigation = useCallback((destination: string) => {
    // This must happen synchronously before the Link's own router click. If an
    // UnsavedChangesGuard blocks the transition, its Stay/ESC focus restore
    // therefore lands on the stable topbar trigger, not an unmounted sheet link.
    focusStableTrigger(menuTriggerRef.current)
    pendingNavigationRef.current = destination
    setMobileNavOpen(false)
  }, [])

  const toggleCompactInbox = useCallback(() => {
    pendingNavigationRef.current = null
    setMobileNavOpen(false)
    toggleInboxOpen()
  }, [])

  useEffect(() => {
    if (!compact || !inboxOpen || !mobileNavOpen) return
    pendingNavigationRef.current = null
    setMobileNavOpen(false)
  }, [compact, inboxOpen, mobileNavOpen])

  useEffect(() => {
    const wasCompact = previousCompactRef.current
    previousCompactRef.current = compact
    if (!wasCompact || compact) return

    pendingNavigationRef.current = null
    setMobileNavOpen(false)
    if (!mobileNavOpen) return
    mainRef.current?.focus({ preventScroll: true })
  }, [compact, mobileNavOpen])

  return (
    <div className={`app-shell${compact ? ' app-shell--compact' : ''}`}>
      {compact ? (
        <CompactTopBar
          menuOpen={mobileNavOpen && !inboxOpen}
          onOpenMenu={openMobileNav}
          menuTriggerRef={menuTriggerRef}
          inboxOpen={inboxOpen}
          onToggleInbox={toggleCompactInbox}
          inboxTriggerRef={inboxTriggerRef}
        />
      ) : (
        <aside className="sidebar desktop-sidebar" data-testid="desktop-sidebar">
          <ShellBrand />
          <ShellNavigation active={active} mode="desktop" renderAccessory={renderAccessory} />
          <InboxFooterButton ref={inboxTriggerRef} open={inboxOpen} onToggle={toggleInboxOpen} />
          <ShellFooter active={active} />
        </aside>
      )}

      <main ref={mainRef} className="content" tabIndex={-1} data-testid="app-shell-main">
        {children}
      </main>

      <RouteCommitFocus
        pathname={pathname}
        mainRef={mainRef}
        pendingNavigationRef={pendingNavigationRef}
      />

      {compact && mobileNavOpen && !inboxOpen && (
        <MobileNavDialog
          active={active}
          onClose={closeMobileNav}
          onNavigate={prepareMobileNavigation}
          triggerRef={menuTriggerRef}
          restoreFocusFallbackRef={mainRef}
          renderAccessory={renderAccessory}
          footer={<ShellFooter active={active} onNavigate={prepareMobileNavigation} />}
        />
      )}

      <InboxDrawer
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        triggerRef={inboxTriggerRef}
      />
    </div>
  )
}

function ShellBrand() {
  const { t } = useTranslation()
  return (
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
  )
}

function ShellFooter({
  active,
  onNavigate,
}: {
  active: ActiveNav
  onNavigate?: (destination: string) => void
}) {
  const captureNavigation = (event: MouseEvent<HTMLDivElement>) => {
    if (onNavigate === undefined) return
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.defaultPrevented
    ) {
      return
    }
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest<HTMLAnchorElement>('a[href]')
    if (link !== null) {
      onNavigate(link.pathname)
      return
    }
    if (target.closest('.settings-gear') !== null) onNavigate('/settings')
  }

  return (
    <div className="sidebar__footer shell-footer" onClickCapture={captureNavigation}>
      <UserMenu />
      <div className="sidebar__footer-row">
        <LanguageSwitch />
        <AdminGear active={active.onSettings} />
      </div>
    </div>
  )
}

function focusStableTrigger(trigger: HTMLButtonElement | null): void {
  if (trigger === null) return
  // Dialog's focus trap is still mounted for the remainder of this click's
  // capture/bubble path. Suppress only this one programmatic focusin at the
  // trigger, otherwise the trap would synchronously yank focus back to the
  // soon-to-unmount link before TanStack Link/dirty-guard sees the event.
  const keepFocusOutsideClosingDialog = (event: FocusEvent) => event.stopPropagation()
  trigger.addEventListener('focusin', keepFocusOutsideClosingDialog)
  try {
    trigger.focus({ preventScroll: true })
  } finally {
    trigger.removeEventListener('focusin', keepFocusOutsideClosingDialog)
  }
}

function AdminGear({ active }: { active: boolean }) {
  const allowed = usePermission('settings:read')
  if (!allowed) return null
  return <SettingsGearButton active={active} />
}
