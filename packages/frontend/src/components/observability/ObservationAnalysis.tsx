import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ObservationMetrics,
  ObservationOverview,
  ObservationTaskSummary,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { TableViewport } from '@/components/TableViewport'
import { EmptyState } from '@/components/EmptyState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { formatDurationMs } from '@/lib/duration'
import { Tokens, Cost, Metrics, observationReasonKey } from './ObservationMetrics'
import { formatObservationCny } from './formatObservations'
import './ObservationAnalysis.css'

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
  onTask: (id: string) => void
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
                <button type="button" className="btn btn--sm" onClick={() => onTask(row.task.id)}>
                  {row.task.name}
                </button>
              </th>
              <td>{t(`tasks.status.${row.task.status}`, { defaultValue: row.task.status })}</td>
              <td>
                <Tokens metrics={metrics?.get(row.task.id) ?? row.metrics} />
              </td>
              <td>
                <Cost metrics={metrics?.get(row.task.id) ?? row.metrics} />
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
  const max = data.trend.reduce(
    (m, row) =>
      BigInt(row.metrics.tokens.totalKnown) > m ? BigInt(row.metrics.tokens.totalKnown) : m,
    1n,
  )
  const date = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      timeZone: data.filtersEcho.timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  return (
    <Card title={t('runObservability.trend')}>
      <p className="muted">{t('runObservability.trendHint')}</p>
      <ol className="observation-trend">
        {data.trend.map((row) => (
          <li key={row.from}>
            <button
              type="button"
              className="btn btn--sm observation-trend__button"
              onClick={() => onBucket(row.from, row.to)}
              aria-label={`${date(row.from)} → ${date(row.to)} · ${t('runObservability.taskCount', { count: row.taskCount })} · ${row.metrics.tokens.hasKnown ? row.metrics.tokens.totalKnown : t('runObservability.unknown')} Token · ${formatObservationCny(row.metrics.cost.knownAmount)}`}
            >
              <span className="observation-trend__label">{date(row.from)}</span>
              <span className="observation-trend__track" aria-hidden="true">
                <span
                  className="observation-trend__bar"
                  style={{
                    width: `${Number((BigInt(row.metrics.tokens.totalKnown) * 10000n) / max) / 100}%`,
                  }}
                />
              </span>
              <span>
                <Tokens metrics={row.metrics} />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  )
}

export function ObservationAnalysis({
  data,
  tab,
  selectedAgent,
  quality,
  onQuality,
  onAgent,
  onTask,
  onBucket,
}: {
  data: ObservationOverview
  tab: ObservationAnalysisTab
  selectedAgent?: string
  quality?: string
  onQuality: (reason?: string) => void
  onAgent: (key?: string) => void
  onTask: (id: string) => void
  onBucket: (from: number, to: number) => void
}) {
  const { t } = useTranslation()
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
          <Card title={t('runObservability.attention')}>
            <TaskRows
              rows={data.tasks.filter((row) =>
                ['failed', 'interrupted', 'awaiting_human', 'awaiting_review'].includes(
                  row.task.status,
                ),
              )}
              onTask={onTask}
            />
          </Card>
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
            <Distribution
              label={t('runObservability.runtime')}
              rows={data.runtimes.map((row) => ({
                key: JSON.stringify([
                  row.authority,
                  row.sourceId,
                  row.registrationId,
                  row.configurationRevision,
                  row.protocol,
                ]),
                metrics: row.metrics,
                label: (
                  <>
                    {row.authority === 'crewstation'
                      ? t('runObservability.platformRuntime')
                      : (row.registrationId ?? t('runObservability.registrationUnknown'))}
                    <div className="muted">
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
          </Card>
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
