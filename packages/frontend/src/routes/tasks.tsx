// Tasks list page — RFC-192 run-monitor table.
//
// Status leads the row (running rows pulse); the name cell carries the ULID
// subtitle, a「定时」origin chip (scheduledTaskId → /scheduled/$id) and — on
// FAILED rows only — the red error summary line (the always-on Error column
// retired; canceled/interrupted rows keep their non-error summaries for the
// detail page). Repo shows the display name (URL-mode derives from the
// REDACTED repoUrl, never the cache dir). Whole row navigates via the shared
// `shouldRowNavigate` guard (modifier clicks / inner links exempt).
//
// Filters: status chips stay URL-driven (API param); subject (Segmented over
// `taskExecutionKind`) + name search are pure client-side (决策 D2) over the
// explicitly requested `limit=500` window (listTasks defaults to 100 —
// without the param local filtering would silently miss older rows).

import { useQuery } from '@tanstack/react-query'
import { describeTaskFailure } from '@/lib/task-failure'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskStatus, TaskSummary } from '@agent-workflow/shared'
import { TASK_STATUS } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { TaskSubjectLink } from '@/components/TaskSubjectLink'
import { TASK_ICON } from '@/components/icons/resourceIcons'
import { useNowTick } from '@/hooks/useNowTick'
import { useTasksSync } from '@/hooks/useTasksSync'
import { taskDurationCell } from '@/lib/duration'
import { shouldRowNavigate } from '@/lib/row-nav'
import { filterTaskRows, type TaskSubjectFilter } from '@/lib/task-list-filter'
import { taskRepoDisplayName } from '@/lib/task-repo-name'
import { Route as RootRoute } from './__root'

interface TasksSearch {
  status?: TaskStatus
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks',
  component: TasksPage,
  validateSearch: (raw: Record<string, unknown>): TasksSearch => {
    const status = raw.status
    if (typeof status === 'string' && (TASK_STATUS as readonly string[]).includes(status)) {
      return { status: status as TaskStatus }
    }
    return {}
  },
})

const SUBJECT_FILTERS: readonly TaskSubjectFilter[] = ['all', 'workflow', 'workgroup', 'agent']

function TasksPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = Route.useSearch() as TasksSearch
  const status = search.status

  useTasksSync()
  const { data, isLoading, error, refetch } = useQuery<TaskSummary[]>({
    queryKey: ['tasks', { status }],
    // RFC-192 (Codex 设计门 P1): listTasks defaults to 100 rows — request the
    // route's full 500-row cap explicitly so client-side subject/search
    // filtering never silently misses rows 101+.
    queryFn: ({ signal }) =>
      api.get(
        '/api/tasks',
        status === undefined ? { limit: '500' } : { status, limit: '500' },
        signal,
      ),
    refetchInterval: 15_000, // Fallback for cases where WS is unavailable.
  })

  const now = useNowTick()
  const [subject, setSubject] = useState<TaskSubjectFilter>('all')
  const [nameSearch, setNameSearch] = useState('')
  const nameSearchRef = useRef<HTMLInputElement | null>(null)
  const allStatusRef = useRef<HTMLAnchorElement | null>(null)
  const focusAfterStatusClearRef = useRef(false)
  const rows = useMemo(
    () => (data === undefined ? undefined : filterTaskRows(data, { subject, search: nameSearch })),
    [data, subject, nameSearch],
  )
  const hasRows = data !== undefined && data.length > 0
  const isInitialEmpty =
    !isLoading && data !== undefined && data.length === 0 && status === undefined
  const isStatusEmpty =
    !isLoading && data !== undefined && data.length === 0 && status !== undefined

  // A status-only empty result does not mount the search field. Clearing that
  // URL filter therefore has to wait until the unfiltered query has rendered
  // before restoring focus. Fall back to the always-mounted "All" chip when
  // the unfiltered list is empty too.
  useEffect(() => {
    if (
      !focusAfterStatusClearRef.current ||
      status !== undefined ||
      isLoading ||
      data === undefined
    ) {
      return
    }
    focusAfterStatusClearRef.current = false
    const target = nameSearchRef.current ?? allStatusRef.current
    if (target !== null && target.isConnected) target.focus()
  }, [data, isLoading, status])
  const newTaskAction = (
    <Link to="/tasks/new" className="btn btn--primary" data-testid="tasks-new-button">
      {t('tasks.newButton')}
    </Link>
  )
  const clearFiltersAction = (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => {
        setSubject('all')
        setNameSearch('')
        if (status !== undefined) {
          focusAfterStatusClearRef.current = true
          void navigate({ to: '/tasks', search: {} })
        }
        const target = nameSearchRef.current
        if (target !== null && target.isConnected) target.focus()
      }}
    >
      {t('common.clearFilters')}
    </button>
  )

  function durationCell(row: TaskSummary): string {
    const cell = taskDurationCell(row, now)
    if (cell.kind === 'dash') return t('common.emDash')
    const dur = t(`common.dur.${cell.dur.key}`, cell.dur.opts)
    if (cell.kind === 'running') return t('tasks.durationRunning', { dur })
    if (cell.kind === 'waiting') return t('tasks.durationWaiting', { dur })
    return dur
  }

  return (
    <div className="page">
      <PageHeader title={t('tasks.title')} actions={isInitialEmpty ? undefined : newTaskAction} />

      <div className="status-filter">
        <Link
          ref={allStatusRef}
          to="/tasks"
          search={{}}
          className={`chip ${status === undefined ? 'chip--active' : ''}`}
        >
          {t('tasks.filterAll')}
        </Link>
        {TASK_STATUS.map((s) => (
          <Link
            key={s}
            to="/tasks"
            search={{ status: s }}
            className={`chip ${status === s ? 'chip--active' : ''}`}
          >
            {t(`tasks.status.${s}`)}
          </Link>
        ))}
        {/* RFC-192 — subject + name filters, pure client-side. Rendered only
            when the list has rows so the empty page stays byte-identical to
            the pre-surgery baseline (tasks.png zero churn). */}
        {hasRows && (
          // div, not span: Segmented's root is a <div> and <span><div> is
          // invalid nesting (React 19 validateDOMNesting; 实现门 P3).
          <div className="tasks-toolbar">
            <Segmented<TaskSubjectFilter>
              value={subject}
              onChange={setSubject}
              ariaLabel={t('tasks.colSubject')}
              options={SUBJECT_FILTERS.map((v) => ({
                value: v,
                label: t(`tasks.subjectFilter.${v}`),
                testid: `tasks-subject-${v}`,
              }))}
            />
            <TextInput
              type="search"
              value={nameSearch}
              onChange={setNameSearch}
              placeholder={t('common.searchEllipsis')}
              aria-label={t('common.searchEllipsis')}
              className="tasks-toolbar__search"
              inputRef={nameSearchRef}
              data-testid="tasks-search"
            />
          </div>
        )}
      </div>

      {isLoading && <LoadingState data-testid="tasks-loading" />}
      {error !== null && error !== undefined && (
        <ErrorBanner error={error} onRetry={() => void refetch()} />
      )}
      {isInitialEmpty && (
        <EmptyState
          title={t('tasks.emptyList')}
          description={t('tasks.emptyDescription')}
          icon={TASK_ICON}
          action={newTaskAction}
          data-testid="tasks-empty"
        />
      )}
      {isStatusEmpty && (
        <EmptyState
          size="compact"
          title={t('common.noMatches')}
          action={clearFiltersAction}
          data-testid="tasks-no-matches"
        />
      )}
      {hasRows && rows !== undefined && rows.length === 0 && (
        <EmptyState
          size="compact"
          title={t('common.noMatches')}
          action={clearFiltersAction}
          data-testid="tasks-no-matches"
        />
      )}

      {rows !== undefined && rows.length > 0 && (
        <TableViewport label={t('tasks.title')} minWidth="lg">
          <table className="data-table">
            <thead>
              <tr>
                {/* RFC-192: status leads (monitor-scan entry point); the ULID
                    stays a muted subtitle inside the name cell (RFC-037). */}
                <th>{t('tasks.colStatus')}</th>
                <th>{t('tasks.colName')}</th>
                <th>{t('tasks.colSubject')}</th>
                <th>{t('tasks.colRepo')}</th>
                <th>{t('tasks.colStarted')}</th>
                <th>{t('tasks.colDuration')}</th>
                <th aria-label={t('common.ariaActions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const repo = taskRepoDisplayName(row)
                return (
                  <tr
                    key={row.id}
                    className="data-table__row"
                    data-testid={`task-row-${row.id}`}
                    onClick={(e) => {
                      // Whole-row navigation; inner links / modifier clicks are
                      // exempt via the shared guard (RFC-192 design §4).
                      if (shouldRowNavigate(e)) {
                        void navigate({ to: '/tasks/$id', params: { id: row.id } })
                      }
                    }}
                  >
                    <td className="data-table__nowrap">
                      <TaskStatusChip status={row.status} pulse={row.status === 'running'} />
                      {/* RFC-108 T22: stuck badge — open lifecycle alerts. */}
                      {(row.openAlertCount ?? 0) > 0 && (
                        <>
                          {' '}
                          <StatusChip
                            kind="warn"
                            size="sm"
                            aria-label={t('tasks.stuckBadge', { count: row.openAlertCount })}
                          >
                            {t('tasks.stuckBadge', { count: row.openAlertCount })}
                          </StatusChip>
                        </>
                      )}
                    </td>
                    <td className="task-name-cell">
                      {/* Flex column lives on this inner wrapper, NOT the <td> —
                        a flex <td> drops out of row-height equalization and its
                        bottom border paints ~3px above the neighbors' (stepped
                        row separator). See .skills__name-cell__inner for the
                        same pattern. */}
                      <div className="task-name-cell__inner">
                        {/* Flex row so the origin chip sits BESIDE the name
                          (__name is display:block — a bare span would push
                          the chip to its own line; 实现门 P2). */}
                        <span className="task-name-cell__row">
                          <Link
                            to="/tasks/$id"
                            params={{ id: row.id }}
                            className="data-table__link task-name-cell__name"
                            title={row.name}
                          >
                            {row.name}
                          </Link>
                          {/* RFC-192: scheduled-origin chip → the owning schedule. */}
                          {row.scheduledTaskId != null && (
                            <Link
                              to="/scheduled/$id"
                              params={{ id: row.scheduledTaskId }}
                              className="chip chip--tight task-name-cell__origin"
                              data-testid={`task-scheduled-chip-${row.id}`}
                            >
                              {t('tasks.scheduledChip')}
                            </Link>
                          )}
                        </span>
                        <code className="task-name-cell__id">{row.id}</code>
                        {/* RFC-192: the error line renders on FAILED rows only —
                          canceled/interrupted rows also carry non-null
                          summaries ("canceled by user", "daemon-shutdown")
                          that are notes, not errors (Codex 设计门 P2). */}
                        {row.status === 'failed' && row.errorSummary != null && (
                          <span
                            className="task-name-cell__error"
                            title={row.errorSummary}
                            data-testid={`task-error-${row.id}`}
                          >
                            {/* RFC-203 T4: localized failure copy; raw token stays in title. */}
                            {
                              describeTaskFailure({
                                failureCode: row.failureCode ?? null,
                                errorSummary: row.errorSummary,
                              }).title
                            }
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="data-table__nowrap">
                      {/* Execution subject (group / agent / workflow) — resolved
                        by TaskSubjectLink so builtin host anchors never leak. */}
                      <TaskSubjectLink task={row} taskId={row.id} badge />
                    </td>
                    <td className="data-table__nowrap">
                      <code title={repo.title}>{repo.name}</code>
                      {row.repoCount > 1 && (
                        <>
                          {' '}
                          <span className="chip chip--tight" data-testid={`task-repos-${row.id}`}>
                            {t('tasks.repoCountChip', { n: row.repoCount })}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="data-table__muted data-table__nowrap">
                      <RelativeTime ts={row.startedAt} />
                    </td>
                    <td className="data-table__muted data-table__nowrap">{durationCell(row)}</td>
                    <td className="data-table__chevron" aria-hidden="true">
                      ›
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableViewport>
      )}
    </div>
  )
}
