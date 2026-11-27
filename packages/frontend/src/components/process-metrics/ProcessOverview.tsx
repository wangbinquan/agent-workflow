// RFC-616 §11 — the overview of one subject: the headline numbers, where the
// time and the tokens went, the weekly trend, how stable the runs were, and the
// first few improvement hints.
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import {
  PROCESS_SYSTEM_WORK_KINDS,
  type ProcessCauseGroup,
  type ProcessMetricId,
  type ProcessSubjectSummary,
  type ProcessTrendPoint,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { MetricGrid, MetricTile } from '@/components/MetricTile'
import { Segmented } from '@/components/Segmented'
import {
  SegmentedBar,
  SegmentedBarLegend,
  type SegmentedBarPart,
  type VizFill,
} from '@/components/SegmentedBar'
import { TableViewport } from '@/components/TableViewport'
import { TrendChart, type TrendChartPoint } from '@/components/TrendChart'
import { ProcessHints } from './ProcessHints'
import {
  DASH,
  count,
  decimal,
  duration,
  metricDelta,
  percent,
  pricedCost,
  timeParts,
  tokens,
  type Translate,
} from './processFormat'
import { stageNamesOf } from './processNames'
import type { ProcessView } from './processSearch'

const HOUR = 3_600_000
const OVERVIEW_HINTS = 3

/** A card that shows one whole split into parts, with the legend that carries the values. */
export function SplitCard(props: {
  title: string
  subtitle?: string
  parts: readonly SegmentedBarPart[]
  empty: string
  children?: ReactNode
}) {
  const total = props.parts.reduce((sum, part) => sum + part.amount, 0)
  return (
    <Card
      title={props.title}
      header={
        props.subtitle ? <p className="muted process-metrics__note">{props.subtitle}</p> : undefined
      }
    >
      {total <= 0 ? (
        <EmptyState size="compact" title={props.empty} />
      ) : (
        <>
          <SegmentedBar parts={props.parts} label={props.title} />
          <SegmentedBarLegend parts={props.parts} />
          {props.children}
        </>
      )}
    </Card>
  )
}

const CAUSE_FILL: Readonly<Record<ProcessCauseGroup, VizFill>> = {
  first: 'cat-1',
  'review-rework': 'cat-2',
  'clarify-rerun': 'cat-3',
  'auto-retry': 'cat-4',
  // Reruns nobody asked for by name are usually a sliver: the muted fill.
  'other-rerun': 'other',
  // The platform's own calls are a part of their own. On real installations they are a large
  // one (memory extraction took 13–55% of a task's tokens), which one muted "everything else"
  // part hid behind a name nobody could act on.
  system: 'cat-5',
}

/** Tokens by why the execution ran: one part per cause, in the order the summary lists them. */
export function causeParts(summary: ProcessSubjectSummary, t: Translate): SegmentedBarPart[] {
  return summary.causes.map((slice) => ({
    key: slice.cause,
    label: t(`processMetrics.cause.${slice.cause}`),
    amount: slice.tokens,
    valueText: tokens(slice.tokens),
    fill: CAUSE_FILL[slice.cause],
  }))
}

/** The product name of a kind of system work; a kind the page does not name is shown as recorded. */
export function systemWorkLabel(kind: string, t: Translate): string {
  return (PROCESS_SYSTEM_WORK_KINDS as readonly string[]).includes(kind)
    ? t(`processMetrics.cause.systemKind.${kind}`)
    : kind
}

/**
 * What the two causes mean whose names do not say it, and where system work can be changed.
 * Shown only for a cause that spent tokens: a zero needs no explanation.
 */
function CauseNotes({ summary }: { summary: ProcessSubjectSummary }) {
  const { t } = useTranslation()
  const spent = (cause: ProcessCauseGroup) =>
    (summary.causes.find((slice) => slice.cause === cause)?.tokens ?? 0) > 0
  const other = spent('other-rerun')
  const system = spent('system')
  if (!other && !system) return null
  return (
    <div className="process-metrics__cause-notes" data-testid="process-cause-notes">
      {other ? (
        <p className="muted process-metrics__note">{t('processMetrics.cause.note.otherRerun')}</p>
      ) : null}
      {system ? (
        <>
          <p className="muted process-metrics__note">
            {t('processMetrics.cause.note.system', {
              kinds: summary.systemWork
                .map((slice) => `${systemWorkLabel(slice.kind, t)} ${tokens(slice.tokens)}`)
                .join(t('processMetrics.listSeparator')),
            })}
          </p>
          <p className="muted process-metrics__note">
            {t('processMetrics.cause.note.systemTune')}{' '}
            <Link to="/settings" search={{ tab: 'systemAgents' }} className="link">
              {t('processMetrics.cause.note.settingsLink')}
            </Link>
          </p>
        </>
      ) : null}
    </div>
  )
}

function CauseTable({ summary }: { summary: ProcessSubjectSummary }) {
  const { t } = useTranslation()
  const label = t('processMetrics.cause.tableLabel')
  return (
    <details className="viz-table-toggle">
      <summary>{t('processMetrics.showTable')}</summary>
      <TableViewport label={label} minWidth="sm">
        <table className="data-table data-table--compact" aria-label={label}>
          <thead>
            <tr>
              <th scope="col">{t('processMetrics.cause.col.cause')}</th>
              <th scope="col" className="viz-num">
                {t('processMetrics.cause.col.tokens')}
              </th>
              <th scope="col" className="viz-num">
                {t('processMetrics.cause.col.cost')}
              </th>
              <th scope="col" className="viz-num">
                {t('processMetrics.cause.col.durationShare')}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.causes.flatMap((slice) => [
              <tr key={slice.cause}>
                <th scope="row">{t(`processMetrics.cause.${slice.cause}`)}</th>
                <td className="viz-num">{tokens(slice.tokens)}</td>
                <td className="viz-num">
                  {/* A slice with no tokens cost nothing; one with tokens and no price is unpriced. */}
                  {pricedCost(slice.costNano, summary.note.unpriced && slice.tokens > 0, t)}
                </td>
                <td className="viz-num">{percent(slice.durationShare)}</td>
              </tr>,
              // What the system slice was spent on, as rows of their own under it.
              ...(slice.cause === 'system'
                ? summary.systemWork.map((work) => (
                    <tr key={`system:${work.kind}`}>
                      <th scope="row" className="process-metrics__indent">
                        {systemWorkLabel(work.kind, t)}
                      </th>
                      <td className="viz-num">{tokens(work.tokens)}</td>
                      <td className="viz-num">
                        {pricedCost(work.costNano, summary.note.unpriced && work.tokens > 0, t)}
                      </td>
                      <td className="viz-num">{DASH}</td>
                    </tr>
                  ))
                : []),
            ])}
          </tbody>
        </table>
      </TableViewport>
    </details>
  )
}

type TrendMetric = 'leadP50' | 'tokensPerUnit' | 'firstPassRate'

/** The points of one trend metric, with the unit its axis is drawn in. */
export function trendPoints(
  trend: readonly ProcessTrendPoint[],
  metric: TrendMetric,
  t: Translate,
): { points: TrendChartPoint[]; formatTick: (value: number) => string } {
  if (metric === 'leadP50') {
    const max = Math.max(0, ...trend.map((point) => point.leadP50 ?? 0))
    // Ticks are drawn in whole days, hours or minutes, never in raw milliseconds.
    const [divisor, unit] =
      max >= 48 * HOUR
        ? ([24 * HOUR, 'days'] as const)
        : max >= 2 * HOUR
          ? ([HOUR, 'hours'] as const)
          : ([60_000, 'minutes'] as const)
    return {
      points: trend.map((point) => ({
        key: point.week,
        label: point.week.slice(5),
        value: point.leadP50 === null ? null : point.leadP50 / divisor,
        valueText: duration(point.leadP50, t),
      })),
      formatTick: (value) => t(`processMetrics.trend.tick.${unit}`, { value: decimal(value) }),
    }
  }
  if (metric === 'tokensPerUnit')
    return {
      points: trend.map((point) => ({
        key: point.week,
        label: point.week.slice(5),
        value: point.tokensPerUnit,
        valueText: tokens(point.tokensPerUnit),
      })),
      formatTick: (value) => tokens(value),
    }
  return {
    points: trend.map((point) => ({
      key: point.week,
      label: point.week.slice(5),
      // One decimal of a percent: 0.22 × 100 is not exactly 22 in floating point.
      value: point.firstPassRate === null ? null : Math.round(point.firstPassRate * 1000) / 10,
      valueText: percent(point.firstPassRate),
    })),
    formatTick: (value) => `${decimal(value)}%`,
  }
}

function TrendCard({ summary }: { summary: ProcessSubjectSummary }) {
  const { t } = useTranslation()
  const [metric, setMetric] = useState<TrendMetric>('leadP50')
  const judged = summary.kind !== 'digital-employee' || summary.firstPassApplicable
  const metrics: TrendMetric[] = judged
    ? ['leadP50', 'tokensPerUnit', 'firstPassRate']
    : ['leadP50', 'tokensPerUnit']
  const active = metrics.includes(metric) ? metric : 'leadP50'
  const per = t(`processMetrics.per.${summary.kind}`)
  const label = t(`processMetrics.trend.metric.${active}`, { per })
  const { points, formatTick } = trendPoints(summary.trend, active, t)
  const title = t('processMetrics.trend.title', { metric: label })
  return (
    <Card
      title={title}
      header={
        <p className="muted process-metrics__note">
          {t('processMetrics.trend.subtitle', { unit: t(`processMetrics.unit.${summary.kind}`) })}
        </p>
      }
    >
      <div className="page-filter process-metrics__picker">
        <Segmented<TrendMetric>
          value={active}
          ariaLabel={t('processMetrics.trend.metricLabel')}
          testidPrefix="process-trend"
          options={metrics.map((value) => ({
            value,
            label: t(`processMetrics.trend.metric.${value}`, { per }),
          }))}
          onChange={setMetric}
        />
      </div>
      {points.some((point) => point.value !== null) ? (
        <TrendChart
          points={points}
          label={title}
          formatTick={formatTick}
          table={{
            summary: t('processMetrics.showTable'),
            period: t('processMetrics.trend.week'),
            value: label,
          }}
        />
      ) : (
        <EmptyState size="compact" title={t('processMetrics.trend.empty')} />
      )}
    </Card>
  )
}

function StabilityCard({ summary }: { summary: ProcessSubjectSummary }) {
  const { t, i18n } = useTranslation()
  const { stability } = summary
  const figures = [
    ['autoRetries', stability.autoRetries],
    ['manualRetries', stability.manualRetries],
    ['interruptions', stability.interruptions],
    ['recoveries', stability.recoveries],
    ['limitCancellations', stability.limitCancellations],
    ['operations', stability.operations],
  ] as const
  const label = t('processMetrics.stability.codes')
  return (
    <Card
      title={t('processMetrics.stability.title')}
      header={
        <p className="muted process-metrics__note">{t('processMetrics.stability.subtitle')}</p>
      }
    >
      <MetricGrid compact>
        {figures.map(([key, value]) => (
          <MetricTile
            key={key}
            label={t(`processMetrics.stability.${key}`)}
            value={count(value, i18n.language)}
            detail={t(`processMetrics.stability.${key}Hint`)}
          />
        ))}
      </MetricGrid>
      {stability.failureCodes.length > 0 ? (
        <TableViewport label={label} minWidth="sm">
          <table className="data-table data-table--compact" aria-label={label}>
            <thead>
              <tr>
                <th scope="col">{t('processMetrics.stability.code')}</th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.stability.runs')}
                </th>
              </tr>
            </thead>
            <tbody>
              {stability.failureCodes.slice(0, 8).map((entry) => (
                <tr key={entry.code}>
                  <th scope="row">
                    <code>{entry.code}</code>
                  </th>
                  <td className="viz-num">{count(entry.runs, i18n.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : null}
    </Card>
  )
}

export function ProcessOverview(props: {
  summary: ProcessSubjectSummary
  onView: (view: ProcessView) => void
}) {
  const { t, i18n } = useTranslation()
  const { summary } = props
  const { metrics, counts } = summary
  const unit = t(`processMetrics.unit.${summary.kind}`)
  const value = (id: ProcessMetricId) => metrics[id]?.value ?? null
  const delta = (id: ProcessMetricId) => metricDelta(id, metrics[id], summary.compare.mode, t)
  const number = (amount: number) => count(amount, i18n.language)

  const unitsTile = (
    <MetricTile
      key="units"
      label={t(`processMetrics.tile.units.${summary.kind}`)}
      value={number(counts.total)}
      detail={
        summary.kind === 'digital-employee'
          ? [
              t('processMetrics.tile.outcomes', {
                merged: number(summary.outcomes.merged),
                noChange: number(summary.outcomes.noChange),
                other: number(summary.outcomes.otherFinished),
                failed: number(summary.outcomes.failed),
              }),
              t('processMetrics.tile.active', { count: counts.active }),
            ]
          : t('processMetrics.tile.counts', {
              succeeded: number(counts.succeeded),
              failed: number(counts.failed),
              canceled: number(counts.canceled),
              active: number(counts.active),
              rate: percent(value('successRate')),
            })
      }
      delta={delta('units')}
      testid="process-tile-units"
    />
  )
  const leadTile = (
    <MetricTile
      key="lead"
      label={t(`processMetrics.tile.lead.${summary.kind}`)}
      value={duration(value('leadP50'), t)}
      detail={t('processMetrics.tile.leadDetail', { p90: duration(value('leadP90'), t) })}
      delta={delta('leadP50')}
    />
  )
  const tokensTile = (
    <MetricTile
      key="tokens"
      label={t('processMetrics.tile.tokens', { per: t(`processMetrics.per.${summary.kind}`) })}
      value={tokens(value('tokensPerUnit'))}
      detail={t('processMetrics.tile.tokensDetail', {
        cost: pricedCost(value('costNanoPerUnit'), summary.note.unpriced, t),
      })}
      delta={delta('tokensPerUnit')}
    />
  )

  // What every kind of subject has (proposal §5.2): how much of the lead time was work, how
  // often a person stepped in, where the time went and why the tokens were spent.
  const flowTile = (
    <MetricTile
      key="flow"
      label={t('processMetrics.tile.flowEfficiency')}
      value={percent(value('flowEfficiency'))}
      detail={t('processMetrics.tile.flowEfficiencyDetail')}
      delta={delta('flowEfficiency')}
    />
  )
  const firstPassTile = (
    <MetricTile
      key="firstPass"
      label={t('processMetrics.tile.firstPass')}
      value={percent(value('firstPassRate'))}
      detail={t('processMetrics.tile.firstPassDetail.workflow')}
      delta={delta('firstPassRate')}
    />
  )
  const interventionsTile = (
    <MetricTile
      key="interventions"
      label={t('processMetrics.tile.interventions')}
      // No ended unit yet: a dash on its own, not "— per task".
      value={
        value('interventionsPerUnit') === null
          ? DASH
          : t('processMetrics.tile.perUnit', {
              value: decimal(value('interventionsPerUnit')),
              unit,
            })
      }
      detail={[
        ...summary.interventions.gates.map(
          (gate) => `${t(`processMetrics.gate.${gate.kind}`)} ${decimal(gate.perUnit)}`,
        ),
        `${t('processMetrics.tile.manualRetries')} ${decimal(summary.interventions.manualRetriesPerUnit)}`,
        `${t('processMetrics.tile.operations')} ${decimal(summary.interventions.operationsPerUnit)}`,
      ].join(' · ')}
      delta={delta('interventionsPerUnit')}
    />
  )
  const timeCard = (
    <SplitCard
      key="time"
      title={t('processMetrics.time.title')}
      subtitle={t('processMetrics.time.subtitle', {
        unit,
        lead: duration(summary.time.leadMs, t),
        count: summary.time.sampleUnits,
      })}
      parts={timeParts(summary.time, t)}
      empty={t('processMetrics.time.empty')}
    />
  )
  const causeCard = (title: string) => (
    <SplitCard
      key="cause"
      title={title}
      subtitle={t('processMetrics.cause.subtitle', {
        unit,
        tokens: tokens(value('tokensPerUnit')),
      })}
      parts={causeParts(summary, t)}
      empty={t('processMetrics.cause.empty')}
    >
      <CauseNotes summary={summary} />
      <CauseTable summary={summary} />
    </SplitCard>
  )

  let tiles: ReactNode[]
  /** The common numbers a kind does not already show among its own tiles. */
  let common: ReactNode[] = []
  let splits: ReactNode
  if (summary.kind === 'workflow') {
    tiles = [unitsTile, leadTile, flowTile, tokensTile, firstPassTile, interventionsTile]
    splits = (
      <>
        {timeCard}
        {causeCard(t('processMetrics.cause.title'))}
      </>
    )
  } else if (summary.kind === 'workgroup') {
    const names = stageNamesOf(summary, t, i18n.language)
    const sources = summary.assignmentSources
    tiles = [
      unitsTile,
      leadTile,
      summary.budget === null ? (
        <MetricTile
          key="rounds"
          label={t('processMetrics.tile.rounds')}
          value={
            value('roundsPerUnit') === null
              ? '—'
              : t('processMetrics.list.rounds', { value: decimal(value('roundsPerUnit')) })
          }
          detail={t('processMetrics.tile.roundsDetail', { rate: percent(value('roundCapRate')) })}
          delta={delta('roundsPerUnit')}
        />
      ) : (
        <MetricTile
          key="budget"
          label={t('processMetrics.tile.budget')}
          value={decimal(summary.budget.usedMean)}
          detail={t('processMetrics.tile.budgetDetail', {
            limit: decimal(summary.budget.limitMean),
          })}
        />
      ),
      <MetricTile
        key="assignments"
        label={t('processMetrics.tile.assignments')}
        value={
          value('assignmentsPerUnit') === null
            ? '—'
            : t('processMetrics.tile.assignmentsValue', {
                value: decimal(value('assignmentsPerUnit')),
                unit,
              })
        }
        detail={t('processMetrics.tile.assignmentsDetail', {
          leader: decimal(sources.leader),
          human: decimal(sources.human),
          self: decimal(sources.self),
        })}
        delta={delta('assignmentsPerUnit')}
      />,
      <MetricTile
        key="coordination"
        label={t('processMetrics.tile.coordination')}
        value={percent(value('coordinationShare'))}
        detail={t('processMetrics.tile.coordinationDetail')}
        delta={delta('coordinationShare')}
      />,
      <MetricTile
        key="protocol"
        label={t('processMetrics.tile.protocolRetry')}
        value={percent(value('protocolRetryRate'))}
        detail={t('processMetrics.tile.protocolRetryDetail')}
        delta={delta('protocolRetryRate')}
      />,
    ]
    const actorFill = {
      leader: 'cat-1',
      member: 'cat-2',
      system: 'cat-3',
      unattributed: 'other',
    } as const
    common = [flowTile, tokensTile, firstPassTile, interventionsTile]
    splits = (
      <>
        {timeCard}
        <SplitCard
          title={t('processMetrics.cause.title')}
          subtitle={t('processMetrics.actor.subtitle', {
            unit,
            tokens: tokens(value('tokensPerUnit')),
            leader: names.get('leader') ?? t('processMetrics.member.leader'),
          })}
          parts={summary.actors.map((slice) => ({
            key: slice.actor,
            label: t(`processMetrics.actor.${slice.actor}`),
            amount: slice.tokens,
            valueText: tokens(slice.tokens),
            fill: actorFill[slice.actor],
          }))}
          empty={t('processMetrics.cause.empty')}
        />
        {causeCard(t('processMetrics.cause.tableLabel'))}
      </>
    )
  } else {
    const ended = counts.total - counts.active
    const cycle = summary.cycle
    const boundary =
      cycle?.boundaryKey == null
        ? null
        : (stageNamesOf(summary, t, i18n.language).get(cycle.boundaryKey) ?? cycle.boundaryKey)
    tiles = [
      unitsTile,
      <MetricTile
        key="merge"
        label={t('processMetrics.tile.mergeRate')}
        value={percent(value('mergeRate'))}
        detail={t('processMetrics.tile.mergeRateDetail')}
        delta={delta('mergeRate')}
      />,
      leadTile,
      tokensTile,
      <MetricTile
        key="firstPass"
        label={t('processMetrics.tile.firstPass')}
        value={
          summary.firstPassApplicable
            ? percent(value('firstPassRate'))
            : t('processMetrics.notApplicable')
        }
        detail={t(
          summary.firstPassApplicable
            ? 'processMetrics.tile.firstPassDetail.digital-employee'
            : 'processMetrics.tile.firstPassUndeclared',
        )}
        delta={summary.firstPassApplicable ? delta('firstPassRate') : null}
      />,
      <MetricTile
        key="blocked"
        label={t('processMetrics.tile.blockedRate')}
        value={percent(value('blockedRate'))}
        detail={t('processMetrics.tile.blockedRateDetail', {
          p50: duration(summary.blocked.durationMs.p50, t),
        })}
        delta={delta('blockedRate')}
      />,
    ]
    splits = (
      <>
        <SplitCard
          title={t('processMetrics.outcome.title')}
          subtitle={t('processMetrics.outcome.subtitle', { count: ended })}
          parts={(
            [
              ['merged', summary.outcomes.merged, 'good'],
              ['noChange', summary.outcomes.noChange, 'other'],
              ['otherFinished', summary.outcomes.otherFinished, 'warn'],
              ['failed', summary.outcomes.failed, 'crit'],
            ] as const
          ).map(([key, amount, fill]) => ({
            key,
            label: t(`processMetrics.outcome.${key}`),
            amount,
            valueText: t('processMetrics.outcome.times', { count: amount }),
            fill,
          }))}
          empty={t('processMetrics.outcome.empty')}
        />
        <SplitCard
          title={t('processMetrics.cycle.title')}
          subtitle={
            cycle === null
              ? undefined
              : t('processMetrics.cycle.subtitle', {
                  count: cycle.sampleUnits,
                  wait: duration(cycle.waitMs, t),
                })
          }
          parts={
            cycle === null || cycle.beforeBoundaryMs === null || cycle.afterBoundaryMs === null
              ? []
              : [
                  {
                    key: 'before',
                    label: t('processMetrics.cycle.before', { boundary }),
                    amount: cycle.beforeBoundaryMs,
                    valueText: duration(cycle.beforeBoundaryMs, t),
                    fill: 'cat-1',
                  },
                  {
                    key: 'after',
                    label: t('processMetrics.cycle.after', { boundary }),
                    amount: cycle.afterBoundaryMs,
                    valueText: duration(cycle.afterBoundaryMs, t),
                    fill: 'cat-2',
                  },
                ]
          }
          empty={t(
            cycle === null ? 'processMetrics.cycle.empty' : 'processMetrics.cycle.noBoundary',
          )}
        />
        {timeCard}
        {causeCard(t('processMetrics.cause.title'))}
      </>
    )
    common = [flowTile, interventionsTile]
  }

  return (
    <>
      <MetricGrid testid="process-overview-tiles">{tiles}</MetricGrid>
      {common.length > 0 ? (
        <Card title={t('processMetrics.common.title')}>
          <MetricGrid compact testid="process-overview-common">
            {common}
          </MetricGrid>
        </Card>
      ) : null}
      <div className="process-metrics__grid2">{splits}</div>
      <TrendCard summary={summary} />
      <StabilityCard summary={summary} />
      <ProcessHints summary={summary} limit={OVERVIEW_HINTS} onView={props.onView} />
    </>
  )
}
