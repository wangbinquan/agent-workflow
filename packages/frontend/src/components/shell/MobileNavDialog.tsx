// RFC-198 PR2 — mobile navigation sheet using the shared Dialog lifecycle.

import { useRef, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import type { ActiveNav, SubNavItem } from '@/lib/nav'
import { ShellNavigation } from './ShellNavigation'

interface MobileNavDialogProps {
  active: ActiveNav
  onClose: () => void
  onNavigate: (destination: string) => void
  onNavigationHandled: () => void
  triggerRef: RefObject<HTMLButtonElement | null>
  restoreFocusFallbackRef: RefObject<HTMLElement | null>
  footer: ReactNode
  renderBadge?: (item: SubNavItem) => ReactNode
}

export function MobileNavDialog({
  active,
  onClose,
  onNavigate,
  onNavigationHandled,
  triggerRef,
  restoreFocusFallbackRef,
  footer,
  renderBadge,
}: MobileNavDialogProps) {
  const { t } = useTranslation()
  const initialFocusRef = useRef<HTMLAnchorElement | null>(null)

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('nav.brand')}
      initialFocusRef={initialFocusRef}
      triggerRef={triggerRef}
      restoreFocusFallbackRef={restoreFocusFallbackRef}
      footer={footer}
      overlayClassName="dialog__overlay--sheet-start"
      panelClassName="mobile-nav-dialog"
      data-testid="mobile-nav-dialog"
    >
      <ShellNavigation
        active={active}
        mode="mobile"
        onNavigate={onNavigate}
        onNavigationHandled={onNavigationHandled}
        focusTargetRef={initialFocusRef}
        renderBadge={renderBadge}
      />
    </Dialog>
  )
}
