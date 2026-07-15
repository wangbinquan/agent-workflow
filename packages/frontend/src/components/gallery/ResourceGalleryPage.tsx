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
// Filtering reuses `filterResourceCards` (RFC-169 T2 — title OR subtitle
// substring), which is why GalleryCardItem's text fields are named
// title/subtitle. Sorting is NOT here — pages sort items (updatedAt desc)
// while assembling.

import { useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { filterResourceCards } from '@/lib/resource-card-filter'
import { GalleryCard, type GalleryCardItem } from '@/components/gallery/GalleryCard'

export type { GalleryCardItem, GalleryLaunchSearch } from '@/components/gallery/GalleryCard'

export interface ResourceGalleryPageProps {
  title: string
  /** Header-right action cluster (import / new buttons, incl. testids/refs). */
  headerActions: ReactNode
  /** Rendered under the header, before search + grid (import feedback …). */
  notice?: ReactNode
  items: GalleryCardItem[] | undefined
  isLoading: boolean
  error: unknown
  searchPlaceholder: string
  /** Shown when the resource list itself is empty (vs. filtered-to-nothing). */
  emptyListText: string
  emptyTestid: string
  loadingTestid?: string
  /** Page-level satellites (QuickCreateDialog …), rendered after the grid. */
  children?: ReactNode
}

export function ResourceGalleryPage(props: ResourceGalleryPageProps): ReactElement {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const items = props.items
  const filtered = useMemo(
    () => (items === undefined ? undefined : filterResourceCards(search, items)),
    [search, items],
  )
  const hasItems = items !== undefined && items.length > 0
  const hasNotice = props.notice != null && props.notice !== false

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{props.title}</h1>
        </div>
        <div className="page__actions">{props.headerActions}</div>
      </header>
      {hasNotice && props.notice}

      {props.isLoading && <LoadingState data-testid={props.loadingTestid} />}
      {props.error !== null && props.error !== undefined && <ErrorBanner error={props.error} />}
      {!props.isLoading && items !== undefined && items.length === 0 && (
        <EmptyState title={props.emptyListText} data-testid={props.emptyTestid} />
      )}

      {hasItems && (
        <div className="gallery__toolbar">
          <TextInput
            type="search"
            value={search}
            onChange={setSearch}
            placeholder={props.searchPlaceholder}
            aria-label={props.searchPlaceholder}
            className="gallery__search"
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
        <EmptyState size="compact" title={t('common.noMatches')} data-testid="gallery-no-matches" />
      )}

      {props.children}
    </div>
  )
}
