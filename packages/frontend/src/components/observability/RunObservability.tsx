import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Fragment, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ObservationMetrics,
  ObservationTaskDetail,
  ObservationTaskPage,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { formatDurationMs } from '@/lib/duration'
import { formatObservationCny } from './formatObservations'
import './RunObservability.css'

export interface ObservationSearch {
  readonly from: number
  readonly to: number
  readonly period: 'week' | 'month' | 'all'
  readonly after?: string
  readonly task?: string
}
const keys = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
const reasonKeys: Readonly<Record<string, string>> = {
  'not-observed': 'unknown',
  unpriced: 'unpriced',
  pending: 'pending',
  'not-authorized': 'hidden',
  'partial-price': 'pricingPartial',
  'model-unknown': 'modelUnknown',
  'registration-unknown': 'registrationUnknown',
  'partial-allocation': 'allocationPartial',
  'coverage-partial': 'coveragePartial',
  'coverage-conflict': 'coverageConflict',
  'capture-gap': 'sourceGap',
  initial: 'sourceInitial',
  syncing: 'sourceSyncing',
  failed: 'sourceFailed',
  'legacy-unbound': 'sourceUnbound',
  truncated: 'limitHint',
}
function Tokens({ metrics }: { metrics: ObservationMetrics }) {
  const { t, i18n } = useTranslation()
  return (
    <>
      <strong>
        {metrics.tokens.hasKnown
          ? BigInt(metrics.tokens.totalKnown).toLocaleString(i18n.language)
          : '—'}
      </strong>{' '}
      {!metrics.tokens.complete && (
        <StatusChip kind="warn" size="sm">
          {t(`runObservability.${metrics.tokens.hasKnown ? 'partial' : 'unknown'}`)}
        </StatusChip>
      )}
    </>
  )
}
function Cost({ metrics }: { metrics: ObservationMetrics }) {
  const { t } = useTranslation()
  return (
    <>
      <strong>{formatObservationCny(metrics.cost.knownAmount)}</strong>{' '}
      {!metrics.cost.complete && (
        <StatusChip kind="warn" size="sm">
          {t('runObservability.partial')}
        </StatusChip>
      )}
    </>
  )
}
function Source({ metrics }: { metrics: ObservationMetrics }) {
  const { t } = useTranslation()
  return (
    <>
      {metrics.authorities.length
        ? metrics.authorities.map((a) => t(`runObservability.${a}`)).join(' · ')
        : '—'}
    </>
  )
}
function Metrics({ value }: { value: ObservationMetrics }) {
  const { t, i18n } = useTranslation()
  return (
    <dl className="detail-grid observation-metrics">
      <dt>{t('runObservability.tokens')}</dt>
      <dd>
        <Tokens metrics={value} />
      </dd>
      {keys.map((key) => (
        <Fragment key={key}>
          <dt>{t(`runObservability.${key}`)}</dt>
          <dd>
            {value.records === 0 || value.tokens.unknownBuckets[key] === value.records
              ? '—'
              : BigInt(value.tokens.known[key]).toLocaleString(i18n.language)}
          </dd>
        </Fragment>
      ))}
      <dt>{t('runObservability.cost')}</dt>
      <dd>
        <Cost metrics={value} />
      </dd>
      <dt>{t('runObservability.coverage')}</dt>
      <dd>
        {value.observedInvocations} / {value.invocations}
      </dd>
      <dt>{t('runObservability.source')}</dt>
      <dd>
        <Source metrics={value} />
      </dd>
      <dt>{t('runObservability.prices')}</dt>
      <dd>
        {value.cost.priceVersionIds.length
          ? value.cost.priceVersionIds.join(' · ')
          : t('runObservability.noPrices')}
      </dd>
      {value.cost.reasons.length > 0 && (
        <>
          <dt>{t('runObservability.state')}</dt>
          <dd>
            {value.cost.reasons
              .map((r) => t(`runObservability.${reasonKeys[r] ?? 'partial'}`))
              .join(' · ')}
          </dd>
        </>
      )}
    </dl>
  )
}
function TaskDetail({ data }: { data: ObservationTaskDetail }) {
  const { t, i18n } = useTranslation(),
    [selected, setSelected] = useState<string | null>(null)
  const attemptTrigger = useRef<HTMLElement | null>(null)
  const duration = (ms: number) => {
    const token = formatDurationMs(ms)
    return t(`common.dur.${token.key}`, token.opts)
  }
  const date = (at: number) => new Date(at).toLocaleString(i18n.language)
  const chosen = data.attempts.find((a) => a.attempt.id === selected)
  const states = {
    initial: 'sourceInitial',
    syncing: 'sourceSyncing',
    ready: 'sourceReady',
    failed: 'sourceFailed',
    'legacy-unbound': 'sourceUnbound',
  } as const
  return (
    <>
      <NoticeBanner tone="info" size="compact">
        {t('runObservability.detailHint')}
      </NoticeBanner>
      {(data.metrics.truncated || data.attemptsTruncated) && (
        <NoticeBanner tone="warning" size="compact">
          {t('runObservability.limitHint')}
        </NoticeBanner>
      )}
      <Card title={t('runObservability.summary')}>
        <Metrics value={data.metrics} />
        <dl className="detail-grid observation-metrics">
          <dt>{t('runObservability.wall')}</dt>
          <dd>{duration(data.wallMs)}</dd>
          <dt>{t('runObservability.running')}</dt>
          <dd>{duration(data.runningMs)}</dd>
          <dt>{t('runObservability.cumulative')}</dt>
          <dd>{data.intervals.knownAttempts > 0 ? duration(data.intervals.cumulativeMs) : '—'}</dd>
          <dt>{t('runObservability.union')}</dt>
          <dd>{data.intervals.knownAttempts > 0 ? duration(data.intervals.activeUnionMs) : '—'}</dd>
        </dl>
        {data.intervals.unknownAttempts > 0 && (
          <p className="muted">
            {t('runObservability.intervalHint', { count: data.intervals.unknownAttempts })}
          </p>
        )}
        {data.intervals.unlinkedInvocations > 0 && (
          <p className="muted">
            {t('runObservability.unlinkedHint', { count: data.intervals.unlinkedInvocations })}
          </p>
        )}
      </Card>
      {data.sources.length > 0 && (
        <Card title={t('runObservability.sourceState')}>
          {data.sources.map((s, index) => (
            <NoticeBanner
              key={`${s.sourceId}-${index}`}
              tone={s.status === 'ready' && !s.hasGaps ? 'info' : 'warning'}
              size="compact"
              title={t(`runObservability.${states[s.status]}`)}
            >
              {s.sourceId && <code>{s.sourceId}</code>}
              {' · '}
              {s.asOf
                ? t('runObservability.sourceAsOf', {
                    time: new Date(s.asOf).toLocaleString(i18n.language),
                  })
                : t('runObservability.noSourceTime')}
              {!s.costsVisible && <p>{t('runObservability.hiddenCost')}</p>}
              {s.hasGaps && <p>{t('runObservability.sourceGap')}</p>}
            </NoticeBanner>
          ))}
        </Card>
      )}
      <Card title={t('runObservability.agents')}>
        {data.agents.length === 0 ? (
          <EmptyState title={t('runObservability.noAgents')} size="compact" />
        ) : (
          <TableViewport label={t('runObservability.agents')}>
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  {['agent', 'purpose', 'tokens', 'cost', 'coverage'].map((key) => (
                    <th key={key} scope="col">
                      {t(`runObservability.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={JSON.stringify([a.agentId, a.agentRevision, a.purpose])}>
                    <th scope="row">
                      {a.agentId ?? t('runObservability.noAgent')}
                      <div className="muted">
                        {a.agentRevision === null
                          ? '—'
                          : t('runObservability.revision', { revision: a.agentRevision })}
                      </div>
                    </th>
                    <td>{t(`runObservability.purpose_${a.purpose}`)}</td>
                    <td>
                      <Tokens metrics={a.metrics} />
                    </td>
                    <td>
                      <Cost metrics={a.metrics} />
                    </td>
                    <td>
                      {a.metrics.observedInvocations} / {a.metrics.invocations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </Card>
      <Card
        title={t('runObservability.timeline')}
        header={<p className="muted">{t('runObservability.timelineHint')}</p>}
      >
        {data.attempts.length === 0 ? (
          <EmptyState title={t('runObservability.noAttempts')} size="compact" />
        ) : (
          <ExecutionSwimlane
            label={t('runObservability.timeline')}
            rowHeading={t('runObservability.attempt')}
            timeHeading={`${date(data.task.startedAt)} → ${date(Math.min(data.asOf, data.task.finishedAt ?? data.asOf))}`}
            unknownLabel={t('runObservability.unknownInterval')}
            from={data.task.startedAt}
            to={Math.min(data.asOf, data.task.finishedAt ?? data.asOf)}
            onSelect={(id, trigger) => {
              attemptTrigger.current = trigger
              setSelected(id)
            }}
            rows={data.attempts.map((a) => ({
              id: a.attempt.id,
              start: a.interval?.start ?? null,
              end: a.interval?.end ?? null,
              label: (
                <>
                  {a.attempt.nodeId}
                  <div className="muted">
                    {a.agents.map((agent) => agent.id ?? t('runObservability.noAgent')).join(' · ')}{' '}
                    · {a.attempt.id}
                  </div>
                </>
              ),
              description: `${t('runObservability.detail')} · ${a.attempt.nodeId} · ${a.attempt.id}`,
              detail: a.interval
                ? `${date(a.interval.start)} → ${date(a.interval.end)} · ${duration(a.interval.end - a.interval.start)}${a.interval.open ? ' · ' + t('runObservability.open') : ''}`
                : '',
            }))}
          />
        )}
      </Card>
      {chosen && (
        <Dialog
          open
          onClose={() => setSelected(null)}
          title={t('runObservability.selected', { id: chosen.attempt.id })}
          triggerRef={attemptTrigger}
          bodyTabIndex={0}
        >
          <p>
            {t('runObservability.retry', { index: chosen.attempt.retryIndex })} ·{' '}
            {t('runObservability.iteration', { index: chosen.attempt.iteration })} ·{' '}
            {t('runObservability.review', { index: chosen.attempt.reviewIteration })}
            {chosen.attempt.wgRound !== null &&
              ` · ${t('runObservability.round', { index: chosen.attempt.wgRound })}`}
          </p>
          <Metrics value={chosen.metrics} />
        </Dialog>
      )}
      <NoticeBanner tone="info" size="compact">
        {t('runObservability.priceHint')}
        <p>{t('runObservability.currencyHint')}</p>
      </NoticeBanner>
    </>
  )
}

export function RunObservability({
  search,
  onChange,
}: {
  search: ObservationSearch
  onChange: (search: ObservationSearch) => void
}) {
  const { t, i18n } = useTranslation()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const list = useQuery({
    queryKey: ['run-observability', 'tasks', search.from, search.to, search.after, timezone],
    queryFn: ({ signal }) =>
      api.get<ObservationTaskPage>(
        '/api/observability/tasks',
        { from: search.from, to: search.to, timezone, limit: 20, after: search.after },
        signal,
      ),
    enabled: !search.task,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const detail = useQuery({
    queryKey: ['run-observability', 'task', search.task],
    queryFn: ({ signal }) =>
      api.get<ObservationTaskDetail>(
        `/api/observability/tasks/${encodeURIComponent(search.task!)}`,
        undefined,
        signal,
      ),
    enabled: !!search.task,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const current = search.task ? detail : list
  const refresh = () => {
    if (search.task) {
      void detail.refetch()
      return
    }
    // Explicit refresh starts a new cohort; paging and drill-down retain theirs.
    const to = Date.now() + 1
    onChange({
      period: search.period,
      from:
        search.period === 'all'
          ? 0
          : Math.max(0, to - (search.period === 'week' ? 7 : 30) * 86400000),
      to,
    })
  }
  const duration = (ms: number) => {
    const token = formatDurationMs(ms)
    return t(`common.dur.${token.key}`, token.opts)
  }
  return (
    <div className="page">
      <PageHeader
        title={search.task && detail.data ? detail.data.task.name : t('runObservability.title')}
        meta={
          current.data &&
          t('runObservability.asOf', {
            time: new Date(current.data.asOf).toLocaleString(i18n.language),
          })
        }
        back={
          search.task && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onChange({ ...search, task: undefined })}
            >
              {t('runObservability.back')}
            </button>
          )
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn--sm"
              onClick={refresh}
              disabled={current.isFetching}
            >
              {t('runObservability.refresh')}
            </button>
            {search.task && (
              <Link
                className="btn btn--sm"
                to="/tasks/$id"
                params={{ id: search.task }}
                search={{}}
              >
                {t('runObservability.execution')}
              </Link>
            )}
          </>
        }
      />
      {!search.task && (
        <>
          <FilterBar ariaLabel={t('runObservability.period')}>
            <FilterField label={t('runObservability.period')}>
              <Select
                value={search.period}
                ariaLabel={t('runObservability.period')}
                options={(['week', 'month', 'all'] as const).map((value) => ({
                  value,
                  label: t(`runObservability.${value}`),
                }))}
                onChange={(period) => {
                  const to = Date.now() + 1
                  onChange({
                    period,
                    from:
                      period === 'all'
                        ? 0
                        : Math.max(0, to - (period === 'week' ? 7 : 30) * 86400000),
                    to,
                  })
                }}
              />
            </FilterField>
          </FilterBar>
          <p className="muted">{t('runObservability.listHint')}</p>
          <p className="muted">
            {t('runObservability.windowHint', {
              from: new Date(search.from).toLocaleString(i18n.language),
              to: new Date(search.to).toLocaleString(i18n.language),
            })}
          </p>
        </>
      )}
      {current.error && (
        <ErrorBanner error={current.error} onRetry={() => void current.refetch()} />
      )}
      {current.isPending && <LoadingState />}
      {search.task
        ? detail.data && <TaskDetail key={search.task} data={detail.data} />
        : list.data && (
            <>
              {list.data.items.length === 0 ? (
                <EmptyState title={t('runObservability.empty')} />
              ) : (
                <TableViewport label={t('runObservability.tasks')} minWidth="lg">
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        {['task', 'state', 'tokens', 'cost', 'wall', 'coverage', 'source'].map(
                          (key) => (
                            <th key={key} scope="col">
                              {t(`runObservability.${key}`)}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.items.map((row) => (
                        <tr key={row.task.id}>
                          <th scope="row">
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => onChange({ ...search, task: row.task.id })}
                            >
                              {row.task.name}
                            </button>
                          </th>
                          <td>
                            {t(`tasks.status.${row.task.status}`, {
                              defaultValue: row.task.status,
                            })}
                          </td>
                          <td>
                            <Tokens metrics={row.metrics} />
                          </td>
                          <td>
                            <Cost metrics={row.metrics} />
                          </td>
                          <td>{duration(row.wallMs)}</td>
                          <td>
                            {row.metrics.observedInvocations} / {row.metrics.invocations}
                          </td>
                          <td>
                            <Source metrics={row.metrics} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
              )}
              <div className="page__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!search.after}
                  onClick={() => onChange({ ...search, after: undefined })}
                >
                  {t('runObservability.first')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!list.data.nextCursor || list.isFetching}
                  onClick={() => onChange({ ...search, after: list.data!.nextCursor! })}
                >
                  {t('runObservability.next')}
                </button>
              </div>
            </>
          )}
    </div>
  )
}
