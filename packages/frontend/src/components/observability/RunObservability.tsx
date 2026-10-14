// RFC-371 v2 §6 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// the run observation page. Statistics are aggregated on demand by the server;
// the window moves with "now" on refresh and every 30 seconds while the page is
// visible, except while the user is paging back through older rows.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TaskStatus } from '@agent-workflow/shared'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { OBSERVATION_QUERY, observationApi } from './observationClient'
import { OBSERVATION_RANGES, observationWindow, type ObservationRange } from './observationFormat'
import { ObservationAgentsPanel } from './ObservationAgents'
import { ObservationOverviewPanel } from './ObservationOverview'
import { ObservationSystemPanel } from './ObservationSystem'
import { ObservationTaskDetailView } from './ObservationTaskDetail'
import { ObservationTasksPanel, type ObservationTaskFilter } from './ObservationTasks'
import './RunObservability.css'

export const OBSERVATION_TABS = ['overview', 'tasks', 'agents', 'system'] as const
export type ObservationTab = (typeof OBSERVATION_TABS)[number]

export interface ObservationSearch {
  readonly range: ObservationRange
  readonly tab: ObservationTab
  /** The task opened from the tasks tab or the overview. */
  readonly task?: string
  readonly q?: string
  readonly status?: TaskStatus
  readonly kind?: string
}

export const OBSERVATION_REFRESH_MS = 30_000

const TAB_LABEL: Record<ObservationTab, string> = {
  overview: 'runObservability.tabOverview',
  tasks: 'runObservability.tabTasks',
  agents: 'runObservability.tabAgents',
  system: 'runObservability.tabSystem',
}
const RANGE_LABEL: Record<ObservationRange, string> = {
  '24h': 'runObservability.range24h',
  '7d': 'runObservability.range7d',
  '30d': 'runObservability.range30d',
}

/** Re-anchor the window every interval while the document is visible and not paused. */
function useMovingAnchor(paused: boolean): [number, () => void] {
  const [anchor, setAnchor] = useState(() => Date.now())
  const refresh = useCallback(() => setAnchor(Date.now()), [])
  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, OBSERVATION_REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [paused, refresh])
  return [anchor, refresh]
}

export function RunObservability(props: {
  search: ObservationSearch
  onChange: (next: ObservationSearch) => void
}) {
  const { t, i18n } = useTranslation()
  const { search, onChange } = props
  const [taskCursors, setTaskCursors] = useState<readonly (string | undefined)[]>([undefined])
  const [systemCursors, setSystemCursors] = useState<readonly (string | undefined)[]>([undefined])
  const paging = taskCursors.length > 1 || systemCursors.length > 1
  const [anchor, refresh] = useMovingAnchor(paging || search.task !== undefined)
  const window = useMemo(() => observationWindow(search.range, anchor), [search.range, anchor])
  const overview = useQuery({
    queryKey: [...OBSERVATION_QUERY, 'overview', window],
    queryFn: ({ signal }) => observationApi.overview(window, signal),
    placeholderData: keepPreviousData,
    enabled: search.tab === 'overview',
  })
  const ids = tabDomIds('run-observation', search.tab)
  const reset = () => {
    setTaskCursors([undefined])
    setSystemCursors([undefined])
  }
  const openTask = (taskId: string) => onChange({ ...search, tab: 'tasks', task: taskId })
  const filter = useMemo<ObservationTaskFilter>(
    () => ({
      ...(search.q ? { q: search.q } : {}),
      ...(search.status ? { status: search.status } : {}),
    }),
    [search.q, search.status],
  )
  const onFilter = useCallback(
    (next: ObservationTaskFilter) => {
      setTaskCursors([undefined])
      const { q: _q, status: _status, ...rest } = search
      onChange({
        ...rest,
        ...(next.q ? { q: next.q } : {}),
        ...(next.status ? { status: next.status } : {}),
      })
    },
    [onChange, search],
  )
  return (
    <div className="page">
      <PageHeader
        title={t('runObservability.title')}
        meta={<span className="muted">{t('runObservability.subtitle')}</span>}
        actions={
          <>
            <Segmented<ObservationRange>
              value={search.range}
              ariaLabel={t('runObservability.range')}
              options={OBSERVATION_RANGES.map((range) => ({
                value: range,
                label: t(RANGE_LABEL[range]),
              }))}
              onChange={(range) => {
                reset()
                refresh()
                onChange({ ...search, range })
              }}
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                reset()
                refresh()
              }}
            >
              {t('runObservability.refresh')}
            </button>
          </>
        }
      />
      <p className="muted">
        {t('runObservability.usageBasis')}{' '}
        {t('runObservability.updatedAt', {
          time: new Date(anchor).toLocaleTimeString(i18n.language),
        })}
      </p>
      <TabBar<ObservationTab>
        tabs={OBSERVATION_TABS.map((tab) => ({ key: tab, label: t(TAB_LABEL[tab]) }))}
        active={search.tab}
        onSelect={(tab) => {
          const { task: _task, ...rest } = search
          onChange({ ...rest, tab })
        }}
        ariaLabel={t('runObservability.tabsLabel')}
        idPrefix="run-observation"
      />
      <div role="tabpanel" id={ids.panelId} aria-labelledby={ids.tabId} className="stack--md">
        {search.tab === 'overview' ? (
          overview.isLoading ? (
            <LoadingState />
          ) : overview.error ? (
            <ErrorBanner error={overview.error} onRetry={() => void overview.refetch()} />
          ) : overview.data ? (
            <>
              {overview.data.partial ? (
                <NoticeBanner tone="warning">{t('runObservability.partial')}</NoticeBanner>
              ) : null}
              <ObservationOverviewPanel data={overview.data} onOpenTask={openTask} />
            </>
          ) : null
        ) : null}
        {search.tab === 'tasks' ? (
          search.task ? (
            <ObservationTaskDetailView
              taskId={search.task}
              onBack={() => {
                const { task: _task, ...rest } = search
                onChange(rest)
              }}
            />
          ) : (
            <ObservationTasksPanel
              window={window}
              filter={filter}
              cursors={taskCursors}
              onFilter={onFilter}
              onCursors={setTaskCursors}
              onOpenTask={openTask}
            />
          )
        ) : null}
        {search.tab === 'agents' ? <ObservationAgentsPanel window={window} /> : null}
        {search.tab === 'system' ? (
          <ObservationSystemPanel
            window={window}
            kind={search.kind}
            cursors={systemCursors}
            onKind={(kind) => {
              setSystemCursors([undefined])
              const { kind: _kind, ...rest } = search
              onChange({ ...rest, ...(kind ? { kind } : {}) })
            }}
            onCursors={setSystemCursors}
          />
        ) : null}
      </div>
    </div>
  )
}
