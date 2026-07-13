// RFC-173 (T2) — shared tag multi-select combobox.
//
// One control that merges "pick" and "show": selected values render as
// removable .chip tags inside the field, and a trailing role=combobox <input>
// opens a portaled, searchable, checkbox listbox to toggle more. Replaces the
// old "single Select above a ChipsInput" two-zone pattern behind ResourcePicker.
//
// Structure is aligned with the shipped <UserPicker> (RFC-099): a
// .chips-input__row field (a DIV, so the chips' × buttons aren't nested inside
// a button) with the combobox role on the trailing <input>, plus a
// portal-to-body listbox positioned by the shared usePopoverPosition hook.
// Differences from UserPicker: local synchronous options (not server search),
// toggle rows (not add-only), keyboard nav, aria-multiselectable.
//
// Only the custom-token state machine is reused from useChipsCommit
// (pending/commit — NOT its handleKeyDown/handleBlur, which lack an IME guard
// and would mis-commit the search text on option-click blur). Backspace-delete
// and all key handling live in this component's own IME-guarded keydown.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePopoverPosition } from '@/hooks/usePopoverPosition'
import { useChipsCommit } from './ChipsInput'

export interface MultiSelectOption {
  /** Committed identity (for ResourcePicker: the resource name). */
  value: string
  /** Row title + tag text. */
  label: string
  /** Muted second line in the row. */
  description?: string
  /** Un-selected → can't be added (greyed). Already-selected → still removable. */
  disabled?: boolean
}

export interface MultiSelectProps {
  value: string[]
  onChange: (next: string[]) => void
  /** Eligible-to-add rows ∪ already-selected (ResourcePicker builds the union).
   *  Any selected value not present here gets a synthesized checked row. */
  options: ReadonlyArray<MultiSelectOption>
  /** Accessible name for the combobox input (the field is a div, not a label). */
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  searchable?: boolean
  /** Allow committing a free-text token not in options (forward-ref / degraded). */
  allowCustom?: boolean
  emptyLabel?: string
  loadingLabel?: string
  loading?: boolean
  'data-testid'?: string
}

type NavItem = { kind: 'option'; row: MultiSelectOption } | { kind: 'custom'; token: string }

export function MultiSelect(props: MultiSelectProps) {
  const { t } = useTranslation()
  const { value, onChange, options, ariaLabel } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()
  const popPos = usePopoverPosition(rootRef, open)

  // Reuse only the pending/commit half of the chips state machine (trim → dedup
  // vs value → clear). onCommit adds a custom token; onRemoveLast is unused
  // (this component owns Backspace in its own keydown).
  const chips = useChipsCommit({
    values: value,
    onCommit: (token) => onChange([...value, token]),
    onRemoveLast: () => onChange(value.slice(0, -1)),
  })
  const query = chips.pending
  const q = query.trim().toLowerCase()
  const trimmed = query.trim()

  // Tag text: options label (short name) else the raw value — a value not in
  // options (deleted resource / forward-ref) still shows a readable tag.
  const optionLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of options) if (!m.has(o.value)) m.set(o.value, o.label)
    return m
  }, [options])
  const tagLabel = (v: string) => optionLabel.get(v) ?? v

  // Listbox rows = options (dedup, first wins) + synth checked rows for any
  // selected value not covered by options. value-set dedup ⇒ no double rows.
  const rows = useMemo(() => {
    const out: MultiSelectOption[] = []
    const seen = new Set<string>()
    for (const opt of options) {
      if (!seen.has(opt.value)) {
        seen.add(opt.value)
        out.push(opt)
      }
    }
    for (const v of value) {
      if (!seen.has(v)) {
        seen.add(v)
        out.push({ value: v, label: v })
      }
    }
    return out
  }, [options, value])

  const searchable = props.searchable !== false
  const filtered = useMemo(() => {
    if (!searchable || q === '') return rows
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.value.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    )
  }, [rows, q, searchable])

  const showCustom =
    props.allowCustom === true && trimmed !== '' && !rows.some((r) => r.value === trimmed)

  const items = useMemo<NavItem[]>(() => {
    const arr: NavItem[] = filtered.map((row) => ({ kind: 'option', row }))
    if (showCustom) arr.push({ kind: 'custom', token: trimmed })
    return arr
  }, [filtered, showCustom, trimmed])

  const isInteractive = (it: NavItem): boolean =>
    it.kind === 'custom' ? true : value.includes(it.row.value) || it.row.disabled !== true
  const firstInteractive = (): number => items.findIndex(isInteractive)

  const [activeIndex, setActiveIndex] = useState(0)
  // Resolve at render (P1-1): keep the stored index only if still valid AND
  // interactive; otherwise fall to the first interactive row. This makes a
  // removed/vanished active row auto-heal (no dangling aria-activedescendant)
  // without an extra effect, and leaves a plain toggle's active untouched.
  const active =
    activeIndex >= 0 && activeIndex < items.length && isInteractive(items[activeIndex]!)
      ? activeIndex
      : firstInteractive()

  // Reset to first interactive on open and on every filter change — so
  // "focus then Enter" and "type then Enter" always act on a definite row.
  useEffect(() => {
    if (open) setActiveIndex(firstInteractive())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q])

  // Focus the input when opening (mirror of UserPicker/Select).
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])

  // Outside click closes without stealing focus (matches Select's mousedown
  // close; the list lives on document.body, outside rootRef).
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      if (rootRef.current?.contains(target) === true) return
      if (listRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function toggle(v: string) {
    if (value.includes(v)) onChange(value.filter((x) => x !== v))
    else onChange([...value, v])
  }

  function moveActive(dir: 1 | -1) {
    if (items.length === 0) return
    let i = active
    for (let step = 0; step < items.length; step++) {
      i += dir
      if (i < 0 || i >= items.length) return // clamp at the ends
      if (isInteractive(items[i]!)) {
        setActiveIndex(i)
        return
      }
    }
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // CJK IME: a composing Enter/arrow/Space commits the composition — never
    // toggle a row or move the active index (mirror of Select.tsx).
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const it = active >= 0 ? items[active] : undefined
      if (it === undefined) return
      if (it.kind === 'custom') {
        chips.commit(it.token) // dedup + clear pending
      } else {
        toggle(it.row.value)
        chips.setPendingValue('') // clear filter after an Enter-toggle
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Just close — the input already holds focus (Esc was pressed on it).
      // Calling focus() again would re-fire onFocus and re-open immediately.
      setOpen(false)
    } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  const activeId =
    open && active >= 0 && items[active] !== undefined ? `${listId}-opt-${active}` : undefined

  return (
    <div className="multi-select" data-open={open}>
      <div
        ref={rootRef}
        className="multi-select__field chips-input__row"
        onMouseDown={(e) => {
          if (props.disabled === true) return
          if ((e.target as HTMLElement).closest('.chip__remove') !== null) return
          // Any click on the field opens (so a click reopens after Esc, even
          // when the input already holds focus — onFocus wouldn't re-fire).
          setOpen(true)
          if (e.target !== inputRef.current) {
            // Keep focus off <body> (Dialog focus-trap would yank it) — focus
            // the input ourselves. See UserPicker's note.
            e.preventDefault()
            inputRef.current?.focus()
          }
        }}
      >
        {value.map((v) => (
          <span key={v} className="chip">
            {tagLabel(v)}
            <button
              type="button"
              className="chip__remove"
              aria-label={t('common.removeAria', { label: tagLabel(v) })}
              disabled={props.disabled}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="chips-input__field"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label={ariaLabel}
          value={query}
          placeholder={value.length === 0 ? props.placeholder : ''}
          disabled={props.disabled}
          data-testid={props['data-testid']}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            chips.setPendingValue(e.target.value)
            setOpen(true)
          }}
          onKeyDown={onInputKeyDown}
        />
        <span className="select__chevron" aria-hidden="true">
          ▾
        </span>
      </div>
      {open &&
        popPos !== null &&
        createPortal(
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label={ariaLabel}
            className="multi-select__listbox select__listbox select__listbox--portal"
            style={{
              position: 'absolute',
              left: popPos.left,
              top: popPos.top,
              minWidth: popPos.width,
            }}
          >
            {props.loading === true ? (
              <li className="select__empty" role="presentation">
                {props.loadingLabel ?? t('common.loading')}
              </li>
            ) : items.length === 0 ? (
              <li className="select__empty" role="presentation">
                {q !== '' ? t('common.noMatches') : (props.emptyLabel ?? t('multiSelect.empty'))}
              </li>
            ) : (
              items.map((it, i) => {
                const optionId = `${listId}-opt-${i}`
                if (it.kind === 'custom') {
                  return (
                    <li
                      key="__custom__"
                      id={optionId}
                      role="option"
                      aria-selected={false}
                      className={`select__option multi-select__add-custom ${i === active ? 'select__option--active' : ''}`.trim()}
                      onMouseEnter={() => setActiveIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        chips.commit(it.token)
                      }}
                    >
                      {t('multiSelect.addCustom', { token: it.token })}
                    </li>
                  )
                }
                const r = it.row
                const selected = value.includes(r.value)
                const rowDisabled = !selected && r.disabled === true
                return (
                  <li
                    key={r.value}
                    id={optionId}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={rowDisabled || undefined}
                    className={`select__option multi-select__option ${i === active ? 'select__option--active' : ''} ${selected ? 'select__option--selected' : ''}`.trim()}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      if (!rowDisabled) toggle(r.value)
                    }}
                  >
                    <span className="select__option-stack">
                      <span className="select__option-title">{r.label}</span>
                      {r.description !== undefined && r.description !== '' && (
                        <span className="select__option-sub">{r.description}</span>
                      )}
                    </span>
                    <span className="select__option-check" aria-hidden="true">
                      {selected ? '✓' : ''}
                    </span>
                  </li>
                )
              })
            )}
          </ul>,
          document.body,
        )}
    </div>
  )
}
