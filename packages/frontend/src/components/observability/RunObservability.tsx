import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ObservationOverviewQuery,
  TaskStatus,
  ObservationOverview,
  ObservationTaskDetail,
  ObservationTaskPage,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { TableViewport } from '@/components/TableViewport'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { formatDurationMs } from '@/lib/duration'
import { useObservationReturn } from '@/hooks/useObservationReturn'
import { Tokens, Cost, Source, Metrics } from './ObservationMetrics'
import { ObservationAnalysis, type ObservationAnalysisTab } from './ObservationAnalysis'
import { ObservationFilters } from './ObservationFilters'
import { ObservationNativeCapture } from './ObservationNativeCapture'
import { ObservationPlatformCapture } from './ObservationPlatformCapture'
import './RunObservability.css'

export interface ObservationSearch {
  readonly from: number
  readonly to: number
  readonly period: 'week' | 'month' | 'all' | 'custom'
  readonly after?: string
  readonly task?: string
  readonly tab?: ObservationAnalysisTab | 'tasks'
  readonly agent?: string
  readonly runtime?: string
  readonly quality?: string
  readonly q?: string
  readonly status?: TaskStatus
  readonly repository?: string
  readonly workflow?: string
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
    <div className="stack--md">
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
          <div className="stack--sm">
            {data.sources.map((s) => (
              <NoticeBanner
                key={JSON.stringify([s.sourceId, s.platformProjectId, s.platformTaskId])}
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
                {s.platformProjectId && (
                  <div>{t('runObservability.platformProject', { id: s.platformProjectId })}</div>
                )}
                {s.platformTaskId && (
                  <div>{t('runObservability.platformTask', { id: s.platformTaskId })}</div>
                )}
                {!s.costsVisible && <p>{t('runObservability.hiddenCost')}</p>}
                {s.hasGaps && <p>{t('runObservability.sourceGap')}</p>}
              </NoticeBanner>
            ))}
          </div>
        </Card>
      )}
      <ObservationNativeCapture rows={data.nativeCaptures ?? []} />
      <ObservationPlatformCapture rows={data.platformCaptures ?? []} />
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
    </div>
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
  const pageRef = useRef<HTMLDivElement | null>(null)
  const tab = search.tab ?? 'tasks'
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const window: ObservationOverviewQuery = {
    from: search.from,
    to: search.to,
    timezone,
    ...(search.q ? { q: search.q } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.repository ? { repository: search.repository } : {}),
    ...(search.workflow ? { workflow: search.workflow } : {}),
  }
  const overview = useQuery({
    queryKey: ['run-observability', 'overview', window],
    queryFn: ({ signal }) =>
      api.get<ObservationOverview>('/api/observability/overview', window, signal),
    enabled: !search.task && tab !== 'tasks',
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  const list = useQuery({
    queryKey: ['run-observability', 'tasks', window, search.after],
    queryFn: ({ signal }) =>
      api.get<ObservationTaskPage>(
        '/api/observability/tasks',
        { ...window, limit: 20, after: search.after },
        signal,
      ),
    enabled: !search.task && tab === 'tasks',
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
  const current = search.task ? detail : tab === 'tasks' ? list : overview
  const captureReturn = useObservationReturn(
    JSON.stringify([
      search.from,
      search.to,
      search.period,
      tab,
      search.after,
      search.agent,
      search.quality,
      search.runtime,
      search.q,
      search.status,
      search.repository,
      search.workflow,
    ]),
    search.task,
    pageRef,
    !search.task && !!current.data,
  )
  const openTask = (task: string, trigger?: HTMLElement) => {
    captureReturn(task, trigger)
    onChange({ ...search, task })
  }
  const refresh = () => {
    if (search.task) {
      void detail.refetch()
      return
    }
    if (search.period === 'custom') {
      void current.refetch()
      return
    }
    // Explicit refresh starts a new cohort; paging and drill-down retain theirs.
    const to = Date.now() + 1
    onChange({
      period: search.period,
      ...(search.q ? { q: search.q } : {}),
      ...(search.status ? { status: search.status } : {}),
      ...(search.repository ? { repository: search.repository } : {}),
      ...(search.workflow ? { workflow: search.workflow } : {}),
      ...(search.tab ? { tab: search.tab } : {}),
      ...(search.agent ? { agent: search.agent } : {}),
      ...(search.quality ? { quality: search.quality } : {}),
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
    <div className="page" ref={pageRef}>
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
              className="btn btn--sm btn--ghost page__heading-back"
              onClick={() => onChange({ ...search, task: undefined })}
            >
              <span aria-hidden="true">←</span>{' '}
              {t(`runObservability.${tab === 'tasks' ? 'back' : 'backAnalysis'}`)}
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
          <ObservationFilters search={search} onChange={onChange} />
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
      {!search.task && (
        <TabBar
          idPrefix="run-observation"
          ariaLabel={t('runObservability.title')}
          tabs={(['overview', 'tasks', 'agents', 'usage', 'performance'] as const).map((key) => ({
            key,
            label: t(`runObservability.tab_${key}`),
          }))}
          active={tab}
          onSelect={(tab) =>
            onChange({
              ...search,
              tab,
              after: undefined,
              agent: undefined,
              quality: undefined,
              runtime: undefined,
            })
          }
        />
      )}
      <div
        {...(!search.task
          ? {
              role: 'tabpanel',
              id: tabDomIds('run-observation', tab).panelId,
              'aria-labelledby': tabDomIds('run-observation', tab).tabId,
            }
          : {})}
      >
        {search.task
          ? detail.data && <TaskDetail key={search.task} data={detail.data} />
          : tab !== 'tasks'
            ? overview.data && (
                <ObservationAnalysis
                  data={overview.data}
                  tab={tab}
                  selectedAgent={search.agent}
                  selectedRuntime={search.runtime}
                  quality={search.quality}
                  onQuality={(quality) => onChange({ ...search, quality })}
                  onAgent={(agent) => onChange({ ...search, tab: 'agents', agent })}
                  onRuntime={(runtime) => onChange({ ...search, tab: 'usage', runtime })}
                  onTask={openTask}
                  onBucket={(from, to) =>
                    onChange({
                      ...search,
                      from,
                      to,
                      period: 'custom',
                      tab: 'tasks',
                      after: undefined,
                      agent: undefined,
                      quality: undefined,
                      runtime: undefined,
                    })
                  }
                />
              )
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
                                  className="link link--button data-table__link task-operations__name"
                                  title={row.task.name}
                                  data-observation-task={row.task.id}
                                  onClick={(event) => openTask(row.task.id, event.currentTarget)}
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
    </div>
  )
}
