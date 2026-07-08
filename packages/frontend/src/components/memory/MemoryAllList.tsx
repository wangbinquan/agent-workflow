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
import { FuseDialog } from '@/components/fusion/FuseDialog'
import { TabBar } from '@/components/TabBar'
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
  // RFC-101: approved-view multi-select → "Fuse into skill".
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fuseOpen, setFuseOpen] = useState(false)
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
      {/* RFC-150: the old `tabs--pills` modifier had NO CSS definition (ghost
          class — visually identical without it), so the shared TabBar renders
          the default variant; the `memory-all__filter` namespace hook stays. */}
      <TabBar<View>
        className="memory-all__filter"
        tabs={(['approved', 'archived'] as const).map((v) => ({
          key: v,
          label: t(`memory.status.${v}`),
          testid: `memory-all-filter-${v}`,
        }))}
        active={view}
        onSelect={setView}
      />

      {view === 'approved' && selected.size > 0 && (
        <div className="memory-all__bulk page__actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => setFuseOpen(true)}
            data-testid="memory-fuse-button"
          >
            {`${t('fusion.launchButton')} · ${t('fusion.selectedCount', { n: selected.size })}`}
          </button>
        </div>
      )}

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
        onEdit: (id) => setEditingId(id),
        selected,
        onToggleSelect: toggleSelect,
        t,
      })}

      <FuseDialog
        open={fuseOpen}
        onClose={() => setFuseOpen(false)}
        entry={{ kind: 'from-memories', memoryIds: Array.from(selected) }}
      />

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
  /** RFC-101: approved-view multi-select for the fuse picker. */
  selected?: ReadonlySet<string>
  onToggleSelect?: (id: string) => void
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
    selected,
    onToggleSelect,
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
      {rows.map((m) => {
        // RFC-099 (D12): per-row manage rights — scope-resource owners manage
        // their own rows; `canManage` comes from the backend annotation and
        // falls back to the admin role for older payloads.
        const rowManage = m.canManage ?? isAdmin
        return (
          <MemoryRow
            key={m.id}
            memory={m}
            onEdit={onEdit !== undefined && rowManage ? () => onEdit(m.id) : undefined}
            editable={rowManage}
            select={
              view === 'approved' && rowManage && onToggleSelect !== undefined
                ? { checked: selected?.has(m.id) ?? false, onChange: () => onToggleSelect(m.id) }
                : undefined
            }
            actions={
              <>
                {view === 'approved' ? (
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={() => onArchive(m.id)}
                    disabled={!rowManage || archivePending}
                    data-testid={`memory-all-${m.id}-archive`}
                  >
                    {t('memory.action.archive')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={() => onUnarchive(m.id)}
                    disabled={!rowManage || unarchivePending}
                    data-testid={`memory-all-${m.id}-unarchive`}
                  >
                    {t('memory.action.unarchive')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  onClick={() => onDelete(m.id)}
                  disabled={!rowManage || delPending}
                  data-testid={`memory-all-${m.id}-delete`}
                >
                  {t('memory.action.delete')}
                </button>
              </>
            }
          />
        )
      })}
    </ul>
  )
}
