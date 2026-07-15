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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export function tabDomIds(prefix: string, key: string) {
  return {
    tabId: `${prefix}-tab-${key}`,
    panelId: `${prefix}-panel-${key}`,
  }
}

export interface TabDef<K extends string> {
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

interface TabBarProps<K extends string> {
  tabs: ReadonlyArray<TabDef<K>>
  active: K
  onSelect: (k: K) => void
  /** Maps to the existing `.tabs--<variant>` CSS modifiers; 'default' adds none. */
  variant?: 'default' | 'inline' | 'inspector' | 'segment'
  ariaLabel?: string
  /** Extra class names appended after the standard `tabs` chain. */
  className?: string
  /** Explicit container data-testid (memory.tsx's `memory-tab-bar`). */
  rootTestid?: string
  /** Stable DOM id namespace shared with the matching TabPanels. */
  idPrefix?: string
  /** Whether moving focus also selects the focused tab. */
  activation?: 'automatic' | 'manual'
}

function scrollTabIntoView(tab: HTMLButtonElement) {
  if (typeof tab.scrollIntoView !== 'function') return
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  tab.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: reduceMotion ? 'auto' : 'smooth',
  })
}

export function TabBar<K extends string>({
  tabs,
  active,
  onSelect,
  variant,
  ariaLabel,
  className,
  rootTestid,
  idPrefix,
  activation = 'automatic',
}: TabBarProps<K>) {
  const enabledKeys = useMemo(
    () => tabs.filter((tab) => !tab.disabled).map((tab) => tab.key),
    [tabs],
  )
  const activeIsEnabled = enabledKeys.includes(active)
  const defaultRovingKey = activeIsEnabled ? active : enabledKeys[0]
  const [rovingKey, setRovingKey] = useState<K | undefined>(defaultRovingKey)
  const previousActiveRef = useRef(active)
  const tabRefs = useRef(new Map<K, HTMLButtonElement>())

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
  return (
    <div className={classes} role="tablist" aria-label={ariaLabel} data-testid={rootTestid}>
      {tabs.map((tab) => {
        const isActive = tab.key === active
        const ids = idPrefix === undefined ? undefined : tabDomIds(idPrefix, tab.key)
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
              <span className="tabs__tab-badge" data-testid={tab.badgeTestid}>
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
