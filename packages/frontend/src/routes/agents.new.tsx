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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Config, CreateAgent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AgentForm, emptyAgent, type AgentTab } from '@/components/AgentForm'
import { AgentImportDialog } from '@/components/AgentImportDialog'
import { AgentPortValidationSummary } from '@/components/agent-ports/AgentPortValidationSummary'
import { ErrorBanner } from '@/components/ErrorBanner'
import { NEW_CARD_KEY, useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { mergeAgentImport } from '@/lib/agent-import-merge'
import { validateAgentPortState } from '@/lib/agent-ports'
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
  const { report } = useSplitDirty()
  const [draft, setDraft] = useState(emptyAgent)
  const [activeTab, setActiveTab] = useState<AgentTab>('basics')
  const [importOpen, setImportOpen] = useState(false)
  const { dirty, resetBaseline } = useDirtyBaseline(draft, draft)
  useReportSplitDirty(NEW_CARD_KEY, dirty)

  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
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
    mutationFn: () => api.post<Agent>('/api/agents', draft),
    onSuccess: async (created) => {
      // Sync-clear before navigating so the guard doesn't block THIS navigation.
      report(NEW_CARD_KEY, false)
      await qc.cancelQueries({ queryKey: ['agents'], exact: true })
      qc.setQueryData<Agent[]>(['agents'], (rows) =>
        rows === undefined ? rows : [...rows, created],
      )
      void qc.invalidateQueries({ queryKey: ['agents'], exact: true })
      qc.setQueryData(['agents', created.name], created)
      navigate({ to: '/agents/$name', params: { name: created.name } })
    },
  })
  const portValidation = validateAgentPortState(draft)
  const blockingPortIssues = portValidation.issues.filter((issue) => issue.severity === 'error')

  return (
    <div className="agent-new">
      <header className="page__header page__header--row">
        <div>
          <h2>{t('agents.newTitle')}</h2>
        </div>
        <div className="page__actions">
          <button
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
            disabled={create.isPending || draft.name === '' || !portValidation.valid}
            onClick={() => {
              if (portValidation.valid) create.mutate()
            }}
            data-testid="agent-create-button"
          >
            {create.isPending ? t('common.creating') : t('agents.createButton')}
          </button>
        </div>
      </header>
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
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasExternalPortAlert={blockingPortIssues.length > 0}
      />
      <AgentImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        currentValue={draft}
        onApply={(res) => setDraft((prev) => mergeAgentImport(prev, res))}
      />
    </div>
  )
}
