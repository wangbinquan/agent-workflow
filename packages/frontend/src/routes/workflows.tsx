// Workflows list. Each row links into the xyflow editor at /workflows/$id.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import type { Workflow } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsPage,
})

function WorkflowsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/workflows/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>Workflows</h1>
          <p className="page__hint">
            DAG of agents + wrappers. Each task snapshots the definition at launch time.
          </p>
        </div>
        <Link to="/workflows/new" className="btn btn--primary">
          + New workflow
        </Link>
      </header>

      {isLoading && <div className="muted">Loading…</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">No workflows yet.</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Version</th>
              <th>ID</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to="/workflows/$id" params={{ id: w.id }} className="data-table__link">
                    {w.name}
                  </Link>
                </td>
                <td className="data-table__muted">v{w.version}</td>
                <td className="data-table__muted">
                  <code>{w.id}</code>
                </td>
                <td className="data-table__actions">
                  <Link to="/workflows/$id" params={{ id: w.id }} className="btn btn--sm">
                    Open
                  </Link>
                  <ConfirmButton
                    label="Delete"
                    onConfirm={() => del.mutateAsync(w.id)}
                    danger
                    disabled={del.isPending}
                  />
                </td>
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
