// Agent detail / edit page. Loads, mutates, deletes.
//
// Note: TanStack code-based routes use `agents/$name`. Splitting into a
// dedicated file keeps imports lean and matches the file layout in plan.md.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, CreateAgent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AclDialogButton } from '@/components/AclPanel'
import { AgentForm, emptyAgent } from '@/components/AgentForm'
import { ConfirmButton } from '@/components/ConfirmButton'
import { describeApiError } from '@/i18n'
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
      const { name: _drop, ...rest } = draft
      // RFC-115: send an explicit `runtime: null` when the agent inherits, so a PUT
      // can CLEAR a previously-pinned runtime. A bare `undefined` is dropped by
      // JSON.stringify, which updateAgent reads as "leave untouched" → the old pin
      // would survive and the selector would keep lying about it.
      const patch = { ...rest, runtime: draft.runtime ?? null }
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
    return <div className="page error-box">{describeApiError(query.error)}</div>

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{name}</h1>
          <p className="page__hint">{t('agents.detailHint')}</p>
        </div>
        <div className="page__actions">
          <AclDialogButton
            resourceBaseUrl={`/api/agents/${encodeURIComponent(name)}`}
            invalidateKey={['agents']}
          />
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
            <span className="form-actions__error">{describeApiError(save.error)}</span>
          )}
          {del.error !== null && del.error !== undefined && (
            <span className="form-actions__error">{describeApiError(del.error)}</span>
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
    syncOutputsOnIterate: a.syncOutputsOnIterate,
    permission: a.permission,
    skills: a.skills,
    dependsOn: a.dependsOn,
    // RFC-028 / RFC-031 round-trip: preserve the saved mcp[] and plugins[]
    // so reopening the edit page doesn't silently reset them. Locked by
    // agents-detail-mcp-plugins-roundtrip.test.ts.
    mcp: a.mcp,
    plugins: a.plugins,
    frontmatterExtra: a.frontmatterExtra,
    bodyMd: a.bodyMd,
  }
  if (a.outputKinds !== undefined) out.outputKinds = a.outputKinds
  // RFC-115 round-trip fix: carry the agent's pinned runtime into the draft. The
  // edit form's Runtime selector reads `draft.runtime`; dropping it here made every
  // agent render as "inherit (global default)" regardless of its real pin — and the
  // RFC-113 startup migration pinned every user agent, so this mis-displayed all of
  // them (and masked that switching the global default no longer moved them).
  if (a.runtime !== undefined) out.runtime = a.runtime
  return out
}
