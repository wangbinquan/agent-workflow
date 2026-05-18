// RFC-036 — minimal styled select. The native <select> element shows a
// browser-chrome popup that no amount of CSS on the <option> elements can
// restyle, which clashes with the rest of the dialog. This component
// renders a custom trigger + popover panel so the dropdown matches the
// surrounding inputs.
//
// API: drop-in replacement for the common (value, onChange, options) shape.
// Accessibility: role=combobox + aria-controls/expanded + role=listbox /
// option + arrow-key + Home/End + Enter/Space + Esc.

import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface SelectOption<V extends string> {
  value: V
  label: string
  description?: string
  disabled?: boolean
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
  /** name attribute on the hidden input so the value lands in `form` submits. */
  name?: string
  /** Render a custom row body. Default = `option.label`. */
  renderOption?: (opt: SelectOption<V>) => React.ReactNode
}

export function Select<V extends string>(props: Props<V>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      props.options.findIndex((o) => o.value === props.value),
    ),
  )
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const popoverId = useId()
  const labelId = useId()

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

  // Focus the listbox when opening so arrow keys work immediately.
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => listRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [open])

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
    }
  }

  function onListKey(e: React.KeyboardEvent<HTMLUListElement>) {
    const last = props.options.length - 1
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
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const opt = props.options[activeIndex]
      if (opt && !opt.disabled) {
        props.onChange(opt.value)
        setOpen(false)
        triggerRef.current?.focus()
      }
    } else if (e.key === 'Escape') {
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
        ref={triggerRef}
        className={`select__trigger ${props.className ?? ''}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-labelledby={labelId}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span id={labelId} className="select__value">
          {current ? current.label : (props.placeholder ?? '')}
        </span>
        <span className="select__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul
          id={popoverId}
          ref={listRef}
          tabIndex={-1}
          role="listbox"
          aria-label={props.ariaLabel ?? 'Select an option'}
          aria-activedescendant={`${popoverId}-opt-${activeIndex}`}
          className="select__listbox"
          onKeyDown={onListKey}
        >
          {props.options.map((opt, i) => {
            const active = i === activeIndex
            const selected = opt.value === props.value
            return (
              <li
                id={`${popoverId}-opt-${i}`}
                key={opt.value}
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
                  {props.renderOption ? props.renderOption(opt) : opt.label}
                </span>
                {selected && (
                  <span className="select__option-check" aria-hidden>
                    ✓
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
