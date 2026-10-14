// RFC-371 v2 §6 — the platform's own agent work (merge resolution, commits,
// memory extraction, intent analysis, MCP tests, runtime probes…), counted apart
// from business tasks: totals per kind and the newest calls.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Select } from '@/components/Select'
import { TableViewport } from '@/components/TableViewport'
import { OBSERVATION_QUERY, observationApi, type ObservationWindow } from './observationClient'
import { callCost, durationLabel, formatCount, systemKindLabel } from './observationFormat'
import { CursorPager } from './ObservationTasks'
import { UsageCells, UsageHeaderCells } from './ObservationUsage'

export function ObservationSystemPanel(props: {
  window: ObservationWindow
  kind: string | undefined
  cursors: readonly (string | undefined)[]
  onKind: (kind: string | undefined) => void
  onCursors: (cursors: readonly (string | undefined)[]) => void
}) {
  const { t, i18n } = useTranslation()
  const cursor = props.cursors.at(-1)
  const query = useQuery({
    queryKey: [...OBSERVATION_QUERY, 'system', props.window, props.kind, cursor],
    queryFn: ({ signal }) =>
      observationApi.system(
        props.window,
        { ...(props.kind ? { kind: props.kind } : {}), ...(cursor ? { cursor } : {}) },
        signal,
      ),
    placeholderData: keepPreviousData,
  })
  const count = (value: number) => formatCount(value, i18n.language)
  const date = (at: number) => new Date(at).toLocaleString(i18n.language)
  if (query.isLoading) return <LoadingState />
  if (query.error) return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
  const data = query.data!
  if (data.kinds.length === 0 && !props.kind)
    return <EmptyState title={t('runObservability.systemEmpty')} />
  return (
    <div className="stack--md">
      <p className="muted">{t('runObservability.systemHint')}</p>
      {data.partial ? (
        <NoticeBanner tone="warning">{t('runObservability.partial')}</NoticeBanner>
      ) : null}
      <Card title={t('runObservability.kindsTitle')}>
        <TableViewport label={t('runObservability.kindsTitle')} minWidth="lg">
          <table
            className="data-table data-table--compact"
            aria-label={t('runObservability.kindsTitle')}
          >
            <thead>
              <tr>
                <th scope="col">{t('runObservability.colKind')}</th>
                <th scope="col" className="observability__num">
                  {t('runObservability.colCalls')}
                </th>
                <UsageHeaderCells />
              </tr>
            </thead>
            <tbody>
              {data.kinds.map((row) => (
                <tr key={row.kind}>
                  <th scope="row">{systemKindLabel(row.kind, t)}</th>
                  <td className="observability__num">{count(row.usage.calls)}</td>
                  <UsageCells usage={row.usage} />
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </Card>
      <Card title={t('runObservability.recentTitle')}>
        <div className="stack--md">
          <FilterBar ariaLabel={t('runObservability.recentTitle')}>
            <FilterField label={t('runObservability.kindFilter')}>
              <Select<string>
                value={props.kind ?? ''}
                ariaLabel={t('runObservability.kindFilter')}
                options={[
                  { value: '', label: t('runObservability.kindAll') },
                  ...data.kinds.map((row) => ({
                    value: row.kind,
                    label: systemKindLabel(row.kind, t),
                  })),
                ]}
                onChange={(value) => props.onKind(value || undefined)}
              />
            </FilterField>
          </FilterBar>
          {data.recent.length === 0 ? (
            <EmptyState title={t('runObservability.systemEmpty')} size="compact" />
          ) : (
            <TableViewport label={t('runObservability.recentTitle')} minWidth="lg">
              <table
                className="data-table data-table--compact"
                aria-label={t('runObservability.recentTitle')}
              >
                <thead>
                  <tr>
                    <th scope="col">{t('runObservability.colStartedAt')}</th>
                    <th scope="col">{t('runObservability.colKind')}</th>
                    <th scope="col">{t('runObservability.colAgent')}</th>
                    <th scope="col">{t('runObservability.colRuntime')}</th>
                    <th scope="col">{t('runObservability.colStatus')}</th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.colCallTime')}
                    </th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.totalTokens')}
                    </th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.cost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((call) => (
                    <tr key={call.id}>
                      <td>{date(call.startedAt)}</td>
                      <th scope="row">
                        {systemKindLabel(call.systemKind, t)}
                        {call.systemLabel ? <div className="muted">{call.systemLabel}</div> : null}
                      </th>
                      <td>{call.agentName}</td>
                      <td>{call.runtimeName ?? call.protocol}</td>
                      <td>
                        {t(`runObservability.callStatus.${call.status}`)}
                        {call.usageState !== 'complete' ? (
                          <div className="muted">
                            {t(`runObservability.usageState.${call.usageState}`)}
                          </div>
                        ) : null}
                      </td>
                      <td className="observability__num">
                        {durationLabel(
                          call.endedAt === null ? null : call.endedAt - call.startedAt,
                          t,
                        )}
                      </td>
                      <td className="observability__num">
                        {count(call.input + call.cacheRead + call.cacheWrite + call.output)}
                      </td>
                      <td className="observability__num">{callCost(call, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
          <CursorPager
            hasPrevious={props.cursors.length > 1}
            nextCursor={data.nextCursor}
            busy={query.isFetching}
            onPrevious={() => props.onCursors(props.cursors.slice(0, -1))}
            onNext={(next) => props.onCursors([...props.cursors, next])}
          />
        </div>
      </Card>
    </div>
  )
}
