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
  /**
   * 挂载时就展开列表。**只给「这个弹窗存在的唯一目的就是选人」的场合**——典型是
   * 转让所有者：弹窗里除了这个 picker 什么都没有，展开就是它要做的事，`rfc099-
   * ownership-acl` 的两段式 Escape 契约（第一下关列表、第二下关内层弹窗）也依赖它。
   *
   * 反面例子是权限面板的加人搜索框：那个弹窗里还有转让 / 保存 / 可见性，展开会把它们
   * 盖住（见下面 input 上的注释）。所以默认关，要开必须在调用点写出来。
   */
  openOnMount?: boolean
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
  openOnMount,
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
  // `openOnMount` 只影响**初值**，不再挂到 onFocus 上——挂 onFocus 就会在每次
  // Dialog 焦点恢复时重开列表，那正是被删掉的 suppressNextFocusOpen 守卫在补的洞。
  const [open, setOpen] = useState(openOnMount === true)
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
  const popPos = usePopoverPosition(rootRef, open, listRef)

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
          }
          // 展开挂在**按下去**这一下，不挂 onFocus —— 见下面 input 上的注释。
          // 门户里的选项是 `.user-picker` 的 React 子节点、不是本行的，所以选人时
          // 的 mousedown 不会冒泡到这里，选完不会把刚关掉的列表又弹开。
          setOpen(true)
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
          // 这里**没有** onFocus 展开，是有意的（WAI-ARIA combobox 也是这个约定：
          // 展开靠点击 / 打字 / ArrowDown，不靠「拿到焦点」）。
          //
          // 反例是实撞出来的：`Dialog.resolveInitialDialogFocus` 会把初始焦点给
          // `.dialog__body` 里第一个可聚焦元素（Dialog.tsx:163-175）。权限面板里
          // 那正是这个加人搜索框（AclPanel.tsx 的 <UserPicker> 排在「转让所有者」
          // 按钮前面），于是**一打开权限弹窗，下拉就自动展开、盖住弹窗自己的按钮**。
          // chromium 上侥幸点得中，webkit 上稳定拦截——
          // `e2e/rfc099-ownership-acl.spec.ts:232` 报
          // `<ul class="user-picker__results"> intercepts pointer events`。
          // 从前那套 suppressNextFocusOpen 一次性守卫只是在补这条规则的漏，
          // 规则本身去掉之后它就是死代码，已一并删除。
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
