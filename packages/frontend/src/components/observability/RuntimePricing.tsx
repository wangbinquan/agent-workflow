import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ObservationPricingRuntime } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { TableViewport } from '@/components/TableViewport'
import { PriceEditor } from './PriceEditor'
import { PriceHistory } from './PriceHistory'
import { PRICING_QUERY, runtimePrices } from './priceClient'

export function RuntimePricing() {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<ObservationPricingRuntime>(),
    [open, setOpen] = useState(false)
  const [history, setHistory] = useState<ObservationPricingRuntime>(),
    [pending, setPending] = useState<ObservationPricingRuntime>()
  const [dirty, setDirty] = useState(false),
    [sequence, setSequence] = useState(0)
  const trigger = useRef<HTMLElement | null>(null),
    historyTrigger = useRef<HTMLElement | null>(null)
  const query = useQuery({
    queryKey: PRICING_QUERY,
    queryFn: ({ signal }) => runtimePrices.directory(signal),
    staleTime: 30_000,
  })
  const rows =
    query.error instanceof ApiError && [401, 403].includes(query.error.status)
      ? []
      : (query.data?.runtimes ?? [])
  const choose = (runtime: ObservationPricingRuntime) => {
    if (editing?.registrationId === runtime.registrationId) {
      setOpen(true)
      return
    }
    if (editing && dirty) {
      setPending(runtime)
      return
    }
    setEditing(runtime)
    setSequence((value) => value + 1)
    setOpen(true)
  }
  return (
    <section id="token-cost">
      <SettingsCard title={t('observationPricing.title')} hint={t('observationPricing.hint')}>
        {query.isLoading ? <LoadingState /> : null}
        {query.error ? (
          <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {!query.isLoading && !query.error && rows.length === 0 ? (
          <p>{t('observationPricing.empty')}</p>
        ) : null}
        {rows.length ? (
          <TableViewport label={t('observationPricing.title')}>
            <table className="data-table">
              <thead>
                <tr>
                  {['runtime', 'model', 'version', 'actions'].map((key) => (
                    <th key={key}>{t('observationPricing.' + key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((runtime) => (
                  <tr key={runtime.registrationId}>
                    <td>
                      {runtime.name}
                      <p className="muted">{runtime.protocol}</p>
                    </td>
                    <td>{runtime.model ?? '—'}</td>
                    <td>
                      {runtime.pricingRevision
                        ? 'CNY-v' + runtime.pricingRevision
                        : t('observationPricing.unpriced')}
                    </td>
                    <td>
                      <div className="page__actions">
                        <button
                          className="btn btn--sm"
                          onClick={(event) => {
                            trigger.current = event.currentTarget
                            choose(runtime)
                          }}
                        >
                          {t('observationPricing.configure')}
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={(event) => {
                            historyTrigger.current = event.currentTarget
                            setHistory(runtime)
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
        ) : null}
      </SettingsCard>
      {editing ? (
        <PriceEditor
          key={sequence}
          runtime={editing}
          open={open}
          triggerRef={trigger}
          onDirty={setDirty}
          onClose={() => setOpen(false)}
          onClear={() => {
            setSequence((value) => value + 1)
            setDirty(false)
          }}
          onSaved={() => {
            setEditing(undefined)
            setOpen(false)
            setDirty(false)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(pending)}
        title={t('observationPricing.title')}
        description={t('observationPricing.switchDraft')}
        confirmLabel={t('observationPricing.discard')}
        onClose={() => setPending(undefined)}
        onConfirm={() => {
          setEditing(pending)
          setPending(undefined)
          setSequence((value) => value + 1)
          setDirty(false)
          setOpen(true)
        }}
      />
      {history ? (
        <PriceHistory
          runtime={history}
          onClose={() => setHistory(undefined)}
          triggerRef={historyTrigger}
        />
      ) : null}
    </section>
  )
}
