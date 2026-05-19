// RFC-041 PR4 — flat list of every approved memory.
// Used for the /memory/all sub-route. Per-row [Archive] / [Delete] for admins.
//
// Bug-fix (post-RFC-041):
//   1. Archive used to fire on a single click with no confirmation, and
//      the UI offered no Archived view to restore from — a mis-click
//      effectively hid the memory until the user hit the API by hand.
//   2. Both Archive and Delete now route through the shared <Dialog>
//      (same chrome as the reviews-detail decision dialog) rather than
//      the native browser modal — consistent in-app styling + focus
//      trap + ESC + portal + a11y.
// Backend already exposes `?status=archived` listing + POST /unarchive.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Memory, MemorySummary } from '@agent-workflow/shared'
import type { ApiError } from '@/api/client'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { describeApiError } from '@/i18n'
import { sortByRecency } from '@/lib/memory'
import { MemoryEditDialog } from './MemoryEditDialog'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

type View = 'approved' | 'archived'

type PendingConfirm = { kind: 'archive' | 'delete'; id: string } | null

export interface MemoryAllListProps {
  isAdmin: boolean
}

export function MemoryAllList({ isAdmin }: MemoryAllListProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [view, setView] = useState<View>('approved')
  const [pending, setPending] = useState<PendingConfirm>(null)
  // RFC-045: id of the row whose Edit button was clicked. We then fetch the
  // full Memory (the list endpoint returns MemorySummary only) and feed it
  // to <MemoryEditDialog>.
  const [editingId, setEditingId] = useState<string | null>(null)
  const editingMemory = useQuery<{ memory: Memory }>({
    queryKey: ['memories', 'detail', editingId],
    queryFn: ({ signal }) =>
      api.get<{ memory: Memory }>(
        `/api/memories/${encodeURIComponent(editingId ?? '')}`,
        undefined,
        signal,
      ),
    enabled: editingId !== null,
  })

  const list = useQuery<ListResponse>({
    queryKey: ['memories', 'all', view],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', { status: view }, signal),
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
  }
  const archive = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.post(`/api/memories/${encodeURIComponent(id)}/archive`),
    onSuccess: invalidate,
  })
  const unarchive = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.post(`/api/memories/${encodeURIComponent(id)}/unarchive`),
    onSuccess: invalidate,
  })
  const del = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.delete(`/api/memories/${encodeURIComponent(id)}?confirm=true`),
    onSuccess: invalidate,
  })

  const submitting =
    (pending?.kind === 'archive' && archive.isPending) ||
    (pending?.kind === 'delete' && del.isPending)

  const confirmPending = () => {
    if (pending === null) return
    if (pending.kind === 'archive') archive.mutate(pending.id)
    else del.mutate(pending.id)
    setPending(null)
  }

  return (
    <div className="memory-all" data-testid="memory-all">
      <div role="tablist" className="tabs tabs--pills memory-all__filter">
        {(['approved', 'archived'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={`tabs__tab ${view === v ? 'tabs__tab--active' : ''}`}
            onClick={() => setView(v)}
            data-testid={`memory-all-filter-${v}`}
          >
            {t(`memory.status.${v}`)}
          </button>
        ))}
      </div>

      {renderBody({
        list,
        view,
        isAdmin,
        archivePending: archive.isPending,
        unarchivePending: unarchive.isPending,
        delPending: del.isPending,
        onArchive: (id) => setPending({ kind: 'archive', id }),
        onUnarchive: (id) => unarchive.mutate(id),
        onDelete: (id) => setPending({ kind: 'delete', id }),
        onEdit: isAdmin ? (id) => setEditingId(id) : undefined,
        t,
      })}

      {editingId !== null && editingMemory.data?.memory !== undefined && (
        <MemoryEditDialog
          open
          onClose={() => setEditingId(null)}
          memory={editingMemory.data.memory}
        />
      )}

      {pending !== null && (
        <Dialog
          open
          onClose={() => setPending(null)}
          size="sm"
          title={t(
            pending.kind === 'archive' ? 'memory.archiveDialogTitle' : 'memory.deleteDialogTitle',
          )}
          panelClassName="memory-confirm-dialog__panel"
          data-testid="memory-confirm-dialog"
          footer={
            <>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPending(null)}
                data-testid="memory-confirm-cancel"
              >
                {t('memory.dialogCancel')}
              </button>
              <button
                type="button"
                className={
                  'btn btn--sm ' + (pending.kind === 'delete' ? 'btn--danger' : 'btn--primary')
                }
                onClick={confirmPending}
                disabled={submitting}
                data-testid="memory-confirm-ok"
              >
                {t('memory.dialogConfirm')}
              </button>
            </>
          }
        >
          <p>{t(pending.kind === 'archive' ? 'memory.confirmArchive' : 'memory.confirmDelete')}</p>
        </Dialog>
      )}
    </div>
  )
}

interface BodyArgs {
  list: ReturnType<typeof useQuery<ListResponse>>
  view: View
  isAdmin: boolean
  archivePending: boolean
  unarchivePending: boolean
  delPending: boolean
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onEdit?: (id: string) => void
  t: (key: string) => string
}

function renderBody(args: BodyArgs) {
  const {
    list,
    view,
    isAdmin,
    archivePending,
    unarchivePending,
    delPending,
    onArchive,
    onUnarchive,
    onDelete,
    onEdit,
    t,
  } = args
  if (list.isLoading) return <LoadingState />
  if (list.error !== null && list.error !== undefined) {
    return <div className="error-box">{describeApiError(list.error)}</div>
  }
  const rows = sortByRecency(list.data?.items ?? [])
  if (rows.length === 0) {
    return <EmptyState title={t('memory.empty')} />
  }

  return (
    <ul className="memory-all-list" data-testid="memory-all-list">
      {rows.map((m) => (
        <MemoryRow
          key={m.id}
          memory={m}
          onEdit={onEdit !== undefined ? () => onEdit(m.id) : undefined}
          editable={isAdmin}
          actions={
            <>
              {view === 'approved' ? (
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() => onArchive(m.id)}
                  disabled={!isAdmin || archivePending}
                  data-testid={`memory-all-${m.id}-archive`}
                >
                  {t('memory.action.archive')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() => onUnarchive(m.id)}
                  disabled={!isAdmin || unarchivePending}
                  data-testid={`memory-all-${m.id}-unarchive`}
                >
                  {t('memory.action.unarchive')}
                </button>
              )}
              <button
                type="button"
                className="btn btn--xs btn--danger"
                onClick={() => onDelete(m.id)}
                disabled={!isAdmin || delPending}
                data-testid={`memory-all-${m.id}-delete`}
              >
                {t('memory.action.delete')}
              </button>
            </>
          }
        />
      ))}
    </ul>
  )
}
