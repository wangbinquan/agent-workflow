// Agent detail / edit page — the right rail of the /agents split page.
//
// RFC-169 / RFC-223: child route under the /agents layout (path '/$id'), with
// `remountDeps: ({params}) => params` so switching agents (a card click that
// only changes the param) remounts this component — otherwise the hydrate-once
// draft would carry agent A's edits into agent B (a pre-existing latent bug the
// split page turns into a main path). Save stays in place (no navigate); the
// cache transaction keeps the list card fresh without turning the editor into
// an error page on a background refetch failure (§4).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, CreateAgent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import {
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import {
  AgentForm,
  AgentJsonValidationSummary,
  agentJsonInvalidFields,
  emptyAgent,
  reconcileAgentJsonDraft,
  type AgentJsonDraft,
  type AgentJsonFieldKey,
  type AgentTab,
} from '@/components/AgentForm'
import { AgentPortValidationSummary } from '@/components/agent-ports/AgentPortValidationSummary'
import { useTour } from '@/components/tour/SpotlightTour'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { validateAgentPortState } from '@/lib/agent-ports'
import { Route as agentsRoute } from './agents'

export const Route = createRoute({
  getParentRoute: () => agentsRoute,
  path: '/$id',
  component: AgentDetailPage,
  // RFC-169 T-D11: param change ⇒ remount ⇒ fresh hydrate-once seed.
  remountDeps: ({ params }) => params,
})

function AgentDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const tour = useTour()
  const [activeTab, setActiveTab] = useState<AgentTab>('basics')
  const [jsonFocusTarget, setJsonFocusTarget] = useState<AgentJsonFieldKey>()
  const clearJsonFocusTarget = useCallback(() => setJsonFocusTarget(undefined), [])
  const [jsonDraft, setJsonDraft] = useState<AgentJsonDraft>()
  const invalidJsonFields = jsonDraft === undefined ? [] : agentJsonInvalidFields(jsonDraft)
  const jsonReady = jsonDraft !== undefined
  const jsonValid = jsonReady && invalidJsonFields.length === 0

  const query = useQuery<Agent>({
    queryKey: ['agents', id],
    queryFn: ({ signal }) => api.get(`/api/agents/${encodeURIComponent(id)}`, undefined, signal),
  })

  // RFC-169: dirty-tracked hydrate-once draft with clean-follow (rebases a clean
  // draft to background refetches; freezes a dirty one). Save reseeds via
  // commitSaved rather than navigating away.
  const { draft, setDraft, loaded, dirty, commitSaved } = useDraftFromQuery(
    query.data,
    agentToDraft,
    { followWhenClean: true, freezeWhen: jsonReady && !jsonValid },
  )
  useEffect(() => {
    if (draft === undefined) return
    setJsonDraft((current) => reconcileAgentJsonDraft(current, draft))
  }, [draft])
  useReportSplitDirty(id, dirty || (jsonReady && !jsonValid))

  const save = useMutation({
    mutationFn: ({ submitted }: { submitted: CreateAgent; release: SplitBusyRelease }) => {
      const revision = query.data
      if (revision === undefined) return Promise.reject(new Error('agent revision is unavailable'))
      return api.put<Agent>(`/api/agents/${encodeURIComponent(id)}`, {
        ...agentToPutBody(submitted),
        expectedUpdatedAt: revision.updatedAt,
        expectedAclRevision: revision.aclRevision ?? 0,
      })
    },
    onSuccess: async (saved, { submitted }) => {
      // Detail fence (R3-P1-2): cancel any in-flight detail GET before writing
      // saved, else a stale GET could land after and clobber it.
      await qc.cancelQueries({ queryKey: ['agents', id], exact: true })
      qc.setQueryData(['agents', id], saved)
      // Collection eager patch (null-safe) then EXACT invalidate — never the
      // non-exact invalidate that would also refetch the active detail query
      // and flip the editor to an error page on a transient failure (§4).
      await qc.cancelQueries({ queryKey: ['agents'], exact: true })
      qc.setQueryData<Agent[]>(['agents'], (rows) =>
        rows === undefined ? rows : rows.map((r) => (r.id === id ? saved : r)),
      )
      void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
      commitSaved(submitted, agentToDraft(saved))
      // stay in place — no navigate (RFC-169 D2).
    },
    onSettled: (_saved, _error, { release }) => release(),
  })

  const del = useMutation({
    mutationFn: ({ confirm, release: _release }: { confirm: string; release: SplitBusyRelease }) =>
      query.data === undefined
        ? Promise.reject(new Error('agent revision is unavailable'))
        : api.deleteJson(`/api/agents/${encodeURIComponent(id)}`, {
            confirm,
            expectedUpdatedAt: query.data.updatedAt,
            expectedAclRevision: query.data.aclRevision ?? 0,
          }),
    onSuccess: async (_deleted, { release }) => {
      // Sync-clear the dirty ref so the guard doesn't block THIS navigation
      // (the resource no longer exists — nothing to save).
      report(id, false)
      await qc.cancelQueries({ queryKey: ['agents'], exact: true })
      qc.setQueryData<Agent[]>(['agents'], (rows) =>
        rows === undefined ? rows : rows.filter((r) => r.id !== id),
      )
      void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
      release()
      navigate({ to: '/agents' })
    },
    onSettled: (_deleted, _error, { release }) => release(),
  })
  const portValidation = validateAgentPortState(draft ?? emptyAgent())
  const blockingPortIssues = portValidation.issues.filter((issue) => issue.severity === 'error')

  // §6 error-state narrowing: only a missing draft shows the full error/loading;
  // once seeded, a background failure keeps the editor and shows a top banner.
  if (draft === undefined) {
    if (query.isLoading) return <LoadingState data-testid="agent-detail-loading" />
    if (query.error !== null && query.error !== undefined)
      return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
  }

  return (
    <fieldset className="detail-freeze" disabled={del.isPending}>
      <DetailHeaderActions
        title={query.data?.name ?? id}
        headingLevel={2}
        acl={{
          resourceBaseUrl: `/api/agents/${encodeURIComponent(id)}`,
          invalidateKey: ['agents'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: () => {
            if (
              draft !== undefined &&
              jsonValid &&
              portValidation.valid &&
              !save.isPending &&
              !del.isPending
            ) {
              save.mutate({ submitted: draft, release: beginBusy(id) })
            }
          },
          disabled:
            save.isPending || del.isPending || !loaded || !portValidation.valid || !jsonValid,
          testid: 'agent-save-button',
        }}
        del={{
          label: t('common.delete'),
          confirmName: query.data?.name ?? id,
          resourceType: 'agent',
          onConfirm: (ctx) => {
            if (save.isPending || del.isPending) return Promise.resolve()
            return del.mutateAsync({ confirm: ctx?.typedConfirm ?? '', release: beginBusy(id) })
          },
          disabled: del.isPending || save.isPending,
        }}
        errors={[save.error, del.error]}
        extra={
          query.data?.builtin !== true && (
            <Link
              to="/tasks/new"
              // RFC-211 §12: while the onboarding tour is running, deep-link the
              // wizard into its prefilled, ready-to-submit tour mode so the tour
              // can complete build → run → result. Normal launches are untouched.
              search={
                tour.active?.tourId === 'first-task'
                  ? { kind: 'agent', agentId: id, tour: 'first-task' }
                  : { kind: 'agent', agentId: id }
              }
              className="btn"
              data-testid="agent-launch-button"
              data-tour="agent-launch"
            >
              {t('taskWizard.launchEntry')}
            </Link>
          )
        }
      />
      {jsonDraft !== undefined && (
        <AgentJsonValidationSummary
          draft={jsonDraft}
          onNavigate={(key) => {
            setJsonFocusTarget(key)
            setActiveTab('advanced')
          }}
        />
      )}
      {blockingPortIssues.length > 0 && (
        <AgentPortValidationSummary
          issues={blockingPortIssues}
          variant="compact"
          onNavigate={setActiveTab}
        />
      )}
      {draft !== undefined && query.error !== null && query.error !== undefined && (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      )}
      <AgentForm
        value={draft ?? emptyAgent()}
        onChange={setDraft}
        resourceId={id}
        idPrefix="agents-detail"
        nameLocked
        defaultTechnicalDetailsOpen
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasExternalPortAlert={blockingPortIssues.length > 0}
        jsonDraft={jsonDraft}
        onJsonDraftChange={setJsonDraft}
        focusJsonField={jsonFocusTarget}
        onJsonFocusHandled={clearJsonFocusTarget}
      />
    </fieldset>
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

/**
 * RFC-173 (T5) — the PUT body sent by the save mutation, extracted as a pure
 * function so the wire shape is unit-testable (AC-7: skills/mcp/plugins/
 * dependsOn must survive the resource-picker rewrite untouched). Drops `name`
 * (it's in the URL) and sends explicit `runtime: null` when inheriting so a PUT
 * can CLEAR a previously-pinned runtime (RFC-115; a bare undefined is dropped by
 * JSON.stringify → updateAgent would read it as "leave untouched").
 */
export function agentToPutBody(submitted: CreateAgent): Omit<CreateAgent, 'name' | 'runtime'> & {
  runtime: string | null
} {
  const { name: _drop, ...rest } = submitted
  return { ...rest, runtime: submitted.runtime ?? null }
}
