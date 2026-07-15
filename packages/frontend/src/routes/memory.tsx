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
// Tab state lives in component-local state; no URL search params yet
// (RFC-041 PR5 may add deep-link via `search` if Inbox/Detail pages need
// to land on a specific tab — currently every entry point goes to the
// approval queue).

import { createRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Route as RootRoute } from './__root'
import { MemoryApprovalQueue } from '@/components/memory/MemoryApprovalQueue'
import { MemoryAllList } from '@/components/memory/MemoryAllList'
import { MemoryByScopeBrowser } from '@/components/memory/MemoryByScopeBrowser'
import { MemoryDistillJobsTable } from '@/components/memory/MemoryDistillJobsTable'
import { MemoryFusionList } from '@/components/memory/MemoryFusionList'
import { MemoryNewDialog } from '@/components/memory/MemoryNewDialog'
import { TabBar } from '@/components/TabBar'
import { useActor } from '@/hooks/useActor'
import { useMemoryWs } from '@/hooks/useMemoryWs'
import { useMemoryDistillJobWs } from '@/hooks/useMemoryDistillJobWs'

type MemoryTab = 'approval-queue' | 'all' | 'by-scope' | 'distill-jobs' | 'fusion'

const TABS: MemoryTab[] = ['approval-queue', 'all', 'by-scope', 'distill-jobs', 'fusion']

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
  const search = Route.useSearch()
  const [tab, setTab] = useState<MemoryTab>(search.tab ?? 'approval-queue')
  // A same-page navigation with a different ?tab (e.g. clicking the homepage
  // tile while already on /memory) re-syncs the local tab state.
  useEffect(() => {
    if (search.tab !== undefined) setTab(search.tab)
  }, [search.tab])
  const [newDialogOpen, setNewDialogOpen] = useState(false)

  // Live updates for the entire surface.
  useMemoryWs()
  useMemoryDistillJobWs({ enabled: isAdmin })

  return (
    <div className="page page--memory">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('memory.title')}</h1>
        </div>
        {/* RFC-099: resource owners may create memories for their own
            agents/workflows — show the button to everyone; the backend
            enforces per-scope manage rights. */}
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setNewDialogOpen(true)}
          data-testid="memory-new-button"
        >
          {t('memory.action.new')}
        </button>
      </header>
      {newDialogOpen && (
        <MemoryNewDialog
          open={newDialogOpen}
          onClose={() => setNewDialogOpen(false)}
          onCreated={() => {
            setNewDialogOpen(false)
            setTab('approval-queue')
          }}
        />
      )}

      <TabBar<MemoryTab>
        className="memory-tab-bar"
        rootTestid="memory-tab-bar"
        tabs={TABS.map((k) => ({ key: k, label: tabLabel(t, k), testid: `memory-tab-${k}` }))}
        active={tab}
        onSelect={setTab}
      />

      <div className="page__content">
        {tab === 'approval-queue' && <MemoryApprovalQueue isAdmin={isAdmin} />}
        {tab === 'all' && <MemoryAllList isAdmin={isAdmin} />}
        {tab === 'by-scope' && <MemoryByScopeBrowser />}
        {tab === 'distill-jobs' &&
          (isAdmin ? (
            <MemoryDistillJobsTable />
          ) : (
            <div className="info-box info-box--muted" data-testid="memory-distill-jobs-admin-only">
              {t('memory.adminOnly')}
            </div>
          ))}
        {tab === 'fusion' && <MemoryFusionList />}
      </div>
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
