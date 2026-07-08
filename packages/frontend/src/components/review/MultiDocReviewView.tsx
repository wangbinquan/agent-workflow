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
//
// RFC-142: `historicalRoundKey` (?round=<key>) switches the shell into the
// read-only historical-round mode — the navigator lists THAT round's members
// (frozen selection + frozen comments via the versions endpoint), a readonly
// banner + decision info block render at the top, and every write affordance
// (round decision buttons, accept/not-accept, comment writes) is disabled.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DocVersionWithBodyAndComments,
  ReviewComment,
  ReviewDecisionKind,
  ReviewDetail,
  ReviewRoundSummary,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { goToTaskDetail } from '@/lib/nav/taskNav'
import { Dialog } from '@/components/Dialog'
import { TextArea } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ReviewDecisionInfo } from '@/components/review/ReviewDecisionInfo'
import { ReviewDocPane } from '@/components/review/ReviewDocPane'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { useTaskSync } from '@/hooks/useTaskSync'
import { useUserLookup } from '@/hooks/useUserLookup'
import { multiDocHotkeyAction, nextDocIndex } from '@/lib/review/multiDocHotkeys'
import {
  pickViewedRoundDecision,
  resolveRoundView,
  type ReviewPaneMode,
} from '@/lib/review/readonly'

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

export function MultiDocReviewView({
  nodeRunId,
  historicalRoundKey,
}: {
  nodeRunId: string
  /** RFC-142: `?round=<roundKey>` — render that round read-only. */
  historicalRoundKey?: string | undefined
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
    refetchInterval: 8000,
  })
  useTaskSync(detail.data?.summary.taskId ?? null)

  // RFC-142: rounds load only when a historical round is requested — the
  // current-round interactive view stays zero-extra-requests.
  const rounds = useQuery<ReviewRoundSummary[]>({
    queryKey: ['reviews', 'rounds', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}/rounds`, undefined, signal),
    enabled: historicalRoundKey !== undefined,
  })
  // RFC-149: `resolveRoundView` replaces the requestedRound / historicalRound /
  // historicalRoundIndex / unknownRound sentinel chain (undefined / -1 / null
  // encodings). While the rounds list is in flight the view is OPTIMISTICALLY
  // historical — the read-only shell renders with placeholder labels instead
  // of blocking on a full-page spinner (deliberate single-doc alignment).
  // `?round=` pointing at the CURRENT round still folds to `current` (the
  // interactive view; list rows send empty search for it anyway).
  const view = resolveRoundView(historicalRoundKey, rounds.data)
  const historicalMode = view.mode === 'historical'
  const historicalRound = historicalMode ? view.round : undefined
  // Unknown round key → one-shot warning + replace back to the current view,
  // mirroring RFC-013's unknown-version handling on the single-doc page.
  const unknownRound = view.mode === 'invalid' ? view.requested : null
  useEffect(() => {
    if (unknownRound === null) return
    window.alert(t('reviews.unknownRound', { id: unknownRound }))
    void navigate({ to: '/reviews/$nodeRunId', params: { nodeRunId }, search: {}, replace: true })
  }, [unknownRound, navigate, nodeRunId, t])

  const documents = useMemo(
    () => (historicalMode ? (historicalRound?.members ?? []) : (detail.data?.documents ?? [])),
    [historicalMode, historicalRound, detail.data],
  )
  const firstDocId = historicalMode
    ? (historicalRound?.members[0]?.docVersionId ?? '')
    : (detail.data?.currentVersion.id ?? '')
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [paneCapturing, setPaneCapturing] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const activeDocId = selectedDocId ?? firstDocId
  // Historical members never ride the detail payload — every doc goes through
  // the versions endpoint (decided rows return the FROZEN comment snapshot).
  const isFirst = !historicalMode && activeDocId === firstDocId

  // RFC-142: switching rounds resets the manual doc selection so the new
  // round opens on its own first member.
  useEffect(() => {
    setSelectedDocId(null)
  }, [historicalRoundKey])

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

  // RFC-149: three-state mode — 'historical' hides the round decision buttons
  // + per-doc accept bar + Q/W hotkeys and flips ReviewDocPane read-only;
  // 'decided' (current round already decided) keeps the buttons VISIBLE but
  // disabled (single-doc parity — the old `awaiting` boolean collapsed this
  // state into the hidden shape); 'awaiting' is fully interactive.
  const mode: ReviewPaneMode = historicalMode
    ? 'historical'
    : (detail.data?.summary.awaitingReview ?? false)
      ? 'awaiting'
      : 'decided'

  // RFC-142/RFC-149: decision info for the viewed round (historical) or the
  // current version's round (already-decided current view) — one picker call
  // instead of five per-field ternaries.
  const decisionSource = pickViewedRoundDecision(view, detail.data?.currentVersion)
  const deciderLookup = useUserLookup([decisionSource.decidedBy])
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
      decision: ReviewDecisionKind
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
      // active document is known (mirrors the per-doc buttons' enable state).
      const cur = idx >= 0 ? documents[idx] : undefined
      if (mode !== 'awaiting' || cur === undefined || selectionMut.isPending) return
      e.preventDefault()
      selectionMut.mutate({
        docVersionId: activeDocId,
        selection: action === 'accept' ? 'accepted' : 'not_accepted',
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneCapturing, dialog, documents, activeDocId, mode, selectionMut])

  // RFC-090: keep the keyboard-selected document visible in the navigator.
  // block:'nearest' is a no-op when the item is already on screen, so mouse
  // clicks and the initial mount don't jank-scroll the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-doc-id="${activeDocId}"]`)
    if (el !== null && el !== undefined && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeDocId])

  if (detail.isLoading) return <LoadingState />
  if (detail.isError || detail.data === undefined) return <ErrorBanner error={detail.error} />
  // RFC-149: while the rounds list loads, the historical view renders
  // OPTIMISTICALLY (read-only shell + placeholder labels + pane loading state)
  // instead of the old full-page spinner — single-doc parity. Only a rounds
  // ERROR still blocks (the list IS the historical data source).
  if (historicalRoundKey !== undefined && rounds.isError) {
    return <ErrorBanner error={rounds.error} />
  }

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
            {view.mode === 'historical' && (
              <>
                {t('reviews.roundLabel', {
                  n: view.roundIndex !== undefined ? view.roundIndex + 1 : '?',
                })}
                {' · '}
              </>
            )}
            {t('reviews.multiDoc.documents', { count: documents.length })}
          </div>
          {/* RFC-142: 决策信息块——历史轮显示该轮决策；当前视图在轮已决策时显示
              （pending 时组件自身返回 null）。 */}
          <ReviewDecisionInfo
            decision={decisionSource.decision}
            decisionReason={decisionSource.decisionReason}
            decidedAt={decisionSource.decidedAt}
            decidedBy={decisionSource.decidedBy}
            decidedByRole={decisionSource.decidedByRole ?? null}
            user={
              decisionSource.decidedBy !== null && decisionSource.decidedBy !== undefined
                ? deciderLookup.get(decisionSource.decidedBy)
                : undefined
            }
          />
        </div>
        {/* RFC-149: decided current round keeps the buttons visible but
            disabled (single-doc parity); only the historical view hides them. */}
        {mode !== 'historical' && (
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              data-testid="multidoc-approve"
              disabled={mode !== 'awaiting' || !allDecided || submitDecision.isPending}
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
              disabled={mode !== 'awaiting' || submitDecision.isPending}
              onClick={() => setDialog({ kind: 'iterate' })}
            >
              {t('reviews.iterateButton')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={mode !== 'awaiting' || submitDecision.isPending}
              onClick={() => setDialog({ kind: 'reject', reason: '', reasonError: false })}
            >
              {t('reviews.rejectButton')}
            </button>
          </div>
        )}
      </header>

      {view.mode === 'historical' && (
        <div className="readonly-banner" role="status">
          <span>
            {t('reviews.historicalRoundBanner', {
              n: view.roundIndex !== undefined ? view.roundIndex + 1 : '?',
              decision: t(`reviews.decision.${view.round?.decision ?? 'pending'}` as const),
            })}
          </span>
          <Link
            to="/reviews/$nodeRunId"
            params={{ nodeRunId }}
            search={{}}
            className="link readonly-banner__back"
          >
            {t('reviews.backToCurrentRound')}
          </Link>
        </div>
      )}

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
          {mode !== 'historical' && current !== undefined && (
            <div className="review-multidoc__doc-actions">
              <button
                type="button"
                data-testid="multidoc-accept"
                title={t('reviews.multiDoc.acceptHint')}
                className={
                  'btn btn--sm' + (current.selection === 'accepted' ? ' btn--primary' : '')
                }
                disabled={mode !== 'awaiting' || selectionMut.isPending}
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
                disabled={mode !== 'awaiting' || selectionMut.isPending}
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
            <LoadingState />
          ) : (
            <ReviewDocPane
              nodeRunId={nodeRunId}
              taskId={detail.data.summary.taskId}
              docVersionId={activeDocId}
              body={activeBody}
              comments={activeComments}
              mode={mode}
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
