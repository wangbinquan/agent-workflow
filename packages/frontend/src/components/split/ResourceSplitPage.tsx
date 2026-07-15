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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { RelativeTime } from '@/components/RelativeTime'
import { filterResourceCards } from '@/lib/resource-card-filter'
import { SplitDirtyContext, type SplitDirtyContextValue } from '@/components/split/splitDirty'
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
  const cardRefs = useRef(new Map<string, HTMLAnchorElement>())
  const newLinkRef = useRef<HTMLAnchorElement | null>(null)
  const restoreListFocusRef = useRef(false)
  const returnCardKeyRef = useRef<string | null>(null)

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
  const ctxValue = useMemo<SplitDirtyContextValue>(() => ({ dirtyKey, report }), [dirtyKey, report])

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

  // The rail and detail stay mounted; CSS chooses which one is reachable at
  // <=720px from data-mobile-view. After the explicit detail -> list link
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
        <UnsavedChangesGuard dirtyRef={dirtyKeyRef} />
        <div className="split">
          <aside className="split__list">
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
          <section className="split__detail" data-testid="split-detail">
            {mobileView === 'detail' &&
              props.listTo !== undefined &&
              props.mobileBackLabel !== undefined && (
                <Link
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
