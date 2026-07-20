// RFC-169 (T5) — the master-detail split page skeleton, shared by all four
// resource pages (agents / skills / mcps / plugins). Left rail = page title +
// search box + resource cards + "+ new"; right rail = the routed <Outlet/>
// (empty pane / edit form / inline new form). This is the single mount point
// for the SplitDirty provider and the UnsavedChangesGuard.
//
// Why a persistent layout component (not three peer routes each rendering the
// two columns): the left rail stays mounted across selection changes, so the
// search term + scroll position + probe queries all survive (T-D1). The nested
// router (see routes/{res}.tsx) renders this once and swaps only the <Outlet/>.
//
// Cards are zero-button (D/T-D7): the whole card is a <Link>; all row-level
// actions moved into the right rail. Selection accent reuses the
// task-outputs-panel option language; the dirty dot is drawn from the
// SplitDirty context.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { RelativeTime } from '@/components/RelativeTime'
import { filterResourceCards } from '@/lib/resource-card-filter'
import {
  SplitDirtyContext,
  type SplitDirtyContextValue,
  type SplitDiscardHandler,
} from '@/components/split/splitDirty'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import { AGENT_ICON, MCP_ICON, PLUGIN_ICON, SKILL_ICON } from '@/components/icons/resourceIcons'

/** Detail routes the cards link to (byte-equal to the existing deep links). */
export type ResourceDetailTo = '/agents/$name' | '/skills/$name' | '/mcps/$name' | '/plugins/$id'
/** "+ new" routes. */
export type ResourceNewTo = '/agents/new' | '/skills/new' | '/mcps/new' | '/plugins/new'
export type SplitResourceKind = 'agent' | 'skill' | 'mcp' | 'plugin'

interface ResourceCardItemBase {
  /** agents/skills/mcps = name; plugins = id. */
  key: string
  title: string
  /** One-line CSS truncation; full text in the title attribute. */
  subtitle?: string
  /** Additional visible facts that should participate in local search. */
  searchText?: string
  /** Optional epoch timestamp rendered as compact relative recency. */
  updatedAt?: number
  /** Operational state shown beside the title (probe / update available). */
  primaryStatus?: ReactNode
  /** Per-page assembled existing chips (ResourceBadges / StatusChip / …). */
  badges?: ReactNode
  testid?: string
}

/** Keep glyph, destination and route params correlated at compile time. */
export type ResourceCardItem =
  | (ResourceCardItemBase & {
      kind: 'agent'
      to: '/agents/$name'
      params: { name: string }
    })
  | (ResourceCardItemBase & {
      kind: 'skill'
      to: '/skills/$name'
      params: { name: string }
    })
  | (ResourceCardItemBase & {
      kind: 'mcp'
      to: '/mcps/$name'
      params: { name: string }
    })
  | (ResourceCardItemBase & {
      kind: 'plugin'
      to: '/plugins/$id'
      params: { id: string }
    })

const RESOURCE_ICON: Record<SplitResourceKind, ReactNode> = {
  agent: AGENT_ICON,
  skill: SKILL_ICON,
  mcp: MCP_ICON,
  plugin: PLUGIN_ICON,
}

export interface ResourceSplitPageProps {
  /** Left-rail page <h1>. */
  title: string
  items: ResourceCardItem[] | undefined
  isLoading: boolean
  error: unknown
  selectedKey: string | null
  newActive: boolean
  newLabel: string
  newTo: ResourceNewTo
  searchPlaceholder: string
  /** Shown when the resource list itself is empty (vs. filtered-to-nothing). */
  emptyListText: string
  /** Optional supporting copy/icon for the genuine empty-list state. */
  emptyDescription?: string
  emptyIcon?: ReactNode
  /** Retry action shown inside the list error banner. */
  onRetry?: () => void
  /** Canonical list route used by the phone-only detail back affordance. */
  listTo?: LinkProps['to']
  /** Visible and accessible label for the phone-only detail back affordance. */
  mobileBackLabel?: string
  mobileBackTestId?: string
  /** Right rail (the routed <Outlet/>). */
  children: ReactNode
}

export function ResourceSplitPage(props: ResourceSplitPageProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const listPaneRef = useRef<HTMLElement | null>(null)
  const detailPaneRef = useRef<HTMLElement | null>(null)
  const mobileBackRef = useRef<HTMLAnchorElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLAnchorElement>())
  const newLinkRef = useRef<HTMLAnchorElement | null>(null)
  const restoreListFocusRef = useRef(false)
  const returnCardKeyRef = useRef<string | null>(null)
  const lastInteractionPaneRef = useRef<'list' | 'detail' | null>(null)

  // Dirty key in a ref (guard reads it synchronously) + state (drives the dot).
  const dirtyKeyRef = useRef<string | null>(null)
  const [dirtyKey, setDirtyKey] = useState<string | null>(null)
  const report = useCallback((cardKey: string, dirty: boolean) => {
    if (dirty) {
      dirtyKeyRef.current = cardKey
      setDirtyKey(cardKey)
    } else if (dirtyKeyRef.current === cardKey) {
      // Only the card that OWNS the current dirty flag may clear it — a
      // remounting-in card reporting clean must not clobber the outgoing
      // card's dirty (which the guard may still be blocking on).
      dirtyKeyRef.current = null
      setDirtyKey(null)
    }
  }, [])

  // Mutation tokens are synchronous refs because navigation can be attempted in
  // the same tick that a route starts network I/O. State is only a render wakeup
  // for the mounted guard when the first token starts or the final token settles.
  const busyRef = useRef(false)
  // RFC-208: tokens now carry metadata, not just identity. `startedAt` lets the
  // unsaved guard offer an informed escape once a mutation has clearly stopped
  // making progress, and `abort` lets that escape actually cancel the request —
  // a timestamp alone could do neither, which is why the first sketch of this
  // (a bare `startedAt` on the release closure) could not work.
  const busyTokensRef = useRef(new Map<symbol, { startedAt: number; abort?: () => void }>())
  const busySinceRef = useRef<number | null>(null)
  const [, setBusy] = useState(false)
  const beginBusy = useCallback((cardKey: string, opts?: { abort?: () => void }) => {
    const token = Symbol(cardKey)
    busyTokensRef.current.set(token, {
      startedAt: Date.now(),
      ...(opts?.abort ? { abort: opts.abort } : {}),
    })
    if (!busyRef.current) {
      busyRef.current = true
      busySinceRef.current = Date.now()
      setBusy(true)
    }

    let released = false
    return () => {
      if (released) return
      released = true
      busyTokensRef.current.delete(token)
      if (busyRef.current && busyTokensRef.current.size === 0) {
        busyRef.current = false
        busySinceRef.current = null
        setBusy(false)
      }
    }
  }, [])

  /** Cancel every in-flight operation holding a token (the escape hatch). */
  const abortBusy = useCallback(() => {
    for (const entry of busyTokensRef.current.values()) entry.abort?.()
  }, [])

  const discardHandlersRef = useRef(new Map<string, Set<SplitDiscardHandler>>())
  const registerDiscard = useCallback((cardKey: string, discard: SplitDiscardHandler) => {
    let handlers = discardHandlersRef.current.get(cardKey)
    if (handlers === undefined) {
      handlers = new Set()
      discardHandlersRef.current.set(cardKey, handlers)
    }
    handlers.add(discard)

    let registered = true
    return () => {
      if (!registered) return
      registered = false
      const current = discardHandlersRef.current.get(cardKey)
      current?.delete(discard)
      if (current?.size === 0) discardHandlersRef.current.delete(cardKey)
    }
  }, [])
  const discardCurrent = useCallback((): boolean => {
    const cardKey = dirtyKeyRef.current
    if (cardKey === null) return true
    const handlers = discardHandlersRef.current.get(cardKey)
    if (handlers === undefined) return true
    for (const discard of [...handlers]) {
      if (discard() === false) return false
    }
    return true
  }, [])

  const ctxValue = useMemo<SplitDirtyContextValue>(
    () => ({ dirtyKey, report, beginBusy, registerDiscard }),
    [beginBusy, dirtyKey, registerDiscard, report],
  )

  const items = props.items
  const filtered = useMemo(
    () => (items === undefined ? undefined : filterResourceCards(search, items)),
    [search, items],
  )
  const listEmpty = items !== undefined && items.length === 0
  const filteredEmpty = filtered !== undefined && filtered.length === 0
  const visibleCount = filtered?.length ?? 0
  const firstVisibleKey = filtered?.[0]?.key ?? null
  const mobileView = props.selectedKey !== null || props.newActive ? 'detail' : 'list'

  // Chromium can blur an element to <body> as soon as a media-query rule hides
  // its pane, before the MediaQueryList change callback runs. Remember the last
  // controlled interaction owner so that resize recovery still knows where the
  // now-lost focus came from. Pointer ownership also clears a stale list value
  // when the user clicked a non-focusable detail/background surface.
  useEffect(() => {
    const paneForTarget = (target: EventTarget | null): 'list' | 'detail' | null => {
      if (!(target instanceof Node)) {
        return null
      } else if (listPaneRef.current?.contains(target) === true) {
        return 'list'
      } else if (detailPaneRef.current?.contains(target) === true) {
        return 'detail'
      }
      return null
    }
    const rememberFocusPane = (event: FocusEvent) => {
      // A hidden focused element is automatically blurred to body/html in
      // Chromium. That synthetic destination must not erase its source pane;
      // an intentional click outside is handled by pointerdown below.
      if (event.target === document.body || event.target === document.documentElement) return
      lastInteractionPaneRef.current = paneForTarget(event.target)
    }
    const rememberPointerPane = (event: PointerEvent) => {
      lastInteractionPaneRef.current = paneForTarget(event.target)
    }
    document.addEventListener('focusin', rememberFocusPane, true)
    document.addEventListener('pointerdown', rememberPointerPane, true)
    return () => {
      document.removeEventListener('focusin', rememberFocusPane, true)
      document.removeEventListener('pointerdown', rememberPointerPane, true)
    }
  }, [])

  // At the compact breakpoint the list and detail are mutually exclusive. A
  // card click or a 1081→1080 resize can otherwise leave keyboard focus on a
  // link that CSS just hid. Move only that hidden-list focus to the explicit
  // Back affordance; focus already inside the detail (or an open dialog) stays
  // exactly where the user put it.
  const recoverCompactDetailFocus = useCallback(() => {
    if (mobileView !== 'detail') return
    const active = document.activeElement
    const activeStillInList = active !== null && listPaneRef.current?.contains(active) === true
    const browserDroppedHiddenListFocus =
      (active === null || active === document.body || active === document.documentElement) &&
      lastInteractionPaneRef.current === 'list'
    if (!activeStillInList && !browserDroppedHiddenListFocus) return
    mobileBackRef.current?.focus()
  }, [mobileView])

  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const compact = window.matchMedia('(max-width: 1080px)')
    let recoveryFrame: number | null = null
    const recoverIfCompact = () => {
      if (!compact.matches) return
      recoverCompactDetailFocus()
      // Real browsers may dispatch the media/resize signal before the new CSS
      // display state is focusable. Retry once after layout; the source-pane
      // memory above survives Chromium's intervening blur-to-body.
      if (typeof window.requestAnimationFrame === 'function') {
        if (recoveryFrame !== null) window.cancelAnimationFrame(recoveryFrame)
        recoveryFrame = window.requestAnimationFrame(() => {
          recoveryFrame = null
          recoverCompactDetailFocus()
        })
      }
    }
    recoverIfCompact()
    compact.addEventListener?.('change', recoverIfCompact)
    window.addEventListener('resize', recoverIfCompact)
    return () => {
      compact.removeEventListener?.('change', recoverIfCompact)
      window.removeEventListener('resize', recoverIfCompact)
      if (recoveryFrame !== null) window.cancelAnimationFrame(recoveryFrame)
    }
  }, [recoverCompactDetailFocus])

  // The rail and detail stay mounted; CSS chooses which one is reachable at
  // <=1080px from data-mobile-view. After the explicit detail -> list link
  // completes (including an UnsavedChangesGuard proceed), restore focus to the
  // card the user came from, then the first visible card, then New.
  useEffect(() => {
    if (mobileView !== 'list' || !restoreListFocusRef.current) return
    restoreListFocusRef.current = false

    const returnTarget =
      returnCardKeyRef.current === null
        ? null
        : (cardRefs.current.get(returnCardKeyRef.current) ?? null)
    const firstTarget =
      firstVisibleKey === null ? null : (cardRefs.current.get(firstVisibleKey) ?? null)
    const targets = [returnTarget, firstTarget, newLinkRef.current]
    for (const target of targets) {
      if (target === null || !target.isConnected) continue
      target.focus()
      if (document.activeElement === target) break
    }
  }, [firstVisibleKey, mobileView])

  const markListFocusRestore = useCallback(() => {
    returnCardKeyRef.current = props.selectedKey
    restoreListFocusRef.current = true
    // Focus the Back trigger synchronously, before TanStack Link's own router
    // click runs. WebKit does not focus an <a> on mouse click — activeElement
    // drops to <body> — so an UnsavedChangesGuard opening from this navigation
    // would capture <body> at open time and its Stay/ESC focus restore would be
    // a no-op, stranding keyboard users at the top of the document. Same
    // rationale (and ordering requirement) as AppShell's prepareMobileNavigation.
    // Locked by e2e/ux-consistency.spec.ts (webkit) + tests/split-page-focus.test.tsx.
    mobileBackRef.current?.focus({ preventScroll: true })
  }, [props.selectedKey])

  const retryAction =
    props.onRetry === undefined ? undefined : (
      <button type="button" className="btn btn--sm" onClick={props.onRetry}>
        {t('common.retry')}
      </button>
    )

  const clearSearch = useCallback(() => {
    setSearch('')
    searchInputRef.current?.focus()
  }, [])

  return (
    <div className="page page--split" data-mobile-view={mobileView}>
      <SplitDirtyContext.Provider value={ctxValue}>
        <UnsavedChangesGuard
          dirtyRef={dirtyKeyRef}
          busyRef={busyRef}
          busySinceRef={busySinceRef}
          onForceLeave={abortBusy}
          onDiscard={discardCurrent}
        />
        <div className="split">
          <aside ref={listPaneRef} className="split__list">
            <div className="split__heading">
              <h1 className="split__title">{props.title}</h1>
              {items !== undefined && (
                <span className="split__count" aria-live="polite" data-testid="split-count">
                  {t('splitPage.itemsCount', { count: visibleCount })}
                </span>
              )}
            </div>
            <TextInput
              inputRef={searchInputRef}
              type="search"
              value={search}
              onChange={setSearch}
              placeholder={props.searchPlaceholder}
              aria-label={props.searchPlaceholder}
              className="split__search"
              data-testid="split-search"
            />
            <div className="split__cards" data-testid="split-cards">
              {props.isLoading && items === undefined && <LoadingState size="compact" />}
              {props.error !== null && props.error !== undefined && (
                <ErrorBanner error={props.error} action={retryAction} />
              )}
              {filteredEmpty && (
                <EmptyState
                  size={listEmpty ? 'comfortable' : 'compact'}
                  title={listEmpty ? props.emptyListText : t('common.noMatches')}
                  description={listEmpty ? props.emptyDescription : undefined}
                  icon={listEmpty ? props.emptyIcon : undefined}
                  action={
                    listEmpty ? undefined : (
                      <button type="button" className="btn btn--sm" onClick={clearSearch}>
                        {t('common.clearSearch')}
                      </button>
                    )
                  }
                  data-testid="split-empty"
                />
              )}
              {filtered?.map((it) => {
                const selected = it.key === props.selectedKey
                const subtitle =
                  it.subtitle !== undefined && it.subtitle !== ''
                    ? it.subtitle
                    : t('splitPage.noDescription')
                const cardTitle = (
                  <span className="split-card__title">
                    <span className="split-card__name">{it.title}</span>
                    {dirtyKey === it.key && (
                      <span
                        className="split-card__dot"
                        aria-label={t('splitPage.dirtyDot')}
                        data-testid={`split-card-dot-${it.key}`}
                      />
                    )}
                  </span>
                )
                return (
                  <Link
                    key={it.key}
                    ref={(node) => {
                      if (node === null) cardRefs.current.delete(it.key)
                      else cardRefs.current.set(it.key, node)
                    }}
                    to={it.to}
                    params={it.params}
                    className={`split-card split-card--${it.kind}${selected ? ' is-selected' : ''}`}
                    aria-current={selected ? 'page' : undefined}
                    title={`${it.title}\n${subtitle}`}
                    data-testid={it.testid ?? `split-card-${it.key}`}
                  >
                    <div className="split-card__head">
                      <span className="split-card__icon" aria-hidden="true">
                        {RESOURCE_ICON[it.kind]}
                      </span>
                      <span className="split-card__identity">
                        {(it.kind !== 'agent' ||
                          (it.primaryStatus != null && it.primaryStatus !== false)) && (
                          <span className="split-card__eyebrow">
                            {it.kind !== 'agent' && (
                              <span className="split-card__kind">
                                {t(`splitPage.kind.${it.kind}`)}
                              </span>
                            )}
                            {it.primaryStatus != null && it.primaryStatus !== false && (
                              <span className="split-card__primary-status">{it.primaryStatus}</span>
                            )}
                          </span>
                        )}
                        {cardTitle}
                      </span>
                      <span className="split-card__trailing">
                        <span className="split-card__chevron" aria-hidden="true">
                          →
                        </span>
                      </span>
                    </div>
                    <div
                      className={`split-card__subtitle${it.subtitle === undefined || it.subtitle === '' ? ' split-card__subtitle--empty' : ''}`}
                      title={it.subtitle}
                    >
                      {subtitle}
                    </div>
                    {(it.badges != null && it.badges !== false) || it.updatedAt !== undefined ? (
                      <div className="split-card__summary">
                        {it.badges != null && it.badges !== false && (
                          <span className="split-card__badges chip-row">{it.badges}</span>
                        )}
                        {it.updatedAt !== undefined && (
                          <span className="split-card__updated">
                            <RelativeTime ts={it.updatedAt} />
                          </span>
                        )}
                      </div>
                    ) : null}
                  </Link>
                )
              })}
            </div>
            <Link
              ref={newLinkRef}
              to={props.newTo}
              className={'btn btn--primary split__new' + (props.newActive ? ' is-active' : '')}
              data-testid="split-new-button"
            >
              {props.newLabel}
            </Link>
          </aside>
          <section ref={detailPaneRef} className="split__detail" data-testid="split-detail">
            {mobileView === 'detail' &&
              props.listTo !== undefined &&
              props.mobileBackLabel !== undefined && (
                <Link
                  ref={mobileBackRef}
                  to={props.listTo}
                  className="split__mobile-back"
                  data-testid={props.mobileBackTestId ?? 'split-mobile-back'}
                  onClick={markListFocusRestore}
                >
                  <span aria-hidden="true">←</span> {props.mobileBackLabel}
                </Link>
              )}
            {props.children}
          </section>
        </div>
      </SplitDirtyContext.Provider>
    </div>
  )
}
