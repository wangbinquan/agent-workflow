// RFC-099 — shared multi-select user picker (launcher collaborators, ACL
// member lists, task members panel). RFC-036 planned this component but the
// UI never shipped; this is the canonical implementation.
//
// Search hits GET /api/users/search (users:search — only when the owning
// surface has that capability, public fields only) with a 200 ms debounce;
// selected users render as removable chips (same .chip primitives as
// ChipsInput).
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
import {
  useEffect,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AppPortal } from '@/components/AppPortal'
import { usePopoverPosition } from '@/hooks/usePopoverPosition'

interface UserPickerProps {
  value: UserPublic[]
  onChange: (next: UserPublic[]) => void
  /** Hide these ids from results (e.g. the resource owner). */
  excludeIds?: string[]
  disabled?: boolean
  placeholder?: string
  /** Single-select mode (owner transfer): picking replaces the selection. */
  single?: boolean
  /** Hide disabled accounts when the target must be an active principal. */
  activeOnly?: boolean
  'aria-label'?: AriaAttributes['aria-label']
  'aria-labelledby'?: AriaAttributes['aria-labelledby']
  'aria-describedby'?: AriaAttributes['aria-describedby']
  'aria-required'?: AriaAttributes['aria-required']
  'aria-invalid'?: AriaAttributes['aria-invalid']
  testidPrefix?: string
  /**
   * RFC-312 —— 已选 chip 名字前的可选装饰（当前唯一用途是在线点）。
   * 做成插槽而不是把 presence 写死进来：UserPicker 是通用组件，
   * 不该知道"在线状态"这回事；调用方传什么就渲染什么。
   */
  renderAdornment?: (userId: string) => ReactNode
}

export function UserPicker({
  value,
  onChange,
  excludeIds,
  disabled,
  placeholder,
  single,
  activeOnly,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  'aria-required': ariaRequired,
  'aria-invalid': ariaInvalid,
  testidPrefix,
  renderAdornment,
}: UserPickerProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [activeUserId, setActiveUserId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input.trim()), 200)
    return () => clearTimeout(handle)
  }, [input])

  // RFC-173 (T1): portal positioning extracted to the shared hook (was a
  // byte-identical copy here and in Select). Anchors from the whole field
  // (rootRef) so the list tracks the chip row's bottom edge.
  const popPos = usePopoverPosition(rootRef, open)

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
    queryKey: ['users', 'search', debounced, activeOnly === true ? 'active' : 'all'],
    queryFn: ({ signal }) =>
      api.get(
        '/api/users/search',
        {
          q: debounced || undefined,
          limit: activeOnly === true ? 100 : 20,
          status: activeOnly === true ? 'active' : undefined,
        },
        signal,
      ),
    enabled: open && !disabled,
    staleTime: 30_000,
  })

  const selectedIds = new Set(value.map((u) => u.id))
  const hidden = new Set(excludeIds ?? [])
  const results = (search.data ?? []).filter(
    (u) =>
      !selectedIds.has(u.id) && !hidden.has(u.id) && (activeOnly !== true || u.status === 'active'),
  )
  const resultKey = results.map((user) => user.id).join('\u0000')
  const activeIndex = results.findIndex((user) => user.id === activeUserId)
  const activeOptionId = open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined

  useEffect(() => {
    if (!open || results.length === 0) {
      setActiveUserId(null)
      return
    }
    setActiveUserId((current) =>
      results.some((user) => user.id === current && user.status === 'active')
        ? current
        : (results.find((user) => user.status === 'active')?.id ?? null),
    )
    // The id signature is the stable dependency for an asynchronously replaced
    // result array; object identity alone changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resultKey])

  function moveActive(direction: 1 | -1) {
    if (results.length === 0) return
    const current = results.findIndex(
      (user) => user.id === activeUserId && user.status === 'active',
    )
    let next = current < 0 ? (direction === 1 ? -1 : 0) : current
    for (let step = 0; step < results.length; step += 1) {
      next = (next + direction + results.length) % results.length
      const candidate = results[next]
      if (candidate?.status === 'active') {
        setActiveUserId(candidate.id)
        return
      }
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      moveActive(-1)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const active = results.find((user) => user.id === activeUserId && user.status === 'active')
      if (active !== undefined) add(active)
    } else if (event.key === 'Escape' && open) {
      // Consume the first Escape inside a Dialog so it closes this portaled
      // listbox, not both the listbox and its parent surface.
      event.stopPropagation()
      event.preventDefault()
      setOpen(false)
      setActiveUserId(null)
    }
  }

  function add(user: UserPublic) {
    onChange(single ? [user] : [...value, user])
    setInput('')
    setActiveUserId(null)
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
            {renderAdornment?.(u.id)}
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
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-describedby={ariaDescribedby}
          aria-required={ariaRequired}
          aria-invalid={ariaInvalid}
          data-testid={testidPrefix ? `${testidPrefix}-input` : undefined}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKeyDown}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
          }}
        />
      </div>
      {open && !disabled && popPos !== null && (
        <AppPortal>
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
              results.map((u, index) => (
                <li key={u.id}>
                  <button
                    id={`${listId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={u.id === activeUserId}
                    aria-disabled={u.status !== 'active'}
                    disabled={u.status !== 'active'}
                    className={`user-picker__option${
                      u.id === activeUserId ? ' user-picker__option--active' : ''
                    }`}
                    data-testid={testidPrefix ? `${testidPrefix}-option-${u.username}` : undefined}
                    onMouseEnter={() => {
                      if (u.status === 'active') setActiveUserId(u.id)
                    }}
                    onClick={() => add(u)}
                  >
                    <span className="user-picker__name">{u.displayName}</span>
                    <span className="user-picker__username">@{u.username}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </AppPortal>
      )}
    </div>
  )
}
