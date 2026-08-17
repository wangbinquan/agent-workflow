// RFC-198 PR2 — the single navigation tree shared by desktop and mobile shells.

import { Link } from '@tanstack/react-router'
import { useLayoutEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ResourceIcon } from '@/components/icons/resourceIcons'
import { NAV_GROUPS, type ActiveNav, type SubNavItem } from '@/lib/nav'
import { NavGroup } from './NavGroup'

export interface ShellNavigationProps {
  active: ActiveNav
  mode: 'desktop' | 'mobile'
  onNavigate?: (destination: string) => void
  /** Bubble-phase close, after Link has handed the transition to the router. */
  onNavigationHandled?: () => void
  focusTargetRef?: RefObject<HTMLAnchorElement | null>
  renderBadge?: (item: SubNavItem) => ReactNode
}

export function ShellNavigation({
  active,
  mode,
  onNavigate,
  onNavigationHandled,
  focusTargetRef,
  renderBadge,
}: ShellNavigationProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement | null>(null)
  // NavGroup stays the single owner of grouped nav rows. Resolve its rendered
  // anchor after commit so Dialog still gets a deterministic initial-focus ref
  // without duplicating the NAV_GROUPS map or changing NavGroup's public API.
  useLayoutEffect(() => {
    if (mode !== 'mobile' || focusTargetRef === undefined) return
    const wantedHref = active.activeItemTo ?? '/'
    focusTargetRef.current =
      Array.from(navRef.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []).find(
        (link) =>
          link.pathname === wantedHref &&
          (wantedHref === '/' || link.classList.contains('nav-item__main')),
      ) ?? null
  }, [active.activeItemTo, focusTargetRef, mode])

  const navigationDestination = (event: MouseEvent<HTMLElement>): string | null => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return null
    }
    const target = event.target
    if (!(target instanceof Element)) return null
    const link = target.closest<HTMLAnchorElement>('a[href]')
    return link?.pathname ?? null
  }

  const captureNavigation = (event: MouseEvent<HTMLElement>) => {
    const destination = navigationDestination(event)
    if (destination !== null) onNavigate?.(destination)
  }

  const completeNavigation = (event: MouseEvent<HTMLElement>) => {
    if (navigationDestination(event) !== null) onNavigationHandled?.()
  }

  return (
    <nav
      ref={navRef}
      className={`sidebar__nav shell-navigation shell-navigation--${mode}`}
      aria-label={t('nav.brand')}
      data-testid={`shell-navigation-${mode}`}
      onClickCapture={captureNavigation}
      onClick={completeNavigation}
    >
      <Link
        to="/"
        className={`nav-item nav-item--home${active.onHome ? ' nav-item--active' : ''}`}
        aria-current={active.onHome ? 'page' : undefined}
        activeOptions={{ exact: true }}
      >
        <span className="nav-item__icon" aria-hidden="true">
          <ResourceIcon name="home" />
        </span>
        <span className="nav-item__label">{t('nav.home')}</span>
      </Link>

      {NAV_GROUPS.map((group) => (
        <NavGroup key={group.key} group={group} active={active} renderBadge={renderBadge} />
      ))}
    </nav>
  )
}
