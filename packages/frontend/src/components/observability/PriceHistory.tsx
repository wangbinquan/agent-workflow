// RFC-371 v2 §3.3 — every saved version of one (runtime, model) price line, newest first.
import type { RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { TableViewport } from '@/components/TableViewport'
import { PRICING_QUERY, pricingApi } from './observationClient'
import { PRICE_BUCKETS } from './priceDraft'

export function PriceHistory(props: {
  runtime: { readonly runtimeId: string; readonly name: string }
  model: string
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const query = useQuery({
    queryKey: [...PRICING_QUERY, 'history', props.runtime.runtimeId, props.model],
    queryFn: ({ signal }) => pricingApi.history(props.runtime.runtimeId, props.model, signal),
  })
  const date = (at: number) => new Date(at).toLocaleString(i18n.language)
  const title = t('observationPricing.historyTitle', {
    runtime: props.runtime.name,
    model: props.model,
  })
  return (
    <Dialog open size="lg" title={title} onClose={props.onClose} triggerRef={props.triggerRef}>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data || query.data.items.length === 0 ? (
        <EmptyState title={t('observationPricing.historyEmpty')} size="compact" />
      ) : (
        <TableViewport label={title} minWidth="lg">
          <table className="data-table data-table--compact" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{t('observationPricing.colSavedAt')}</th>
                <th scope="col">{t('observationPricing.colEffectiveFrom')}</th>
                {PRICE_BUCKETS.map((bucket) => (
                  <th key={bucket} scope="col" className="observability__num">
                    {t(`observationPricing.${bucket}`)}
                  </th>
                ))}
                <th scope="col">{t('observationPricing.colSavedBy')}</th>
                <th scope="col">{t('observationPricing.colNote')}</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((version) => (
                <tr key={version.id}>
                  <th scope="row">{date(version.createdAt)}</th>
                  <td>{date(Math.max(version.effectiveFrom, version.createdAt))}</td>
                  {PRICE_BUCKETS.map((bucket) => (
                    <td key={bucket} className="observability__num">
                      {version.rates[bucket] === null
                        ? t('observationPricing.unpriced')
                        : t('observationPricing.rate', { rate: version.rates[bucket] })}
                    </td>
                  ))}
                  <td>{version.createdBy}</td>
                  <td>{version.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
    </Dialog>
  )
}
