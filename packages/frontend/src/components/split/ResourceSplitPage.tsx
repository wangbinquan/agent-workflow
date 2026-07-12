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

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { filterResourceCards } from '@/lib/resource-card-filter'
import { SplitDirtyContext, type SplitDirtyContextValue } from '@/components/split/splitDirty'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'

/** Detail routes the cards link to (byte-equal to the existing deep links). */
export type ResourceDetailTo = '/agents/$name' | '/skills/$name' | '/mcps/$name' | '/plugins/$id'
/** "+ new" routes. */
export type ResourceNewTo = '/agents/new' | '/skills/new' | '/mcps/new' | '/plugins/new'

export interface ResourceCardItem {
  /** agents/skills/mcps = name; plugins = id. */
  key: string
  title: string
  /** One-line CSS truncation; full text in the title attribute. */
  subtitle?: string
  /** Per-page assembled existing chips (ResourceBadges / StatusChip / …). */
  badges?: ReactNode
  to: ResourceDetailTo
  params: { name: string } | { id: string }
  testid?: string
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
  /** Right rail (the routed <Outlet/>). */
  children: ReactNode
}

export function ResourceSplitPage(props: ResourceSplitPageProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

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

  return (
    <div className="page page--split">
      <SplitDirtyContext.Provider value={ctxValue}>
        <UnsavedChangesGuard dirtyRef={dirtyKeyRef} />
        <div className="split">
          <aside className="split__list">
            <h1 className="split__title">{props.title}</h1>
            <input
              className="form-input split__search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={props.searchPlaceholder}
              aria-label={props.searchPlaceholder}
              data-testid="split-search"
            />
            <div className="split__cards" data-testid="split-cards">
              {props.isLoading && items === undefined && <LoadingState size="compact" />}
              {props.error !== null && props.error !== undefined && (
                <ErrorBanner error={props.error} />
              )}
              {filteredEmpty && (
                <EmptyState
                  size="compact"
                  title={listEmpty ? props.emptyListText : t('common.noMatches')}
                  data-testid="split-empty"
                />
              )}
              {filtered?.map((it) => (
                <Link
                  key={it.key}
                  to={it.to}
                  params={it.params}
                  className={'split-card' + (it.key === props.selectedKey ? ' is-selected' : '')}
                  data-testid={it.testid ?? `split-card-${it.key}`}
                >
                  <div className="split-card__title">
                    <span className="split-card__name">{it.title}</span>
                    {dirtyKey === it.key && (
                      <span
                        className="split-card__dot"
                        aria-label={t('splitPage.dirtyDot')}
                        data-testid={`split-card-dot-${it.key}`}
                      />
                    )}
                  </div>
                  {it.subtitle !== undefined && it.subtitle !== '' && (
                    <div className="split-card__subtitle" title={it.subtitle}>
                      {it.subtitle}
                    </div>
                  )}
                  {it.badges !== undefined && (
                    <div className="split-card__badges chip-row">{it.badges}</div>
                  )}
                </Link>
              ))}
            </div>
            <Link
              to={props.newTo}
              className={'btn btn--primary split__new' + (props.newActive ? ' is-active' : '')}
              data-testid="split-new-button"
            >
              {props.newLabel}
            </Link>
          </aside>
          <section className="split__detail" data-testid="split-detail">
            {props.children}
          </section>
        </div>
      </SplitDirtyContext.Provider>
    </div>
  )
}
