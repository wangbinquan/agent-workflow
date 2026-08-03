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

function firstEnabledIndex<V extends string>(options: ReadonlyArray<SelectOption<V>>): number {
  return options.findIndex((option) => option.disabled !== true)
}

function lastEnabledIndex<V extends string>(options: ReadonlyArray<SelectOption<V>>): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (options[index]?.disabled !== true) return index
  }
  return -1
}

function moveEnabledIndex<V extends string>(
  options: ReadonlyArray<SelectOption<V>>,
  current: number,
  direction: 1 | -1,
): number {
  let index = current
  if (index < 0) return direction === 1 ? firstEnabledIndex(options) : lastEnabledIndex(options)
  while (true) {
    index += direction
    if (index < 0 || index >= options.length) return current
    if (options[index]?.disabled !== true) return index
  }
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
  // Keep the highlighted option by its stable identity, never by its current
  // array position. Async inventories can reorder while the popover is open;
  // retaining an index would make Enter commit whichever value moved into it.
  const [activeValue, setActiveValue] = useState<V | null>(() => {
    const selected = props.options.find(
      (option) => option.value === props.value && option.disabled !== true,
    )
    return selected?.value ?? props.options[firstEnabledIndex(props.options)]?.value ?? null
  })
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
  const activeIndex = visible.findIndex(
    (option) => option.value === activeValue && option.disabled !== true,
  )
  // Listbox is portaled out of the trigger's parent so containers with
  // overflow:hidden (e.g. .data-table — used for border-radius rounding)
  // don't clip it. We position it manually with the trigger's
  // bounding rect each time it opens / on scroll / on resize.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const openIntentRef = useRef<'selected' | 'first' | 'last'>('selected')
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | null>(null)
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
      // Re-align the active row with the CURRENT selection on every open.
      // The same Select instance may receive a new value while hidden (for
      // example KindSelect's Advanced → Guided transition).
      const selected = props.options.find(
        (option) => option.value === props.value && option.disabled !== true,
      )
      const nextOption =
        openIntentRef.current === 'first'
          ? props.options[firstEnabledIndex(props.options)]
          : openIntentRef.current === 'last'
            ? props.options[lastEnabledIndex(props.options)]
            : selected !== undefined
              ? selected
              : props.options[firstEnabledIndex(props.options)]
      setActiveValue(nextOption?.value ?? null)
      const t = window.setTimeout(() => {
        if (props.searchable === true) searchRef.current?.focus()
        else listRef.current?.focus()
      }, 0)
      return () => window.clearTimeout(t)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    setActiveValue((currentValue) => {
      const stillAvailable = visible.some(
        (option) => option.value === currentValue && option.disabled !== true,
      )
      if (stillAvailable) return currentValue
      return visible[firstEnabledIndex(visible)]?.value ?? null
    })
  }, [open, visible])

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
    },
    [],
  )

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openIntentRef.current =
        e.key === 'ArrowUp' ? 'last' : e.key === 'ArrowDown' ? 'first' : 'selected'
      setQuery('')
      setOpen(true)
    }
  }

  function onListKey(e: React.KeyboardEvent<HTMLElement>) {
    // CJK IME: Enter/arrows while composing commit the composition — they
    // must never select an option or move the active row (Codex P1).
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveValue((value) => {
        const index = visible.findIndex(
          (option) => option.value === value && option.disabled !== true,
        )
        const next = visible[moveEnabledIndex(visible, index, 1)]
        return next?.value ?? value
      })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveValue((value) => {
        const index = visible.findIndex(
          (option) => option.value === value && option.disabled !== true,
        )
        const next = visible[moveEnabledIndex(visible, index, -1)]
        return next?.value ?? value
      })
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveValue(visible[firstEnabledIndex(visible)]?.value ?? null)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveValue(visible[lastEnabledIndex(visible)]?.value ?? null)
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
    } else if (
      props.searchable !== true &&
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const key = e.key.toLocaleLowerCase()
      typeaheadRef.current += key
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = ''
        typeaheadTimerRef.current = null
      }, 500)
      const findMatch = (needle: string): number => {
        for (let offset = 1; offset <= visible.length; offset += 1) {
          const index = (Math.max(activeIndex, -1) + offset) % Math.max(visible.length, 1)
          const option = visible[index]
          if (
            option !== undefined &&
            option.disabled !== true &&
            (option.label.toLocaleLowerCase().startsWith(needle) ||
              option.value.toLocaleLowerCase().startsWith(needle))
          )
            return index
        }
        return -1
      }
      let match = findMatch(typeaheadRef.current)
      if (match < 0 && typeaheadRef.current.length > 1) {
        typeaheadRef.current = key
        match = findMatch(key)
      }
      if (match >= 0) {
        e.preventDefault()
        setActiveValue(visible[match]?.value ?? null)
      }
    }
  }

  const activeDescendant =
    activeIndex >= 0 && visible[activeIndex]?.disabled !== true
      ? `${popoverId}-opt-${activeIndex}`
      : undefined
  const hasEnabledVisible = visible.some((option) => option.disabled !== true)

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
        onClick={() => {
          if (!open) {
            openIntentRef.current = 'selected'
            setQuery('')
          }
          setOpen((value) => !value)
        }}
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
            aria-activedescendant={activeDescendant}
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
                  aria-activedescendant={activeDescendant}
                  data-testid={
                    props['data-testid'] !== undefined
                      ? `${props['data-testid']}-search`
                      : undefined
                  }
                  onChange={(e) => {
                    const nextQuery = e.target.value
                    setQuery(nextQuery)
                    const normalized = nextQuery.trim().toLocaleLowerCase()
                    const nextVisible =
                      normalized === ''
                        ? props.options
                        : props.options.filter(
                            (option) =>
                              option.label.toLocaleLowerCase().includes(normalized) ||
                              option.value.toLocaleLowerCase().includes(normalized),
                          )
                    setActiveValue(nextVisible[firstEnabledIndex(nextVisible)]?.value ?? null)
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
            {props.options.length === 0 && (
              <li className="select__empty" role="presentation">
                {t('common.noAvailableOptions')}
              </li>
            )}
            {props.options.length > 0 && visible.length === 0 && (
              <li className="select__empty" role="presentation">
                {t('common.noMatches')}
              </li>
            )}
            {visible.length > 0 && !hasEnabledVisible && (
              <li className="select__empty" role="presentation">
                {t('common.allOptionsUnavailable')}
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
                    onMouseEnter={() => {
                      if (opt.disabled !== true) setActiveValue(opt.value)
                    }}
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
