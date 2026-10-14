// RFC-371 v2 §6 — consumption per agent and per runtime × actual model; an
// unpriced model links to its price line in Settings → Runtimes.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { TableViewport } from '@/components/TableViewport'
import { OBSERVATION_QUERY, observationApi, type ObservationWindow } from './observationClient'
import { durationLabel, formatCount } from './observationFormat'
import { UsageCells, UsageHeaderCells } from './ObservationUsage'

export function ObservationAgentsPanel({ window }: { window: ObservationWindow }) {
  const { t, i18n } = useTranslation()
  const agents = useQuery({
    queryKey: [...OBSERVATION_QUERY, 'agents', window],
    queryFn: ({ signal }) => observationApi.agents(window, signal),
    placeholderData: keepPreviousData,
  })
  const models = useQuery({
    queryKey: [...OBSERVATION_QUERY, 'models', window],
    queryFn: ({ signal }) => observationApi.models(window, signal),
    placeholderData: keepPreviousData,
  })
  const count = (value: number) => formatCount(value, i18n.language)
  return (
    <div className="stack--md">
      {agents.data?.partial || models.data?.partial ? (
        <NoticeBanner tone="warning">{t('runObservability.partial')}</NoticeBanner>
      ) : null}
      <Card title={t('runObservability.agentsTitle')}>
        {agents.isLoading ? (
          <LoadingState />
        ) : agents.error ? (
          <ErrorBanner error={agents.error} onRetry={() => void agents.refetch()} />
        ) : !agents.data || agents.data.items.length === 0 ? (
          <EmptyState title={t('runObservability.agentsEmpty')} size="compact" />
        ) : (
          <>
            {agents.data.truncated ? (
              <p className="muted">
                {t('runObservability.listTruncated', { count: agents.data.items.length })}
              </p>
            ) : null}
            <TableViewport label={t('runObservability.agentsTitle')} minWidth="lg">
              <table
                className="data-table data-table--compact"
                aria-label={t('runObservability.agentsTitle')}
              >
                <thead>
                  <tr>
                    <th scope="col">{t('runObservability.colAgent')}</th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.colTasks')}
                    </th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.colCalls')}
                    </th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.colCallTime')}
                    </th>
                    <UsageHeaderCells />
                  </tr>
                </thead>
                <tbody>
                  {agents.data.items.map((row) => (
                    <tr key={row.agentId ?? '~' + row.agentName}>
                      <th scope="row">{row.agentName}</th>
                      <td className="observability__num">{count(row.tasks)}</td>
                      <td className="observability__num">{count(row.usage.calls)}</td>
                      <td className="observability__num">{durationLabel(row.durationMs, t)}</td>
                      <UsageCells usage={row.usage} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          </>
        )}
      </Card>
      <Card title={t('runObservability.modelsTitle')}>
        <p className="muted">{t('runObservability.modelsHint')}</p>
        {models.isLoading ? (
          <LoadingState />
        ) : models.error ? (
          <ErrorBanner error={models.error} onRetry={() => void models.refetch()} />
        ) : !models.data || models.data.items.length === 0 ? (
          <EmptyState title={t('runObservability.modelsEmpty')} size="compact" />
        ) : (
          <TableViewport label={t('runObservability.modelsTitle')} minWidth="lg">
            <table
              className="data-table data-table--compact"
              aria-label={t('runObservability.modelsTitle')}
            >
              <thead>
                <tr>
                  <th scope="col">{t('runObservability.colRuntime')}</th>
                  <th scope="col">{t('runObservability.colModel')}</th>
                  <th scope="col" className="observability__num">
                    {t('runObservability.colCalls')}
                  </th>
                  <UsageHeaderCells />
                  <th scope="col">
                    <span className="sr-only">{t('runObservability.configurePrice')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.data.items.map((row) => (
                  <tr key={`${row.runtimeId ?? ''}\u0000${row.model}`}>
                    <th scope="row">{row.runtimeName ?? row.protocol}</th>
                    <td>{row.model || t('runObservability.unattributed')}</td>
                    <td className="observability__num">{count(row.usage.calls)}</td>
                    <UsageCells usage={row.usage} />
                    <td>
                      {row.usage.unpricedCalls > 0 && row.runtimeId !== null && row.model ? (
                        <Link
                          to="/settings"
                          search={{ tab: 'runtime' }}
                          hash="token-cost"
                          className="btn btn--sm"
                        >
                          {t('runObservability.configurePrice')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </Card>
    </div>
  )
}
