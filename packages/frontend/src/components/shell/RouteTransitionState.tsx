// RFC-198 PR2 — protected-route transition placeholder + route-commit focus.
//
// The placeholder prevents a stale protected Outlet from flashing while the
// root auth redirect is committing. RouteCommitFocus is deliberately separate:
// only navigation initiated from the compact sheet moves focus into the new
// page; ordinary desktop navigation keeps the browser's native focus behavior.

import { useEffect, useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingState } from '@/components/LoadingState'

export function RouteTransitionState() {
  const { t } = useTranslation()
  return (
    <div className="route-transition-state" data-testid="route-transition-state">
      <LoadingState size="compact" label={t('common.redirectingToLogin')} />
    </div>
  )
}

interface RouteCommitFocusProps {
  pathname: string
  mainRef: RefObject<HTMLElement | null>
  pendingNavigationRef: RefObject<string | null>
}

function focusRouteTarget(main: HTMLElement): void {
  const heading = main.querySelector<HTMLElement>('h1')
  if (heading === null) {
    main.focus({ preventScroll: true })
    return
  }

  const hadTabIndex = heading.hasAttribute('tabindex')
  if (!hadTabIndex) heading.tabIndex = -1
  heading.focus({ preventScroll: true })
  if (!hadTabIndex) {
    heading.addEventListener(
      'blur',
      () => {
        heading.removeAttribute('tabindex')
      },
      { once: true },
    )
  }
}

export function RouteCommitFocus({
  pathname,
  mainRef,
  pendingNavigationRef,
}: RouteCommitFocusProps) {
  const previousPathnameRef = useRef(pathname)

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return
    previousPathnameRef.current = pathname
    const destination = pendingNavigationRef.current
    if (destination === null) return
    pendingNavigationRef.current = null
    if (pathname !== destination) return

    const timer = window.setTimeout(() => {
      const main = mainRef.current
      if (main !== null) focusRouteTarget(main)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [mainRef, pathname, pendingNavigationRef])

  return null
}
