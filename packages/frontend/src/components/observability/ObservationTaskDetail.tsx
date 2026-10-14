// RFC-371 v2 §6 — one task's lifetime: summary, a swimlane with one bar per
// runtime call grouped by node, and the call table (four token columns, CNY).
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ObservationCall } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { TableViewport } from '@/components/TableViewport'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { ApiError } from '@/api/client'
import { OBSERVATION_QUERY, observationApi } from './observationClient'
import {
  callCost,
  durationLabel,
  formatCount,
  systemKindLabel,
  tokenTotal,
  usageCost,
} from './observationFormat'

const RUNNING_REFRESH_MS = 30_000

function callLabel(
  call: ObservationCall,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (call.nodeId !== null)
    return call.attempt === null
      ? call.nodeId
      : `${call.nodeId} · ${t('runObservability.attempt', { n: call.attempt })}`
  if (call.purpose === 'system')
    return t('runObservability.systemNode', { kind: systemKindLabel(call.systemKind, t) })
  return call.agentName
}

export function ObservationTaskDetailView(props: { taskId: string; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const [selected, setSelected] = useState<string | null>(null)
  const table = useRef<HTMLTableSectionElement | null>(null)
  const query = useQuery({
    queryKey: [...OBSERVATION_QUERY, 'task', props.taskId],
    queryFn: ({ signal }) => observationApi.task(props.taskId, signal),
    refetchInterval: (current) =>
      current.state.data?.calls.some((call) => call.status === 'running')
        ? RUNNING_REFRESH_MS
        : false,
  })
  const back = (
    <button type="button" className="btn btn--sm" onClick={props.onBack}>
      {t('runObservability.back')}
    </button>
  )
  if (query.isLoading) return <LoadingState label={t('runObservability.detailLoading')} />
  if (query.error)
    return (
      <div className="stack--md">
        {back}
        {query.error instanceof ApiError && query.error.status === 404 ? (
          <NoticeBanner tone="info">{t('runObservability.detailMissing')}</NoticeBanner>
        ) : (
          <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    )
  const data = query.data!
  const count = (value: number) => formatCount(value, i18n.language)
  const status = (call: ObservationCall) => t(`runObservability.callStatus.${call.status}`)
  const elapsed = (call: ObservationCall) =>
    durationLabel((call.endedAt ?? data.asOf) - call.startedAt, t)
  const calls = data.calls
  const from = calls.length ? Math.min(...calls.map((call) => call.startedAt)) : data.task.startedAt
  const to = Math.max(from + 1, ...calls.map((call) => call.endedAt ?? data.asOf))
  const wall = (data.task.finishedAt ?? data.asOf) - data.task.startedAt
  // A swimlane row selects and focuses its call in the table below.
  const focusCall = (id: string) => {
    setSelected(id)
    table.current?.querySelector<HTMLElement>(`[data-call-id="${CSS.escape(id)}"]`)?.focus()
  }
  return (
    <div className="stack--md">
      {back}
      <header className="page__heading">
        <h2 className="page__title">{data.task.name}</h2>
        <TaskStatusChip status={data.task.status} />
      </header>
      <div className="observability__metrics">
        <Card title={t('runObservability.wallClock')}>
          <p className="observability__metric-value">{durationLabel(wall, t)}</p>
        </Card>
        <Card title={t('runObservability.runningTime')}>
          <p className="observability__metric-value">{durationLabel(data.task.runningMs, t)}</p>
        </Card>
        <Card title={t('runObservability.totalTokens')}>
          <p className="observability__metric-value">{count(tokenTotal(data.usage))}</p>
          <p className="observability__metric-detail">
            {t('runObservability.calls', { count: data.usage.calls })}
            {data.usage.incompleteCalls > 0 ? ' · ' + t('runObservability.lowerBoundHint') : ''}
          </p>
        </Card>
        <Card title={t('runObservability.cost')}>
          <p className="observability__metric-value">{usageCost(data.usage, t)}</p>
        </Card>
      </div>
      {data.truncated ? (
        <NoticeBanner tone="warning">
          {t('runObservability.truncated', { count: calls.length })}
        </NoticeBanner>
      ) : null}
      {calls.length === 0 ? (
        <EmptyState title={t('runObservability.callsEmpty')} size="compact" />
      ) : (
        <>
          <Card title={t('runObservability.swimlane')}>
            <ExecutionSwimlane
              label={t('runObservability.swimlane')}
              rowHeading={t('runObservability.swimlaneRow')}
              timeHeading={t('runObservability.swimlaneTime')}
              unknownLabel={t('runObservability.swimlaneUnknown')}
              from={from}
              to={to}
              rows={[...calls]
                .sort(
                  (a, b) =>
                    (a.nodeId ?? '~').localeCompare(b.nodeId ?? '~') || a.startedAt - b.startedAt,
                )
                .map((call) => ({
                  id: call.id,
                  label: callLabel(call, t),
                  start: call.startedAt,
                  end: call.endedAt,
                  open: call.status === 'running',
                  description: t('runObservability.swimlaneDescription', {
                    label: callLabel(call, t),
                    status: status(call),
                    duration: elapsed(call),
                  }),
                  detail: `${status(call)} · ${elapsed(call)}`,
                }))}
              onSelect={focusCall}
            />
          </Card>
          <Card title={t('runObservability.callsTitle')}>
            <TableViewport label={t('runObservability.callsTitle')} minWidth="lg">
              <table
                className="data-table data-table--compact"
                aria-label={t('runObservability.callsTitle')}
              >
                <thead>
                  <tr>
                    <th scope="col">{t('runObservability.colNode')}</th>
                    <th scope="col">{t('runObservability.colAgent')}</th>
                    <th scope="col">{t('runObservability.colRuntime')}</th>
                    <th scope="col">{t('runObservability.colModel')}</th>
                    <th scope="col">{t('runObservability.colStatus')}</th>
                    <th scope="col">{t('runObservability.colUsage')}</th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.colCallTime')}
                    </th>
                    {(['input', 'cacheRead', 'cacheWrite', 'output', 'cost'] as const).map(
                      (key) => (
                        <th key={key} scope="col" className="observability__num">
                          {t(`runObservability.${key}`)}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody ref={table}>
                  {calls.map((call) => (
                    <tr
                      key={call.id}
                      data-call-id={call.id}
                      tabIndex={-1}
                      className={selected === call.id ? 'observability__selected' : undefined}
                    >
                      <th scope="row">{callLabel(call, t)}</th>
                      <td>{call.agentName}</td>
                      <td>{call.runtimeName ?? call.protocol}</td>
                      <td>
                        {call.models.length === 0
                          ? '—'
                          : call.models
                              .map((model) => model.model || t('runObservability.unattributed'))
                              .join(', ')}
                      </td>
                      <td>{status(call)}</td>
                      <td>{t(`runObservability.usageState.${call.usageState}`)}</td>
                      <td className="observability__num">{elapsed(call)}</td>
                      {([call.input, call.cacheRead, call.cacheWrite, call.output] as const).map(
                        (value, index) => (
                          <td key={index} className="observability__num">
                            {count(value)}
                          </td>
                        ),
                      )}
                      <td className="observability__num">{callCost(call, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          </Card>
        </>
      )}
    </div>
  )
}
