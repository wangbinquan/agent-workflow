// RFC-191 (T2) — the card-gallery page skeleton, shared by the two
// definition-resource list pages (workflows / workgroups).
//
// Layout: `.page__header--row` header (title + caller-assembled actions) →
// `notice` slot (import feedback MUST render before the grid — Codex 设计门
// P2-9) → search box (ONLY when the list has items, so the empty state stays
// byte-identical to the pre-gallery pages and the visual baselines never
// churn) → loading / error / empty states (shared primitives, same testids)
// → the responsive card grid.
//
// Filtering reuses `filterResourceCards` (RFC-169 T2 — title / subtitle plus
// an optional projection of visible card facts). Sorting is NOT here — pages
// sort items (updatedAt desc) while assembling.

import { useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { filterResourceCards } from '@/lib/resource-card-filter'
import { GalleryCard, type GalleryCardItem } from '@/components/gallery/GalleryCard'

export type {
  GalleryCardItem,
  GalleryLaunchSearch,
  WorkflowGalleryCardItem,
  WorkgroupGalleryCardItem,
} from '@/components/gallery/GalleryCard'

interface ResourceGalleryPageBaseProps {
  title: string
  /** Header-right action cluster (import / new buttons, incl. testids/refs). */
  headerActions: ReactNode
  /**
   * Header actions retained for a genuine empty list when `emptyAction` moves
   * the primary action into EmptyState (for example, keep Import but omit New).
   */
  emptyHeaderActions?: ReactNode
  /** Rendered under the header, before search + grid (import feedback …). */
  notice?: ReactNode
  items: GalleryCardItem[] | undefined
  isLoading: boolean
  error: unknown
  searchPlaceholder: string
  /** Shown when the resource list itself is empty (vs. filtered-to-nothing). */
  emptyListText: string
  emptyDescription?: string
  emptyIcon?: ReactNode
  /** Primary empty-list action; suppresses `headerActions` while it is shown. */
  emptyAction?: ReactNode
  /** Retry action shown inside the error banner; stale items remain visible. */
  onRetry?: () => void
  emptyTestid: string
  loadingTestid?: string
  /** Page-level satellites (QuickCreateDialog …), rendered after the grid. */
  children?: ReactNode
}

type ResourceGalleryClearSearchProps =
  | {
      onClearSearch?: undefined
      clearSearchLabel?: undefined
    }
  | {
      /** Called after the internal query is cleared and before search focus is restored. */
      onClearSearch: () => void
      /** Caller-translated visible label for the compact no-match action. */
      clearSearchLabel: string
    }

export type ResourceGalleryPageProps = ResourceGalleryPageBaseProps &
  ResourceGalleryClearSearchProps

export function ResourceGalleryPage(props: ResourceGalleryPageProps): ReactElement {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)

  const items = props.items
  const filtered = useMemo(
    () => (items === undefined ? undefined : filterResourceCards(search, items)),
    [search, items],
  )
  const hasItems = items !== undefined && items.length > 0
  const isGenuineEmpty = !props.isLoading && items !== undefined && items.length === 0
  const hasNotice = props.notice != null && props.notice !== false
  const hasEmptyAction =
    props.emptyAction !== undefined && props.emptyAction !== null && props.emptyAction !== false
  const visibleCount = filtered?.length ?? 0
  const headerActions =
    isGenuineEmpty && hasEmptyAction ? props.emptyHeaderActions : props.headerActions
  const retryAction =
    props.onRetry === undefined ? undefined : (
      <button type="button" className="btn btn--sm" onClick={props.onRetry}>
        {t('common.retry')}
      </button>
    )

  const clearSearch = () => {
    setSearch('')
    props.onClearSearch?.()
    const target = searchRef.current
    if (target !== null && target.isConnected) target.focus()
  }

  const clearSearchAction =
    props.onClearSearch === undefined ? undefined : (
      <button type="button" className="btn btn--sm" onClick={clearSearch}>
        {props.clearSearchLabel}
      </button>
    )

  return (
    <div className="page page--gallery">
      <PageHeader title={props.title} actions={headerActions} />
      {hasNotice && props.notice}

      {props.isLoading && <LoadingState data-testid={props.loadingTestid} />}
      {props.error !== null && props.error !== undefined && (
        <ErrorBanner error={props.error} action={retryAction} />
      )}
      {isGenuineEmpty && (
        <EmptyState
          title={props.emptyListText}
          description={props.emptyDescription}
          icon={props.emptyIcon}
          action={hasEmptyAction ? props.emptyAction : undefined}
          data-testid={props.emptyTestid}
        />
      )}

      {hasItems && (
        <div className="gallery__toolbar">
          <span className="gallery__count" data-testid="gallery-count" aria-live="polite">
            {t('common.itemsCount', { count: visibleCount })}
          </span>
          <TextInput
            type="search"
            value={search}
            onChange={setSearch}
            placeholder={props.searchPlaceholder}
            aria-label={props.searchPlaceholder}
            className="gallery__search"
            inputRef={searchRef}
            data-testid="gallery-search"
          />
        </div>
      )}
      {filtered !== undefined && filtered.length > 0 && (
        <div className="gallery" data-testid="gallery-grid">
          {filtered.map((it) => (
            <GalleryCard key={it.key} item={it} />
          ))}
        </div>
      )}
      {hasItems && filtered !== undefined && filtered.length === 0 && (
        <EmptyState
          size="compact"
          title={t('common.noMatches')}
          action={clearSearchAction}
          data-testid="gallery-no-matches"
        />
      )}

      {props.children}
    </div>
  )
}
