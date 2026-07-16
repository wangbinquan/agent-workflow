// RFC-150 — shared tab strip primitive (`.tabs` CSS namespace).
//
// One component for every horizontal tab bar (settings / skills.new /
// reviews / clarify / memory / NodeInspector / NodeDetailDrawer /
// tasks.detail main tabs, …). DOM shape matches the pre-existing hand-rolled
// form so the `.tabs` CSS modifiers and role/aria locks keep working:
//   <div class="tabs[ tabs--<variant>][ className]" role="tablist">
//     <button type="button" role="tab" aria-selected=…
//             class="tabs__tab[ tabs__tab--active]">label[ <span
//             class="tabs__tab-badge">badge</span>]
//
// Vertical roving-tabindex tablists (WorktreeDiffPanel / StructuralDiffView
// file trees) are a different primitive shape and stay out of v1 (design §D2).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

export function tabDomIds(prefix: string, key: string) {
  return {
    tabId: `${prefix}-tab-${key}`,
    panelId: `${prefix}-panel-${key}`,
  }
}

export type TabBadgeTone = 'neutral' | 'attention' | 'danger'

interface TabDefBase<K extends string> {
  key: K
  label: ReactNode
  /** Temporarily prevent selection while the owning task is busy. */
  disabled?: boolean
  /**
   * Optional count/badge pill rendered as `<span class="tabs__tab-badge">`
   * (tasks.detail pending-question count). Pass undefined/null/false to
   * render no badge (`count > 0 && count` works as-is).
   */
  badge?: ReactNode
  testid?: string
  /**
   * Explicit data-testid for the badge <span> itself (tasks.detail's
   * `tq-tab-badge`). Only rendered when the badge renders.
   */
  badgeTestid?: string
}

type TabBadgeStatus =
  | {
      /** Counts are neutral by default. */
      badgeTone?: 'neutral'
      badgeAriaLabel?: string
    }
  | {
      /** Actionable or blocking states must have equivalent accessible text. */
      badgeTone: Exclude<TabBadgeTone, 'neutral'>
      badgeAriaLabel: string
    }

export type TabDef<K extends string> = TabDefBase<K> & TabBadgeStatus

interface TabBarBaseProps<K extends string> {
  tabs: ReadonlyArray<TabDef<K>>
  active: K
  onSelect: (k: K) => void
  /** Maps to the existing `.tabs--<variant>` CSS modifiers; 'default' adds none. */
  variant?: 'default' | 'inline' | 'inspector' | 'segment'
  /** Extra class names appended after the standard `tabs` chain. */
  className?: string
  /** Explicit container data-testid (memory.tsx's `memory-tab-bar`). */
  rootTestid?: string
  /** Stable DOM id namespace shared with the matching TabPanels. */
  idPrefix?: string
  /** Whether moving focus also selects the focused tab. */
  activation?: 'automatic' | 'manual'
  /** Optional override for contexts that need a more specific scroll-control name. */
  scrollStartAriaLabel?: string
  scrollEndAriaLabel?: string
}

type TabBarAccessibleName =
  | { ariaLabel: string; ariaLabelledBy?: never }
  | { ariaLabel?: never; ariaLabelledBy: string }

export type TabBarProps<K extends string> = TabBarBaseProps<K> & TabBarAccessibleName

interface TabOverflowState {
  hasOverflow: boolean
  canScrollStart: boolean
  canScrollEnd: boolean
}

const INITIAL_OVERFLOW_STATE: TabOverflowState = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
}

// Scroll metrics can settle on fractional CSS pixels at zoom levels other
// than 100%. Treat a one-pixel remainder as an edge so controls do not flash.
const SCROLL_EDGE_TOLERANCE = 1
const SCROLL_PAGE_RATIO = 0.7

export const TAB_SCROLL_START_ARIA_LABEL = 'Show more sections before'
export const TAB_SCROLL_END_ARIA_LABEL = 'Show more sections after'

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function deriveOverflowState(tablist: HTMLDivElement): TabOverflowState {
  const { clientWidth, scrollLeft, scrollWidth } = tablist
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  const hasOverflow = maxScrollLeft > SCROLL_EDGE_TOLERANCE
  return {
    hasOverflow,
    canScrollStart: hasOverflow && scrollLeft > SCROLL_EDGE_TOLERANCE,
    canScrollEnd: hasOverflow && maxScrollLeft - scrollLeft > SCROLL_EDGE_TOLERANCE,
  }
}

function scrollTabIntoView(tab: HTMLButtonElement) {
  if (typeof tab.scrollIntoView !== 'function') return
  tab.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  })
}

export function TabBar<K extends string>({
  tabs,
  active,
  onSelect,
  variant,
  ariaLabel,
  ariaLabelledBy,
  className,
  rootTestid,
  idPrefix,
  activation = 'automatic',
  scrollStartAriaLabel,
  scrollEndAriaLabel,
}: TabBarProps<K>) {
  const { t } = useTranslation()
  const resolvedScrollStartAriaLabel =
    scrollStartAriaLabel ?? t('tabBar.scrollStart', { defaultValue: TAB_SCROLL_START_ARIA_LABEL })
  const resolvedScrollEndAriaLabel =
    scrollEndAriaLabel ?? t('tabBar.scrollEnd', { defaultValue: TAB_SCROLL_END_ARIA_LABEL })
  const enabledKeys = useMemo(
    () => tabs.filter((tab) => !tab.disabled).map((tab) => tab.key),
    [tabs],
  )
  const activeIsEnabled = enabledKeys.includes(active)
  const defaultRovingKey = activeIsEnabled ? active : enabledKeys[0]
  const [rovingKey, setRovingKey] = useState<K | undefined>(defaultRovingKey)
  const previousActiveRef = useRef(active)
  const tabRefs = useRef(new Map<K, HTMLButtonElement>())
  const tablistRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<TabOverflowState>(INITIAL_OVERFLOW_STATE)

  const measureOverflow = useCallback(() => {
    const tablist = tablistRef.current
    if (tablist === null) return
    const next = deriveOverflowState(tablist)
    setOverflow((current) =>
      current.hasOverflow === next.hasOverflow &&
      current.canScrollStart === next.canScrollStart &&
      current.canScrollEnd === next.canScrollEnd
        ? current
        : next,
    )
  }, [])

  useLayoutEffect(() => {
    const tablist = tablistRef.current
    if (tablist === null) return

    // The first paint should already know whether affordances are needed;
    // ResizeObserver delivery is intentionally not the initial measurement.
    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measureOverflow)
    observer.observe(tablist)
    // A label or badge can grow without changing the tablist's own content
    // box, so observe each direct tab as well as the scroll container.
    for (const tab of tabRefs.current.values()) observer.observe(tab)
    return () => observer.disconnect()
  }, [measureOverflow, tabs])

  useEffect(() => {
    const activeChanged = previousActiveRef.current !== active
    previousActiveRef.current = active
    setRovingKey((current) => {
      if (activeChanged) return defaultRovingKey
      if (current !== undefined && enabledKeys.includes(current)) return current
      return defaultRovingKey
    })
  }, [active, activeIsEnabled, defaultRovingKey, enabledKeys])

  useEffect(() => {
    if (!activeIsEnabled) return
    const activeTab = tabRefs.current.get(active)
    if (activeTab !== undefined) scrollTabIntoView(activeTab)
  }, [active, activeIsEnabled])

  const moveFocus = (from: K, direction: 'previous' | 'next' | 'first' | 'last') => {
    if (enabledKeys.length === 0) return
    const currentIndex = enabledKeys.indexOf(from)
    let targetIndex: number
    switch (direction) {
      case 'first':
        targetIndex = 0
        break
      case 'last':
        targetIndex = enabledKeys.length - 1
        break
      case 'previous':
        targetIndex = (Math.max(currentIndex, 0) - 1 + enabledKeys.length) % enabledKeys.length
        break
      case 'next':
        targetIndex = (Math.max(currentIndex, -1) + 1) % enabledKeys.length
        break
    }
    const targetKey = enabledKeys[targetIndex]
    if (targetKey === undefined) return
    setRovingKey(targetKey)
    tabRefs.current.get(targetKey)?.focus()
    if (activation === 'automatic' && targetKey !== from) onSelect(targetKey)
  }

  const handleKeyDown = (key: K, event: KeyboardEvent<HTMLButtonElement>) => {
    if (tabs.find((tab) => tab.key === key)?.disabled) return
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        moveFocus(key, 'previous')
        break
      case 'ArrowRight':
        event.preventDefault()
        moveFocus(key, 'next')
        break
      case 'Home':
        event.preventDefault()
        moveFocus(key, 'first')
        break
      case 'End':
        event.preventDefault()
        moveFocus(key, 'last')
        break
      case ' ':
      case 'Enter':
        if (activation !== 'manual') return
        event.preventDefault()
        setRovingKey(key)
        onSelect(key)
        break
    }
  }

  const classes =
    'tabs' +
    (variant !== undefined && variant !== 'default' ? ' tabs--' + variant : '') +
    (className !== undefined && className !== '' ? ' ' + className : '')
  const viewportClasses =
    'tabs-viewport' +
    (variant !== undefined && variant !== 'default' ? ' tabs-viewport--' + variant : '')

  const scrollByPage = (direction: 'start' | 'end') => {
    const tablist = tablistRef.current
    if (tablist === null || typeof tablist.scrollBy !== 'function') return
    tablist.scrollBy({
      left: (direction === 'start' ? -1 : 1) * tablist.clientWidth * SCROLL_PAGE_RATIO,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }

  return (
    <div
      className={viewportClasses}
      data-has-overflow={overflow.hasOverflow}
      data-overflow-start={overflow.canScrollStart}
      data-overflow-end={overflow.canScrollEnd}
    >
      {overflow.hasOverflow && (
        <button
          type="button"
          className="tabs-viewport__scroll tabs-viewport__scroll--start"
          aria-label={resolvedScrollStartAriaLabel}
          disabled={!overflow.canScrollStart}
          onClick={() => scrollByPage('start')}
        >
          <span aria-hidden="true">&#8249;</span>
        </button>
      )}
      <div
        ref={tablistRef}
        className={classes}
        role="tablist"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-testid={rootTestid}
        onScroll={measureOverflow}
      >
        {tabs.map((tab) => {
          const isActive = tab.key === active
          const ids = idPrefix === undefined ? undefined : tabDomIds(idPrefix, tab.key)
          const badgeTone = tab.badgeTone ?? 'neutral'
          return (
            <button
              key={tab.key}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(tab.key)
                else tabRefs.current.set(tab.key, element)
              }}
              type="button"
              role="tab"
              id={ids?.tabId}
              aria-controls={ids?.panelId}
              aria-selected={isActive}
              tabIndex={!tab.disabled && tab.key === rovingKey ? 0 : -1}
              className={'tabs__tab' + (isActive ? ' tabs__tab--active' : '')}
              data-testid={tab.testid}
              disabled={tab.disabled}
              onClick={() => {
                setRovingKey(tab.key)
                onSelect(tab.key)
              }}
              onKeyDown={(event) => handleKeyDown(tab.key, event)}
            >
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null && tab.badge !== false && (
                <span
                  className={`tabs__tab-badge tabs__tab-badge--${badgeTone}`}
                  data-tone={badgeTone}
                  data-testid={tab.badgeTestid}
                  aria-label={tab.badgeAriaLabel}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <span className="tabs-viewport__hint" aria-hidden="true" />
      {overflow.hasOverflow && (
        <button
          type="button"
          className="tabs-viewport__scroll tabs-viewport__scroll--end"
          aria-label={resolvedScrollEndAriaLabel}
          disabled={!overflow.canScrollEnd}
          onClick={() => scrollByPage('end')}
        >
          <span aria-hidden="true">&#8250;</span>
        </button>
      )}
    </div>
  )
}
