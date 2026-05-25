// RFC-061 PR-C: drawer used to show memory candidates only. The follow-
// up commit extends it to also surface open SignalKind suspensions
// (self-clarify / cross-clarify / review / retry-pending-*) fetched
// from the projection-native /api/suspensions endpoint. Clicking a
// suspension navigates to the owning task's detail page — the
// dedicated /clarify and /reviews routes will be rebuilt in a follow-
// up PR with the per-SignalKind answer/approve forms.

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { usePermission } from '@/hooks/useActor'

interface InboxDrawerProps {
  open: boolean
  onClose: () => void
}

interface SuspensionRow {
  id: string
  taskId: string
  nodeRunId: string
  scope: { nodeId: string; loopIter: number; shardKey: string; iter: number }
  signalKind:
    | 'self-clarify'
    | 'cross-clarify'
    | 'review'
    | 'retry-pending-auto'
    | 'retry-pending-human'
    | 'await-external-data'
  awaitsActor: string
  body: unknown
  createdAt: number
  resolvedAt: number | null
  resolvedByEventId: string | null
}

export function InboxDrawer({ open, onClose }: InboxDrawerProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const canSeeMemory = usePermission('memory:approve')

  const memoryQuery = useQuery<{ items: MemorySummary[] }>({
    queryKey: ['memories', 'inbox', 'candidates'],
    queryFn: ({ signal }) => api.get('/api/memories?status=candidate', undefined, signal),
    enabled: open && canSeeMemory,
    refetchInterval: open && canSeeMemory ? 15_000 : false,
  })

  const suspensionsQuery = useQuery<{ rows: SuspensionRow[] }>({
    queryKey: ['suspensions', 'inbox'],
    queryFn: ({ signal }) => api.get('/api/suspensions', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

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
      const footerButton = document.querySelector('[data-testid="inbox-footer-button"]')
      if (footerButton !== null && footerButton.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDocClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [open, onClose])

  const items = useMemo<InboxItem[]>(() => {
    const rows: InboxItem[] = []
    for (const s of suspensionsQuery.data?.rows ?? []) {
      // Skip retry-pending-auto entries — those are scheduler-internal
      // (the auto-resolver re-fires them on the next tick); humans
      // never need to look at them from the inbox.
      if (s.signalKind === 'retry-pending-auto') continue
      rows.push({
        rowKey: s.id,
        kind: 'suspension',
        signalKind: s.signalKind,
        taskId: s.taskId,
        nodeId: s.scope.nodeId,
        title: signalKindLabel(t, s.signalKind),
        subtitle: t('nav.inbox.suspensionItemSubtitle', {
          taskId: s.taskId.slice(0, 10),
          nodeId: s.scope.nodeId,
        }),
        createdAt: s.createdAt,
      })
    }
    if (canSeeMemory) {
      for (const m of memoryQuery.data?.items ?? []) {
        rows.push({
          rowKey: m.id,
          kind: 'memory',
          title: m.title,
          subtitle: t('nav.inbox.memoryItemSubtitle', {
            scope: t(`memory.scope.${m.scopeType}`),
            kind: t(`memory.distillAction.${memoryActionKey(m.distillAction)}`, { id: '' }),
          }),
          createdAt: m.approvedAt ?? Date.now(),
        })
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows
  }, [memoryQuery.data, suspensionsQuery.data, canSeeMemory, t])

  if (!open) return null

  const overlay = (
    <div
      ref={panelRef}
      className="inbox-drawer"
      role="dialog"
      aria-label={t('nav.inbox.label')}
      data-testid="inbox-drawer"
    >
      {items.length === 0 ? (
        <div className="inbox-drawer__empty muted">{t('nav.inbox.empty')}</div>
      ) : (
        <div className="inbox-drawer__list">
          {items.map((it) => (
            <button
              key={`${it.kind}:${it.rowKey}`}
              type="button"
              className="inbox-drawer__item"
              data-testid={`inbox-row-${it.kind}-${it.rowKey}`}
              onClick={() => {
                onClose()
                if (it.kind === 'memory') {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  void navigate({ to: '/memory' } as any)
                  return
                }
                // Suspension row — land on the owning task's detail page.
                // Dedicated /clarify / /reviews routes will rebuild in a
                // follow-up PR; for now the user can at least see the task
                // context from the canvas.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                void navigate({ to: `/tasks/${encodeURIComponent(it.taskId)}` } as any)
              }}
            >
              <span
                className={`inbox-drawer__kind inbox-drawer__kind--${kindClass(it)}`}
                data-kind={kindClass(it)}
              >
                {it.kind === 'memory' ? t('nav.memory') : it.title}
              </span>
              {it.kind === 'memory' && <span className="inbox-drawer__title">{it.title}</span>}
              <span className="inbox-drawer__subtitle muted">{it.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return createPortal(overlay, document.body)
}

type InboxItem =
  | {
      rowKey: string
      kind: 'memory'
      title: string
      subtitle: string
      createdAt: number
    }
  | {
      rowKey: string
      kind: 'suspension'
      signalKind: SuspensionRow['signalKind']
      taskId: string
      nodeId: string
      title: string
      subtitle: string
      createdAt: number
    }

function kindClass(it: InboxItem): string {
  if (it.kind === 'memory') return 'memory'
  if (it.signalKind === 'review') return 'review'
  if (it.signalKind.includes('clarify')) return 'clarify'
  return 'suspension'
}

function signalKindLabel(t: (k: string) => string, k: SuspensionRow['signalKind']): string {
  switch (k) {
    case 'self-clarify':
      return t('nav.inbox.suspensionKindSelfClarify')
    case 'cross-clarify':
      return t('nav.inbox.suspensionKindCrossClarify')
    case 'review':
      return t('nav.inbox.suspensionKindReview')
    case 'retry-pending-auto':
      return t('nav.inbox.suspensionKindRetryAuto')
    case 'retry-pending-human':
      return t('nav.inbox.suspensionKindRetryHuman')
    case 'await-external-data':
      return t('nav.inbox.suspensionKindAwaitExternal')
  }
}

function memoryActionKey(a: MemorySummary['distillAction']): string {
  switch (a) {
    case 'new':
      return 'new'
    case 'update_of':
      return 'updateOf'
    case 'duplicate_of':
      return 'duplicateOf'
    case 'conflict_with':
      return 'conflictWith'
    case null:
    default:
      return 'new'
  }
}
