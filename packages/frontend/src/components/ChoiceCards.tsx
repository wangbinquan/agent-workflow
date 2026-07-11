// RFC-165 UI 精修 — card-style single-choice group (用户 2026-07-11：向导
// 选择项卡片化，替代全宽 Segmented 的线框感)。
//
// A radiogroup of bordered cards, each carrying an optional icon, a bold
// label and a muted one-line description — the scannable middle ground
// between a Segmented strip (no room for descriptions) and a full table.
// Same a11y contract as Segmented (role=radiogroup/radio + aria-checked,
// testid `${testidPrefix}-${value}`), so call sites migrating from Segmented
// keep their test anchors.
//
// Keyboard: Tab reaches the group (roving tabindex on the checked card),
// Arrow keys move the selection, Space/Enter select the focused card —
// standard radio-group behaviour.

import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface ChoiceCardOption<V extends string> {
  value: V
  label: string
  /** One-line muted description under the label. */
  description?: string
  /** Leading icon (inline SVG idiom — stroke="currentColor"). */
  icon?: ReactNode
  disabled?: boolean
  /** Extra hint shown as the native tooltip. */
  title?: string
}

interface ChoiceCardsProps<V extends string> {
  value: V
  options: ReadonlyArray<ChoiceCardOption<V>>
  onChange: (v: V) => void
  /** Disable every card (per-option `disabled` also supported). */
  disabled?: boolean
  ariaLabel?: string
  /** data-testid per card: `${testidPrefix}-${value}`. */
  testidPrefix?: string
  className?: string
}

export function ChoiceCards<V extends string>(props: ChoiceCardsProps<V>) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  const enabled = props.options.filter((o) => !(props.disabled === true || o.disabled === true))
  // Roving tab stop: the checked card when usable, else the first enabled
  // card — a native disabled button is skipped by Tab, which would make the
  // whole group keyboard-unreachable (Codex P2).
  const checkedEnabled = enabled.some((o) => o.value === props.value)
  const tabStopValue = checkedEnabled ? props.value : enabled[0]?.value
  const move = (from: V, dir: 1 | -1) => {
    if (enabled.length === 0) return
    const idx = enabled.findIndex((o) => o.value === from)
    const next = enabled[(idx + dir + enabled.length) % enabled.length]
    if (next !== undefined && next.value !== from) {
      props.onChange(next.value)
      // Keep focus on the newly-checked card (roving tabindex).
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-choice-value="${next.value}"]`)
        ?.focus()
    }
  }
  const onKeyDown = (e: KeyboardEvent, value: V) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(value, 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(value, -1)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`choice-cards${props.className ? ` ${props.className}` : ''}`}
      role="radiogroup"
      aria-label={props.ariaLabel}
      data-testid={props.testidPrefix}
    >
      {props.options.map((opt) => {
        const active = opt.value === props.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={opt.value === tabStopValue ? 0 : -1}
            data-choice-value={opt.value}
            className={'choice-card' + (active ? ' choice-card--active' : '')}
            disabled={props.disabled === true || opt.disabled === true}
            title={opt.title}
            data-testid={
              props.testidPrefix !== undefined ? `${props.testidPrefix}-${opt.value}` : undefined
            }
            onClick={() => {
              if (!active) props.onChange(opt.value)
            }}
            onKeyDown={(e) => onKeyDown(e, opt.value)}
          >
            {opt.icon !== undefined && (
              <span className="choice-card__icon" aria-hidden="true">
                {opt.icon}
              </span>
            )}
            <span className="choice-card__body">
              <span className="choice-card__label">{opt.label}</span>
              {opt.description !== undefined && (
                <span className="choice-card__desc">{opt.description}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
