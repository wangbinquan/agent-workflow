// Agent detail / edit page. Loads, mutates, deletes.
//
// Note: TanStack code-based routes use `agents/$name`. Splitting into a
// dedicated file keeps imports lean and matches the file layout in plan.md.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, CreateAgent } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { AgentForm, emptyAgent } from '@/components/AgentForm'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents/$name',
  component: AgentDetailPage,
})

function AgentDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<CreateAgent>(emptyAgent)
  const [loaded, setLoaded] = useState(false)

  const query = useQuery<Agent>({
    queryKey: ['agents', name],
    queryFn: ({ signal }) => api.get(`/api/agents/${encodeURIComponent(name)}`, undefined, signal),
  })

  useEffect(() => {
    if (!loaded && query.data !== undefined) {
      setDraft(agentToDraft(query.data))
      setLoaded(true)
    }
  }, [loaded, query.data])

  const save = useMutation({
    mutationFn: () => {
      const { name: _drop, ...patch } = draft
      return api.put<Agent>(`/api/agents/${encodeURIComponent(name)}`, patch)
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      qc.setQueryData(['agents', name], a)
      navigate({ to: '/agents' })
    },
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/agents/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      navigate({ to: '/agents' })
    },
  })

  if (query.isLoading) return <div className="page muted">{t('agents.loadingAgent')}</div>
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeError(query.error)}</div>

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{name}</h1>
          <p className="page__hint">{t('agents.detailHint')}</p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || !loaded}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </button>
          <ConfirmButton
            label={t('common.delete')}
            onConfirm={() => del.mutateAsync()}
            danger
            disabled={del.isPending}
          />
        </div>
      </header>
      {(save.error !== null && save.error !== undefined) ||
      (del.error !== null && del.error !== undefined) ? (
        <div className="form-actions">
          {save.error !== null && save.error !== undefined && (
            <span className="form-actions__error">{describeError(save.error)}</span>
          )}
          {del.error !== null && del.error !== undefined && (
            <span className="form-actions__error">{describeError(del.error)}</span>
          )}
        </div>
      ) : null}
      <AgentForm value={draft} onChange={setDraft} nameLocked />
    </div>
  )
}

export function agentToDraft(a: Agent): CreateAgent {
  const out: CreateAgent = {
    name: a.name,
    description: a.description,
    outputs: a.outputs,
    readonly: a.readonly,
    syncOutputsOnIterate: a.syncOutputsOnIterate,
    permission: a.permission,
    skills: a.skills,
    dependsOn: a.dependsOn,
    frontmatterExtra: a.frontmatterExtra,
    bodyMd: a.bodyMd,
  }
  if (a.model !== undefined) out.model = a.model
  if (a.variant !== undefined) out.variant = a.variant
  if (a.temperature !== undefined) out.temperature = a.temperature
  if (a.steps !== undefined) out.steps = a.steps
  if (a.maxSteps !== undefined) out.maxSteps = a.maxSteps
  return out
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
