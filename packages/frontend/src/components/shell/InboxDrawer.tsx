// RFC-061 PR-C: drawer now shows memory candidates only. Reviews and
// clarify panes are temporarily disabled while the new suspensions-
// projection UI is being designed (PR-C T16+T17 follow-up).

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
    if (canSeeMemory) {
      for (const m of memoryQuery.data?.items ?? []) {
        rows.push({
          rowKey: m.id,
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
  }, [memoryQuery.data, canSeeMemory, t])

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
              key={it.rowKey}
              type="button"
              className="inbox-drawer__item"
              data-testid={`inbox-row-memory-${it.rowKey}`}
              onClick={() => {
                onClose()
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                void navigate({ to: '/memory' } as any)
              }}
            >
              <span className="inbox-drawer__kind inbox-drawer__kind--memory" data-kind="memory">
                {t('nav.memory')}
              </span>
              <span className="inbox-drawer__title">{it.title}</span>
              <span className="inbox-drawer__subtitle muted">{it.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return createPortal(overlay, document.body)
}

interface InboxItem {
  rowKey: string
  title: string
  subtitle: string
  createdAt: number
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
