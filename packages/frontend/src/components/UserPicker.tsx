// RFC-099 — shared multi-select user picker (launcher collaborators, ACL
// member lists, task members panel). RFC-036 planned this component but the
// UI never shipped; this is the canonical implementation.
//
// Search hits GET /api/users/search (users:search — available to every
// logged-in user, public fields only) with a 200 ms debounce; selected users
// render as removable chips (same .chip primitives as ChipsInput).
//
// The results list is PORTALED to document.body and positioned from the
// field's bounding rect — the same pattern as <Select>'s listbox — so it
// never gets clipped by ancestors with overflow (most notably
// `.dialog__body`, the Dialog's scroll region: the pre-portal version was
// unclickable inside the owner-transfer dialog). The input carries
// `aria-controls={listId}` pointing at the portaled <ul>, which is exactly
// the hook Dialog's focus trap uses to treat the floating layer as
// "inside the dialog" (Dialog.tsx isFocusInsideDialog).

import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'

interface UserPickerProps {
  value: UserPublic[]
  onChange: (next: UserPublic[]) => void
  /** Hide these ids from results (e.g. the resource owner). */
  excludeIds?: string[]
  disabled?: boolean
  placeholder?: string
  /** Single-select mode (owner transfer): picking replaces the selection. */
  single?: boolean
  testidPrefix?: string
}

export function UserPicker({
  value,
  onChange,
  excludeIds,
  disabled,
  placeholder,
  single,
  testidPrefix,
}: UserPickerProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()
  const [popPos, setPopPos] = useState<{ left: number; top: number; width: number } | null>(null)

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input.trim()), 200)
    return () => clearTimeout(handle)
  }, [input])

  // Position the portaled list under the field; track scroll/resize while
  // open (mirror of Select.tsx — window-scroll coords, no ancestor chasing).
  useLayoutEffect(() => {
    if (!open) return
    function recompute() {
      const el = rootRef.current
      if (el === null) return
      const r = el.getBoundingClientRect()
      setPopPos({
        left: r.left + window.scrollX,
        top: r.bottom + window.scrollY + 4,
        width: r.width,
      })
    }
    recompute()
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [open])

  // Close on outside click — outside means outside BOTH the field and the
  // portaled list (the list lives on document.body, not under rootRef).
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (rootRef.current?.contains(target) === true) return
      if (listRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const search = useQuery<UserPublic[]>({
    queryKey: ['users', 'search', debounced],
    queryFn: ({ signal }) =>
      api.get('/api/users/search', { q: debounced || undefined, limit: 20 }, signal),
    enabled: open && !disabled,
    staleTime: 30_000,
  })

  const selectedIds = new Set(value.map((u) => u.id))
  const hidden = new Set(excludeIds ?? [])
  const results = (search.data ?? []).filter((u) => !selectedIds.has(u.id) && !hidden.has(u.id))

  function add(user: UserPublic) {
    onChange(single ? [user] : [...value, user])
    setInput('')
    if (single) setOpen(false)
  }

  function remove(id: string) {
    onChange(value.filter((u) => u.id !== id))
  }

  return (
    <div className="user-picker" ref={rootRef}>
      {/* The whole bordered box IS the field: a mousedown anywhere on the
          row (its padding, the empty area next to chips) would otherwise
          land on a non-focusable div — the browser parks focus on <body>
          and, inside a Dialog, the focus trap immediately yanks it to the
          × close button, so typing goes nowhere and the field reads as
          dead/disabled (user report: "搜索用户那个textbox无法使用，是灰的").
          preventDefault keeps the implicit blur from ever happening and we
          focus the input ourselves. */}
      <div
        className="chips-input__row"
        onMouseDown={(e) => {
          if (disabled) return
          // Chip × buttons keep their own click semantics.
          if ((e.target as HTMLElement).closest('.chip__remove') !== null) return
          if (e.target !== inputRef.current) {
            e.preventDefault()
            inputRef.current?.focus()
            setOpen(true)
          }
        }}
      >
        {value.map((u) => (
          <span key={u.id} className="chip">
            {u.displayName}
            <button
              type="button"
              className="chip__remove"
              aria-label={t('userPicker.remove', { name: u.displayName })}
              disabled={disabled}
              data-testid={testidPrefix ? `${testidPrefix}-remove-${u.username}` : undefined}
              onClick={() => remove(u.id)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="chips-input__field"
          value={input}
          placeholder={placeholder ?? t('userPicker.placeholder')}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          data-testid={testidPrefix ? `${testidPrefix}-input` : undefined}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
          }}
        />
      </div>
      {open &&
        !disabled &&
        popPos !== null &&
        createPortal(
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            className="user-picker__results"
            style={{
              position: 'absolute',
              left: popPos.left,
              top: popPos.top,
              minWidth: popPos.width,
            }}
          >
            {results.length === 0 ? (
              <li className="user-picker__empty">
                {search.isLoading ? t('common.loading') : t('userPicker.noResults')}
              </li>
            ) : (
              results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="user-picker__option"
                    data-testid={testidPrefix ? `${testidPrefix}-option-${u.username}` : undefined}
                    onClick={() => add(u)}
                  >
                    <span className="user-picker__name">{u.displayName}</span>
                    <span className="user-picker__username">@{u.username}</span>
                  </button>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  )
}
