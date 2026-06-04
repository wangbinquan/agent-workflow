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
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Config,
  DocVersionWithBodyAndComments,
  ReviewComment,
  ReviewDetail,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { TextArea } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ReviewDocPane } from '@/components/review/ReviewDocPane'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { useTaskSync } from '@/hooks/useTaskSync'

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

  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
    refetchInterval: 8000,
  })
  useTaskSync(detail.data?.summary.taskId ?? null)

  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
  })

  const documents = useMemo(() => detail.data?.documents ?? [], [detail.data])
  const firstDocId = detail.data?.currentVersion.id ?? ''
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
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

  if (detail.isLoading) return <LoadingState label={t('common.loading')} />
  if (detail.isError || detail.data === undefined) return <ErrorBanner error={detail.error} />

  const current = documents.find((d) => d.docVersionId === activeDocId)

  return (
    <div className="page review-multidoc">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">
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
          <ul role="list">
            {documents.map((d) => {
              const chip = selectionChip(d.selection)
              const active = d.docVersionId === activeDocId
              return (
                <li key={d.docVersionId}>
                  <button
                    type="button"
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
                className={
                  'btn btn--sm' + (current.selection === 'accepted' ? ' btn--primary' : '')
                }
                disabled={selectionMut.isPending}
                onClick={() =>
                  selectionMut.mutate({ docVersionId: activeDocId, selection: 'accepted' })
                }
              >
                {t('reviews.multiDoc.accept')}
              </button>
              <button
                type="button"
                data-testid="multidoc-not-accept"
                className={
                  'btn btn--sm' + (current.selection === 'not_accepted' ? ' btn--danger' : '')
                }
                disabled={selectionMut.isPending}
                onClick={() =>
                  selectionMut.mutate({ docVersionId: activeDocId, selection: 'not_accepted' })
                }
              >
                {t('reviews.multiDoc.notAccept')}
              </button>
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
              plantumlEndpoint={config.data?.plantumlEndpoint}
              plantumlAuthHeader={config.data?.plantumlAuthHeader}
              onInvalidate={invalidate}
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
