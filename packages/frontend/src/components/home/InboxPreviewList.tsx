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
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { NoticeBanner } from '@/components/NoticeBanner'
import {
  INBOX_PREVIEW_LIMIT,
  formatRelativeTime,
  mergeInboxItems,
  projectInboxPreviewState,
  type InboxPreviewItem,
  type InboxSource,
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

  const projection = projectInboxPreviewState(reviews, clarify)
  const knownItems = mergeInboxItems(reviews.data ?? [], clarify.data ?? [], INBOX_PREVIEW_LIMIT)
  const hasKnownSource = reviews.data !== undefined || clarify.data !== undefined
  useEffect(() => {
    if (hasKnownSource) onCount?.(knownItems.length)
  }, [hasKnownSource, knownItems.length, onCount])

  if (projection.kind === 'loading') {
    return <LoadingState size="compact" />
  }
  const failedSources: InboxSource[] =
    projection.kind === 'items'
      ? projection.failedSources
      : (['reviews', 'clarify'] as const).filter((source) =>
          source === 'reviews' ? reviews.error !== null : clarify.error !== null,
        )
  const feedback = (
    <InboxPreviewErrors
      failedSources={failedSources}
      reviewError={reviews.error}
      clarifyError={clarify.error}
      retryReviews={() => void reviews.refetch()}
      retryClarify={() => void clarify.refetch()}
      partial={projection.kind === 'items'}
    />
  )

  if (projection.kind === 'error') {
    return feedback
  }
  if (projection.kind === 'empty') {
    return (
      <EmptyState
        size="compact"
        title={t('home.section.empty.inbox')}
        data-testid="inbox-preview-empty"
      />
    )
  }
  return (
    <>
      {feedback}
      <div className="inbox-list">
        {projection.items.map((item) => (
          <InboxPreviewRow
            key={`${item.kind}-${item.rowKey}`}
            item={item}
            nowMs={nowMs}
            navigate={navigate}
          />
        ))}
      </div>
    </>
  )
}

function InboxPreviewErrors(props: {
  failedSources: readonly InboxSource[]
  reviewError: unknown | null
  clarifyError: unknown | null
  retryReviews: () => void
  retryClarify: () => void
  partial: boolean
}) {
  const { t } = useTranslation()
  if (props.failedSources.length === 0) return null

  return (
    <FeedbackStack variant="section" testid="inbox-preview-errors">
      {props.failedSources.map((source) => {
        const reviews = source === 'reviews'
        const feedLabel = t(reviews ? 'nav.inbox.tabReviews' : 'nav.inbox.tabClarify')
        const message = t(reviews ? 'nav.inbox.errorReviews' : 'nav.inbox.errorClarify')
        const retry = reviews ? props.retryReviews : props.retryClarify
        const retryAriaLabel = t('nav.inbox.retryFeed', { feed: feedLabel })
        if (props.partial) {
          return (
            <NoticeBanner
              key={source}
              tone="warning"
              size="compact"
              action={
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-label={retryAriaLabel}
                  onClick={retry}
                >
                  {t('nav.inbox.retry')}
                </button>
              }
              testid={`inbox-preview-error-${source}`}
            >
              {message}
            </NoticeBanner>
          )
        }
        return (
          <ErrorBanner
            key={source}
            error={reviews ? props.reviewError : props.clarifyError}
            message={message}
            onRetry={retry}
            retryLabel={t('nav.inbox.retry')}
            retryAriaLabel={retryAriaLabel}
            testid={`inbox-preview-error-${source}`}
          />
        )
      })}
    </FeedbackStack>
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
