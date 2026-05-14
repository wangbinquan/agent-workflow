// Agent create page. POST /api/agents → redirect to detail.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { Agent } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { AgentForm, emptyAgent } from '@/components/AgentForm'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents/new',
  component: AgentCreatePage,
})

function AgentCreatePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(emptyAgent)

  const create = useMutation({
    mutationFn: () => api.post<Agent>('/api/agents', draft),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      navigate({ to: '/agents/$name', params: { name: a.name } })
    },
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>New agent</h1>
        <p className="page__hint">DB is the source of truth; this is not a file path.</p>
      </header>
      <AgentForm value={draft} onChange={setDraft} />
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={create.isPending || draft.name === ''}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creating…' : 'Create agent'}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeError(create.error)}</span>
        )}
      </div>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
