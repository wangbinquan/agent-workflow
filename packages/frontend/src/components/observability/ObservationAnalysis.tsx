import { Fragment, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ObservationMetrics,
  ObservationOverview,
  ObservationTaskSummary,
} from '@agent-workflow/shared'
import { observationRuntimeKey } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { TableViewport } from '@/components/TableViewport'
import { EmptyState } from '@/components/EmptyState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { formatDurationMs } from '@/lib/duration'
import { Tokens, Cost, Metrics, observationReasonKey } from './ObservationMetrics'
import { formatObservationCny } from './formatObservations'
import './ObservationAnalysis.css'
import { ObservationCollection } from './ObservationCollection'
import { ObservationRuntimeDetails } from './ObservationRuntimeDetails'

export type ObservationAnalysisTab = 'overview' | 'agents' | 'usage' | 'performance'
export const observationAgentKey = (agent: ObservationOverview['agents'][number]) =>
  JSON.stringify([agent.agentId, agent.agentRevision, agent.purpose])
const byTokens = (a: { metrics: ObservationMetrics }, b: { metrics: ObservationMetrics }) => {
  const left = BigInt(a.metrics.tokens.totalKnown),
    right = BigInt(b.metrics.tokens.totalKnown)
  return left === right ? 0 : left > right ? -1 : 1
}

function SummaryCards({ data }: { data: ObservationOverview }) {
  const { t } = useTranslation()
  return (
    <div className="observation-summary">
      <Card title={t('runObservability.loadedTasks')}>
        <strong className="observation-summary__value">{data.tasks.length}</strong>
      </Card>
      <Card title={t('runObservability.tokens')}>
        <div className="observation-summary__value">
          <Tokens metrics={data.metrics} />
        </div>
      </Card>
      <Card title={t('runObservability.cost')}>
        <div className="observation-summary__value">
          <Cost metrics={data.metrics} />
        </div>
      </Card>
      <Card title={t('runObservability.coverage')}>
        <strong className="observation-summary__value">
          {data.metrics.observedInvocations} / {data.metrics.invocations}
        </strong>
      </Card>
    </div>
  )
}

function TaskRows({
  rows,
  onTask,
  metrics,
}: {
  rows: readonly ObservationTaskSummary[]
  onTask: (id: string, trigger?: HTMLElement) => void
  metrics?: ReadonlyMap<string, ObservationMetrics>
}) {
  const { t } = useTranslation()
  if (rows.length === 0) return <EmptyState title={t('runObservability.empty')} size="compact" />
  return (
    <TableViewport label={t('runObservability.tasks')}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {['task', 'state', 'tokens', 'cost'].map((key) => (
              <th scope="col" key={key}>
                {t(`runObservability.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.task.id}>
              <th scope="row">
                <button
                  type="button"
                  className="link link--button data-table__link task-operations__name"
                  title={row.task.name}
                  data-observation-task={row.task.id}
                  onClick={(event) => onTask(row.task.id, event.currentTarget)}
                >
                  {row.task.name}
                </button>
              </th>
              <td>{t(`tasks.status.${row.task.status}`, { defaultValue: row.task.status })}</td>
              <td>
                {metrics && !metrics.has(row.task.id) ? (
                  '—'
                ) : (
                  <Tokens metrics={metrics?.get(row.task.id) ?? row.metrics} />
                )}
              </td>
              <td>
                {metrics && !metrics.has(row.task.id) ? (
                  '—'
                ) : (
                  <Cost metrics={metrics?.get(row.task.id) ?? row.metrics} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}

function Distribution({
  rows,
  label,
}: {
  rows: readonly { key: string; label: ReactNode; metrics: ObservationMetrics }[]
  label: string
}) {
  const { t } = useTranslation()
  if (rows.length === 0)
    return <EmptyState title={t('runObservability.noDistribution')} size="compact" />
  return (
    <TableViewport label={label}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {[
              label,
              t('runObservability.tokens'),
              t('runObservability.cost'),
              t('runObservability.relatedCalls'),
            ].map((text, i) => (
              <th scope="col" key={i}>
                {text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...rows].sort(byTokens).map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>
                <Tokens metrics={row.metrics} />
              </td>
              <td>
                <Cost metrics={row.metrics} />
              </td>
              <td>{row.metrics.invocations}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}

function Trend({
  data,
  onBucket,
}: {
  data: ObservationOverview
  onBucket: (from: number, to: number) => void
}) {
  const { t, i18n } = useTranslation()
  const [activeFrom, setActiveFrom] = useState<number | null>(null)
  const max = data.trend.reduce(
    (m, row) =>
      BigInt(row.metrics.tokens.totalKnown) > m ? BigInt(row.metrics.tokens.totalKnown) : m,
    0n,
  )
  const date = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      timeZone: data.filtersEcho.timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  const active =
    data.trend.find((row) => row.from === activeFrom) ??
    data.trend.find((row) => row.taskCount > 0) ??
    data.trend[0]
  return (
    <Card title={t('runObservability.trend')} footer={t('runObservability.trendHint')}>
      <div className="stack--md">
        <div className="observation-trend__scale muted">
          <span>{t('runObservability.trendScale')}</span>
          <span>{max.toLocaleString(i18n.language)}</span>
        </div>
        <TableViewport label={t('runObservability.trend')}>
          <ol className="observation-trend" aria-label={t('runObservability.trend')}>
            {data.trend.map((row) => {
              const tokens = row.metrics.tokens
              const label = `${date(row.from)} → ${date(row.to)} · ${t('runObservability.taskCount', { count: row.taskCount })} · ${tokens.hasKnown ? tokens.totalKnown : t('runObservability.unknown')} Token${tokens.hasKnown && !tokens.complete ? ` · ${t('runObservability.partial')}` : ''} · ${formatObservationCny(row.metrics.cost.knownAmount, true)}${row.metrics.cost.complete ? '' : ` · ${t('runObservability.partial')}`}`
              return (
                <li key={row.from}>
                  <button
                    type="button"
                    className="btn btn--ghost observation-trend__button"
                    onClick={() => onBucket(row.from, row.to)}
                    onFocus={() => setActiveFrom(row.from)}
                    onMouseEnter={() => setActiveFrom(row.from)}
                    aria-label={label}
                    title={label}
                  >
                    <span className="observation-trend__value" aria-hidden="true">
                      {tokens.hasKnown
                        ? `${tokens.complete ? '' : '≥ '}${BigInt(tokens.totalKnown).toLocaleString(i18n.language)}`
                        : '—'}
                    </span>
                    <span className="observation-trend__track" aria-hidden="true">
                      <span
                        className="observation-trend__bar"
                        data-partial={!tokens.complete}
                        data-positive={tokens.hasKnown && BigInt(tokens.totalKnown) > 0n}
                        style={{
                          height: `${Number((BigInt(tokens.totalKnown) * 10000n) / (max > 0n ? max : 1n)) / 100}%`,
                        }}
                      />
                    </span>
                    <span className="observation-trend__label" aria-hidden="true">
                      {new Date(row.from).toLocaleDateString(i18n.language, {
                        timeZone: data.filtersEcho.timezone,
                        month: 'numeric',
                        day: 'numeric',
                      })}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </TableViewport>
        {active && (
          <div
            className="observation-trend__detail"
            aria-label={t('runObservability.trendInterval')}
            role="group"
          >
            <span className="muted">
              {date(active.from)} → {date(active.to)}
            </span>
            <span>
              {t('runObservability.taskCount', { count: active.taskCount })} ·{' '}
              <Tokens metrics={active.metrics} /> Token · <Cost metrics={active.metrics} exact />
            </span>
          </div>
        )}
      </div>
    </Card>
  )
}

export function ObservationAnalysis({
  data,
  tab,
  selectedAgent,
  selectedRuntime,
  quality,
  onQuality,
  onAgent,
  onRuntime,
  onTask,
  onBucket,
}: {
  data: ObservationOverview
  tab: ObservationAnalysisTab
  selectedAgent?: string
  selectedRuntime?: string
  quality?: string
  onQuality: (reason?: string) => void
  onAgent: (key?: string) => void
  onRuntime: (key?: string) => void
  onTask: (id: string, trigger?: HTMLElement) => void
  onBucket: (from: number, to: number) => void
}) {
  const { t } = useTranslation()
  const runtimeTrigger = useRef<HTMLElement | null>(null)
  const runtimeFallback = useRef<HTMLDivElement | null>(null)
  const runtime = data.runtimes.find((row) => observationRuntimeKey(row) === selectedRuntime)
  const runtimeTitle = (row: ObservationOverview['runtimes'][number]) =>
    row.authority === 'crewstation'
      ? t('runObservability.platformRuntime')
      : row.acceptedNames?.length
        ? row.acceptedNames.join(' · ')
        : t(
            `runObservability.${row.registrationId === null ? 'registrationUnknown' : 'runtimeNameUnknown'}`,
          )
  const agents = [...data.agents].sort(byTokens)
  const selected = agents.find((agent) => observationAgentKey(agent) === selectedAgent)
  const agentLabel = (agent: ObservationOverview['agents'][number]) => (
    <>
      {agent.agentId ?? t('runObservability.noAgent')}
      <div className="muted">
        {agent.agentRevision === null
          ? '—'
          : t('runObservability.revision', { revision: agent.agentRevision })}{' '}
        · {t(`runObservability.purpose_${agent.purpose}`)}
      </div>
    </>
  )
  const duration = (ms: number | null) => {
    if (ms === null) return '—'
    const token = formatDurationMs(ms)
    return t(`common.dur.${token.key}`, token.opts)
  }
  const ranked = (list: typeof agents) => (
    <Distribution
      label={t('runObservability.agent')}
      rows={list.map((agent) => ({
        key: observationAgentKey(agent),
        label: (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onAgent(observationAgentKey(agent))}
          >
            {agentLabel(agent)}
          </button>
        ),
        metrics: agent.metrics,
      }))}
    />
  )
  return (
    <div className="stack--md">
      {data.partial && (
        <NoticeBanner tone="warning" title={t('runObservability.analysisPartial')}>
          {t('runObservability.analysisLimit', data.limits)}
        </NoticeBanner>
      )}
      {tab === 'overview' && (
        <>
          <SummaryCards data={data} />
          <div className="observation-columns">
            <Trend data={data} onBucket={onBucket} />
            <Card title={t('runObservability.agentRanking')}>{ranked(agents.slice(0, 8))}</Card>
          </div>
          <Card title={t('runObservability.recent')}>
            <TaskRows rows={data.tasks.slice(0, 8)} onTask={onTask} />
          </Card>
        </>
      )}
      {tab === 'agents' && (
        <>
          <SummaryCards data={data} />
          {selectedAgent ? (
            selected ? (
              <>
                <div className="page__actions">
                  <button type="button" className="btn btn--sm" onClick={() => onAgent()}>
                    {t('runObservability.allAgents')}
                  </button>
                </div>
                <Card title={selected.agentId ?? t('runObservability.noAgent')}>
                  <Metrics value={selected.metrics} />
                </Card>
                <Card title={t('runObservability.agentTasks')}>
                  <p className="muted">{t('runObservability.agentTasksHint')}</p>
                  <TaskRows
                    rows={data.tasks.filter((row) =>
                      selected.tasks.some((entry) => entry.taskId === row.task.id),
                    )}
                    metrics={new Map(selected.tasks.map((row) => [row.taskId, row.metrics]))}
                    onTask={onTask}
                  />
                </Card>
              </>
            ) : (
              <EmptyState
                title={t('runObservability.agentMissing')}
                action={
                  <button type="button" className="btn" onClick={() => onAgent()}>
                    {t('runObservability.allAgents')}
                  </button>
                }
              />
            )
          ) : (
            <Card title={t('runObservability.crossTaskAgents')}>{ranked(agents)}</Card>
          )}
        </>
      )}
      {tab === 'usage' && (
        <>
          <SummaryCards data={data} />
          <Card title={t('runObservability.usageBreakdown')}>
            <Metrics value={data.metrics} />
          </Card>
          <Card title={t('runObservability.models')}>
            <p className="muted">{t('runObservability.modelsHint')}</p>
            <Distribution
              label={t('runObservability.model')}
              rows={data.models.map((row) => ({
                key: JSON.stringify([row.authority, row.sourceId, row.provider, row.model]),
                metrics: row.metrics,
                label: (
                  <>
                    {row.model ?? t('runObservability.modelUnknown')}
                    <div className="muted">
                      {t(`runObservability.${row.authority}`)} ·{' '}
                      {row.authority === 'crewstation'
                        ? t('runObservability.platformModelRef')
                        : (row.provider ?? '—')}
                      {row.sourceId && (
                        <div>{t('runObservability.platformSource', { id: row.sourceId })}</div>
                      )}
                    </div>
                  </>
                ),
              }))}
            />
          </Card>
          <Card title={t('runObservability.runtimes')}>
            <div ref={runtimeFallback} tabIndex={-1}>
              <Distribution
                label={t('runObservability.runtime')}
                rows={data.runtimes.map((row) => ({
                  key: observationRuntimeKey(row),
                  metrics: row.metrics,
                  label: (
                    <>
                      <button
                        type="button"
                        className="link link--button data-table__link task-operations__name"
                        aria-label={t('runObservability.runtimeView', { name: runtimeTitle(row) })}
                        title={runtimeTitle(row)}
                        data-observation-runtime={observationRuntimeKey(row)}
                        ref={(button) => {
                          if (selectedRuntime === observationRuntimeKey(row) && button)
                            runtimeTrigger.current = button
                        }}
                        onClick={(event) => {
                          runtimeTrigger.current = event.currentTarget
                          onRuntime(observationRuntimeKey(row))
                        }}
                      >
                        {runtimeTitle(row)}
                      </button>
                      <div className="muted">
                        {row.registrationId && <div>{row.registrationId}</div>}
                        {row.protocol ?? '—'} ·{' '}
                        {row.configurationRevision === null
                          ? '—'
                          : t('runObservability.revision', { revision: row.configurationRevision })}
                        {row.sourceId && (
                          <div>{t('runObservability.platformSource', { id: row.sourceId })}</div>
                        )}
                      </div>
                    </>
                  ),
                }))}
              />
            </div>
          </Card>
          <ObservationRuntimeDetails
            open={selectedRuntime !== undefined}
            row={runtime}
            title={runtime ? runtimeTitle(runtime) : t('runObservability.runtime')}
            partial={data.partial}
            onClose={() => onRuntime()}
            triggerRef={runtimeTrigger}
            fallbackRef={runtimeFallback}
          >
            <TaskRows
              rows={data.tasks.filter((row) =>
                runtime?.tasks?.some((entry) => entry.taskId === row.task.id),
              )}
              metrics={new Map(runtime?.tasks?.map((row) => [row.taskId, row.metrics]) ?? [])}
              onTask={onTask}
            />
          </ObservationRuntimeDetails>
          <NoticeBanner tone="info">
            {t('runObservability.priceHint')}
            <p>{t('runObservability.currencyHint')}</p>
          </NoticeBanner>
        </>
      )}
      {tab === 'performance' && (
        <>
          <NoticeBanner tone="info">
            {t('runObservability.durationHint', { count: data.durations.completedTasks })}
          </NoticeBanner>
          <div className="observation-summary">
            {(['p50Ms', 'p95Ms', 'maxMs'] as const).map((key) => (
              <Card key={key} title={t(`runObservability.${key}`)}>
                <strong className="observation-summary__value">
                  {duration(data.durations[key])}
                </strong>
              </Card>
            ))}
          </div>
          <Card title={t('runObservability.taskStates')}>
            <dl className="detail-grid">
              {data.statuses.map((row) => (
                <Fragment key={row.status}>
                  <dt>{t(`tasks.status.${row.status}`, { defaultValue: row.status })}</dt>
                  <dd>{row.count}</dd>
                </Fragment>
              ))}
            </dl>
          </Card>
          <Card title={t('runObservability.dataQuality')}>
            <p className="muted">{t('runObservability.qualityHint')}</p>
            {data.quality.length ? (
              <div className="page__actions">
                {data.quality.map((row) => (
                  <button
                    type="button"
                    key={row.reason}
                    className="btn btn--sm"
                    aria-pressed={quality === row.reason}
                    onClick={() => onQuality(quality === row.reason ? undefined : row.reason)}
                  >
                    {t(`runObservability.${observationReasonKey(row.reason)}`)} ·{' '}
                    {row.taskIds.length}
                  </button>
                ))}
              </div>
            ) : (
              <p>{t('runObservability.noQualityIssues')}</p>
            )}
          </Card>
          <ObservationCollection data={data} onTask={onTask} />
          {quality && (
            <Card title={t(`runObservability.${observationReasonKey(quality)}`)}>
              <TaskRows
                rows={data.tasks.filter((row) =>
                  data.quality
                    .find((entry) => entry.reason === quality)
                    ?.taskIds.includes(row.task.id),
                )}
                onTask={onTask}
              />
            </Card>
          )}
        </>
      )}
    </div>
  )
}
