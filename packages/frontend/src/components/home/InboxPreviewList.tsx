// RFC-032 PR3: homepage's "Waiting on you" preview list.
//
// Same data feeds as the sidebar inbox drawer (`/api/reviews?status=pending`
// + `/api/clarify?status=awaiting_human`), merged through the shared
// `mergeInboxItems` helper and capped at 8 rows. v1 navigates directly
// to the detail page on click; we don't try to coordinate state with
// the sidebar drawer (the user can still pop the drawer open from the
// sidebar if they want a longer queue).

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import {
  INBOX_PREVIEW_LIMIT,
  formatRelativeTime,
  mergeInboxItems,
  type InboxPreviewItem,
} from '@/lib/homepage'

export const REVIEWS_HOMEPAGE_QUERY_KEY = ['reviews', 'homepage', 'pending'] as const
export const CLARIFY_HOMEPAGE_QUERY_KEY = ['clarify', 'homepage', 'pending'] as const

interface InboxPreviewListProps {
  onCount?: (n: number) => void
}

export function InboxPreviewList({ onCount }: InboxPreviewListProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const reviews = useQuery<ReviewSummary[]>({
    queryKey: REVIEWS_HOMEPAGE_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/reviews?status=pending', undefined, signal),
    refetchInterval: 15_000,
  })
  const clarify = useQuery<ClarifyRoundSummary[]>({
    queryKey: CLARIFY_HOMEPAGE_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/clarify?status=awaiting_human', undefined, signal),
    refetchInterval: 15_000,
  })
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const items = mergeInboxItems(reviews.data ?? [], clarify.data ?? [], INBOX_PREVIEW_LIMIT)
  useEffect(() => {
    onCount?.(items.length)
  }, [items.length, onCount])

  const isLoading = reviews.isLoading || clarify.isLoading
  const bothErrored = reviews.error !== null && clarify.error !== null
  if (isLoading && items.length === 0) {
    return <LoadingState size="compact" />
  }
  if (bothErrored) {
    return (
      <div className="error-box" role="alert">
        <span>{t('home.section.error.generic')}</span>
        <button
          type="button"
          className="btn btn--xs"
          onClick={() => {
            void reviews.refetch()
            void clarify.refetch()
          }}
          style={{ marginLeft: 8 }}
        >
          {t('home.section.error.retry')}
        </button>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyState
        size="compact"
        title={t('home.section.empty.inbox')}
        data-testid="inbox-preview-empty"
      />
    )
  }
  return (
    <div className="inbox-list">
      {items.map((item) => (
        <InboxPreviewRow
          key={`${item.kind}-${item.rowKey}`}
          item={item}
          nowMs={nowMs}
          navigate={navigate}
        />
      ))}
    </div>
  )
}

interface InboxPreviewRowProps {
  item: InboxPreviewItem
  nowMs: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigate: any
}

function InboxPreviewRow({ item, nowMs, navigate }: InboxPreviewRowProps) {
  const { t } = useTranslation()
  const rel = formatRelativeTime(nowMs, item.timestamp)
  return (
    <button
      type="button"
      className="inbox-row"
      data-testid={`inbox-preview-${item.kind}-${item.rowKey}`}
      onClick={() => {
        const target =
          item.kind === 'review'
            ? { to: '/reviews/$nodeRunId', params: { nodeRunId: item.id } }
            : { to: '/clarify/$nodeRunId', params: { nodeRunId: item.id } }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void navigate(target as any)
      }}
    >
      <span className={`inbox-row__kind inbox-row__kind--${item.kind}`}>
        {t(item.kind === 'review' ? 'nav.inbox.tabReviews' : 'nav.inbox.tabClarify')}
      </span>
      <span className="inbox-row__title">{item.title}</span>
      <span className="inbox-row__subtitle muted">{item.subtitle}</span>
      <span className="inbox-row__time muted">{t(`home.taskRow.${rel.key}`, rel.opts)}</span>
    </button>
  )
}
