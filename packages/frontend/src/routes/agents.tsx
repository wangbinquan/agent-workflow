// Agents list page. Each row links to the detail editor.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import type { Agent } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents',
  component: AgentsPage,
})

function AgentsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/agents/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>Agents</h1>
          <p className="page__hint">
            Virtual agents; injected per-run via OPENCODE_CONFIG_CONTENT.
          </p>
        </div>
        <Link to="/agents/new" className="btn btn--primary">
          + New agent
        </Link>
      </header>

      {isLoading && <div className="muted">Loading…</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">No agents yet. Create one to get started.</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Outputs</th>
              <th>Read-only</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link to="/agents/$name" params={{ name: a.name }} className="data-table__link">
                    {a.name}
                  </Link>
                </td>
                <td className="data-table__muted">{a.description || '—'}</td>
                <td>
                  {a.outputs.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className="chip-row">
                      {a.outputs.map((o) => (
                        <span className="chip chip--tight" key={o}>
                          {o}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td>{a.readonly ? 'yes' : 'no'}</td>
                <td className="data-table__actions">
                  <Link to="/agents/$name" params={{ name: a.name }} className="btn btn--sm">
                    Open
                  </Link>
                  <ConfirmButton
                    label="Delete"
                    onConfirm={() => del.mutateAsync(a.name)}
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
