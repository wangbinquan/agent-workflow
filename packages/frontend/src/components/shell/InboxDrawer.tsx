// RFC-032 PR2: unified inbox drawer. Replaces the standalone /reviews and
// /clarify sidebar entries — one button, one drawer, three segmented tabs
// (All / Reviews / Clarify). Click a row to navigate to the underlying
// detail page; the drawer stays open so the user can plough through a
// queue of pending items.
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
import type { ClarifySessionSummary, ReviewSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'

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

  const clarify = useQuery<ClarifySessionSummary[]>({
    queryKey: ['clarify', 'inbox', 'pending'],
    queryFn: ({ signal }) => api.get('/api/clarify?status=awaiting_human', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

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
          id: r.nodeRunId,
          taskId: r.taskId,
          title: r.title,
          subtitle: r.workflowName,
          createdAt: r.createdAt,
        })
      }
    }
    if (tab === 'all' || tab === 'clarify') {
      for (const c of clarify.data ?? []) {
        rows.push({
          kind: 'clarify',
          id: c.clarifyNodeRunId,
          taskId: c.taskId,
          // The list page renders source-agent + iteration; the drawer is
          // tighter, so we use just the agent name as the title.
          title: c.sourceAgentNodeId,
          subtitle: c.sourceShardKey ? `shard ${c.sourceShardKey}` : `iter ${c.iterationIndex}`,
          createdAt: c.createdAt,
        })
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }, [tab, reviews.data, clarify.data])

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
            {t(
              k === 'all'
                ? 'nav.inbox.tabAll'
                : k === 'reviews'
                  ? 'nav.inbox.tabReviews'
                  : 'nav.inbox.tabClarify',
            )}
          </button>
        ))}
      </div>

      {(tab === 'all' || tab === 'reviews') && reviews.error !== null && (
        <ErrorRow message={t('nav.inbox.errorReviews')} onRetry={() => void reviews.refetch()} />
      )}
      {(tab === 'all' || tab === 'clarify') && clarify.error !== null && (
        <ErrorRow message={t('nav.inbox.errorClarify')} onRetry={() => void clarify.refetch()} />
      )}

      {items.length === 0 && !reviews.isLoading && !clarify.isLoading && (
        <div className="inbox-drawer__empty muted">{t('nav.inbox.empty')}</div>
      )}

      <div className="inbox-drawer__list">
        {items.map((it) => (
          <button
            key={`${it.kind}-${it.id}`}
            type="button"
            className="inbox-drawer__item"
            data-testid={`inbox-row-${it.kind}-${it.id}`}
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
              {t(it.kind === 'review' ? 'nav.inbox.tabReviews' : 'nav.inbox.tabClarify')}
            </span>
            <span className="inbox-drawer__title">{it.title}</span>
            <span className="inbox-drawer__subtitle muted">{it.subtitle}</span>
            <span className="inbox-drawer__task muted">
              {t('nav.inbox.sourceTask', { taskId: it.taskId })}
            </span>
          </button>
        ))}
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

interface InboxItem {
  kind: 'review' | 'clarify'
  id: string
  taskId: string
  title: string
  subtitle: string
  createdAt: number
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
