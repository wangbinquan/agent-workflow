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

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import type { ApiError } from '@/api/client'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { LoadingState } from '@/components/LoadingState'
import { Segmented } from '@/components/Segmented'
import { sortByRecency } from '@/lib/memory'
import { FuseDialog } from '@/components/fusion/FuseDialog'
import { MemoryEditDialog } from './MemoryEditDialog'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

export type MemoryAllView = 'approved' | 'archived'

type PendingConfirm = { kind: 'archive' | 'delete'; id: string } | null

export interface MemoryAllListProps {
  /** Route-owned so leaving All and returning preserves the chosen view. */
  view?: MemoryAllView
  onViewChange?: (view: MemoryAllView) => void
}

export function MemoryAllList({ view: controlledView, onViewChange }: MemoryAllListProps = {}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [localView, setLocalView] = useState<MemoryAllView>('approved')
  const view = controlledView ?? localView
  const setView = (next: MemoryAllView) => {
    setLocalView(next)
    onViewChange?.(next)
  }
  const [pending, setPending] = useState<PendingConfirm>(null)
  // Synchronous lock for the click-to-mutation render gap. React Query's
  // isPending flag arrives on the next render; without this ref another row
  // can replace/reset the submitted target while its request is in flight.
  const destructiveOperationRef = useRef<Exclude<PendingConfirm, null> | null>(null)
  const [unarchivePendingIds, setUnarchivePendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [unarchiveErrors, setUnarchiveErrors] = useState<ReadonlyMap<string, unknown>>(
    () => new Map(),
  )
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
  const destructivePending = archive.isPending || del.isPending

  const removeSelected = (id: string) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const openPending = (next: Exclude<PendingConfirm, null>) => {
    if (destructiveOperationRef.current !== null || destructivePending) return
    archive.reset()
    del.reset()
    setPending(next)
  }

  const closePending = () => {
    if (destructiveOperationRef.current !== null || submitting) return
    archive.reset()
    del.reset()
    setPending(null)
  }

  const confirmPending = async () => {
    const target = pending
    if (target === null || destructiveOperationRef.current !== null || submitting) return
    destructiveOperationRef.current = target
    try {
      if (target.kind === 'archive') await archive.mutateAsync(target.id)
      else await del.mutateAsync(target.id)
      removeSelected(target.id)
      setPending((current) =>
        current?.kind === target.kind && current.id === target.id ? null : current,
      )
    } catch {
      // useMutation owns the error rendered inside the still-open dialog.
    } finally {
      if (destructiveOperationRef.current === target) destructiveOperationRef.current = null
    }
  }

  const runUnarchive = async (id: string) => {
    setUnarchivePendingIds((prev) => new Set(prev).add(id))
    setUnarchiveErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    try {
      await unarchive.mutateAsync(id)
    } catch (error) {
      setUnarchiveErrors((prev) => new Map(prev).set(id, error))
    } finally {
      setUnarchivePendingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const confirmError =
    pending?.kind === 'archive' ? archive.error : pending?.kind === 'delete' ? del.error : null

  return (
    <div className="memory-all" data-testid="memory-all">
      <Segmented<MemoryAllView>
        className="memory-all__filter"
        options={(['approved', 'archived'] as const).map((v) => ({
          value: v,
          label: t(`memory.status.${v}`),
          testid: `memory-all-filter-${v}`,
        }))}
        value={view}
        onChange={setView}
        ariaLabel={t('memory.tab.all')}
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
        archivePendingId: archive.isPending ? (archive.variables ?? null) : null,
        unarchivePendingIds,
        deletePendingId: del.isPending ? (del.variables ?? null) : null,
        destructivePending,
        unarchiveErrors: view === 'archived' ? unarchiveErrors : new Map(),
        onArchive: (id) => openPending({ kind: 'archive', id }),
        onUnarchive: (id) => void runUnarchive(id),
        onRetryUnarchive: (id) => void runUnarchive(id),
        onDelete: (id) => openPending({ kind: 'delete', id }),
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

      {editingId !== null && (
        <MemoryEditDialog open onClose={() => setEditingId(null)} memoryId={editingId} />
      )}

      {pending !== null && (
        <Dialog
          open
          onClose={closePending}
          dismissDisabled={submitting}
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
                onClick={closePending}
                disabled={submitting}
                data-testid="memory-confirm-cancel"
              >
                {t('memory.dialogCancel')}
              </button>
              <button
                type="button"
                className={
                  'btn btn--sm ' + (pending.kind === 'delete' ? 'btn--danger' : 'btn--primary')
                }
                onClick={() => void confirmPending()}
                disabled={submitting}
                data-testid="memory-confirm-ok"
              >
                {t('memory.dialogConfirm')}
              </button>
            </>
          }
        >
          <p>{t(pending.kind === 'archive' ? 'memory.confirmArchive' : 'memory.confirmDelete')}</p>
          <FeedbackStack variant="inline">
            {confirmError != null && (
              <ErrorBanner
                error={confirmError}
                onRetry={() => void confirmPending()}
                testid="memory-confirm-error"
              />
            )}
          </FeedbackStack>
        </Dialog>
      )}
    </div>
  )
}

interface BodyArgs {
  list: ReturnType<typeof useQuery<ListResponse>>
  view: MemoryAllView
  archivePendingId: string | null
  unarchivePendingIds: ReadonlySet<string>
  deletePendingId: string | null
  destructivePending: boolean
  unarchiveErrors: ReadonlyMap<string, unknown>
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onRetryUnarchive: (id: string) => void
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
    archivePendingId,
    unarchivePendingIds,
    deletePendingId,
    destructivePending,
    unarchiveErrors,
    onArchive,
    onUnarchive,
    onRetryUnarchive,
    onDelete,
    onEdit,
    selected,
    onToggleSelect,
    t,
  } = args
  const listError = list.error !== null && list.error !== undefined

  if (list.data === undefined) {
    if (list.isLoading) return <LoadingState />
    if (listError) {
      return <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
    }
    return <LoadingState />
  }
  const rows = sortByRecency(list.data.items)

  return (
    <>
      <FeedbackStack variant="section">
        {listError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />}
        {Array.from(unarchiveErrors, ([id, error]) => (
          <ErrorBanner
            key={id}
            error={error}
            onRetry={() => onRetryUnarchive(id)}
            testid={`memory-unarchive-error-${id}`}
          />
        ))}
      </FeedbackStack>
      {rows.length === 0 ? (
        <EmptyState
          title={t(
            view === 'approved' ? 'memory.emptyStates.approved' : 'memory.emptyStates.archived',
          )}
          description={t(
            view === 'approved'
              ? 'memory.emptyStates.approvedDescription'
              : 'memory.emptyStates.archivedDescription',
          )}
        />
      ) : (
        <ul className="memory-all-list" data-testid="memory-all-list">
          {rows.map((m) => {
            // RFC-201: fail closed when an old payload lacks the annotation.
            // Actor role/ownership is never reconstructed in the browser.
            const rowManage = m.canManage === true
            return (
              <MemoryRow
                key={m.id}
                memory={m}
                onEdit={onEdit !== undefined && rowManage ? () => onEdit(m.id) : undefined}
                editable={rowManage}
                select={
                  view === 'approved' && rowManage && onToggleSelect !== undefined
                    ? {
                        checked: selected?.has(m.id) ?? false,
                        onChange: () => onToggleSelect(m.id),
                        disabled: archivePendingId === m.id || deletePendingId === m.id,
                      }
                    : undefined
                }
                actions={
                  <>
                    {view === 'approved' ? (
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => onArchive(m.id)}
                        disabled={!rowManage || destructivePending}
                        data-testid={`memory-all-${m.id}-archive`}
                      >
                        {t('memory.action.archive')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => onUnarchive(m.id)}
                        disabled={!rowManage || unarchivePendingIds.has(m.id)}
                        data-testid={`memory-all-${m.id}-unarchive`}
                      >
                        {t('memory.action.unarchive')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--xs btn--danger"
                      onClick={() => onDelete(m.id)}
                      disabled={!rowManage || destructivePending}
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
      )}
    </>
  )
}
