// RFC-371 v2 §6 — overview: four metrics, daily tokens, the largest tasks and
// agents, and the business / system split of the window. The four metrics are
// the shared metric tiles (RFC-616), the same ones process metrics use.
import { useTranslation } from 'react-i18next'
import type { ObservationOverview } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { MetricGrid, MetricTile } from '@/components/MetricTile'
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
      <MetricGrid>
        <MetricTile
          label={t('runObservability.cardTokens')}
          value={count(tokenTotal(data.usage))}
          detail={[
            t('runObservability.calls', { count: data.usage.calls }) +
              (data.usage.failedCalls > 0
                ? ' · ' + t('runObservability.failedCalls', { count: data.usage.failedCalls })
                : ''),
            data.usage.incompleteCalls > 0
              ? t('runObservability.incompleteCalls', { count: data.usage.incompleteCalls })
              : null,
          ]}
        />
        <MetricTile
          label={t('runObservability.cardCost')}
          value={usageCost(data.usage, t)}
          detail={
            data.usage.unpricedCalls > 0
              ? t('runObservability.unpricedCalls', { count: data.usage.unpricedCalls })
              : undefined
          }
        />
        <MetricTile
          label={t('runObservability.cardTasks')}
          value={t('runObservability.tasksTotal', { count: tasks.total })}
          detail={t('runObservability.tasksBreakdown', {
            done: tasks.done,
            failed: tasks.failed,
            canceled: tasks.canceled,
            running: tasks.running,
            waiting: tasks.waiting,
            interrupted: tasks.interrupted,
          })}
        />
        {tasks.durationSamples > 0 ? (
          <MetricTile
            label={t('runObservability.cardDuration')}
            value={t('runObservability.durationPercentiles', {
              p50: durationLabel(tasks.durationP50, t),
              p95: durationLabel(tasks.durationP95, t),
            })}
            detail={t('runObservability.durationMax', {
              max: durationLabel(tasks.durationMax, t),
              count: tasks.durationSamples,
            })}
          />
        ) : (
          <MetricTile
            label={t('runObservability.cardDuration')}
            value="—"
            detail={t('runObservability.noDuration')}
          />
        )}
      </MetricGrid>

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
