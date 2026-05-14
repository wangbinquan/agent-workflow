// Skills list page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import type { Skill } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills',
  component: SkillsPage,
})

function SkillsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/skills/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>Skills</h1>
          <p className="page__hint">
            File system is the source of truth. <code>managed</code> skills live under
            <code> ~/.agent-workflow/skills/</code>; <code>external</code> skills are symlinked at
            run time.
          </p>
        </div>
        <Link to="/skills/new" className="btn btn--primary">
          + New skill
        </Link>
      </header>

      {isLoading && <div className="muted">Loading…</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">No skills yet.</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Description</th>
              <th>Path</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to="/skills/$name" params={{ name: s.name }} className="data-table__link">
                    {s.name}
                  </Link>
                </td>
                <td>
                  <span className={`chip chip--tight chip--${s.sourceKind}`}>{s.sourceKind}</span>
                </td>
                <td className="data-table__muted">{s.description || '—'}</td>
                <td className="data-table__muted">
                  <code>{s.managedPath ?? s.externalPath ?? '—'}</code>
                </td>
                <td className="data-table__actions">
                  <Link to="/skills/$name" params={{ name: s.name }} className="btn btn--sm">
                    Open
                  </Link>
                  <ConfirmButton
                    label="Delete"
                    onConfirm={() => del.mutateAsync(s.name)}
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
