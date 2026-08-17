import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import { AppPortal } from './AppPortal'
import { TextInput } from './Form'
import { useManagedLiveRegion } from './ManagedLiveRegion'
import {
  runtimeParameterBreadcrumb,
  runtimeParameterMatches,
  type RuntimeParameterEntry,
} from './runtime-parameters/catalog'
import { runtimeParameterTargetForAuthority } from './runtime-parameters/authority'
import {
  commitRuntimeParameter,
  runtimeParameterTargetElement,
  snapshotRuntimeParameterTarget,
  type RuntimeParameterTarget,
  type RuntimeParameterTargetSnapshot,
} from './runtime-parameters/target'
import type { RuntimeTemplateAuthorityKey } from '@agent-workflow/shared'

const PATH_KEYS = ['scope', 'type', 'source', 'group'] as const

interface PickerPosition {
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  readonly top?: number
  readonly bottom?: number
}

interface BranchAction {
  readonly kind: 'branch'
  readonly id: string
  readonly value: string
  readonly label: string
  readonly count: number
}

interface LeafAction {
  readonly kind: 'leaf'
  readonly id: string
  readonly entry: RuntimeParameterEntry
}

type PickerAction = BranchAction | LeafAction

function actionDisabled(action: PickerAction): boolean {
  return action.kind === 'leaf' && action.entry.availability === 'unavailable'
}

function firstEnabledAction(actions: readonly PickerAction[]): PickerAction | undefined {
  return actions.find((action) => !actionDisabled(action))
}

export interface RuntimeParameterPickerProps {
  readonly authority: RuntimeTemplateAuthorityKey
  readonly entries: readonly RuntimeParameterEntry[]
  readonly target: RuntimeParameterTarget
  readonly disabled?: boolean
  readonly className?: string
  readonly testId?: string
  /** Distinguishes an unavailable source (for example no selected events) from no search match. */
  readonly emptyMessage?: string
}

function focusRelativeTo(trigger: HTMLButtonElement, backwards: boolean): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.closest('[data-runtime-parameter-popover]') === null)
  const index = candidates.indexOf(trigger)
  const next = candidates[index + (backwards ? -1 : 1)]
  ;(next ?? trigger).focus()
}

function entryPath(entry: RuntimeParameterEntry): readonly string[] {
  return PATH_KEYS.map((key) => entry.path[key])
}

function matchesPrefix(entry: RuntimeParameterEntry, prefix: readonly string[]): boolean {
  const path = entryPath(entry)
  return prefix.every((value, index) => path[index] === value)
}

/** Skip singleton branches without flattening the underlying stable path. */
function compressPrefix(
  entries: readonly RuntimeParameterEntry[],
  prefix: readonly string[],
): string[] {
  const next = [...prefix]
  while (next.length < PATH_KEYS.length) {
    const values = new Set(
      entries
        .filter((entry) => matchesPrefix(entry, next))
        .map((entry) => entryPath(entry)[next.length]),
    )
    if (values.size !== 1) break
    const value = [...values][0]
    if (value === undefined) break
    next.push(value)
  }
  return next
}

function labelForPrefix(
  entries: readonly RuntimeParameterEntry[],
  prefix: readonly string[],
): readonly string[] {
  const entry = entries.find((candidate) => matchesPrefix(candidate, prefix))
  return entry === undefined ? [] : entry.pathLabels.slice(0, prefix.length)
}

function actionsAt(
  entries: readonly RuntimeParameterEntry[],
  prefix: readonly string[],
  query: string,
): PickerAction[] {
  if (query.trim() !== '') {
    return entries
      .filter((entry) => runtimeParameterMatches(entry, query))
      .map((entry) => ({ kind: 'leaf' as const, id: `leaf:${entry.id}`, entry }))
  }
  const scoped = entries.filter((entry) => matchesPrefix(entry, prefix))
  if (prefix.length >= PATH_KEYS.length) {
    return scoped.map((entry) => ({ kind: 'leaf' as const, id: `leaf:${entry.id}`, entry }))
  }
  const values = new Map<string, { label: string; count: number }>()
  for (const entry of scoped) {
    const value = entryPath(entry)[prefix.length]
    const label = entry.pathLabels[prefix.length]
    if (value === undefined || label === undefined) continue
    const current = values.get(value)
    values.set(value, { label, count: (current?.count ?? 0) + 1 })
  }
  return [...values].map(([value, item]) => ({
    kind: 'branch' as const,
    id: `branch:${prefix.join('/')}:${value}`,
    value,
    label: item.label,
    count: item.count,
  }))
}

export function RuntimeParameterPicker({
  authority,
  entries,
  target: proposedTarget,
  disabled = false,
  className,
  testId,
  emptyMessage,
}: RuntimeParameterPickerProps) {
  const target = runtimeParameterTargetForAuthority(authority, proposedTarget)
  const { t } = useTranslation()
  const liveRegion = useManagedLiveRegion()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const actionRefs = useRef(new Map<string, HTMLButtonElement>())
  const latestTargetRef = useRef(target)
  const pointerSnapshotRef = useRef<RuntimeParameterTargetSnapshot | null>(null)
  const openSnapshotRef = useRef<RuntimeParameterTargetSnapshot | null>(null)
  const composingRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [prefix, setPrefix] = useState<string[]>(() => compressPrefix(entries, []))
  const [navigationHistory, setNavigationHistory] = useState<readonly string[][]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [position, setPosition] = useState<PickerPosition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const popoverId = useId()
  const listboxId = useId()
  const descriptionId = useId()
  latestTargetRef.current = target

  const actions = useMemo(() => actionsAt(entries, prefix, query), [entries, prefix, query])
  const activeIndex = actions.findIndex((action) => action.id === activeId)
  const activeAction = activeIndex < 0 ? undefined : actions[activeIndex]
  const breadcrumb = useMemo(() => labelForPrefix(entries, prefix), [entries, prefix])
  const blocked = disabled || target.disabled === true

  const close = useCallback((restoreTrigger: boolean) => {
    setOpen(false)
    setQuery('')
    setActiveId(null)
    setNavigationHistory([])
    openSnapshotRef.current = null
    pointerSnapshotRef.current = null
    if (restoreTrigger) triggerRef.current?.focus()
  }, [])

  const beginOpen = useCallback(() => {
    if (blocked) return
    const initialPrefix = compressPrefix(entries, [])
    const initialActions = actionsAt(entries, initialPrefix, '')
    setError(null)
    setPrefix(initialPrefix)
    setNavigationHistory([])
    setQuery('')
    setActiveId(firstEnabledAction(initialActions)?.id ?? null)
    openSnapshotRef.current =
      pointerSnapshotRef.current ?? snapshotRuntimeParameterTarget(latestTargetRef.current)
    pointerSnapshotRef.current = null
    setOpen(true)
  }, [blocked, entries])

  const chooseLeaf = useCallback(
    (entry: RuntimeParameterEntry) => {
      const snapshot = openSnapshotRef.current
      if (snapshot === null) return
      const current = latestTargetRef.current
      const result = commitRuntimeParameter(snapshot, current, entry.token)
      if (!result.ok) {
        const message =
          result.reason === 'stale'
            ? t('runtimeParameters.stale')
            : result.reason === 'invalid'
              ? (result.error ?? t('runtimeParameters.unavailable'))
              : t('runtimeParameters.unavailable')
        setError(message)
        liveRegion?.announce(message)
        return
      }
      const message = t('runtimeParameters.inserted', {
        parameter: entry.label,
        field: current.label,
      })
      liveRegion?.announce(message)
      close(runtimeParameterTargetElement(current) === null)
    },
    [close, liveRegion, t],
  )

  const chooseAction = useCallback(
    (action: PickerAction) => {
      if (action.kind === 'leaf') {
        chooseLeaf(action.entry)
        return
      }
      const next = compressPrefix(entries, [...prefix, action.value])
      const nextActions = actionsAt(entries, next, '')
      setNavigationHistory((current) => [...current, prefix])
      setPrefix(next)
      setQuery('')
      setActiveId(firstEnabledAction(nextActions)?.id ?? null)
      queueMicrotask(() => searchRef.current?.focus())
    },
    [chooseLeaf, entries, prefix],
  )

  const goBack = useCallback(() => {
    const previous = navigationHistory.at(-1)
    if (previous === undefined) return
    const nextActions = actionsAt(entries, previous, '')
    setNavigationHistory((current) => current.slice(0, -1))
    setPrefix([...previous])
    setQuery('')
    setActiveId(firstEnabledAction(nextActions)?.id ?? null)
    queueMicrotask(() => searchRef.current?.focus())
  }, [entries, navigationHistory])

  useLayoutEffect(() => {
    if (!open) return
    const recompute = () => {
      const trigger = triggerRef.current
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      const visual = window.visualViewport
      const viewportLeft = visual?.offsetLeft ?? 0
      const viewportTop = visual?.offsetTop ?? 0
      const viewportWidth = visual?.width ?? window.innerWidth
      const viewportHeight = visual?.height ?? window.innerHeight
      const viewportRight = viewportLeft + viewportWidth
      const viewportBottom = viewportTop + viewportHeight
      const gutter = 8
      const gap = 4
      const availableWidth = Math.max(0, viewportWidth - gutter * 2)
      const width = Math.min(Math.max(rect.width, 360), availableWidth)
      const left = Math.min(
        Math.max(viewportLeft + gutter, rect.left),
        Math.max(viewportLeft + gutter, viewportRight - gutter - width),
      )
      const below = Math.max(0, viewportBottom - rect.bottom - gutter - gap)
      const above = Math.max(0, rect.top - viewportTop - gutter - gap)
      const openAbove = below < 240 && above > below
      const maxHeight = Math.max(120, Math.min(440, openAbove ? above : below))
      const next: PickerPosition = {
        left,
        width,
        maxHeight,
        ...(openAbove
          ? { bottom: Math.max(gutter, window.innerHeight - rect.top + gap) }
          : { top: rect.bottom + gap }),
      }
      setPosition((current) =>
        current?.left === next.left &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight &&
        current.top === next.top &&
        current.bottom === next.bottom
          ? current
          : next,
      )
    }
    recompute()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => recompute())
    if (popoverRef.current !== null) observer?.observe(popoverRef.current)
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    window.visualViewport?.addEventListener('resize', recompute)
    window.visualViewport?.addEventListener('scroll', recompute)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
      window.visualViewport?.removeEventListener('resize', recompute)
      window.visualViewport?.removeEventListener('scroll', recompute)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target
      if (!(node instanceof Node)) return
      if (popoverRef.current?.contains(node) || triggerRef.current?.contains(node)) return
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [close, open])

  useEffect(() => {
    if (!open) return
    if (entries.length === 0) return
    const matching = entries.some((entry) => matchesPrefix(entry, prefix))
    if (!matching) {
      const next = compressPrefix(entries, [])
      setPrefix(next)
      setNavigationHistory([])
      setQuery('')
      setActiveId(firstEnabledAction(actionsAt(entries, next, ''))?.id ?? null)
    }
  }, [entries, open, prefix])

  useEffect(() => {
    if (actions.some((action) => action.id === activeId)) return
    setActiveId(firstEnabledAction(actions)?.id ?? null)
  }, [actions, activeId])

  const moveActionFocus = (nextIndex: number, direction: 1 | -1 = 1) => {
    if (actions.length === 0) return
    let index = nextIndex
    let remaining = actions.length
    while (remaining > 0 && actionDisabled(actions[(index + actions.length) % actions.length]!)) {
      index += direction
      remaining -= 1
    }
    const action = actions[(index + actions.length) % actions.length]
    if (action === undefined) return
    setActiveId(action.id)
    actionRefs.current.get(action.id)?.focus()
  }

  const leavePopover = (backwards: boolean) => {
    const trigger = triggerRef.current
    close(false)
    if (trigger !== null) focusRelativeTo(trigger, backwards)
  }

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (composingRef.current || event.nativeEvent.isComposing) return
      close(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      leavePopover(event.shiftKey)
      return
    }
    if (event.nativeEvent.isComposing || composingRef.current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (actions.length === 0) return
      moveActionFocus(
        event.key === 'ArrowDown' ? 0 : actions.length - 1,
        event.key === 'ArrowDown' ? 1 : -1,
      )
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveActionFocus(event.key === 'Home' ? 0 : actions.length - 1, event.key === 'Home' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && activeAction !== undefined) {
      event.preventDefault()
      chooseAction(activeAction)
    }
  }

  const onActionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const action = actions[index]
      if (action !== undefined && !actionDisabled(action)) chooseAction(action)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      leavePopover(event.shiftKey)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      moveActionFocus((index + delta + actions.length) % actions.length, delta)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveActionFocus(event.key === 'Home' ? 0 : actions.length - 1, event.key === 'Home' ? 1 : -1)
      return
    }
    if (event.key === 'Backspace' && query === '' && navigationHistory.length > 0) {
      event.preventDefault()
      goBack()
    }
  }

  const capturePointerSnapshot = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || blocked) return
    pointerSnapshotRef.current = snapshotRuntimeParameterTarget(latestTargetRef.current)
  }

  const popoverStyle: CSSProperties | undefined =
    position === null
      ? undefined
      : {
          left: position.left,
          width: position.width,
          maxHeight: position.maxHeight,
          ...(position.top === undefined ? {} : { top: position.top }),
          ...(position.bottom === undefined ? {} : { bottom: position.bottom }),
        }

  const empty =
    query.trim() === ''
      ? (emptyMessage ?? t('runtimeParameters.unavailable'))
      : t('runtimeParameters.noMatches')
  const activeDescendant =
    activeIndex < 0 ? undefined : `${listboxId}-option-${String(activeIndex)}`

  return (
    <div className={className === undefined ? 'runtime-parameter-picker' : className}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--sm btn--ghost runtime-parameter-picker__trigger"
        disabled={blocked}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-describedby={target.mode === 'replace-whole-value' ? descriptionId : undefined}
        aria-label={t('runtimeParameters.insertFor', { field: target.label })}
        data-testid={testId}
        data-runtime-parameter-authority={authority}
        onPointerDown={capturePointerSnapshot}
        onClick={() => {
          if (open) close(true)
          else beginOpen()
        }}
      >
        <span aria-hidden="true">＋</span>
        {t('runtimeParameters.insert')}
      </button>
      {target.mode === 'replace-whole-value' ? (
        <span id={descriptionId} className="runtime-parameter-picker__mode-hint">
          {t('runtimeParameters.replaceWholeValue', { field: target.label })}
        </span>
      ) : null}
      {error !== null ? (
        <span className="runtime-parameter-picker__error" role="alert">
          {error}
        </span>
      ) : null}
      {open && (
        <AppPortal>
          <div
            id={popoverId}
            ref={popoverRef}
            className="runtime-parameter-popover"
            style={popoverStyle}
            data-runtime-parameter-popover="true"
          >
            <div className="runtime-parameter-popover__search">
              {navigationHistory.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--xs btn--ghost runtime-parameter-popover__back"
                  aria-label={t('runtimeParameters.back')}
                  onClick={goBack}
                >
                  <span aria-hidden="true">←</span>
                </button>
              ) : null}
              <TextInput
                inputRef={searchRef}
                type="search"
                role="combobox"
                className="runtime-parameter-popover__search-input"
                value={query}
                placeholder={t('runtimeParameters.search')}
                aria-label={t('runtimeParameters.search')}
                aria-controls={listboxId}
                aria-expanded
                aria-autocomplete="list"
                aria-activedescendant={activeDescendant}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onChange={(next) => {
                  const nextActions = actionsAt(entries, prefix, next)
                  setQuery(next)
                  setActiveId(firstEnabledAction(nextActions)?.id ?? null)
                }}
                onKeyDown={onSearchKeyDown}
              />
            </div>
            {breadcrumb.length > 0 ? (
              <div className="runtime-parameter-popover__breadcrumb">{breadcrumb.join(' / ')}</div>
            ) : null}
            <div
              id={listboxId}
              className="runtime-parameter-popover__list"
              role="listbox"
              aria-label={t('runtimeParameters.insertFor', { field: target.label })}
              aria-activedescendant={activeDescendant}
            >
              {actions.length === 0 ? (
                <div className="runtime-parameter-popover__empty">{empty}</div>
              ) : null}
              {actions.map((action, index) => {
                const active = action.id === activeId
                return (
                  <button
                    key={action.id}
                    id={`${listboxId}-option-${String(index)}`}
                    ref={(element) => {
                      if (element === null) actionRefs.current.delete(action.id)
                      else actionRefs.current.set(action.id, element)
                    }}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={actionDisabled(action)}
                    tabIndex={active ? 0 : -1}
                    className={`runtime-parameter-popover__option${active ? ' runtime-parameter-popover__option--active' : ''}`}
                    aria-label={
                      action.kind === 'branch'
                        ? t('runtimeParameters.categoryAria', {
                            category: action.label,
                            count: action.count,
                          })
                        : `${runtimeParameterBreadcrumb(action.entry)}. ${action.entry.token}. ${action.entry.description}${action.entry.unavailableReason === undefined ? '' : `. ${action.entry.unavailableReason}`}`
                    }
                    onFocus={() => setActiveId(action.id)}
                    onMouseEnter={() => setActiveId(action.id)}
                    onKeyDown={(event) => onActionKeyDown(event, index)}
                    onClick={() => chooseAction(action)}
                  >
                    {action.kind === 'branch' ? (
                      <>
                        <span className="runtime-parameter-popover__option-heading">
                          <span className="runtime-parameter-popover__option-label">
                            {action.label}
                          </span>
                          <span className="runtime-parameter-popover__branch-count">
                            {t('runtimeParameters.categoryCount', { count: action.count })}
                          </span>
                        </span>
                        <span className="runtime-parameter-popover__description">
                          {t('runtimeParameters.openCategory')}
                        </span>
                      </>
                    ) : (
                      <>
                        {query.trim() !== '' ? (
                          <span className="runtime-parameter-popover__result-path">
                            {action.entry.pathLabels.join(' / ')}
                          </span>
                        ) : null}
                        <span className="runtime-parameter-popover__option-heading">
                          <span className="runtime-parameter-popover__option-label">
                            {action.entry.label}
                          </span>
                          <code className="runtime-parameter-popover__token">
                            {action.entry.token}
                          </code>
                        </span>
                        <span className="runtime-parameter-popover__description">
                          {action.entry.unavailableReason ?? action.entry.description}
                        </span>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </AppPortal>
      )}
    </div>
  )
}
