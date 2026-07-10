// RFC-032 PR2: unified inbox drawer. Replaces the standalone /reviews and
// /clarify sidebar entries — one button, one drawer, three segmented tabs
// (All / Reviews / Clarify). Click a row to navigate to the underlying
// detail page; the drawer stays open so the user can plough through a
// queue of pending items.
//
// RFC-121: the inbox is scoped back to task-flow to-dos (reviews + clarify).
// The memory-candidate group (RFC-041 PR4) and the fusion group (RFC-101)
// were lifted OUT of here and onto the /memory page (its approval-queue +
// new "fusion" tab), with the sidebar Memory badge carrying their pending
// count. Keep this drawer to reviews + clarify only.
//
// Lifecycle:
//   - The footer button (lifted in __root.tsx) toggles `open`.
//   - ESC + outside click close it. Detail-page navigation does NOT.
//   - Renders into document.body via a React portal so the absolute
//     positioning lives outside the sidebar's flow.

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { WorkgroupPendingCount } from '@/lib/workgroup-room'

export type InboxTab = 'all' | 'reviews' | 'clarify'

interface InboxDrawerProps {
  open: boolean
  onClose: () => void
}

export function InboxDrawer({ open, onClose }: InboxDrawerProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<InboxTab>('all')
  const tabRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()

  const reviews = useQuery<ReviewSummary[]>({
    queryKey: ['reviews', 'inbox', 'pending'],
    queryFn: ({ signal }) => api.get('/api/reviews?status=pending', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

  const clarify = useQuery<ClarifyRoundSummary[]>({
    queryKey: ['clarify', 'inbox', 'pending'],
    queryFn: ({ signal }) => api.get('/api/clarify?status=awaiting_human', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

  // RFC-164 PR-6 — third source: workgroup to-dos (deliveries + gates). The
  // endpoint is count-only, so the drawer renders a single summary row that
  // jumps to the tasks list (each room carries its own to-do cards).
  const workgroups = useQuery<WorkgroupPendingCount>({
    queryKey: ['workgroup-tasks', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/workgroup-tasks/pending-count', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })
  const wgTotal = tab === 'all' ? (workgroups.data?.total ?? 0) : 0

  // ESC closes; outside-click closes (only after the first paint, so the
  // very click that opened the drawer doesn't immediately close it).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDocClick = (e: MouseEvent): void => {
      const panel = panelRef.current
      const target = e.target
      if (panel === null || !(target instanceof Node)) return
      if (panel.contains(target)) return
      // The footer button has its own onToggle handler; do not double-fire
      // if the user clicked it (it bubbles after our handler).
      const footerButton = document.querySelector('[data-testid="inbox-footer-button"]')
      if (footerButton !== null && footerButton.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    // Use mousedown rather than click — the mouseup-after-drag artifact
    // can otherwise fire on a release that started inside the panel.
    document.addEventListener('mousedown', onDocClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [open, onClose])

  // Focus the first segmented tab when the drawer mounts open.
  useEffect(() => {
    if (open) tabRef.current?.focus()
  }, [open])

  const items = useMemo<InboxItem[]>(() => {
    const rows: InboxItem[] = []
    if (tab === 'all' || tab === 'reviews') {
      for (const r of reviews.data ?? []) {
        rows.push({
          kind: 'review',
          rowKey: r.nodeRunId,
          id: r.nodeRunId,
          taskId: r.taskId,
          taskName: r.taskName,
          title: r.title,
          subtitle: r.workflowName,
          createdAt: r.createdAt,
        })
      }
    }
    if (tab === 'all' || tab === 'clarify') {
      for (const c of clarify.data ?? []) {
        // RFC-058: unified ClarifyRoundSummary — intermediary == clarify
        // node, asking == source agent, iteration == legacy iterationIndex.
        const clarifyTitle =
          typeof c.intermediaryNodeTitle === 'string' && c.intermediaryNodeTitle.length > 0
            ? c.intermediaryNodeTitle
            : c.intermediaryNodeId
        const agentLabel =
          typeof c.askingNodeTitle === 'string' && c.askingNodeTitle.length > 0
            ? c.askingNodeTitle
            : c.askingNodeId
        const shardOrIter = c.askingShardKey
          ? t('nav.inbox.shardLabel', { shard: c.askingShardKey })
          : t('nav.inbox.iterLabel', { iter: c.iteration })
        rows.push({
          kind: 'clarify',
          // React key uses the round id (always unique). The nav target
          // stays on `intermediaryNodeRunId` because the detail route is
          // /clarify/$nodeRunId — keyed by the intermediary (clarify /
          // clarify-cross-agent) node's run id.
          rowKey: c.id,
          id: c.intermediaryNodeRunId,
          taskId: c.taskId,
          taskName: c.taskName,
          title: clarifyTitle,
          subtitle: t('nav.inbox.clarifySubtitle', { agent: agentLabel, detail: shardOrIter }),
          createdAt: c.createdAt,
        })
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }, [tab, reviews.data, clarify.data, t])

  if (!open) return null

  const overlay = (
    <div
      ref={panelRef}
      className="inbox-drawer"
      role="dialog"
      aria-label={t('nav.inbox.label')}
      data-testid="inbox-drawer"
    >
      <div className="inbox-drawer__tabs" role="tablist">
        {(['all', 'reviews', 'clarify'] as const).map((k, i) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            ref={i === 0 ? tabRef : null}
            className={`inbox-drawer__tab${tab === k ? ' inbox-drawer__tab--active' : ''}`}
            onClick={() => setTab(k)}
            data-testid={`inbox-tab-${k}`}
          >
            {t(inboxTabLabelKey(k))}
          </button>
        ))}
      </div>

      {(tab === 'all' || tab === 'reviews') && reviews.error !== null && (
        <ErrorRow message={t('nav.inbox.errorReviews')} onRetry={() => void reviews.refetch()} />
      )}
      {(tab === 'all' || tab === 'clarify') && clarify.error !== null && (
        <ErrorRow message={t('nav.inbox.errorClarify')} onRetry={() => void clarify.refetch()} />
      )}
      {tab === 'all' && workgroups.error !== null && (
        <ErrorRow
          message={t('nav.inbox.errorWorkgroups')}
          onRetry={() => void workgroups.refetch()}
        />
      )}

      {items.length === 0 && wgTotal === 0 && !reviews.isLoading && !clarify.isLoading && (
        <div className="inbox-drawer__empty muted">{t('nav.inbox.empty')}</div>
      )}

      {/* RFC-164 PR-6 — workgroup to-dos summary row (count-only source; the
          per-task room owns the actionable cards). */}
      {wgTotal > 0 && (
        <button
          type="button"
          className="inbox-drawer__item"
          data-testid="inbox-row-workgroups"
          onClick={() => {
            onClose()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void navigate({ to: '/tasks' } as any)
          }}
        >
          <span className="inbox-drawer__kind inbox-drawer__kind--wg" data-kind="wg">
            {t('nav.inbox.wgKind')}
          </span>
          <span className="inbox-drawer__title">{t('nav.inbox.wgRow', { n: wgTotal })}</span>
          <span
            className="inbox-drawer__subtitle muted"
            data-testid="inbox-row-workgroups-breakdown"
          >
            {t('nav.inbox.wgBreakdown', {
              d: workgroups.data?.deliveries ?? 0,
              g: workgroups.data?.gates ?? 0,
            })}
          </span>
        </button>
      )}

      <div className="inbox-drawer__list">
        {items.map((it) => (
          <button
            key={`${it.kind}-${it.rowKey}`}
            type="button"
            className="inbox-drawer__item"
            data-testid={`inbox-row-${it.kind}-${it.rowKey}`}
            onClick={() => {
              const target =
                it.kind === 'review'
                  ? { to: '/reviews/$nodeRunId', params: { nodeRunId: it.id } }
                  : { to: '/clarify/$nodeRunId', params: { nodeRunId: it.id } }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              void navigate(target as any)
            }}
          >
            <span
              className={`inbox-drawer__kind inbox-drawer__kind--${it.kind}`}
              data-kind={it.kind}
            >
              {t(inboxKindLabelKey(it.kind))}
            </span>
            <span className="inbox-drawer__title">{it.title}</span>
            <span className="inbox-drawer__subtitle muted">{it.subtitle}</span>
            {/* RFC-037: surface the user-supplied task name so the inbox
                disambiguates same-workflow tasks. Falls back to the short
                ID label when name is blank (defensive — schema requires it). */}
            <span className="inbox-drawer__task-name" data-testid="inbox-row-task-name">
              {it.taskName.length > 0
                ? it.taskName
                : t('nav.inbox.sourceTask', { taskId: it.taskId })}
            </span>
            <span className="inbox-drawer__task muted">
              {t('nav.inbox.sourceTask', { taskId: it.taskId })}
            </span>
          </button>
        ))}
      </div>

      {/* Footer entry points to the full list pages. The drawer was
          intentionally kept short (pending-only), so users need a way to
          reach the historical /reviews + /clarify tabs (approved /
          rejected / answered, etc.). Clicking closes the drawer so the
          user lands cleanly on the list page. */}
      <div className="inbox-drawer__footer">
        <button
          type="button"
          className="inbox-drawer__footer-link"
          data-testid="inbox-drawer-open-reviews"
          onClick={() => {
            onClose()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void navigate({ to: '/reviews' } as any)
          }}
        >
          {t('nav.inbox.openReviews')}
        </button>
        <button
          type="button"
          className="inbox-drawer__footer-link"
          data-testid="inbox-drawer-open-clarify"
          onClick={() => {
            onClose()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void navigate({ to: '/clarify' } as any)
          }}
        >
          {t('nav.inbox.openClarify')}
        </button>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

interface InboxItem {
  kind: 'review' | 'clarify'
  /**
   * Stable, row-unique identifier used for the React `key` and the row's
   * `data-testid`. For reviews this is `nodeRunId` (unique per pending
   * review); for clarify this is the session `id` rather than
   * `clarifyNodeRunId`, because a single node-run can have several
   * awaiting sessions across loop iterations / retries.
   */
  rowKey: string
  /** Navigation target — `nodeRunId` for both kinds. */
  id: string
  taskId: string
  /** RFC-037: joined `tasks.name`. Rendered as a chip in the row. */
  taskName: string
  title: string
  subtitle: string
  createdAt: number
}

function inboxTabLabelKey(k: InboxTab): string {
  switch (k) {
    case 'all':
      return 'nav.inbox.tabAll'
    case 'reviews':
      return 'nav.inbox.tabReviews'
    case 'clarify':
      return 'nav.inbox.tabClarify'
  }
}

function inboxKindLabelKey(kind: InboxItem['kind']): string {
  switch (kind) {
    case 'review':
      return 'nav.inbox.tabReviews'
    case 'clarify':
      return 'nav.inbox.tabClarify'
  }
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="inbox-drawer__error error-box" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn--xs" onClick={onRetry}>
        {t('nav.inbox.retry')}
      </button>
    </div>
  )
}
