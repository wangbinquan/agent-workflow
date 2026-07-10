// Tasks list page — status filter chips + table linking into the detail page.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { TaskStatus, TaskSummary } from '@agent-workflow/shared'
import { TASK_STATUS } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useTasksSync } from '@/hooks/useTasksSync'
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

function TasksPage() {
  const { t } = useTranslation()
  const search = Route.useSearch() as TasksSearch
  const status = search.status

  useTasksSync()
  const { data, isLoading, error } = useQuery<TaskSummary[]>({
    queryKey: ['tasks', { status }],
    queryFn: ({ signal }) =>
      api.get('/api/tasks', status === undefined ? undefined : { status }, signal),
    refetchInterval: 15_000, // Fallback for cases where WS is unavailable.
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('tasks.title')}</h1>
        </div>
        <div className="page__actions">
          <Link to="/tasks/new" className="btn btn--primary" data-testid="tasks-new-button">
            {t('taskWizard.title')}
          </Link>
        </div>
      </header>

      <div className="status-filter">
        <Link
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
      </div>

      {isLoading && <LoadingState data-testid="tasks-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('tasks.emptyList')} data-testid="tasks-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              {/* RFC-037: task name is the primary identifier; the ULID drops
                  into a muted subtitle inside the same cell. */}
              <th>{t('tasks.colName')}</th>
              <th>{t('tasks.colWorkflow')}</th>
              <th>{t('tasks.colStatus')}</th>
              <th>{t('tasks.colStarted')}</th>
              <th>{t('tasks.colRepo')}</th>
              <th>{t('tasks.colError')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.id}>
                <td className="task-name-cell">
                  {/* Flex column lives on this inner wrapper, NOT the <td> —
                      a flex <td> drops out of row-height equalization and its
                      bottom border paints ~3px above the neighbors' (stepped
                      row separator). See .skills__name-cell__inner for the
                      same pattern. */}
                  <div className="task-name-cell__inner">
                    <Link
                      to="/tasks/$id"
                      params={{ id: row.id }}
                      className="data-table__link task-name-cell__name"
                      title={row.name}
                    >
                      {row.name}
                    </Link>
                    <code className="task-name-cell__id">{row.id}</code>
                  </div>
                </td>
                <td>
                  <Link
                    to="/workflows/$id"
                    params={{ id: row.workflowId }}
                    className="data-table__link"
                  >
                    {row.workflowName ?? row.workflowId}
                  </Link>
                  {/* RFC-164 PR-4: workgroup tasks carry a badge next to the
                      workflow cell (their workflowId is the builtin host). */}
                  {row.workgroupId != null && (
                    <>
                      {' '}
                      <StatusChip
                        kind="info"
                        size="sm"
                        data-testid={`task-workgroup-badge-${row.id}`}
                      >
                        {t('tasks.workgroupBadge')}
                      </StatusChip>
                    </>
                  )}
                </td>
                <td>
                  <TaskStatusChip status={row.status} />
                  {/* RFC-108 T22: stuck badge — open lifecycle alerts on this task. */}
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
                <td className="data-table__muted">
                  <RelativeTime ts={row.startedAt} />
                </td>
                <td className="data-table__muted">
                  <code>{row.repoPath}</code>
                </td>
                <td className="data-table__muted">
                  <span className="data-table__clip" title={row.errorSummary ?? undefined}>
                    {row.errorSummary ?? t('common.emDash')}
                  </span>
                </td>
                <td className="data-table__actions">
                  <Link to="/tasks/$id" params={{ id: row.id }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function RelativeTime({ ts }: { ts: number }) {
  const { t } = useTranslation()
  return <span>{formatRelative(ts, t)}</span>
}

export function formatRelative(ts: number, t: TFunction): string {
  const diff = Date.now() - ts
  const s = Math.round(diff / 1000)
  if (s < 60) return t('tasks.secondsAgo', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('tasks.minutesAgo', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('tasks.hoursAgo', { n: h })
  return new Date(ts).toLocaleDateString()
}
