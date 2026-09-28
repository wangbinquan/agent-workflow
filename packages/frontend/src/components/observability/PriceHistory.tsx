import { useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ObservationPricingRuntime } from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { TableViewport } from '@/components/TableViewport'
import { PRICE_BUCKETS } from './priceDraft'
import { PRICING_QUERY, runtimePrices } from './priceClient'

export function PriceHistory({
  runtime,
  onClose,
  triggerRef,
}: {
  runtime: ObservationPricingRuntime
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation(),
    [cursors, setCursors] = useState<Array<number | undefined>>([undefined])
  const before = cursors.at(-1)
  const query = useQuery({
    queryKey: [...PRICING_QUERY, 'history', runtime.registrationId, before],
    queryFn: ({ signal }) => runtimePrices.history(runtime.registrationId, before, signal),
  })
  const rows = query.data?.items ?? []
  return (
    <Dialog
      open
      onClose={onClose}
      title={runtime.name + ' · ' + t('observationPricing.history')}
      triggerRef={triggerRef}
      size="lg"
      footer={
        <>
          <button
            className="btn"
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            {t('observationPricing.newer')}
          </button>
          <button
            className="btn"
            disabled={!query.data?.nextBeforeRevision || query.isFetching}
            onClick={() => setCursors((current) => [...current, query.data!.nextBeforeRevision])}
          >
            {t('observationPricing.older')}
          </button>
        </>
      }
    >
      <p>{t('observationPricing.historyHint')}</p>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <p>{t('observationPricing.unpriced')}</p>
      ) : (
        <TableViewport label={t('observationPricing.history')} minWidth="lg">
          <table className="data-table">
            <thead>
              <tr>
                {['version', 'model', 'effectiveFrom', ...PRICE_BUCKETS, 'sourceNote'].map(
                  (key) => (
                    <th key={key}>{t('observationPricing.' + key)}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>CNY-v{row.revision}</td>
                  <td>
                    {row.provider} / {row.model}
                    {row.condition ? <p>{row.condition}</p> : null}
                  </td>
                  <td>{new Date(row.effectiveFrom).toLocaleString()}</td>
                  {PRICE_BUCKETS.map((key) => (
                    <td key={key}>
                      {row.rates[key] === null
                        ? t('observationPricing.unpriced')
                        : '¥' + row.rates[key]}
                    </td>
                  ))}
                  <td>{row.sourceNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
    </Dialog>
  )
}
