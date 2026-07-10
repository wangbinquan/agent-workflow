// Agent detail / edit page. Loads, mutates, deletes.
//
// Note: TanStack code-based routes use `agents/$name`. Splitting into a
// dedicated file keeps imports lean and matches the file layout in plan.md.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent, CreateAgent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { AgentForm, emptyAgent } from '@/components/AgentForm'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
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

  const query = useQuery<Agent>({
    queryKey: ['agents', name],
    queryFn: ({ signal }) => api.get(`/api/agents/${encodeURIComponent(name)}`, undefined, signal),
  })

  // RFC-151 PR-4 — hydrate-once draft (see useDraftFromQuery's stale-race
  // contract: save.onSuccess below eagerly setQueryData's the fresh row).
  const { draft, setDraft, loaded } = useDraftFromQuery(query.data, agentToDraft)

  const save = useMutation({
    mutationFn: () => {
      // Save is disabled until `loaded`, so the draft is always seeded here.
      if (draft === undefined) return Promise.reject(new Error('draft not loaded'))
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
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/agents/${encodeURIComponent(name)}`,
          invalidateKey: ['agents'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: () => save.mutate(),
          disabled: save.isPending || !loaded,
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        errors={[save.error, del.error]}
        extra={
          query.data?.builtin !== true && (
            <Link
              to="/tasks/new"
              search={{ kind: 'agent', agent: name }}
              className="btn btn--primary"
              data-testid="agent-launch-button"
            >
              {t('taskWizard.launchEntry')}
            </Link>
          )
        }
      >
        <div>
          <h1>{name}</h1>
        </div>
      </DetailHeaderActions>
      <AgentForm value={draft ?? emptyAgent()} onChange={setDraft} nameLocked />
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
  // RFC-155 (same shape as the runtime fix above): role + outputWrapperPortNames
  // are real GET fields (RFC-060 PR-B, projected back to top level by rowToAgent)
  // but were never copied into the draft — editing an aggregator showed
  // role=normal and an empty rename map, and the Advanced section would not
  // auto-open for it. Data was never lost (updateAgent keeps the stored role
  // when the patch omits it); the form just lied.
  if (a.role !== undefined) out.role = a.role
  if (a.outputWrapperPortNames !== undefined) out.outputWrapperPortNames = a.outputWrapperPortNames
  // RFC-166 round-trip (same shape as role/runtime above): carry declared input
  // ports into the draft so the InputsEditor shows them and a subsequent save
  // doesn't silently clear them. rowToAgent always populates inputs ([] or a
  // value); the guard keeps hand-built agents without the field lossless too.
  if (a.inputs !== undefined) out.inputs = a.inputs
  return out
}
