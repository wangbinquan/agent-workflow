// RFC-201 B4 — Memory is URL-backed page-section navigation, not a five-tab
// strip. Legacy `?tab=` keys stay valid, while the absent-key default is the
// stable approved-memory library (`all`). Capability filtering never derives
// row ACL from the actor: only the server-returned `canManage` field is used.

import { createRoute, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState, type RefObject } from 'react'
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
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { PageSectionLink, PageSectionNav, type PageSectionGroup } from '@/components/PageSectionNav'
import { useMemoryPendingCounts } from '@/components/shell/MemoryPendingBadge'
import { useActor } from '@/hooks/useActor'
import { useMemoryWs } from '@/hooks/useMemoryWs'
import { useMemoryDistillJobWs } from '@/hooks/useMemoryDistillJobWs'

export type MemoryTab = 'approval-queue' | 'all' | 'by-scope' | 'distill-jobs' | 'fusion'

export const MEMORY_TABS: MemoryTab[] = [
  'approval-queue',
  'all',
  'by-scope',
  'distill-jobs',
  'fusion',
]

function isMemoryTab(value: unknown): value is MemoryTab {
  return typeof value === 'string' && (MEMORY_TABS as string[]).includes(value)
}

export function withMemoryTab<T extends Record<string, unknown>>(
  previous: T,
  tab: MemoryTab,
): T & { tab: MemoryTab } {
  return { ...previous, tab }
}

export interface MemorySearch extends Record<string, unknown> {
  tab?: MemoryTab
  focus?: string
}

/** Preserve unrelated search state while validating only Memory-owned keys. */
export function validateMemorySearch(search: Record<string, unknown>): MemorySearch {
  const { tab: _tab, focus: _focus, ...adjacent } = search
  return {
    ...adjacent,
    ...(isMemoryTab(search.tab) ? { tab: search.tab as MemoryTab } : {}),
    ...(typeof search.focus === 'string' ? { focus: search.focus } : {}),
  }
}

function rawMemoryTab(href: string): string | null {
  return new URL(href, 'http://memory.local').searchParams.get('tab')
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/memory',
  component: MemoryPage,
  // RFC-190: optional `?tab=` deep-link (the homepage memory tile lands on
  // `all`, whose default view is the approved pool the tile counts). Unknown
  // or absent values keep that stable All default. `focus` is the
  // pre-existing RFC-041 deep-link param (written by distill-job
  // CandidatesList) — passed through so those links keep compiling/working.
  validateSearch: validateMemorySearch,
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
  const href = useRouterState({ select: (state) => state.location.href })
  const rawTab = rawMemoryTab(href)
  const requestedTab = isMemoryTab(search.tab) ? search.tab : 'all'
  const tab: MemoryTab = !isAdmin && requestedTab === 'distill-jobs' ? 'all' : requestedTab
  const [newDialogOpen, setNewDialogOpen] = useState(false)
  const [allView, setAllView] = useState<'approved' | 'archived'>('approved')
  const [showUnavailableNotice, setShowUnavailableNotice] = useState(false)
  const sectionHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const pendingCounts = useMemoryPendingCounts({ enabled: actor.data !== undefined })

  const selectTab = (next: MemoryTab) => {
    if (next === tab) return
    setShowUnavailableNotice(false)
    void navigate({ search: (previous) => withMemoryTab(previous, next), hash })
  }

  useEffect(() => {
    if (rawTab === null || (MEMORY_TABS as string[]).includes(rawTab)) return
    void navigate({
      search: (previous) => withMemoryTab(previous, 'all'),
      hash,
      replace: true,
    })
  }, [hash, navigate, rawTab])

  useEffect(() => {
    if (actor.data === undefined || isAdmin || search.tab !== 'distill-jobs') return
    setShowUnavailableNotice(true)
    void navigate({
      search: (previous) => withMemoryTab(previous, 'all'),
      hash,
      replace: true,
    })
  }, [actor.data, hash, isAdmin, navigate, search.tab])

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
          {showUnavailableNotice && (
            <NoticeBanner tone="info" size="compact" className="memory-section-notice">
              {t('memory.sectionUnavailable')}
            </NoticeBanner>
          )}
          <MemorySections
            tab={tab}
            isAdmin={isAdmin}
            hash={hash}
            pendingCounts={pendingCounts}
            allView={allView}
            onAllViewChange={setAllView}
            onSelect={selectTab}
            headingRef={sectionHeadingRef}
          />
        </>
      )}
    </div>
  )
}

interface MemorySectionsProps {
  tab: MemoryTab
  isAdmin: boolean
  hash: string
  pendingCounts: ReturnType<typeof useMemoryPendingCounts>
  allView: 'approved' | 'archived'
  onAllViewChange: (view: 'approved' | 'archived') => void
  onSelect: (tab: MemoryTab) => void
  headingRef: RefObject<HTMLHeadingElement | null>
}

function MemorySections(props: MemorySectionsProps) {
  const { t } = useTranslation()
  const groups: PageSectionGroup<MemoryTab>[] = [
    {
      key: 'pending',
      label: t('memory.sectionGroups.pending'),
      badge: props.pendingCounts.total > 0 ? props.pendingCounts.total : undefined,
      badgeTone: 'attention',
      items: [
        {
          key: 'approval-queue',
          label: tabLabel(t, 'approval-queue'),
          description: t('memory.sectionDescriptions.approvalQueue'),
          badge: props.pendingCounts.candidates > 0 ? props.pendingCounts.candidates : undefined,
          badgeTone: 'attention',
        },
        {
          key: 'fusion',
          label: tabLabel(t, 'fusion'),
          description: t('memory.sectionDescriptions.fusion'),
          badge: props.pendingCounts.fusions > 0 ? props.pendingCounts.fusions : undefined,
          badgeTone: 'attention',
        },
      ],
    },
    {
      key: 'library',
      label: t('memory.sectionGroups.library'),
      items: [
        {
          key: 'all',
          label: tabLabel(t, 'all'),
          description: t('memory.sectionDescriptions.all'),
        },
        {
          key: 'by-scope',
          label: tabLabel(t, 'by-scope'),
          description: t('memory.sectionDescriptions.byScope'),
        },
      ],
    },
    ...(props.isAdmin
      ? [
          {
            key: 'automation',
            label: t('memory.sectionGroups.automation'),
            items: [
              {
                key: 'distill-jobs' as const,
                label: tabLabel(t, 'distill-jobs'),
                description: t('memory.sectionDescriptions.distillJobs'),
              },
            ],
          },
        ]
      : []),
  ]
  const activeSection = groups
    .flatMap((group) => group.items)
    .find((section) => section.key === props.tab)

  return (
    <div className="page-section-layout memory-section-layout">
      <PageSectionNav<MemoryTab>
        groups={groups}
        active={props.tab}
        presentation="rail"
        ariaLabel={t('memory.sectionNavLabel')}
        idPrefix="memory"
        renderDestination={(key, destination) => (
          <PageSectionLink
            to="/memory"
            search={(previous) => withMemoryTab(previous, key)}
            hash={props.hash}
            className={destination.className}
            pageSectionCurrent={destination.ariaCurrent}
            data-testid={`memory-section-${key}`}
          >
            {destination.children}
          </PageSectionLink>
        )}
        onSelectCompact={(next) => props.onSelect(next)}
      />

      <section
        className={`memory-section-panel memory-section-panel--${props.tab}`}
        aria-labelledby={`memory-section-title-${props.tab}`}
        data-testid="memory-section-panel"
      >
        <header className="memory-section-panel__header">
          <h2 ref={props.headingRef} id={`memory-section-title-${props.tab}`} tabIndex={-1}>
            {activeSection?.label}
          </h2>
          <p>{activeSection?.description}</p>
        </header>
        {props.tab === 'approval-queue' && <MemoryApprovalQueue />}
        {props.tab === 'all' && (
          <MemoryAllList view={props.allView} onViewChange={props.onAllViewChange} />
        )}
        {props.tab === 'by-scope' && <MemoryByScopeBrowser />}
        {props.tab === 'distill-jobs' && props.isAdmin && <MemoryDistillJobsTable />}
        {props.tab === 'fusion' && <MemoryFusionList />}
      </section>
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
