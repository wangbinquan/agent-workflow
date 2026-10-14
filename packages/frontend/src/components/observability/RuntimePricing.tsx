// RFC-371 v2 §6 — Settings → Runtimes → Token cost: each runtime lists its
// configured model and every model it has reported, each with its own CNY price line.
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ObservationPrice, ObservationPricingRuntime } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { PRICING_QUERY, pricingApi } from './observationClient'
import { PRICE_BUCKETS } from './priceDraft'
import { PriceEditor } from './PriceEditor'
import { PriceHistory } from './PriceHistory'
import './RunObservability.css'

interface Editing {
  readonly runtime: ObservationPricingRuntime
  readonly model: string | null
  readonly current: ObservationPrice | null
}

export function RuntimePricing() {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [history, setHistory] = useState<{
    runtime: ObservationPricingRuntime
    model: string
  } | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const query = useQuery({
    queryKey: PRICING_QUERY,
    queryFn: ({ signal }) => pricingApi.directory(signal),
    staleTime: 30_000,
  })
  // Without settings write permission the section stays empty instead of erroring.
  const forbidden = query.error instanceof ApiError && [401, 403].includes(query.error.status)
  const runtimes = forbidden ? [] : (query.data?.runtimes ?? [])
  const summary = (price: ObservationPrice | null) =>
    price === null
      ? t('observationPricing.unpriced')
      : PRICE_BUCKETS.map((bucket) =>
          price.rates[bucket] === null
            ? `${t(`observationPricing.${bucket}`)} ${t('observationPricing.unpriced')}`
            : `${t(`observationPricing.${bucket}`)} ${t('observationPricing.rate', { rate: price.rates[bucket] })}`,
        ).join(' · ')
  return (
    <section id="token-cost">
      <SettingsCard title={t('observationPricing.title')} hint={t('observationPricing.hint')}>
        {query.isLoading ? <LoadingState /> : null}
        {query.error && !forbidden ? (
          <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {!query.isLoading && !query.error && runtimes.length === 0 ? (
          <EmptyState title={t('observationPricing.empty')} size="compact" />
        ) : null}
        <div className="stack--md">
          {runtimes.map((runtime) => (
            <section
              key={runtime.runtimeId}
              className="stack--sm"
              aria-label={t('observationPricing.runtimeModels', { name: runtime.name })}
            >
              <h4>
                {t('observationPricing.runtimeModels', { name: runtime.name })}{' '}
                <span className="muted">{runtime.protocol}</span>
              </h4>
              {runtime.models.length === 0 ? (
                <p className="muted">{t('observationPricing.noModels')}</p>
              ) : (
                <TableViewport
                  label={t('observationPricing.runtimeModels', { name: runtime.name })}
                  minWidth="lg"
                >
                  <table
                    className="data-table data-table--compact"
                    aria-label={t('observationPricing.runtimeModels', { name: runtime.name })}
                  >
                    <thead>
                      <tr>
                        <th scope="col">{t('observationPricing.colModel')}</th>
                        <th scope="col" className="observability__num">
                          {t('observationPricing.colCalls')}
                        </th>
                        <th scope="col">{t('observationPricing.colCurrent')}</th>
                        <th scope="col">{t('observationPricing.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runtime.models.map((line) => (
                        <tr key={line.model}>
                          <th scope="row">
                            {line.model}{' '}
                            {line.model === runtime.configuredModel ? (
                              <StatusChip kind="neutral">
                                {t('observationPricing.configured')}
                              </StatusChip>
                            ) : null}
                          </th>
                          <td className="observability__num">{line.calls}</td>
                          <td>{summary(line.current)}</td>
                          <td>
                            <div className="page__actions">
                              <button
                                type="button"
                                className="btn btn--sm"
                                onClick={(event) => {
                                  trigger.current = event.currentTarget
                                  setEditing({ runtime, model: line.model, current: line.current })
                                }}
                              >
                                {t('observationPricing.configure')}
                              </button>
                              <button
                                type="button"
                                className="btn btn--sm"
                                disabled={line.current === null}
                                onClick={(event) => {
                                  trigger.current = event.currentTarget
                                  setHistory({ runtime, model: line.model })
                                }}
                              >
                                {t('observationPricing.history')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
              )}
              <div>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={(event) => {
                    trigger.current = event.currentTarget
                    setEditing({ runtime, model: null, current: null })
                  }}
                >
                  {t('observationPricing.addModel')}
                </button>
              </div>
            </section>
          ))}
        </div>
      </SettingsCard>
      {editing ? (
        <PriceEditor
          runtime={{ runtimeId: editing.runtime.runtimeId, name: editing.runtime.name }}
          model={editing.model}
          current={editing.current}
          triggerRef={trigger}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {history ? (
        <PriceHistory
          runtime={{ runtimeId: history.runtime.runtimeId, name: history.runtime.name }}
          model={history.model}
          triggerRef={trigger}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </section>
  )
}
