// RFC-036 — minimal styled select. The native <select> element shows a
// browser-chrome popup that no amount of CSS on the <option> elements can
// restyle, which clashes with the rest of the dialog. This component
// renders a custom trigger + popover panel so the dropdown matches the
// surrounding inputs.
//
// API: drop-in replacement for the common (value, onChange, options) shape.
// Accessibility: role=combobox + aria-controls/expanded + role=listbox /
// option + arrow-key + Home/End + Enter/Space + Esc.

import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePopoverPosition } from '@/hooks/usePopoverPosition'

export interface SelectOption<V extends string> {
  value: V
  label: string
  description?: string
  disabled?: boolean
  /** Optional compact status carried by both the closed value and option row. */
  badge?: ReactNode
  badgeTone?: 'neutral' | 'attention' | 'danger'
  badgeAriaLabel?: string
  /**
   * Optional group label. Consecutive options sharing the same non-empty
   * `group` render under a single non-interactive header — the unified
   * replacement for the native `<optgroup>` (used by ModelSelect's
   * provider grouping). Options must already be ordered so same-group
   * entries are adjacent; the header shows whenever `group` changes.
   */
  group?: string
  /** Status for the non-interactive group header rendered before this option. */
  groupBadge?: ReactNode
  groupBadgeTone?: 'neutral' | 'attention' | 'danger'
  groupBadgeAriaLabel?: string
}

function hasBadge(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false
}

function OptionBadge({
  value,
  tone = 'neutral',
  ariaLabel,
}: {
  value: ReactNode
  tone?: 'neutral' | 'attention' | 'danger'
  ariaLabel?: string
}) {
  if (!hasBadge(value)) return null
  return (
    <span
      className={`select__badge select__badge--${tone}`}
      data-tone={tone}
      aria-label={ariaLabel}
    >
      {value}
    </span>
  )
}

function OptionTitle<V extends string>({ option }: { option: SelectOption<V> }) {
  return (
    <span className="select__option-title-row">
      <span>{option.label}</span>
      <OptionBadge value={option.badge} tone={option.badgeTone} ariaLabel={option.badgeAriaLabel} />
    </span>
  )
}

interface Props<V extends string> {
  value: V
  options: ReadonlyArray<SelectOption<V>>
  onChange: (v: V) => void
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
  /** Extra class names appended to the trigger button. */
  className?: string
  /** Optional focus/restore handle for Dialog contracts. */
  triggerRef?: Ref<HTMLButtonElement>
  /** name attribute on the hidden input so the value lands in `form` submits. */
  name?: string
  /** Forwarded to the trigger button so callers migrated from a native
   *  `<select data-testid>` keep the same test anchor. */
  'data-testid'?: string
  /** Render a custom row body. Default = `option.label`. */
  renderOption?: (opt: SelectOption<V>) => React.ReactNode
  /**
   * RFC-165 UI 精修 — show a filter input at the top of the popover and
   * narrow the options to case-insensitive label/value matches. Keyboard
   * focus lands on the input; arrows/Enter/Escape keep working.
   */
  searchable?: boolean
  /**
   * Render the trigger's selected-value display. Default = `option.label`.
   * Useful when the option rows are rich (icons, badges, mono-font sub-text)
   * and the same layout should appear on the closed trigger button.
   */
  renderValue?: (opt: SelectOption<V>) => React.ReactNode
}

export function Select<V extends string>(props: Props<V>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      props.options.findIndex((o) => o.value === props.value),
    ),
  )
  // The list every render path (keyboard nav, aria ids, option rows) works
  // on. Without `searchable` it is exactly props.options, so the pre-existing
  // behaviour is untouched.
  const visible = useMemo(() => {
    if (props.searchable !== true) return props.options
    const q = query.trim().toLowerCase()
    if (q === '') return props.options
    return props.options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    )
  }, [props.options, props.searchable, query])
  // Listbox is portaled out of the trigger's parent so containers with
  // overflow:hidden (e.g. .data-table — used for border-radius rounding)
  // don't clip it. We position it manually with the trigger's
  // bounding rect each time it opens / on scroll / on resize.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const popoverId = useId()
  const labelId = useId()
  // RFC-173 (T1): portal positioning extracted to the shared hook (was a
  // byte-identical copy here and in UserPicker).
  const popPos = usePopoverPosition(triggerRef, open)

  const current = useMemo(
    () => props.options.find((o) => o.value === props.value),
    [props.options, props.value],
  )

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) === false && listRef.current?.contains(t) === false) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Focus the listbox (or the filter input) when opening so keys work
  // immediately; reset the filter on every open.
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) {
      setQuery('')
      // Re-align the active row with the CURRENT selection on every open.
      // The same Select instance may receive a new value while hidden (for
      // example KindSelect's Advanced → Guided transition); retaining its old
      // index would make an immediate Enter silently choose another option.
      setActiveIndex(
        Math.max(
          0,
          props.options.findIndex((o) => o.value === props.value),
        ),
      )
      const t = window.setTimeout(() => {
        if (props.searchable === true) searchRef.current?.focus()
        else listRef.current?.focus()
      }, 0)
      return () => window.clearTimeout(t)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
    }
  }

  function onListKey(e: React.KeyboardEvent<HTMLElement>) {
    // CJK IME: Enter/arrows while composing commit the composition — they
    // must never select an option or move the active row (Codex P1).
    if (e.nativeEvent.isComposing) return
    const last = visible.length - 1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(last, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(last)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = visible[activeIndex]
      if (opt && !opt.disabled) {
        props.onChange(opt.value)
        setOpen(false)
        triggerRef.current?.focus()
      }
    } else if (e.key === ' ' && props.searchable !== true) {
      // Space selects in the plain listbox; in searchable mode it types.
      e.preventDefault()
      const opt = visible[activeIndex]
      if (opt && !opt.disabled) {
        props.onChange(opt.value)
        setOpen(false)
        triggerRef.current?.focus()
      }
    } else if (e.key === 'Escape') {
      // A Select can live inside a Dialog. Consume the first Escape here so
      // it closes only this listbox; a subsequent Escape may then close the
      // surrounding Dialog. Without this, the event reaches Dialog's window
      // listener and dismisses both layers at once (RFC-194).
      e.stopPropagation()
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="select" data-open={open}>
      {props.name && <input type="hidden" name={props.name} value={props.value} />}
      <button
        type="button"
        role="combobox"
        ref={(node) => {
          triggerRef.current = node
          if (typeof props.triggerRef === 'function') props.triggerRef(node)
          else if (props.triggerRef !== null && props.triggerRef !== undefined) {
            props.triggerRef.current = node
          }
        }}
        className={`select__trigger ${props.className ?? ''}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-labelledby={props.ariaLabel ? undefined : labelId}
        aria-label={props.ariaLabel}
        data-testid={props['data-testid']}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span id={labelId} className="select__value">
          {current ? (
            props.renderValue ? (
              props.renderValue(current)
            ) : (
              <OptionTitle option={current} />
            )
          ) : (
            (props.placeholder ?? '')
          )}
        </span>
        <span className="select__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        popPos &&
        createPortal(
          <ul
            id={popoverId}
            ref={listRef}
            tabIndex={-1}
            role="listbox"
            aria-label={props.ariaLabel ?? t('common.selectAnOption')}
            aria-activedescendant={`${popoverId}-opt-${activeIndex}`}
            className="select__listbox select__listbox--portal"
            onKeyDown={onListKey}
            style={{
              position: 'absolute',
              left: popPos.left,
              top: popPos.top,
              minWidth: popPos.width,
            }}
          >
            {props.searchable === true && (
              <li className="select__search" role="presentation">
                <input
                  ref={searchRef}
                  className="select__search-input"
                  value={query}
                  placeholder={t('common.searchEllipsis')}
                  aria-label={props.ariaLabel ?? t('common.searchEllipsis')}
                  aria-controls={popoverId}
                  aria-activedescendant={`${popoverId}-opt-${activeIndex}`}
                  data-testid={
                    props['data-testid'] !== undefined
                      ? `${props['data-testid']}-search`
                      : undefined
                  }
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActiveIndex(0)
                  }}
                  onKeyDown={(e) => {
                    // Handle once here — without stopPropagation the same
                    // event bubbles to the <ul onKeyDown> and every arrow
                    // moves two rows / Enter fires twice (Codex P1).
                    e.stopPropagation()
                    onListKey(e)
                  }}
                />
              </li>
            )}
            {visible.length === 0 && (
              <li className="select__empty" role="presentation">
                {t('common.noMatches')}
              </li>
            )}
            {visible.map((opt, i) => {
              const active = i === activeIndex
              const selected = opt.value === props.value
              // Render a group header whenever the (non-empty) group changes
              // from the previous option. Index `i` is the VISIBLE index so
              // keyboard nav / aria-activedescendant stay aligned.
              const prevGroup = i > 0 ? visible[i - 1]?.group : undefined
              const showHeader =
                opt.group !== undefined && opt.group !== '' && opt.group !== prevGroup
              return (
                <Fragment key={opt.value}>
                  {showHeader && (
                    <li className="select__group" role="presentation">
                      <span>{opt.group}</span>
                      <OptionBadge
                        value={opt.groupBadge}
                        tone={opt.groupBadgeTone}
                        ariaLabel={opt.groupBadgeAriaLabel}
                      />
                    </li>
                  )}
                  <li
                    id={`${popoverId}-opt-${i}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={opt.disabled || undefined}
                    className={`select__option ${active ? 'select__option--active' : ''} ${
                      selected ? 'select__option--selected' : ''
                    }`.trim()}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => {
                      // mousedown not click — keeps focus from leaving before we close
                      e.preventDefault()
                      if (opt.disabled) return
                      props.onChange(opt.value)
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}
                  >
                    <span className="select__option-label">
                      {/* RFC-187 TRAP-1 (Codex impl-gate P2): `description` existed on
                          SelectOption but was never rendered — a dead prop. Render it
                          via the existing stack/title/sub vocabulary (zero new CSS) so
                          advisory / not-ready copy actually reaches the user; callers
                          already setting it benefit together. renderOption keeps full
                          control when provided. */}
                      {props.renderOption ? (
                        props.renderOption(opt)
                      ) : opt.description !== undefined && opt.description !== '' ? (
                        <span className="select__option-stack">
                          <span className="select__option-title">
                            <OptionTitle option={opt} />
                          </span>
                          <span className="select__option-sub">{opt.description}</span>
                        </span>
                      ) : (
                        <OptionTitle option={opt} />
                      )}
                    </span>
                    {selected && (
                      <span className="select__option-check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </li>
                </Fragment>
              )
            })}
          </ul>,
          document.body,
        )}
    </div>
  )
}
