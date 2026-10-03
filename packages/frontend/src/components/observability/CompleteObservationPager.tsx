import { useTranslation } from 'react-i18next'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import type { ReactNode } from 'react'
import type { CompleteObservationReportPage } from '@agent-workflow/shared'

export interface CompletePageState<T> {
  readonly data: CompleteObservationReportPage<T> | undefined
  readonly error: Error | null
  readonly isPending: boolean
  readonly isFetching: boolean
  readonly page: number
  readonly first: () => void
  readonly previous: () => void
  readonly next: () => void
  readonly refetch: () => Promise<unknown>
}
export function CompleteObservationPage<T>({
  query,
  children,
}: {
  query: CompletePageState<T>
  children: (items: readonly T[]) => ReactNode
}) {
  const { t, i18n } = useTranslation()
  if (query.error) return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
  if (!query.data || query.isFetching) return <LoadingState />
  return (
    <div className="stack--md">
      {children(query.data.items)}
      <div className="complete-observation-pager">
        <span className="muted">
          {t('runObservability.fullPage', {
            total: BigInt(query.data.total).toLocaleString(i18n.language),
            page: query.page,
          })}
        </span>
        <div className="action-row">
          <button
            className="btn btn--sm btn--ghost"
            type="button"
            disabled={query.page === 1}
            onClick={query.first}
          >
            {t('runObservability.first')}
          </button>
          <button
            className="btn btn--sm"
            type="button"
            disabled={query.page === 1}
            onClick={query.previous}
          >
            {t('runObservability.previous')}
          </button>
          <button
            className="btn btn--sm"
            type="button"
            disabled={query.data.nextCursor === null}
            onClick={query.next}
          >
            {t('runObservability.next')}
          </button>
        </div>
      </div>
    </div>
  )
}
