// RFC-616 §11 — stage analysis of a workflow: the canvas coloured by one
// metric, the facts of the selected node, and the same numbers for every node
// in a table. A stage is a canvas node; wrappers are group rows; platform work
// and removed nodes are listed after the canvas nodes.
import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProcessStageRow, ProcessWorkflowSummary } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { HeatScale, type HeatLevel } from '@/components/HeatScale'
import { MeterBar } from '@/components/MeterBar'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { TableViewport } from '@/components/TableViewport'
import { WorkflowCanvas } from '@/components/canvas/WorkflowCanvas'
import { ProcessFacts, type ProcessFact } from './ProcessFacts'
import { decimal, duration, durationSpread, percent, tokens, type Translate } from './processFormat'
import { heatColumn } from './processHeat'
import { stageName, stageTree } from './processNames'

export const STAGE_HEAT_METRICS = ['duration', 'tokens', 'wait', 'reject', 'failure'] as const
export type StageHeatMetric = (typeof STAGE_HEAT_METRICS)[number]

/** The value a stage is coloured by; null where the metric does not apply to it. */
export function stageHeatValue(stage: ProcessStageRow, metric: StageHeatMetric): number | null {
  switch (metric) {
    case 'duration':
      return stage.durationMs.p50
    case 'tokens':
      return stage.tokensPerUnit === 0 ? null : stage.tokensPerUnit
    case 'wait':
      return stage.gateWaitMsPerUnit
    case 'reject':
      return stage.rejectRate
    case 'failure':
      return stage.failureRate
  }
}

export function stageHeatText(value: number | null, metric: StageHeatMetric, t: Translate): string {
  if (value === null) return '—'
  if (metric === 'duration' || metric === 'wait') return duration(value, t)
  if (metric === 'tokens') return tokens(value)
  return percent(value)
}

const isWrapper = (stage: ProcessStageRow) => stage.kind.startsWith('wrapper-')
const onCanvas = (stage: ProcessStageRow) =>
  !stage.removed && stage.kind !== 'system' && stage.kind !== 'unattributed'

/** What a wrapper's own row says: how its loop or its fan-out behaved. */
function wrapperFacts(stage: ProcessStageRow, t: Translate): string {
  const parts: string[] = []
  if (stage.loop !== null) {
    if (stage.loop.roundsMean !== null)
      parts.push(t('processMetrics.stages.loopRounds', { value: decimal(stage.loop.roundsMean) }))
    // The mean hides the one task that went round and round; the most rounds any took says it.
    if (stage.loop.roundsMax !== null && stage.loop.roundsMax !== stage.loop.roundsMean)
      parts.push(t('processMetrics.stages.loopRoundsMax', { value: stage.loop.roundsMax }))
    if (stage.loop.maxIterations !== null)
      parts.push(t('processMetrics.stages.loopCap', { value: stage.loop.maxIterations }))
    if (stage.loop.capRate !== null)
      parts.push(
        t(
          stage.loop.capIncludesFullRuns
            ? 'processMetrics.stages.loopCapRateFull'
            : 'processMetrics.stages.loopCapRate',
          { value: percent(stage.loop.capRate) },
        ),
      )
  }
  if (stage.fanout !== null) {
    if (stage.fanout.shardsMean !== null)
      parts.push(t('processMetrics.stages.shards', { value: decimal(stage.fanout.shardsMean) }))
    if (stage.fanout.shardFailureRate !== null)
      parts.push(
        t('processMetrics.stages.shardFailure', { value: percent(stage.fanout.shardFailureRate) }),
      )
  }
  if (stage.durationMs.p50 !== null)
    parts.push(t('processMetrics.stages.span', { value: duration(stage.durationMs.p50, t) }))
  return parts.join(' · ')
}

function stageFacts(stage: ProcessStageRow, t: Translate): ProcessFact[] {
  const facts: ProcessFact[] = []
  const add = (key: string, value: string) =>
    facts.push({ key, label: t(`processMetrics.stages.fact.${key}`), value })
  if (stage.runsPerUnit !== null) add('runs', decimal(stage.runsPerUnit))
  if (stage.durationMs.p50 !== null) add('duration', durationSpread(stage.durationMs, t))
  if (stage.tokensPerUnit !== null)
    add(
      'tokens',
      stage.tokenShare === null
        ? tokens(stage.tokensPerUnit)
        : t('processMetrics.stages.tokensShare', {
            tokens: tokens(stage.tokensPerUnit),
            share: percent(stage.tokenShare),
          }),
    )
  if (stage.failureRate !== null)
    add(
      'failure',
      stage.topFailureCode === null || stage.failureRate === 0
        ? percent(stage.failureRate)
        : t('processMetrics.stages.failureCode', {
            rate: percent(stage.failureRate),
            code: stage.topFailureCode,
            share: percent(stage.topFailureShare),
          }),
    )
  if (stage.autoRetryRate !== null) add('autoRetry', percent(stage.autoRetryRate))
  if (stage.rejectRate !== null) add('reject', percent(stage.rejectRate))
  if (stage.reworkTokenShare !== null) add('reworkTokens', percent(stage.reworkTokenShare))
  if (stage.clarifyRate !== null) add('clarify', percent(stage.clarifyRate))
  if (stage.gateRoundsPerUnit !== null) add('gateRounds', decimal(stage.gateRoundsPerUnit))
  if (stage.gateWaitMsPerUnit !== null) add('gateWait', duration(stage.gateWaitMsPerUnit, t))
  if (stage.gateFirstPassRate !== null) add('gateFirstPass', percent(stage.gateFirstPassRate))
  const wrapper = wrapperFacts(stage, t)
  if (wrapper !== '' && (stage.loop !== null || stage.fanout !== null)) add('wrapper', wrapper)
  return facts
}

function StageTable({ summary }: { summary: ProcessWorkflowSummary }) {
  const { t, i18n } = useTranslation()
  const compared = summary.compare.mode !== 'off'
  const label = t('processMetrics.stages.tableTitle')
  const columns = [
    'kind',
    'runs',
    'duration',
    'tokens',
    'tokenShare',
    'failure',
    'autoRetry',
    'reject',
    'clarify',
    'gate',
  ] as const
  return (
    <TableViewport label={label} minWidth="lg">
      <table className="data-table data-table--compact" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t('processMetrics.stages.col.node')}</th>
            {columns.map((key) => (
              <th
                key={key}
                scope="col"
                className={key === 'kind' || key === 'tokenShare' ? undefined : 'viz-num'}
              >
                {t(`processMetrics.stages.col.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stageTree(summary.stages).map(({ stage, depth }) => {
            const name = stageName(stage, t, i18n.language)
            const indent =
              depth === 0
                ? {}
                : {
                    className: 'process-metrics__indent',
                    style: { '--depth': depth } as CSSProperties,
                  }
            const title = (
              <>
                {name}
                {stage.removed ? (
                  <span className="muted"> {t('processMetrics.stages.removed')}</span>
                ) : null}
              </>
            )
            if (isWrapper(stage)) {
              return (
                <tr key={stage.key} className="process-metrics__group-row">
                  <th scope="row" colSpan={columns.length + 1} {...indent}>
                    {t(`processMetrics.stageKind.${stage.kind}`)} · {title}
                    <span className="muted"> {wrapperFacts(stage, t)}</span>
                  </th>
                </tr>
              )
            }
            const base = stage.baseline
            const withBase = (text: string, baseText: string | null) =>
              compared && baseText !== null && baseText !== '—'
                ? t('processMetrics.stages.withBaseline', { value: text, baseline: baseText })
                : text
            return (
              <tr key={stage.key}>
                <th scope="row" {...indent}>
                  {title}
                </th>
                <td>{t(`processMetrics.stageKind.${stage.kind}`)}</td>
                <td className="viz-num">{decimal(stage.runsPerUnit)}</td>
                <td className="viz-num">
                  {withBase(
                    durationSpread(stage.durationMs, t),
                    base === null ? null : duration(base.durationP50, t),
                  )}
                </td>
                <td className="viz-num">
                  {withBase(
                    tokens(stage.tokensPerUnit),
                    base === null ? null : tokens(base.tokensPerUnit),
                  )}
                </td>
                <td>
                  <MeterBar share={stage.tokenShare} />
                </td>
                <td className="viz-num">{percent(stage.failureRate)}</td>
                <td className="viz-num">{percent(stage.autoRetryRate)}</td>
                <td className="viz-num">{percent(stage.rejectRate)}</td>
                <td className="viz-num">{percent(stage.clarifyRate)}</td>
                <td className="viz-num">
                  {stage.gateRoundsPerUnit === null
                    ? '—'
                    : t('processMetrics.stages.gateCell', {
                        rounds: decimal(stage.gateRoundsPerUnit),
                        wait: duration(stage.gateWaitMsPerUnit, t),
                      })}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableViewport>
  )
}

export function ProcessStages({ summary }: { summary: ProcessWorkflowSummary }) {
  const { t, i18n } = useTranslation()
  const [presentation, setPresentation] = useState<'canvas' | 'table'>('canvas')
  const [metric, setMetric] = useState<StageHeatMetric>('duration')
  const [selected, setSelected] = useState<string | null>(null)
  const stages = summary.stages
  // Ranked among the nodes the canvas draws: platform work and removed nodes are not on it, and
  // must neither take a step of the scale nor set the values its two ends name.
  const heat = useMemo(
    () =>
      heatColumn(stages.map((stage) => (onCanvas(stage) ? stageHeatValue(stage, metric) : null))),
    [stages, metric],
  )
  const nodeHeat = useMemo(() => {
    const map: Record<string, { level: HeatLevel; label: string }> = {}
    stages.forEach((stage, index) => {
      const level = heat.levels[index]
      if (level === undefined || level === 0 || !onCanvas(stage)) return
      map[stage.key] = { level, label: stageHeatText(stageHeatValue(stage, metric), metric, t) }
    })
    return map
  }, [stages, heat, metric, t])
  if (stages.length === 0) return <EmptyState title={t('processMetrics.stages.empty')} />
  // Until a node is picked, the facts card shows the one that stands out most on this metric.
  const hottest = stages.reduce<ProcessStageRow | null>((best, stage, index) => {
    if ((heat.levels[index] ?? 0) === 0) return best
    const bestValue = best === null ? null : stageHeatValue(best, metric)
    const value = stageHeatValue(stage, metric)
    return bestValue === null || (value !== null && value > bestValue) ? stage : best
  }, null)
  const current = stages.find((stage) => stage.key === selected) ?? hottest
  const metricLabel = t(`processMetrics.stages.heat.${metric}`)
  const canvas = summary.definition !== null
  return (
    <>
      <FilterBar ariaLabel={t('processMetrics.stages.controlsLabel')} density="compact">
        <Segmented<'canvas' | 'table'>
          value={presentation}
          ariaLabel={t('processMetrics.stages.presentation')}
          testidPrefix="process-stages-presentation"
          options={[
            { value: 'canvas', label: t('processMetrics.stages.canvas') },
            { value: 'table', label: t('processMetrics.stages.table') },
          ]}
          onChange={setPresentation}
        />
        {presentation === 'canvas' ? (
          <FilterField label={t('processMetrics.heatMetric')}>
            {/* Five metrics do not fit a phone: the picker scrolls inside itself, not the page. */}
            <div className="page-filter process-metrics__picker">
              <Segmented<StageHeatMetric>
                value={metric}
                ariaLabel={t('processMetrics.heatMetric')}
                testidPrefix="process-stages-heat"
                options={STAGE_HEAT_METRICS.map((value) => ({
                  value,
                  label: t(`processMetrics.stages.heat.${value}`),
                }))}
                onChange={setMetric}
              />
            </div>
          </FilterField>
        ) : null}
      </FilterBar>
      {presentation === 'canvas' ? (
        <>
          <Card
            title={t('processMetrics.stages.canvasTitle', { metric: metricLabel })}
            header={
              <p className="muted process-metrics__note">{t('processMetrics.stages.canvasHint')}</p>
            }
          >
            {heat.min === null ? (
              <EmptyState
                size="compact"
                title={t('processMetrics.stages.noHeat', { metric: metricLabel })}
              />
            ) : (
              <HeatScale
                lowLabel={t('processMetrics.heat.low', {
                  value: stageHeatText(heat.min, metric, t),
                })}
                highLabel={t('processMetrics.heat.high', {
                  value: stageHeatText(heat.max, metric, t),
                })}
                note={t('processMetrics.heat.note')}
              />
            )}
            {canvas ? (
              <div
                className="canvas-frame process-metrics__canvas"
                data-testid="process-stages-canvas"
              >
                <WorkflowCanvas
                  surface="task"
                  definition={summary.definition!}
                  readOnly
                  nodeHeat={nodeHeat}
                  onSelect={(selection) =>
                    setSelected(selection?.kind === 'node' ? selection.id : null)
                  }
                />
              </div>
            ) : (
              <NoticeBanner tone="info">{t('processMetrics.stages.noDefinition')}</NoticeBanner>
            )}
          </Card>
          {current === null ? null : (
            <Card
              title={t('processMetrics.stages.selected', {
                name: stageName(current, t, i18n.language),
              })}
              header={
                <p className="muted process-metrics__note">
                  {t(`processMetrics.stageKind.${current.kind}`)}
                  {selected === null ? ` · ${t('processMetrics.stages.selectedHint')}` : ''}
                </p>
              }
            >
              <ProcessFacts
                facts={stageFacts(current, t)}
                empty={t('processMetrics.stages.noFacts')}
              />
            </Card>
          )}
          {canvas ? null : (
            <Card title={t('processMetrics.stages.tableTitle')}>
              <StageTable summary={summary} />
            </Card>
          )}
        </>
      ) : (
        <Card
          title={t('processMetrics.stages.tableTitle')}
          header={
            <p className="muted process-metrics__note">{t('processMetrics.stages.tableHint')}</p>
          }
        >
          <StageTable summary={summary} />
        </Card>
      )}
    </>
  )
}
