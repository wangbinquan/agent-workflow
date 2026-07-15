// RFC-041 PR4 — top-level Memory route + 4 sub-tabs.
//
// Sub-tabs (admin / non-admin):
//   - approval-queue: admin sees buttons; non-admin sees the rows but the
//     buttons are disabled (cheap "Admin only" banner above).
//   - all:            list of every approved memory; admin can archive /
//     delete; non-admin sees rows read-only.
//   - by-scope:       4 buckets (agent/workflow/repo/global). Read-only.
//   - distill-jobs:   admin-only; non-admins see a "Admin only" placeholder.
//
// RFC-198: the validated `?tab=` search key is the single page-tab authority.
// Functional search updates retain RFC-041's existing `focus` deep-link, while
// stable tab/panel ids give every tab a real accessible target.

import { createRoute, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Route as RootRoute } from './__root'
import { MemoryApprovalQueue } from '@/components/memory/MemoryApprovalQueue'
import { MemoryAllList } from '@/components/memory/MemoryAllList'
import { MemoryByScopeBrowser } from '@/components/memory/MemoryByScopeBrowser'
import { MemoryDistillJobsTable } from '@/components/memory/MemoryDistillJobsTable'
import { MemoryFusionList } from '@/components/memory/MemoryFusionList'
import { MemoryNewDialog } from '@/components/memory/MemoryNewDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { useActor } from '@/hooks/useActor'
import { useMemoryWs } from '@/hooks/useMemoryWs'
import { useMemoryDistillJobWs } from '@/hooks/useMemoryDistillJobWs'

export type MemoryTab = 'approval-queue' | 'all' | 'by-scope' | 'distill-jobs' | 'fusion'

const TABS: MemoryTab[] = ['approval-queue', 'all', 'by-scope', 'distill-jobs', 'fusion']

export function withMemoryTab<T extends Record<string, unknown>>(
  previous: T,
  tab: MemoryTab,
): T & { tab: MemoryTab } {
  return { ...previous, tab }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/memory',
  component: MemoryPage,
  // RFC-190: optional `?tab=` deep-link (the homepage memory tile lands on
  // `all`, whose default view is the approved pool the tile counts). Unknown
  // or absent values keep the classic approval-queue default. `focus` is the
  // pre-existing RFC-041 deep-link param (written by distill-job
  // CandidatesList) — passed through so those links keep compiling/working.
  validateSearch: (search: Record<string, unknown>): { tab?: MemoryTab; focus?: string } => {
    const out: { tab?: MemoryTab; focus?: string } = {}
    if (typeof search.tab === 'string' && (TABS as string[]).includes(search.tab)) {
      out.tab = search.tab as MemoryTab
    }
    if (typeof search.focus === 'string') out.focus = search.focus
    return out
  },
})

function MemoryPage() {
  const { t } = useTranslation()
  // RFC-099 (D12): memory:approve moved into the user baseline (the real
  // gate is per-row canManage), so the ADMIN surfaces here key off the
  // actor's role instead of the permission point.
  const actor = useActor()
  const isAdmin = actor.data?.user.role === 'admin'
  const actorError = actor.error !== null && actor.error !== undefined
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const hash = useRouterState({ select: (state) => state.location.hash })
  const tab = search.tab ?? 'approval-queue'
  const [newDialogOpen, setNewDialogOpen] = useState(false)

  const selectTab = (next: MemoryTab) => {
    if (next === tab) return
    void navigate({ search: (previous) => withMemoryTab(previous, next), hash })
  }

  // Live updates for the entire surface.
  useMemoryWs()
  useMemoryDistillJobWs({ enabled: isAdmin })

  const retryActorAction = (
    <button type="button" className="btn btn--sm" onClick={() => void actor.refetch()}>
      {t('common.retry')}
    </button>
  )

  return (
    <div className="page page--memory">
      <PageHeader
        title={t('memory.title')}
        actions={
          /* RFC-099: resource owners may create memories for their own
            agents/workflows — show the button to everyone; the backend
            enforces per-scope manage rights. */
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setNewDialogOpen(true)}
            data-testid="memory-new-button"
          >
            {t('memory.action.new')}
          </button>
        }
      />
      {newDialogOpen && (
        <MemoryNewDialog
          open={newDialogOpen}
          onClose={() => setNewDialogOpen(false)}
          onCreated={() => {
            setNewDialogOpen(false)
            selectTab('approval-queue')
          }}
        />
      )}

      {actor.data === undefined ? (
        actor.isLoading ? (
          <LoadingState />
        ) : actorError ? (
          <ErrorBanner error={actor.error} action={retryActorAction} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {actorError && <ErrorBanner error={actor.error} action={retryActorAction} />}
          <TabBar<MemoryTab>
            className="memory-tab-bar"
            rootTestid="memory-tab-bar"
            tabs={TABS.map((k) => ({ key: k, label: tabLabel(t, k), testid: `memory-tab-${k}` }))}
            active={tab}
            onSelect={selectTab}
            idPrefix="memory"
            ariaLabel={t('memory.title')}
          />

          {TABS.map((panelTab) => {
            const ids = tabDomIds('memory', panelTab)
            const isActive = panelTab === tab
            return (
              <div
                key={panelTab}
                className="page__content"
                role="tabpanel"
                id={ids.panelId}
                aria-labelledby={ids.tabId}
                hidden={!isActive}
              >
                {isActive && panelTab === 'approval-queue' && (
                  <MemoryApprovalQueue isAdmin={isAdmin} />
                )}
                {isActive && panelTab === 'all' && <MemoryAllList isAdmin={isAdmin} />}
                {isActive && panelTab === 'by-scope' && <MemoryByScopeBrowser />}
                {isActive &&
                  panelTab === 'distill-jobs' &&
                  (isAdmin ? (
                    <MemoryDistillJobsTable />
                  ) : (
                    <div
                      className="info-box info-box--muted"
                      data-testid="memory-distill-jobs-admin-only"
                    >
                      {t('memory.adminOnly')}
                    </div>
                  ))}
                {isActive && panelTab === 'fusion' && <MemoryFusionList />}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function tabLabel(t: (key: string) => string, k: MemoryTab): string {
  switch (k) {
    case 'approval-queue':
      return t('memory.tab.approvalQueue')
    case 'all':
      return t('memory.tab.all')
    case 'by-scope':
      return t('memory.tab.byScope')
    case 'distill-jobs':
      return t('memory.tab.distillJobs')
    case 'fusion':
      return t('memory.tab.fusion')
  }
}
