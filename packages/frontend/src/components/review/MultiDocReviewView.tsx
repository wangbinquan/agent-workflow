// RFC-079 — multi-document review view.
//
// Rendered by the /reviews/$nodeRunId route when the review is a multi-document
// round (ReviewDetail.documents present). Keeps the single-document review page
// (reviews.detail.tsx) completely untouched.
//
// RFC-082: the per-document "markdown + anchored comment sidebar" is now the
// shared <ReviewDocPane> (same component the single-doc page uses), so each
// document gets the full comment experience — anchored bubbles, collapse/resize,
// scroll-spy, J/K jump, inline edit/copy. This view keeps ONLY the multi-doc
// shell: the left document navigator, per-document accept/reject, and the
// round-level approve/iterate/reject decision.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DocVersionWithBodyAndComments,
  ReviewComment,
  ReviewDetail,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { goToTaskDetail } from '@/lib/nav/taskNav'
import { Dialog } from '@/components/Dialog'
import { TextArea } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ReviewDocPane } from '@/components/review/ReviewDocPane'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { useTaskSync } from '@/hooks/useTaskSync'
import { multiDocHotkeyAction, nextDocIndex } from '@/lib/review/multiDocHotkeys'

type Selection = 'unselected' | 'accepted' | 'not_accepted'

function selectionChip(s: Selection): { kind: StatusChipKind; key: string } {
  if (s === 'accepted') return { kind: 'success', key: 'reviews.multiDoc.accepted' }
  if (s === 'not_accepted') return { kind: 'danger', key: 'reviews.multiDoc.notAccepted' }
  return { kind: 'neutral', key: 'reviews.multiDoc.pending' }
}

type DecisionDialog =
  | null
  | { kind: 'approve' }
  | { kind: 'iterate' }
  | { kind: 'reject'; reason: string; reasonError: boolean }

export function MultiDocReviewView({ nodeRunId }: { nodeRunId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
    refetchInterval: 8000,
  })
  useTaskSync(detail.data?.summary.taskId ?? null)

  const documents = useMemo(() => detail.data?.documents ?? [], [detail.data])
  const firstDocId = detail.data?.currentVersion.id ?? ''
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [paneCapturing, setPaneCapturing] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const activeDocId = selectedDocId ?? firstDocId
  const isFirst = activeDocId === firstDocId

  // The first document's body/comments arrive with the detail payload; other
  // documents are lazy-loaded via the existing version-detail endpoint.
  const selectedDoc = useQuery<DocVersionWithBodyAndComments>({
    queryKey: ['reviews', 'version-body', nodeRunId, activeDocId],
    queryFn: ({ signal }) =>
      api.get(`/api/reviews/${nodeRunId}/versions/${activeDocId}`, undefined, signal),
    enabled: !isFirst && activeDocId !== '',
  })
  const activeBody = isFirst ? detail.data?.currentBody : selectedDoc.data?.body
  const activeComments = useMemo<ReviewComment[]>(
    () => (isFirst ? (detail.data?.comments ?? []) : (selectedDoc.data?.comments ?? [])),
    [isFirst, detail.data, selectedDoc.data],
  )

  const awaiting = detail.data?.summary.awaitingReview ?? false
  const decidedCount = documents.filter((d) => d.selection !== 'unselected').length
  const allDecided = documents.length > 0 && decidedCount === documents.length

  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
    await qc.invalidateQueries({ queryKey: ['reviews', 'version-body', nodeRunId, activeDocId] })
  }, [qc, nodeRunId, activeDocId])

  const selectionMut = useMutation({
    mutationFn: async (input: { docVersionId: string; selection: 'accepted' | 'not_accepted' }) => {
      await api.patch(`/api/reviews/${nodeRunId}/documents/${input.docVersionId}/selection`, {
        selection: input.selection,
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] }),
  })

  const submitDecision = useMutation({
    mutationFn: async (input: {
      decision: 'approved' | 'rejected' | 'iterated'
      rejectReason?: string
      reviewIteration: number
    }) => {
      await api.post(`/api/reviews/${nodeRunId}/decision`, input)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'list'] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'pending-count'] })
      // RFC-023 bugfix #8 parity (see lib/nav/taskNav): bounce the reviewer
      // to the owning task so they see the round resume / rerun instead of
      // being stranded on the multi-doc review page.
      const taskId = detail.data?.summary.taskId
      if (taskId !== undefined) goToTaskDetail(qc, navigate, taskId)
    },
  })

  const [dialog, setDialog] = useState<DecisionDialog>(null)
  const reviewIteration = detail.data?.summary.reviewIteration ?? 0
  const confirmDecision = useCallback(async () => {
    if (dialog === null) return
    if (dialog.kind === 'reject') {
      const reason = dialog.reason.trim()
      if (reason.length === 0) {
        setDialog({ ...dialog, reasonError: true })
        return
      }
      setDialog(null)
      await submitDecision.mutateAsync({
        decision: 'rejected',
        rejectReason: reason,
        reviewIteration,
      })
      return
    }
    const decision = dialog.kind === 'approve' ? 'approved' : 'iterated'
    setDialog(null)
    await submitDecision.mutateAsync({ decision, reviewIteration })
  }, [dialog, submitDecision, reviewIteration])

  // RFC-090: keyboard nav for the multi-doc review queue — ↑/↓ switch document,
  // Q/W accept/reject the current one. Suppressed while the reviewer is filling
  // in a comment (paneCapturing, reported by ReviewDocPane when its popover is
  // open or a comment is inline-edited), while a decision dialog is open, or
  // while focus is in any form control. Modifier chords are ignored (see
  // multiDocHotkeyAction) so Cmd+W / Shift+Arrow etc. pass through untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paneCapturing) return
      if (dialog !== null) return
      if (
        document.activeElement !== null &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return
      }
      const action = multiDocHotkeyAction(e)
      if (action === null) return
      const idx = documents.findIndex((d) => d.docVersionId === activeDocId)
      if (action === 'prev' || action === 'next') {
        if (documents.length === 0) return
        e.preventDefault()
        const target = documents[nextDocIndex(idx, documents.length, action)]
        if (target !== undefined) setSelectedDocId(target.docVersionId)
        return
      }
      // accept / not_accept — only when the round is awaiting review and the
      // active document is known (mirrors the per-doc buttons' visibility).
      const cur = idx >= 0 ? documents[idx] : undefined
      if (!awaiting || cur === undefined || selectionMut.isPending) return
      e.preventDefault()
      selectionMut.mutate({
        docVersionId: activeDocId,
        selection: action === 'accept' ? 'accepted' : 'not_accepted',
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneCapturing, dialog, documents, activeDocId, awaiting, selectionMut])

  // RFC-090: keep the keyboard-selected document visible in the navigator.
  // block:'nearest' is a no-op when the item is already on screen, so mouse
  // clicks and the initial mount don't jank-scroll the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-doc-id="${activeDocId}"]`)
    if (el !== null && el !== undefined && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeDocId])

  if (detail.isLoading) return <LoadingState label={t('common.loading')} />
  if (detail.isError || detail.data === undefined) return <ErrorBanner error={detail.error} />

  const current = documents.find((d) => d.docVersionId === activeDocId)

  return (
    <div className="page review-multidoc">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">
            {/* Lead with the task name linked to its detail page (inline, no
                extra row — keeps the multi-doc header compact), then the review
                round's title / node id. */}
            <Link
              to="/tasks/$id"
              params={{ id: detail.data.summary.taskId }}
              className="link"
              data-testid="review-multidoc-task-link"
            >
              {detail.data.summary.taskName.length > 0
                ? detail.data.summary.taskName
                : detail.data.summary.workflowName}
            </Link>
            {' / '}
            {detail.data.summary.title || detail.data.summary.reviewNodeId}
          </h1>
          <div className="muted">
            {t('reviews.multiDoc.documents', { count: documents.length })}
          </div>
        </div>
        {awaiting && (
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              data-testid="multidoc-approve"
              disabled={!allDecided || submitDecision.isPending}
              title={
                allDecided
                  ? undefined
                  : t('reviews.multiDoc.approveBlocked', { count: documents.length - decidedCount })
              }
              onClick={() => setDialog({ kind: 'approve' })}
            >
              {t('reviews.multiDoc.approveProgress', {
                decided: decidedCount,
                total: documents.length,
              })}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={submitDecision.isPending}
              onClick={() => setDialog({ kind: 'iterate' })}
            >
              {t('reviews.iterateButton')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={submitDecision.isPending}
              onClick={() => setDialog({ kind: 'reject', reason: '', reasonError: false })}
            >
              {t('reviews.rejectButton')}
            </button>
          </div>
        )}
      </header>

      <div className="review-multidoc__body">
        <aside
          className="review-multidoc__list"
          aria-label={t('reviews.multiDoc.documents', { count: documents.length })}
        >
          <div className="review-multidoc__list-head">
            {t('reviews.multiDoc.documents', { count: documents.length })}
          </div>
          <ul role="list" ref={listRef}>
            {documents.map((d) => {
              const chip = selectionChip(d.selection)
              const active = d.docVersionId === activeDocId
              return (
                <li key={d.docVersionId}>
                  <button
                    type="button"
                    data-doc-id={d.docVersionId}
                    className={
                      'review-multidoc__doc' + (active ? ' review-multidoc__doc--active' : '')
                    }
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelectedDocId(d.docVersionId)}
                  >
                    <span className="review-multidoc__doc-title">{d.title}</span>
                    <span className="review-multidoc__doc-meta">
                      <StatusChip kind={chip.kind} size="sm">
                        {t(chip.key)}
                      </StatusChip>
                      {/* RFC-129: inherited selection whose content changed since
                          the human last judged it — advisory "已变更" badge. */}
                      {d.stale === true && (
                        <StatusChip
                          kind="warn"
                          size="sm"
                          data-testid="multidoc-stale-badge"
                          title={t('reviews.multiDoc.changedHint')}
                        >
                          {t('reviews.multiDoc.changed')}
                        </StatusChip>
                      )}
                      {d.commentCount > 0 && (
                        <span className="review-multidoc__doc-comments" aria-hidden="true">
                          💬 {d.commentCount}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        {/* Per-document accept/reject bar (multi-doc only) pinned above the
            shared <ReviewDocPane>, which renders the active doc's markdown +
            anchored comment sidebar exactly like the single-document page. */}
        <div className="review-multidoc__pane">
          {awaiting && current !== undefined && (
            <div className="review-multidoc__doc-actions">
              <button
                type="button"
                data-testid="multidoc-accept"
                title={t('reviews.multiDoc.acceptHint')}
                className={
                  'btn btn--sm' + (current.selection === 'accepted' ? ' btn--primary' : '')
                }
                disabled={selectionMut.isPending}
                onClick={() =>
                  selectionMut.mutate({ docVersionId: activeDocId, selection: 'accepted' })
                }
              >
                {t('reviews.multiDoc.accept')}
                <kbd className="kbd-shortcut" aria-hidden="true" data-testid="multidoc-accept-kbd">
                  Q
                </kbd>
              </button>
              <button
                type="button"
                data-testid="multidoc-not-accept"
                title={t('reviews.multiDoc.notAcceptHint')}
                className={
                  'btn btn--sm' + (current.selection === 'not_accepted' ? ' btn--danger' : '')
                }
                disabled={selectionMut.isPending}
                onClick={() =>
                  selectionMut.mutate({ docVersionId: activeDocId, selection: 'not_accepted' })
                }
              >
                {t('reviews.multiDoc.notAccept')}
                <kbd
                  className="kbd-shortcut"
                  aria-hidden="true"
                  data-testid="multidoc-not-accept-kbd"
                >
                  W
                </kbd>
              </button>
              <span className="muted review-multidoc__shortcut-hint">
                {t('reviews.multiDoc.shortcutHint')}
              </span>
            </div>
          )}
          {activeBody === undefined ? (
            <LoadingState label={t('common.loading')} />
          ) : (
            <ReviewDocPane
              nodeRunId={nodeRunId}
              taskId={detail.data.summary.taskId}
              docVersionId={activeDocId}
              body={activeBody}
              comments={activeComments}
              readonly={!awaiting}
              awaiting={awaiting}
              onInvalidate={invalidate}
              onShortcutCaptureChange={setPaneCapturing}
            />
          )}
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === 'reject'
            ? t('reviews.rejectDialogTitle')
            : dialog?.kind === 'iterate'
              ? t('reviews.iterateDialogTitle')
              : t('reviews.approveDialogTitle')
        }
        footer={
          <>
            <button type="button" className="btn btn--sm" onClick={() => setDialog(null)}>
              {t('reviews.dialogCancel')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => void confirmDecision()}
            >
              {t('reviews.dialogConfirm')}
            </button>
          </>
        }
      >
        {dialog?.kind === 'reject' && (
          <div className="form-field">
            <label className="form-label" htmlFor="reject-reason">
              {t('reviews.rejectReasonLabel')}
            </label>
            <TextArea
              value={dialog.reason}
              onChange={(v) => setDialog({ ...dialog, reason: v, reasonError: false })}
              rows={4}
              data-testid="multidoc-reject-reason"
            />
            {dialog.reasonError && (
              <div className="form-error">{t('reviews.rejectReasonRequired')}</div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
