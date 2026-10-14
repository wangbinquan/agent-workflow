// RFC-371 v2 §6 — overview: four metrics, daily tokens, the largest tasks and
// agents, and the business / system split of the window.
import { useTranslation } from 'react-i18next'
import type { ObservationOverview } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { TableViewport } from '@/components/TableViewport'
import { ObservationDailyChart } from './ObservationDailyChart'
import { UsageCells, UsageHeaderCells } from './ObservationUsage'
import { durationLabel, formatCount, tokenTotal, usageCost } from './observationFormat'

export function ObservationOverviewPanel(props: {
  data: ObservationOverview
  onOpenTask: (taskId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const { data } = props
  const count = (value: number) => formatCount(value, i18n.language)
  const tasks = data.tasks
  return (
    <div className="stack--md">
      <div className="observability__metrics">
        <Card title={t('runObservability.cardTokens')}>
          <p className="observability__metric-value">{count(tokenTotal(data.usage))}</p>
          <p className="observability__metric-detail">
            {t('runObservability.calls', { count: data.usage.calls })}
            {data.usage.failedCalls > 0
              ? ' · ' + t('runObservability.failedCalls', { count: data.usage.failedCalls })
              : ''}
          </p>
          {data.usage.incompleteCalls > 0 ? (
            <p className="observability__metric-detail">
              {t('runObservability.incompleteCalls', { count: data.usage.incompleteCalls })}
            </p>
          ) : null}
        </Card>
        <Card title={t('runObservability.cardCost')}>
          <p className="observability__metric-value">{usageCost(data.usage, t)}</p>
          {data.usage.unpricedCalls > 0 ? (
            <p className="observability__metric-detail">
              {t('runObservability.unpricedCalls', { count: data.usage.unpricedCalls })}
            </p>
          ) : null}
        </Card>
        <Card title={t('runObservability.cardTasks')}>
          <p className="observability__metric-value">
            {t('runObservability.tasksTotal', { count: tasks.total })}
          </p>
          <p className="observability__metric-detail">
            {t('runObservability.tasksBreakdown', {
              done: tasks.done,
              failed: tasks.failed,
              canceled: tasks.canceled,
              running: tasks.running,
              waiting: tasks.waiting,
              interrupted: tasks.interrupted,
            })}
          </p>
        </Card>
        <Card title={t('runObservability.cardDuration')}>
          {tasks.durationSamples > 0 ? (
            <>
              <p className="observability__metric-value">
                {t('runObservability.durationPercentiles', {
                  p50: durationLabel(tasks.durationP50, t),
                  p95: durationLabel(tasks.durationP95, t),
                })}
              </p>
              <p className="observability__metric-detail">
                {t('runObservability.durationMax', {
                  max: durationLabel(tasks.durationMax, t),
                  count: tasks.durationSamples,
                })}
              </p>
            </>
          ) : (
            <p className="observability__metric-detail">{t('runObservability.noDuration')}</p>
          )}
        </Card>
      </div>

      <Card title={t('runObservability.dailyTitle')}>
        <p className="muted">{t('runObservability.dailyHint')}</p>
        <ObservationDailyChart days={data.daily} />
      </Card>

      <div className="observability__grid">
        <Card title={t('runObservability.topTasks')}>
          {data.topTasks.length === 0 ? (
            <EmptyState title={t('runObservability.noData')} size="compact" />
          ) : (
            <TableViewport label={t('runObservability.topTasks')} minWidth="sm">
              <table
                className="data-table data-table--compact"
                aria-label={t('runObservability.topTasks')}
              >
                <thead>
                  <tr>
                    <th scope="col">{t('runObservability.colTask')}</th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.totalTokens')}
                    </th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.cost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topTasks.map((row) => (
                    <tr key={row.taskId}>
                      <th scope="row">
                        {row.name === null ? (
                          <span className="muted">{t('runObservability.deletedTask')}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            aria-label={t('runObservability.open', { name: row.name })}
                            onClick={() => props.onOpenTask(row.taskId)}
                          >
                            {row.name}
                          </button>
                        )}
                      </th>
                      <td className="observability__num">{count(tokenTotal(row.usage))}</td>
                      <td className="observability__num">{usageCost(row.usage, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
        </Card>
        <Card title={t('runObservability.topAgents')}>
          {data.topAgents.length === 0 ? (
            <EmptyState title={t('runObservability.noData')} size="compact" />
          ) : (
            <TableViewport label={t('runObservability.topAgents')} minWidth="sm">
              <table
                className="data-table data-table--compact"
                aria-label={t('runObservability.topAgents')}
              >
                <thead>
                  <tr>
                    <th scope="col">{t('runObservability.colAgent')}</th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.totalTokens')}
                    </th>
                    <th scope="col" className="observability__num">
                      {t('runObservability.cost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topAgents.map((row) => (
                    <tr key={row.agentId ?? '~' + row.agentName}>
                      <th scope="row">{row.agentName}</th>
                      <td className="observability__num">{count(tokenTotal(row.usage))}</td>
                      <td className="observability__num">{usageCost(row.usage, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
        </Card>
      </div>

      <Card title={t('runObservability.split')}>
        <TableViewport label={t('runObservability.split')} minWidth="md">
          <table
            className="data-table data-table--compact"
            aria-label={t('runObservability.split')}
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
              {(
                [
                  ['splitTask', data.taskUsage],
                  ['splitSystem', data.systemUsage],
                ] as const
              ).map(([key, usage]) => (
                <tr key={key}>
                  <th scope="row">{t(`runObservability.${key}`)}</th>
                  <td className="observability__num">{count(usage.calls)}</td>
                  <UsageCells usage={usage} />
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </Card>
    </div>
  )
}
