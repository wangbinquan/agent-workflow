// Agent create page — the inline "new" view of the /agents split page.
//
// RFC-169 (T6/T8): child route under the /agents layout (path '/new'); the left
// rail stays mounted. Light header (title + import + create — no ACL/delete).
//
// RFC-002: on mount, snapshot the current Runtime defaults from /api/config into
// the draft *once*. RFC-169 (P2-4): the same config snapshot ALSO resets the
// dirty baseline, computed separately so an untouched page stays clean while a
// page the user already typed into stays dirty (the baseline absorbs defaults on
// the empty shape; the draft folds defaults into whatever the user has).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  Config,
  CreateAgent,
  ResolveAgentImportRefsRequest,
  ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  AgentForm,
  AgentJsonValidationSummary,
  agentJsonInvalidFields,
  createAgentJsonDraft,
  emptyAgent,
  type AgentJsonFieldKey,
  type AgentTab,
} from '@/components/AgentForm'
import { AgentImportDialog } from '@/components/AgentImportDialog'
import { AgentPortValidationSummary } from '@/components/agent-ports/AgentPortValidationSummary'
import { ErrorBanner } from '@/components/ErrorBanner'
import { PageHeader } from '@/components/PageHeader'
import {
  NEW_CARD_KEY,
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { mergeAgentImport } from '@/lib/agent-import-merge'
import { validateAgentPortState } from '@/lib/agent-ports'
import { queryConfig, useConfigQueryKey } from '@/lib/config-resource'
import { Route as agentsRoute } from './agents'

export const Route = createRoute({
  getParentRoute: () => agentsRoute,
  path: '/new',
  component: AgentCreatePage,
})

/**
 * Pre-select the configured default runtime on a fresh draft (if the user
 * hasn't picked one yet). RFC-113: model/variant/temperature/steps live on the
 * RUNTIME now, not the agent — so the only Runtime default an agent draft seeds
 * is which runtime it points at. Pure, exported for unit tests.
 */
export function applyDefaults(draft: CreateAgent, cfg: Config): CreateAgent {
  const next: CreateAgent = { ...draft }
  if (draft.runtime === undefined && cfg.defaultRuntime) next.runtime = cfg.defaultRuntime
  return next
}

function AgentCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const [draft, setDraft] = useState(emptyAgent)
  const [jsonDraft, setJsonDraft] = useState(() => createAgentJsonDraft(emptyAgent()))
  const [activeTab, setActiveTab] = useState<AgentTab>('basics')
  const [jsonFocusTarget, setJsonFocusTarget] = useState<AgentJsonFieldKey>()
  const clearJsonFocusTarget = useCallback(() => setJsonFocusTarget(undefined), [])
  const [importOpen, setImportOpen] = useState(false)
  const importTriggerRef = useRef<HTMLButtonElement | null>(null)
  const { dirty, resetBaseline } = useDirtyBaseline(draft, draft)
  const invalidJsonFields = agentJsonInvalidFields(jsonDraft)
  const jsonValid = invalidJsonFields.length === 0
  useReportSplitDirty(NEW_CARD_KEY, dirty || !jsonValid)

  const configQueryKey = useConfigQueryKey()
  const config = useQuery<Config>({
    queryKey: configQueryKey,
    queryFn: ({ signal }) => queryConfig(signal),
    staleTime: 30_000,
    retry: false,
  })

  const snapshottedRef = useRef(false)
  useEffect(() => {
    if (snapshottedRef.current) return
    if (!config.data) return
    snapshottedRef.current = true
    const cfg = config.data
    // Baseline absorbs defaults on the EMPTY shape (so a never-touched page is
    // clean); the draft folds defaults into whatever the user already has.
    resetBaseline(applyDefaults(emptyAgent(), cfg))
    setDraft((prev) => applyDefaults(prev, cfg))
  }, [config.data, resetBaseline])

  const create = useMutation({
    // Capture the exact click-time payload.  The request may settle after a
    // render (or after the defaults query), so reading the closure here would
    // make the submitted agent depend on unrelated later state.
    mutationFn: ({
      submitted,
      signal,
    }: {
      submitted: CreateAgent
      release: SplitBusyRelease
      signal: AbortSignal
    }) => api.post<Agent>('/api/agents', submitted, signal),
    onSuccess: async (created, { release, signal }) => {
      // RFC-208: the unsaved guard's "leave anyway" aborts this request. If it
      // did, the user has already chosen a destination — a late success must not
      // navigate them somewhere else.
      if (signal.aborted) {
        release()
        return
      }
      // Sync-clear before navigating so the guard doesn't block THIS navigation.
      report(NEW_CARD_KEY, false)
      await qc.cancelQueries({ queryKey: ['agents'], exact: true })
      qc.setQueryData<Agent[]>(['agents'], (rows) =>
        rows === undefined ? rows : [...rows, created],
      )
      void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
      qc.setQueryData(['agents', created.id], created)
      release()
      navigate({ to: '/agents/$id', params: { id: created.id } })
    },
    onSettled: (_created, _error, { release }) => release(),
  })
  const portValidation = validateAgentPortState(draft)
  const blockingPortIssues = portValidation.issues.filter((issue) => issue.severity === 'error')

  return (
    <fieldset
      className="agent-new detail-freeze"
      disabled={create.isPending}
      data-testid="agent-create-scope"
    >
      <PageHeader
        title={t('agents.newTitle')}
        headingLevel={2}
        actions={
          <>
            <button
              ref={importTriggerRef}
              type="button"
              className="btn btn--sm"
              data-testid="agent-import-open"
              onClick={() => setImportOpen(true)}
            >
              {t('agentForm.importButton')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                create.isPending || draft.name === '' || !portValidation.valid || !jsonValid
              }
              onClick={() => {
                if (portValidation.valid && jsonValid && !create.isPending) {
                  const ctl = new AbortController()
                  create.mutate({
                    submitted: draft,
                    signal: ctl.signal,
                    release: beginBusy(NEW_CARD_KEY, { abort: () => ctl.abort() }),
                  })
                }
              }}
              data-testid="agent-create-button"
              data-tour="agent-save"
            >
              {create.isPending ? t('common.creating') : t('agents.createButton')}
            </button>
          </>
        }
      />
      <AgentJsonValidationSummary
        draft={jsonDraft}
        onNavigate={(key) => {
          setJsonFocusTarget(key)
          setActiveTab('advanced')
        }}
      />
      {blockingPortIssues.length > 0 && (
        <AgentPortValidationSummary
          issues={blockingPortIssues}
          variant="compact"
          onNavigate={setActiveTab}
        />
      )}
      {create.error !== null && create.error !== undefined && <ErrorBanner error={create.error} />}
      <AgentForm
        value={draft}
        onChange={setDraft}
        idPrefix="agents-new"
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasExternalPortAlert={blockingPortIssues.length > 0}
        jsonDraft={jsonDraft}
        onJsonDraftChange={setJsonDraft}
        focusJsonField={jsonFocusTarget}
        onJsonFocusHandled={clearJsonFocusTarget}
      />
      <AgentImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        currentValue={draft}
        triggerRef={importTriggerRef}
        onViewForm={setActiveTab}
        onResolve={(request: ResolveAgentImportRefsRequest) =>
          api.post<ResolveAgentImportRefsResult>('/api/agents/import-resolve', request)
        }
        onApply={(res, resolved) => {
          const merged = mergeAgentImport(draft, res, resolved)
          setDraft(merged)
          // Import is an explicit replacement, so it resets raw JSON (including
          // any invalid text) to the imported semantic values atomically.
          setJsonDraft(createAgentJsonDraft(merged))
        }}
      />
    </fieldset>
  )
}
