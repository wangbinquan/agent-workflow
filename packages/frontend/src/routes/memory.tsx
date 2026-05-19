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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Route as RootRoute } from './__root'
import { MemoryApprovalQueue } from '@/components/memory/MemoryApprovalQueue'
import { MemoryAllList } from '@/components/memory/MemoryAllList'
import { MemoryByScopeBrowser } from '@/components/memory/MemoryByScopeBrowser'
import { MemoryDistillJobsTable } from '@/components/memory/MemoryDistillJobsTable'
import { MemoryNewDialog } from '@/components/memory/MemoryNewDialog'
import { useMemoryWs } from '@/hooks/useMemoryWs'
import { useMemoryDistillJobWs } from '@/hooks/useMemoryDistillJobWs'
import { usePermission } from '@/hooks/useActor'

type MemoryTab = 'approval-queue' | 'all' | 'by-scope' | 'distill-jobs'

const TABS: MemoryTab[] = ['approval-queue', 'all', 'by-scope', 'distill-jobs']

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/memory',
  component: MemoryPage,
})

function MemoryPage() {
  const { t } = useTranslation()
  const isAdmin = usePermission('memory:approve')
  const [tab, setTab] = useState<MemoryTab>('approval-queue')
  const [newDialogOpen, setNewDialogOpen] = useState(false)

  // Live updates for the entire surface.
  useMemoryWs()
  useMemoryDistillJobWs({ enabled: isAdmin })

  return (
    <div className="page page--memory">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('memory.title')}</h1>
          <p className="muted">{t('memory.hint')}</p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setNewDialogOpen(true)}
            data-testid="memory-new-button"
          >
            {t('memory.action.new')}
          </button>
        )}
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

      <nav role="tablist" className="tabs memory-tab-bar" data-testid="memory-tab-bar">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`tabs__tab ${tab === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab(k)}
            data-testid={`memory-tab-${k}`}
          >
            {tabLabel(t, k)}
          </button>
        ))}
      </nav>

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
  }
}
