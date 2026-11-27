// RFC-616 §6.2 — a workgroup by round. Only leader dispatch runs in rounds:
// a round is the leader reading the state and dispatching, until that batch of
// assignments has a result. The other two modes say what stands in for rounds.
import { useTranslation } from 'react-i18next'
import type { ProcessWorkgroupSummary } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { ColumnChart } from '@/components/ColumnChart'
import { EmptyState } from '@/components/EmptyState'
import { MeterBar } from '@/components/MeterBar'
import { MetricGrid, MetricTile } from '@/components/MetricTile'
import { NoticeBanner } from '@/components/NoticeBanner'
import { TableViewport } from '@/components/TableViewport'
import { count, decimal, duration, tokens } from './processFormat'

export function ProcessRounds({ summary }: { summary: ProcessWorkgroupSummary }) {
  const { t, i18n } = useTranslation()
  // No task in the range: there is no mode to explain, only nothing to show.
  if (summary.mode === null) return <EmptyState title={t('processMetrics.list.empty.workgroup')} />
  if (summary.mode !== 'leader_worker') {
    return (
      <>
        <NoticeBanner tone="info">
          {t(
            summary.mode === 'dynamic_workflow'
              ? 'processMetrics.rounds.dynamic'
              : 'processMetrics.rounds.free',
          )}
        </NoticeBanner>
        {summary.budget === null ? null : (
          <Card title={t('processMetrics.rounds.budgetTitle')}>
            <MetricGrid compact>
              <MetricTile
                label={t('processMetrics.rounds.budgetUsed')}
                value={decimal(summary.budget.usedMean)}
                detail={t('processMetrics.rounds.budgetUsedHint')}
              />
              <MetricTile
                label={t('processMetrics.rounds.budgetLimit')}
                value={decimal(summary.budget.limitMean)}
                detail={t('processMetrics.rounds.budgetLimitHint')}
              />
            </MetricGrid>
          </Card>
        )}
      </>
    )
  }
  if (summary.rounds.length === 0) return <EmptyState title={t('processMetrics.rounds.empty')} />
  const roundLabel = (round: number) => t('processMetrics.rounds.round', { round })
  const label = t('processMetrics.rounds.tableTitle')
  return (
    <>
      <Card
        title={t('processMetrics.rounds.chartTitle')}
        header={
          <p className="muted process-metrics__note">{t('processMetrics.rounds.chartHint')}</p>
        }
      >
        <ColumnChart
          label={t('processMetrics.rounds.chartTitle')}
          items={summary.rounds
            .filter((row) => row.assignmentsMean !== null)
            .map((row) => ({
              key: String(row.round),
              label: roundLabel(row.round),
              value: row.assignmentsMean ?? 0,
              valueText: t('processMetrics.list.assignments', {
                value: decimal(row.assignmentsMean),
              }),
              note: t('processMetrics.rounds.reached', { count: row.units }),
            }))}
        />
      </Card>
      <Card
        title={label}
        header={
          <p className="muted process-metrics__note">{t('processMetrics.rounds.tableHint')}</p>
        }
      >
        <TableViewport label={label} minWidth="md">
          <table className="data-table data-table--compact" aria-label={label}>
            <thead>
              <tr>
                <th scope="col">{t('processMetrics.rounds.col.round')}</th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.rounds.col.units')}
                </th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.rounds.col.assignments')}
                </th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.rounds.col.duration')}
                </th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.rounds.col.tokens')}
                </th>
                <th scope="col">{t('processMetrics.rounds.col.leaderShare')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.rounds.map((row) => (
                <tr key={row.round}>
                  <th scope="row">{roundLabel(row.round)}</th>
                  <td className="viz-num">{count(row.units, i18n.language)}</td>
                  <td className="viz-num">{decimal(row.assignmentsMean)}</td>
                  <td className="viz-num">{duration(row.durationMs, t)}</td>
                  <td className="viz-num">{tokens(row.tokens)}</td>
                  <td>
                    <MeterBar share={row.leaderTokenShare} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </Card>
    </>
  )
}
