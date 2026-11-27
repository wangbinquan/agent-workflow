// RFC-616 §6.3 — a digital employee by work item: the employee type's own duty
// map coloured by one metric, the facts of the selected work item, and the same
// numbers for every work item in a table grouped by lifecycle region.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ProcessEmployeeSummary, ProcessWorkItemRow } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { HeatScale, type HeatLevel } from '@/components/HeatScale'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { TableViewport } from '@/components/TableViewport'
import { EmployeeCapabilityPanorama } from '@/components/digital-employees/EmployeeCapabilityPanorama'
import type { EmployeeTypePackage } from '@/components/digital-employees/types'
import { ProcessFacts, type ProcessFact } from './ProcessFacts'
import {
  decimal,
  duration,
  durationSpread,
  labelText,
  percent,
  tokens,
  type Translate,
} from './processFormat'
import { heatColumn } from './processHeat'
import { stageName } from './processNames'

export const DUTY_HEAT_METRICS = ['duration', 'rounds', 'tokens', 'failure'] as const
export type DutyHeatMetric = (typeof DUTY_HEAT_METRICS)[number]

/** The value a work item is coloured by; null where the metric does not apply to it. */
export function dutyHeatValue(item: ProcessWorkItemRow, metric: DutyHeatMetric): number | null {
  switch (metric) {
    case 'duration':
      return item.roundMs.p50
    case 'rounds':
      return item.roundsPerUnit
    case 'tokens':
      return item.tokensPerUnit === 0 ? null : item.tokensPerUnit
    case 'failure':
      return item.failureRate
  }
}

export function dutyHeatText(value: number | null, metric: DutyHeatMetric, t: Translate): string {
  if (value === null) return '—'
  if (metric === 'duration') return duration(value, t)
  if (metric === 'tokens') return tokens(value)
  if (metric === 'rounds') return t('processMetrics.list.rounds', { value: decimal(value) })
  return percent(value)
}

function itemFacts(item: ProcessWorkItemRow, t: Translate): ProcessFact[] {
  const facts: ProcessFact[] = []
  const add = (key: string, value: string) =>
    facts.push({ key, label: t(`processMetrics.duties.fact.${key}`), value })
  add('kind', t(`processMetrics.stageKind.${item.kind}`))
  if (item.rework) add('rework', t('processMetrics.duties.reworkYes'))
  if (item.roundsPerUnit !== null)
    add('rounds', t('processMetrics.list.rounds', { value: decimal(item.roundsPerUnit) }))
  if (item.roundMs.p50 !== null) add('roundTime', durationSpread(item.roundMs, t))
  if (item.attemptsPerRound !== null) add('attempts', decimal(item.attemptsPerRound))
  if (item.tokensPerUnit !== null) add('tokens', tokens(item.tokensPerUnit))
  if (item.failureRate !== null) add('failure', percent(item.failureRate))
  if (item.autoRetryRate !== null) add('autoRetry', percent(item.autoRetryRate))
  if (item.gateRoundsPerUnit !== null) add('gateRounds', decimal(item.gateRoundsPerUnit))
  if (item.gateWaitMsPerUnit !== null) add('gateWait', duration(item.gateWaitMsPerUnit, t))
  return facts
}

function DutyTable({ summary }: { summary: ProcessEmployeeSummary }) {
  const { t, i18n } = useTranslation()
  const label = t('processMetrics.duties.tableTitle')
  const regions = [...summary.regions].sort((a, b) => a.order - b.order)
  const placed = new Set(regions.map((region) => region.regionId))
  const groups = [
    ...regions.map((region) => ({
      key: region.regionId,
      name: labelText(region.label, i18n.language),
      lanes: new Map(
        region.lanes.map((lane) => [lane.laneId, labelText(lane.label, i18n.language)]),
      ),
      items: summary.workItems.filter((item) => item.regionId === region.regionId),
    })),
    {
      key: '',
      name: t('processMetrics.duties.otherRegion'),
      lanes: new Map<string, string>(),
      items: summary.workItems.filter(
        (item) => item.regionId === null || !placed.has(item.regionId),
      ),
    },
  ].filter((group) => group.items.length > 0)
  return (
    <TableViewport label={label} minWidth="md">
      <table className="data-table data-table--compact" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t('processMetrics.duties.col.item')}</th>
            <th scope="col">{t('processMetrics.duties.col.lane')}</th>
            <th scope="col" className="viz-num">
              {t('processMetrics.duties.col.rounds')}
            </th>
            <th scope="col" className="viz-num">
              {t('processMetrics.duties.col.roundTime')}
            </th>
            <th scope="col" className="viz-num">
              {t('processMetrics.duties.col.tokens')}
            </th>
            <th scope="col" className="viz-num">
              {t('processMetrics.duties.col.failure')}
            </th>
            <th scope="col" className="viz-num">
              {t('processMetrics.duties.col.gate')}
            </th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr className="process-metrics__group-row">
              <th scope="rowgroup" colSpan={7}>
                {group.name}
              </th>
            </tr>
            {group.items.map((item) => (
              <tr key={item.key}>
                <th scope="row" className="process-metrics__indent">
                  {stageName(item, t, i18n.language)}
                  {item.rework ? (
                    <span className="muted"> {t('processMetrics.duties.reworkTag')}</span>
                  ) : null}
                </th>
                <td>
                  {[
                    item.laneId === null ? null : (group.lanes.get(item.laneId) ?? null),
                    t(`processMetrics.stageKind.${item.kind}`),
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </td>
                <td className="viz-num">{decimal(item.roundsPerUnit)}</td>
                <td className="viz-num">{durationSpread(item.roundMs, t)}</td>
                <td className="viz-num">{tokens(item.tokensPerUnit)}</td>
                <td className="viz-num">{percent(item.failureRate)}</td>
                <td className="viz-num">
                  {item.gateRoundsPerUnit === null
                    ? '—'
                    : t('processMetrics.stages.gateCell', {
                        rounds: decimal(item.gateRoundsPerUnit),
                        wait: duration(item.gateWaitMsPerUnit, t),
                      })}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </TableViewport>
  )
}

export function ProcessDuties({ summary }: { summary: ProcessEmployeeSummary }) {
  const { t, i18n } = useTranslation()
  const [metric, setMetric] = useState<DutyHeatMetric>('duration')
  const [selected, setSelected] = useState<string | null>(null)
  const items = summary.workItems
  const typeRef =
    summary.typeId === null || summary.typeRevision === null
      ? null
      : `${summary.typeId}@${summary.typeRevision}`
  // The duty map is the employee type's own; an account that may not read employee types simply gets the table.
  const type = useQuery<EmployeeTypePackage>({
    queryKey: ['digital-employee-type', typeRef, 'process-metrics'],
    enabled: typeRef !== null,
    retry: false,
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(typeRef ?? '')}`,
        undefined,
        signal,
      ),
  })
  const heat = useMemo(
    () => heatColumn(items.map((item) => dutyHeatValue(item, metric))),
    [items, metric],
  )
  const byRef = useMemo(() => {
    const map = new Map<string, { level: HeatLevel | 0; text: string }>()
    items.forEach((item, index) =>
      map.set(item.key, {
        level: heat.levels[index] ?? 0,
        text: dutyHeatText(dutyHeatValue(item, metric), metric, t),
      }),
    )
    return map
  }, [items, heat, metric, t])
  if (items.length === 0) return <EmptyState title={t('processMetrics.duties.empty')} />
  const hottest = items.reduce<ProcessWorkItemRow | null>((best, item, index) => {
    if ((heat.levels[index] ?? 0) === 0) return best
    const bestValue = best === null ? null : dutyHeatValue(best, metric)
    const value = dutyHeatValue(item, metric)
    return bestValue === null || (value !== null && value > bestValue) ? item : best
  }, null)
  const current = items.find((item) => item.key === selected) ?? hottest
  const metricLabel = t(`processMetrics.duties.heat.${metric}`)
  return (
    <>
      <p className="muted process-metrics__note">{t('processMetrics.duties.hint')}</p>
      <FilterBar ariaLabel={t('processMetrics.duties.controlsLabel')} density="compact">
        <FilterField label={t('processMetrics.heatMetric')}>
          <div className="page-filter process-metrics__picker">
            <Segmented<DutyHeatMetric>
              value={metric}
              ariaLabel={t('processMetrics.heatMetric')}
              testidPrefix="process-duties-heat"
              options={DUTY_HEAT_METRICS.map((value) => ({
                value,
                label: t(`processMetrics.duties.heat.${value}`),
              }))}
              onChange={setMetric}
            />
          </div>
        </FilterField>
      </FilterBar>
      <Card
        title={t('processMetrics.duties.mapTitle', { metric: metricLabel })}
        header={<p className="muted process-metrics__note">{t('processMetrics.duties.mapHint')}</p>}
      >
        {heat.min === null ? (
          <EmptyState
            size="compact"
            title={t('processMetrics.stages.noHeat', { metric: metricLabel })}
          />
        ) : (
          <HeatScale
            lowLabel={t('processMetrics.heat.low', { value: dutyHeatText(heat.min, metric, t) })}
            highLabel={t('processMetrics.heat.high', { value: dutyHeatText(heat.max, metric, t) })}
            note={t('processMetrics.heat.note')}
          />
        )}
        {typeRef === null ? (
          <NoticeBanner tone="info">{t('processMetrics.duties.noManifest')}</NoticeBanner>
        ) : type.isLoading ? (
          <LoadingState size="compact" />
        ) : type.data === undefined ? (
          <NoticeBanner tone="info">{t('processMetrics.duties.noMap')}</NoticeBanner>
        ) : (
          <div data-testid="process-duties-map">
            <EmployeeCapabilityPanorama
              type={type.data}
              language={i18n.language}
              selectedWorkItemRef={current?.key ?? null}
              onSelect={setSelected}
              compactChrome
              cardIdPrefix="process-duty"
              toolState={(tool) => {
                const entry = byRef.get(tool.workItemRef)
                const text = entry?.text ?? '—'
                return {
                  state: 'neutral',
                  detail: text,
                  compactDetail: text,
                  ...(entry === undefined || entry.level === 0 ? {} : { heat: entry.level }),
                }
              }}
              // A work item with a human review is one card here: the review is measured under "human steps".
              reviewToolState={() => ({ active: false, state: 'neutral', detail: '' })}
            />
          </div>
        )}
      </Card>
      {current === null ? null : (
        <Card
          title={t('processMetrics.duties.selected', {
            name: stageName(current, t, i18n.language),
          })}
        >
          <ProcessFacts facts={itemFacts(current, t)} empty={t('processMetrics.stages.noFacts')} />
        </Card>
      )}
      <Card
        title={t('processMetrics.duties.tableTitle')}
        header={
          <p className="muted process-metrics__note">{t('processMetrics.duties.tableHint')}</p>
        }
      >
        <DutyTable summary={summary} />
      </Card>
    </>
  )
}
