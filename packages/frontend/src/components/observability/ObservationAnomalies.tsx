import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ObservationAnomalyPageSchema, type ObservationAnomaly } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { TableViewport } from '@/components/TableViewport'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { ErrorBanner } from '@/components/ErrorBanner'
export function ObservationAnomalies({ from, to }: { from: number; to: number }) {
  const { t, i18n } = useTranslation(),
    [cursor, setCursor] = useState<{ from: number; to: number; after: string }>(),
    [selected, setSelected] = useState<ObservationAnomaly>(),
    trigger = useRef<HTMLButtonElement | null>(null),
    after = cursor?.from === from && cursor.to === to ? cursor.after : undefined,
    query = useQuery({
      queryKey: ['observation-anomalies', from, to, after],
      queryFn: async () =>
        ObservationAnomalyPageSchema.parse(
          await api.get(
            '/api/observability/anomalies?' +
              new URLSearchParams({
                from: String(from),
                to: String(to),
                ...(after ? { after } : {}),
              }),
          ),
        ),
      refetchInterval: 10000,
    }),
    data = query.error ? undefined : query.data,
    date = (at: number | null) => (at === null ? '—' : new Date(at).toLocaleString(i18n.language))
  return (
    <Card title={t('runObservability.anomalyTitle')}>
      {query.isPending ? <LoadingState /> : null}
      {query.error ? (
        <ErrorBanner
          error={query.error}
          onRetry={() => {
            void query.refetch()
          }}
        />
      ) : null}
      {data?.items.length ? (
        <TableViewport label={t('runObservability.anomalyTitle')}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('runObservability.anomalyRule')}</th>
                <th>{t('runObservability.anomalyState')}</th>
                <th>{t('runObservability.task')}</th>
                <th>{t('runObservability.start')}</th>
                <th>{t('runObservability.end')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      className="link link--button data-table__link"
                      onClick={(e) => {
                        trigger.current = e.currentTarget
                        setSelected(row)
                      }}
                    >
                      {t('runObservability.anomalyRule_' + row.rule)}
                    </button>
                  </td>
                  <td>{t('runObservability.anomalyState_' + row.state)}</td>
                  <td>
                    {row.taskName ?? t('runObservability.unknown')}
                    <div className="muted">{row.taskId}</div>
                  </td>
                  <td>{date(row.firedAt ?? row.firstObservedAt)}</td>
                  <td>{date(row.resolvedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : data ? (
        <EmptyState title={t('runObservability.noAnomalies')} />
      ) : null}
      <p className="muted">{t('runObservability.anomalyHint')}</p>
      {data ? (
        <p className="muted">{t('runObservability.anomalyCount', { count: data.total })}</p>
      ) : null}
      <div className="page__actions">
        {data?.nextCursor ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              if (data.nextCursor) setCursor({ from, to, after: data.nextCursor })
            }}
          >
            {t('runObservability.next')}
          </button>
        ) : null}
        {after ? (
          <button type="button" className="btn btn--sm" onClick={() => setCursor(undefined)}>
            {t('runObservability.first')}
          </button>
        ) : null}
      </div>
      {selected ? (
        <Dialog
          panelClassName="observation-typography"
          open
          title={t('runObservability.anomalyRule_' + selected.rule)}
          onClose={() => setSelected(undefined)}
          triggerRef={trigger}
        >
          <dl className="detail-grid">
            <dt>{t('runObservability.anomalyState')}</dt>
            <dd>{t('runObservability.anomalyState_' + selected.state)}</dd>
            <dt>{t('runObservability.anomalySourceState')}</dt>
            <dd>{selected.sourceState}</dd>
            <dt>{t('runObservability.anomalyThreshold')}</dt>
            <dd>
              {t('runObservability.anomalyThresholdValue', {
                samples: selected.minimumSamples,
                duration: selected.durationMs,
                window: selected.windowMs,
              })}
            </dd>
            <dt>{t('runObservability.start')}</dt>
            <dd>{date(selected.firstObservedAt)}</dd>
            <dt>{t('runObservability.end')}</dt>
            <dd>{date(selected.resolvedAt)}</dd>
            <dt>{t('runObservability.anomalyEvidence')}</dt>
            <dd>{selected.evidence.join(' · ')}</dd>
          </dl>
        </Dialog>
      ) : null}
    </Card>
  )
}
