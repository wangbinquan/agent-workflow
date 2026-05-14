// Tasks list page — status filter chips + table linking into the detail page.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import type { TaskStatus, TaskSummary } from '@agent-workflow/shared'
import { TASK_STATUS } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
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
          <h1>Tasks</h1>
          <p className="page__hint">
            Tasks run in isolated git worktrees. Click into a row to see node statuses + the
            worktree diff.
          </p>
        </div>
      </header>

      <div className="status-filter">
        <Link
          to="/tasks"
          search={{}}
          className={`chip ${status === undefined ? 'chip--active' : ''}`}
        >
          All
        </Link>
        {TASK_STATUS.map((s) => (
          <Link
            key={s}
            to="/tasks"
            search={{ status: s }}
            className={`chip ${status === s ? 'chip--active' : ''}`}
          >
            {s}
          </Link>
        ))}
      </div>

      {isLoading && <div className="muted">Loading…</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">No tasks match this filter.</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Started</th>
              <th>Repo</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link
                    to="/tasks/$id"
                    params={{ id: t.id }}
                    className="data-table__link data-table__id"
                  >
                    <code>{t.id.slice(-10)}</code>
                  </Link>
                </td>
                <td>
                  <TaskStatusChip status={t.status} />
                </td>
                <td className="data-table__muted">{formatRelative(t.startedAt)}</td>
                <td className="data-table__muted">
                  <code>{t.repoPath}</code>
                </td>
                <td className="data-table__muted">{t.errorSummary ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ErrorBanner({ error }: { error: unknown }) {
  let msg = 'Unknown error'
  if (error instanceof ApiError) msg = `${error.code}: ${error.message}`
  else if (error instanceof Error) msg = error.message
  return <div className="error-box">⚠ {msg}</div>
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.round(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ts).toLocaleDateString()
}
