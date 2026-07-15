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

import type { ReactNode } from 'react'

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
}

export function TabBar<K extends string>({
  tabs,
  active,
  onSelect,
  variant,
  ariaLabel,
  className,
  rootTestid,
}: TabBarProps<K>) {
  const classes =
    'tabs' +
    (variant !== undefined && variant !== 'default' ? ' tabs--' + variant : '') +
    (className !== undefined && className !== '' ? ' ' + className : '')
  return (
    <div className={classes} role="tablist" aria-label={ariaLabel} data-testid={rootTestid}>
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={'tabs__tab' + (isActive ? ' tabs__tab--active' : '')}
            data-testid={tab.testid}
            disabled={tab.disabled}
            onClick={() => onSelect(tab.key)}
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
