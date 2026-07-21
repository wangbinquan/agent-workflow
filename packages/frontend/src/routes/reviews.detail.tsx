// /reviews/:nodeRunId — RFC-005 PR-D T27.
//
// The review detail page. Renders the current doc_version's markdown body,
// shows existing review comments in a right sidebar, lets the user select
// text + drop a comment via a popover, and surfaces the three decision
// buttons (approve / reject / iterate) along with the optimistic-lock
// review_iteration the backend will check.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate, useSearch, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DocVersionWithBodyAndComments,
  ReviewComment,
  ReviewDecisionKind,
  ReviewDetail,
} from '@agent-workflow/shared'
import type { DocVersion } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { ReviewDecisionInfo } from '@/components/review/ReviewDecisionInfo'
import { useUserLookup } from '@/hooks/useUserLookup'
import { DiffView, type DiffGranularity } from '@/components/review/DiffView'
import { Dialog } from '@/components/Dialog'
import { MultiDocReviewView } from '@/components/review/MultiDocReviewView'
import { ReviewDocPane } from '@/components/review/ReviewDocPane'
import { useTaskSync } from '@/hooks/useTaskSync'
import { listDrafts } from '@/lib/review/draftStore'
import { pickViewedVersion, resolveReviewView, type ReviewPaneMode } from '@/lib/review/readonly'
import { goToTaskDetail } from '@/lib/nav/taskNav'
import { Route as RootRoute } from './__root'

// RFC-013: optional ?version=<vid> for the read-only historical view.
// RFC-142: optional ?round=<roundKey> for the multi-doc historical-round view
// (consumed by the multi-doc branch only; single-doc keeps ?version).
// The search object must always be defined (TanStack invariant), so we
// hand back `{}` for the no-query path.
interface ReviewDetailSearch {
  version?: string
  round?: string
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/reviews/$nodeRunId',
  validateSearch: (raw: Record<string, unknown>): ReviewDetailSearch => {
    const out: ReviewDetailSearch = {}
    if (typeof raw.version === 'string' && raw.version.length > 0) out.version = raw.version
    if (typeof raw.round === 'string' && raw.round.length > 0) out.round = raw.round
    return out
  },
  component: ReviewDetailRoute,
})

// RFC-079: route-level branch. A multi-document review round
// (ReviewDetail.documents present) renders the dedicated MultiDocReviewView;
// everything else keeps the single-document ReviewDetailPage below untouched.
// Branching at the component boundary (not via conditional hooks) keeps both
// views' hook lists stable.
function ReviewDetailRoute() {
  const { nodeRunId } = Route.useParams()
  const search = useSearch({ from: Route.id }) as ReviewDetailSearch
  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
  })
  if (detail.data?.documents !== undefined && detail.data.documents.length > 0) {
    return <MultiDocReviewView nodeRunId={nodeRunId} historicalRoundKey={search.round} />
  }
  return <ReviewDetailPage />
}

function ReviewDetailPage() {
  const { nodeRunId } = Route.useParams()
  const search = useSearch({ from: Route.id }) as ReviewDetailSearch
  const navigate = useNavigate()
  const { t } = useTranslation()
  const qc = useQueryClient()

  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
    refetchInterval: 8000,
  })

  // RFC-005 PR-D T30: subscribe to /ws/tasks/{taskId} once detail resolves;
  // useTaskSync invalidates review queries on review.* events as well, so
  // the page stays live across multi-tab edits.
  useTaskSync(detail.data?.summary.taskId ?? null)

  // RFC-005 PR-E T35: diff view toggle + granularity. Default to "off"
  // (single-pane view); flipping it on loads the prior decided doc_version
  // and renders side-by-side.
  const [diffMode, setDiffMode] = useState(false)
  const [diffGranularity, setDiffGranularity] = useState<DiffGranularity>('word')

  // RFC-013: versions list is consulted for two distinct purposes — the
  // diff toggle's prior-version pick AND the read-only historical view's
  // legitimacy check (resolveReviewView falls into `invalid` only after
  // this resolves and the requested vid isn't in the list). Fire it
  // whenever either consumer needs it.
  const versions = useQuery<DocVersion[]>({
    queryKey: ['reviews', 'versions', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}/versions`, undefined, signal),
    enabled: diffMode || search.version !== undefined,
  })

  // Pick the most recent doc_version that ISN'T the current pending one as
  // the diff "left" pane. That maps to "the last rejected / iterated /
  // approved version" in the RFC's vocabulary.
  const priorVersion = useMemo<DocVersion | null>(() => {
    if (versions.data === undefined || detail.data === undefined) return null
    const currentId = detail.data.currentVersion.id
    const candidate = versions.data.find((v) => v.id !== currentId)
    return candidate ?? null
  }, [versions.data, detail.data])

  const priorBody = useQuery<DocVersionWithBodyAndComments>({
    queryKey: ['reviews', 'version-body', nodeRunId, priorVersion?.id ?? ''],
    queryFn: ({ signal }) =>
      api.get(`/api/reviews/${nodeRunId}/versions/${priorVersion?.id ?? ''}`, undefined, signal),
    enabled: diffMode && priorVersion !== null,
  })

  // RFC-013: when ?version=<vid> is present and it's not the current vid,
  // fetch that historical version's body + comments. The endpoint validates
  // nodeRunId scoping server-side; a bogus vid returns 404 which we surface
  // through the navigate-replace + toast path below.
  const view = resolveReviewView(
    search.version,
    detail.data?.currentVersion.id ?? '',
    versions.data,
  )
  const historicalVid = view.mode === 'historical' ? view.vid : null
  const historicalDetail = useQuery<DocVersionWithBodyAndComments>({
    queryKey: ['reviews', 'version-body', nodeRunId, historicalVid ?? ''],
    queryFn: ({ signal }) =>
      api.get(`/api/reviews/${nodeRunId}/versions/${historicalVid ?? ''}`, undefined, signal),
    enabled: historicalVid !== null,
  })
  // RFC-149: three-state pane mode replaces the `readonly` + `isAwaiting`
  // boolean pair — 'historical' (read-only view of an old version, write
  // affordances hidden), 'awaiting' (current version pending a decision,
  // fully writable), 'decided' (current version already decided: buttons
  // stay visible but disabled).
  const mode: ReviewPaneMode =
    view.mode === 'historical'
      ? 'historical'
      : detail.data?.summary.awaitingReview === true
        ? 'awaiting'
        : 'decided'
  // RFC-149: one picker replaces the seven per-field ternaries that each
  // switched between the historical payload and the current version — every
  // viewed-version field now changes source together.
  const viewed = pickViewedVersion(view, historicalDetail.data, detail.data?.currentVersion)

  // RFC-013: doc body + comments the page should *render* — in current
  // mode these come from the detail endpoint, in historical mode from the
  // version-detail endpoint. Memoized so the downstream `wrapAnchorsInDom`
  // effect doesn't churn its dependency on every render.
  const activeBody = useMemo<string | undefined>(() => {
    if (view.mode === 'historical') return historicalDetail.data?.body
    return detail.data?.currentBody
  }, [view.mode, historicalDetail.data, detail.data])

  const activeComments = useMemo<ReviewComment[]>(() => {
    if (view.mode === 'historical') return historicalDetail.data?.comments ?? []
    return detail.data?.comments ?? []
  }, [view.mode, historicalDetail.data, detail.data])

  // RFC-198: snapshot the translated warning BEFORE replacing an unknown
  // version. The local notice survives the canonical navigation, but a route-id
  // change/unmount clears it and the canonical URL cannot replay it on refresh
  // or Back/Forward.
  const requestedInvalid = view.mode === 'invalid' ? view.requested : null
  const [invalidVersionWarning, setInvalidVersionWarning] = useState<{
    routeId: string
    message: string
  } | null>(null)
  const handledInvalidVersionRef = useRef<string | null>(null)
  const warningRouteIdRef = useRef(nodeRunId)
  const invalidVersionMessage =
    invalidVersionWarning?.routeId === nodeRunId ? invalidVersionWarning.message : null
  useEffect(() => {
    // Skip the initial effect (including StrictMode's replay). Only a genuine
    // route-id transition expires the previous route's one-shot warning.
    if (warningRouteIdRef.current === nodeRunId) return
    warningRouteIdRef.current = nodeRunId
    handledInvalidVersionRef.current = null
    setInvalidVersionWarning(null)
  }, [nodeRunId])
  useEffect(() => {
    if (requestedInvalid === null) {
      handledInvalidVersionRef.current = null
      return
    }
    const invalidKey = `${nodeRunId}:${requestedInvalid}`
    if (handledInvalidVersionRef.current === invalidKey) return
    handledInvalidVersionRef.current = invalidKey
    setInvalidVersionWarning({
      routeId: nodeRunId,
      message: t('reviews.unknownVersion', { id: requestedInvalid }),
    })
    void navigate({
      to: '/reviews/$nodeRunId',
      params: { nodeRunId },
      search: {},
      replace: true,
    })
  }, [requestedInvalid, navigate, nodeRunId, t])

  // RFC-082: the markdown body + anchored comment sidebar + popover + comment
  // CRUD all live in <ReviewDocPane> now (shared with the multi-doc page). The
  // page keeps only what it needs to DRIVE the pane: invalidate on comment
  // writes, and a `paneCapturing` flag the pane reports so the page can suppress
  // its own single-key shortcuts (A/R/I + Ctrl+1/2/3) while the pane owns the
  // keyboard (popover open / inline-editing) — faithfully reproducing the old
  // single combined handler's `if (popover) / if (editingId) return` guards.
  const invalidateDetail = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
  }, [qc, nodeRunId])
  const [paneCapturing, setPaneCapturing] = useState(false)

  // RFC-202 T8: a decision can land while the follow-up task resume fails
  // (worktree GC'd, spawn error, …) — the backend now reports that in the
  // response's optional `resume` field. Keep the user here with a warning
  // instead of navigating away as if everything worked.
  const [resumeWarning, setResumeWarning] = useState<{ code: string } | null>(null)
  const submitDecision = useMutation({
    mutationFn: async (input: {
      decision: ReviewDecisionKind
      rejectReason?: string
      reviewIteration: number
    }) => {
      return await api.post<{ resume?: { ok: false; code: string; message: string } }>(
        `/api/reviews/${nodeRunId}/decision`,
        input,
      )
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'list'] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'pending-count'] })
      if (res.resume !== undefined && res.resume.ok === false) {
        setResumeWarning({ code: res.resume.code })
        return
      }
      // RFC-023 bugfix #8 parity (see lib/nav/taskNav): after deciding, take
      // the reviewer to the owning task's detail page so they immediately
      // see the agent resume (approve) / rerun (iterate · reject) kick off
      // via useTaskSync's review.decision_made handler — the previous
      // behavior stranded them on the review page relying on WS to mutate
      // the buttons in place, the same "did anything happen?" gap clarify
      // already closed.
      const taskId = detail.data?.summary.taskId
      if (taskId !== undefined) goToTaskDetail(qc, navigate, taskId)
    },
  })

  // RFC followup: replace browser-native confirm / prompt / alert for the
  // approve / iterate / reject buttons with a styled in-app dialog. State
  // holds the kind + any kind-specific payload (draft count for approve,
  // willRerun string for iterate / reject). `reject` also drives a
  // controlled textarea (reason). When `null`, no dialog is open.
  const [decisionDialog, setDecisionDialog] = useState<
    | null
    | { kind: 'approve'; draftCount: number; commentCount: number }
    | { kind: 'iterate'; willRerun: string; noComments: boolean }
    | { kind: 'reject'; willRerun: string; reason: string; reasonError: boolean }
  >(null)

  const onApprove = useCallback(async () => {
    if (detail.data === undefined) return
    const draftCount = (
      await listDrafts({
        taskId: detail.data.summary.taskId,
        nodeRunId,
        docVersionId: detail.data.currentVersion.id,
      })
    ).filter((d) => d.text.trim().length > 0).length
    const commentCount = detail.data.comments.length
    // Show the confirm dialog whenever the reviewer has any open
    // signal — submitted comments or unsubmitted drafts. Approving
    // silently while comments exist surprised users (they expect a
    // "are you sure?" prompt since the comments look like blockers).
    if (draftCount > 0 || commentCount > 0) {
      setDecisionDialog({ kind: 'approve', draftCount, commentCount })
      return
    }
    await submitDecision.mutateAsync({
      decision: 'approved',
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, nodeRunId, submitDecision])

  const onReject = useCallback(() => {
    if (detail.data === undefined) return
    // Fallback mirrors `onIterate` below: when rerunnableOnReject is empty,
    // services/review.ts still adds dv.sourceNodeId into the rerun set
    // ("direct upstream always rerunnable, regardless of config" — see
    // review.ts:1315 + workflow-validator.test.ts "rerunnableOnReject
    // empty does NOT emit `review-rerunnable-empty-on-reject`"). Showing
    // "(none)" here told users nothing would re-run, which was a lie.
    const willRerun = detail.data.rerunnableOnReject.join(', ') || t('reviews.rerunDirectUpstream')
    setDecisionDialog({ kind: 'reject', willRerun, reason: '', reasonError: false })
  }, [detail.data, t])

  const onIterate = useCallback(() => {
    if (detail.data === undefined) return
    const willRerun = detail.data.rerunnableOnIterate.join(', ') || t('reviews.rerunDirectUpstream')
    setDecisionDialog({
      kind: 'iterate',
      willRerun,
      noComments: detail.data.comments.length === 0,
    })
  }, [detail.data, t])

  const confirmDecisionDialog = useCallback(async () => {
    if (decisionDialog === null || detail.data === undefined) return
    if (decisionDialog.kind === 'approve') {
      setDecisionDialog(null)
      await submitDecision.mutateAsync({
        decision: 'approved',
        reviewIteration: detail.data.summary.reviewIteration,
      })
      return
    }
    if (decisionDialog.kind === 'iterate') {
      setDecisionDialog(null)
      await submitDecision.mutateAsync({
        decision: 'iterated',
        reviewIteration: detail.data.summary.reviewIteration,
      })
      return
    }
    // reject — require a non-empty trimmed reason.
    const trimmed = decisionDialog.reason.trim()
    if (trimmed.length === 0) {
      setDecisionDialog({ ...decisionDialog, reasonError: true })
      return
    }
    setDecisionDialog(null)
    await submitDecision.mutateAsync({
      decision: 'rejected',
      rejectReason: trimmed,
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [decisionDialog, detail.data, submitDecision])

  // Keyboard shortcuts: A/R/I decisions + Ctrl/Cmd+1/2/3 diff granularity.
  // J/K (cross-comment jump) and Esc-closes-popover moved into
  // <ReviewDocPane> with the comment machinery; `paneCapturing` (reported by
  // the pane while its popover is open or a comment is being inline-edited)
  // stands in for the old `if (popover) / if (editingId) return` guards so
  // A/R/I never fire mid-comment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === 'historical') return
      if (paneCapturing) return
      // Don't hijack typing inside form fields.
      if (
        document.activeElement !== null &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return
      }
      // Granularity hotkeys: Ctrl/Cmd+1/2/3 cycle word/line/block when diff
      // is on. Don't run when modifiers aren't set so plain "1/2/3" still
      // types into focused fields.
      if (diffMode && (e.ctrlKey || e.metaKey)) {
        if (e.key === '1') {
          e.preventDefault()
          setDiffGranularity('word')
          return
        }
        if (e.key === '2') {
          e.preventDefault()
          setDiffGranularity('line')
          return
        }
        if (e.key === '3') {
          e.preventDefault()
          setDiffGranularity('block')
          return
        }
      }
      // Plain A/R/I are intentionally single-key actions. Never let browser
      // or OS chords such as Cmd+A (select all) submit an irreversible review
      // decision as a side effect.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'a') void onApprove()
      else if (k === 'r') void onReject()
      else if (k === 'i') void onIterate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneCapturing, onApprove, onReject, onIterate, diffMode, mode])

  // RFC-099 (D7) — resolve the decider id for the attribution chip. Hook must
  // sit above the early returns; tolerant of undefined while loading.
  const deciderLookup = useUserLookup([viewed.decidedBy])

  if (detail.data === undefined) {
    return (
      <div className="page review-detail page--review-detail">
        <PageHeader title={nodeRunId} />
        {detail.error !== null && detail.error !== undefined ? (
          <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <LoadingState />
        )}
      </div>
    )
  }

  const data = detail.data
  // RFC-013: in the historical mode, decision buttons are not in the DOM,
  // comment write affordances are hidden, and the diff toggle is hidden.
  // 'awaiting' vs 'decided' drives the current-mode button enable state.
  // The "viewing version vN" label in the header (and the whole decision
  // info block) reads `viewed` — the RFC-149 one-shot picker that switches
  // every field between the historical payload and the current version.
  const hasTitle = data.summary.title !== '' && data.summary.title !== data.summary.reviewNodeId

  // Download the markdown body the user is currently viewing (current or
  // historical version) as a `.md` file. Filename combines a sanitized title
  // (or the review node id when the user didn't set a title) with the
  // version index — gives a useful name when the user accumulates several
  // versions of the same review in their downloads folder. Sanitization
  // strips characters that POSIX / Windows refuse in filenames so the click
  // never silently fails on edge cases like "user/auth: design".
  const downloadDisabled = activeBody === undefined || activeBody.length === 0
  const downloadFileName = (() => {
    const base = (hasTitle ? data.summary.title : data.summary.reviewNodeId)
      .replace(/[\\/:*?"<>|\n\r\t]+/g, '_')
      .replace(/\s+/g, '_')
      .trim()
    const safeBase = base.length > 0 ? base : 'document'
    return `${safeBase}-v${viewed.versionIndex ?? data.currentVersion.versionIndex}.md`
  })()
  const handleDownloadMarkdown = (): void => {
    if (activeBody === undefined || activeBody.length === 0) return
    const blob = new Blob([activeBody], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = downloadFileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const queryError = (error: unknown, refetch: () => unknown, testId: string) => (
    <div data-testid={testId}>
      <ErrorBanner error={error} onRetry={() => void refetch()} />
    </div>
  )

  // Auxiliary version queries own the body slot while their requested view is
  // unresolved. This prevents a selected diff / historical view from silently
  // falling back to the current document and looking successful. Once cached
  // auxiliary data exists, the normal pane stays mounted and a stale error is
  // surfaced separately below.
  const auxiliaryBodySlot = (() => {
    if (mode === 'historical') {
      if (historicalDetail.data !== undefined) return undefined
      if (historicalDetail.error !== null && historicalDetail.error !== undefined) {
        return queryError(
          historicalDetail.error,
          historicalDetail.refetch,
          'review-historical-body-error',
        )
      }
      return <LoadingState size="compact" />
    }

    if (!diffMode) return undefined
    if (versions.data === undefined) {
      if (versions.error !== null && versions.error !== undefined) {
        return queryError(versions.error, versions.refetch, 'review-diff-versions-error')
      }
      return <LoadingState size="compact" />
    }
    if (priorVersion === null) return undefined
    if (priorBody.data === undefined) {
      if (priorBody.error !== null && priorBody.error !== undefined) {
        return queryError(priorBody.error, priorBody.refetch, 'review-diff-body-error')
      }
      return <LoadingState size="compact" />
    }
    return (
      <DiffView
        left={priorBody.data.body}
        right={data.currentBody}
        granularity={diffGranularity}
        leftLabel={t('reviews.diffLeftLabel', {
          version: priorVersion.versionIndex,
          decision: priorVersion.decision ?? t('reviews.decision.pending'),
        })}
        rightLabel={t('reviews.diffRightLabel', {
          version: data.currentVersion.versionIndex,
        })}
      />
    )
  })()

  return (
    <div className="page review-detail page--review-detail">
      <PageHeader
        className="review-detail__page-header"
        title={
          <>
            {/* RFC-037: lead with the user-supplied task name, linked to the owning task
                detail page; workflow name + review node title stay as muted metadata. */}
            <Link
              to="/tasks/$id"
              params={{ id: data.summary.taskId }}
              className="link"
              data-testid="review-detail-task-link"
            >
              {data.summary.taskName.length > 0 ? data.summary.taskName : data.summary.workflowName}
            </Link>
            {' / '}
            {hasTitle ? data.summary.title : <code>{data.summary.reviewNodeId}</code>}
            <span className="muted">
              {' '}
              · v{viewed.versionIndex ?? data.currentVersion.versionIndex}
            </span>
          </>
        }
        meta={
          <div className="review-detail__breadcrumbs">
            <span>{data.summary.workflowName}</span>
            {hasTitle && (
              <>
                {' · '}
                <code>{data.summary.reviewNodeId}</code>
              </>
            )}
          </div>
        }
        actions={
          <div className="review-detail__page-header-actions">
            <button
              type="button"
              className="btn btn--sm review-detail__download"
              disabled={downloadDisabled}
              onClick={handleDownloadMarkdown}
              title={t('reviews.downloadMarkdownTitle', { filename: downloadFileName })}
            >
              <span aria-hidden="true" className="review-detail__download-icon">
                ↓
              </span>
              {t('reviews.downloadMarkdown')}
            </button>
            {mode !== 'historical' && (
              <div
                className="review-detail__decision-actions"
                role="group"
                aria-label={t('reviews.decisionActionsAria')}
              >
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={mode !== 'awaiting' || submitDecision.isPending}
                  onClick={() => void onApprove()}
                >
                  {t('reviews.approveButton')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={mode !== 'awaiting' || submitDecision.isPending}
                  onClick={() => onIterate()}
                >
                  {t('reviews.iterateButton')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  disabled={mode !== 'awaiting' || submitDecision.isPending}
                  onClick={() => onReject()}
                >
                  {t('reviews.rejectButton')}
                </button>
              </div>
            )}
          </div>
        }
      >
        {data.summary.description !== '' && data.summary.description !== data.summary.title && (
          <p className="page__hint review-detail__description">{data.summary.description}</p>
        )}
        {/* RFC-142: 决策信息块——决策 chip + 决策人 + 时间 + 退回原因/系统作废
              说明（替换 RFC-099 只有决策人 chip 的旧行；superseded 的系统行
              不再整体隐藏）。 */}
        <ReviewDecisionInfo
          decision={viewed.decision}
          decisionReason={viewed.decisionReason}
          decidedAt={viewed.decidedAt}
          decidedBy={viewed.decidedBy}
          decidedByRole={viewed.decidedByRole ?? null}
          user={
            viewed.decidedBy !== null && viewed.decidedBy !== undefined
              ? deciderLookup.get(viewed.decidedBy)
              : undefined
          }
          data-testid="review-decider"
        />
        {mode !== 'historical' && (
          <p className="page__hint">
            {t('reviews.detailHint', {
              iteration: data.summary.reviewIteration,
              decision: data.currentVersion.decision,
            })}
          </p>
        )}
      </PageHeader>

      {invalidVersionMessage !== null && (
        <div data-testid="review-invalid-version-warning">
          <NoticeBanner
            tone="warning"
            action={
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setInvalidVersionWarning(null)}
              >
                {t('common.close')}
              </button>
            }
          >
            {invalidVersionMessage}
          </NoticeBanner>
        </div>
      )}

      {detail.error !== null && detail.error !== undefined && (
        <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
      )}

      {/* Historical bodies can still be usable while version-list validation
          refreshes fail. Keep that cached body visible and expose the failed
          list refresh independently. In diff mode an initial list error lives
          inside auxiliaryBodySlot so the current prose cannot masquerade as a
          successful diff. */}
      {versions.error !== null &&
        versions.error !== undefined &&
        (versions.data !== undefined || mode === 'historical') &&
        queryError(versions.error, versions.refetch, 'review-versions-error')}
      {historicalDetail.data !== undefined &&
        historicalDetail.error !== null &&
        historicalDetail.error !== undefined &&
        queryError(
          historicalDetail.error,
          historicalDetail.refetch,
          'review-historical-body-stale-error',
        )}
      {priorBody.data !== undefined &&
        priorBody.error !== null &&
        priorBody.error !== undefined &&
        queryError(priorBody.error, priorBody.refetch, 'review-diff-body-stale-error')}

      {mode === 'historical' && (
        <div className="readonly-banner" role="status">
          <span>
            {t('reviews.historicalBanner', {
              version: viewed.versionIndex ?? '?',
              decision: viewed.decision ?? t('reviews.decision.pending'),
            })}
          </span>
          <Link
            to="/reviews/$nodeRunId"
            params={{ nodeRunId }}
            search={{}}
            className="link readonly-banner__back"
          >
            {t('reviews.backToCurrent')}
          </Link>
        </div>
      )}

      {mode !== 'historical' && data.currentVersion.versionIndex > 1 && (
        <div className="review-detail__diff-toolbar">
          {/* RFC-010 follow-up：把"勾选框 + 三按钮"合并成一个 4 段 pill
              segmented control。选 "原文" 等价于关闭 diff 模式；其它三段
              等价于开启 diff + 设置 granularity。视觉更紧凑、状态更明确，
              用户少一次"先勾选才出现按钮"的两步操作。 */}
          <Segmented<'off' | DiffGranularity>
            className="diff-mode-segmented"
            options={(['off', 'word', 'line', 'block'] as const).map((m) => ({
              value: m,
              label:
                m === 'off'
                  ? t('reviews.diffOff')
                  : t(`reviews.diffGranularity${m.charAt(0).toUpperCase()}${m.slice(1)}` as const),
            }))}
            value={diffMode ? diffGranularity : 'off'}
            onChange={(mode) => {
              if (mode === 'off') {
                setDiffMode(false)
              } else {
                setDiffMode(true)
                setDiffGranularity(mode)
              }
            }}
            ariaLabel={t('reviews.diffToggle')}
          />
        </div>
      )}

      <ReviewDocPane
        nodeRunId={nodeRunId}
        taskId={data.summary.taskId}
        docVersionId={historicalVid ?? data.currentVersion.id}
        body={activeBody ?? ''}
        comments={activeComments}
        mode={mode}
        onInvalidate={invalidateDetail}
        onShortcutCaptureChange={setPaneCapturing}
        diffMode={diffMode}
        bodySlot={auxiliaryBodySlot}
      />

      {mode !== 'historical' &&
        submitDecision.error !== null &&
        submitDecision.error !== undefined && (
          <div className="review-detail__error">
            <ErrorBanner error={submitDecision.error} />
          </div>
        )}

      {resumeWarning !== null && (
        <div className="review-detail__error">
          <NoticeBanner tone="warning" size="compact" className="review-resume-failed">
            {t('common.resumeFailedAfterSubmit', { code: resumeWarning.code })}
          </NoticeBanner>
        </div>
      )}

      {mode !== 'historical' && decisionDialog !== null && (
        <DecisionDialog
          state={decisionDialog}
          onChange={setDecisionDialog}
          onConfirm={() => void confirmDecisionDialog()}
          onCancel={() => setDecisionDialog(null)}
          submitting={submitDecision.isPending}
        />
      )}
    </div>
  )
}

// In-app dialog for the three decision buttons. The styled, accessible modal
// keeps approve / iterate / reject out of native browser dialogs. Reject
// carries a controlled textarea + inline reason-required hint; approve and
// iterate are pure confirms with kind-specific copy.
type DecisionDialogState =
  | { kind: 'approve'; draftCount: number; commentCount: number }
  | { kind: 'iterate'; willRerun: string; noComments: boolean }
  | { kind: 'reject'; willRerun: string; reason: string; reasonError: boolean }

function DecisionDialog({
  state,
  onChange,
  onConfirm,
  onCancel,
  submitting,
}: {
  state: DecisionDialogState
  onChange: (next: DecisionDialogState) => void
  onConfirm: () => void
  onCancel: () => void
  submitting: boolean
}) {
  const { t } = useTranslation()

  const title =
    state.kind === 'approve'
      ? t('reviews.approveDialogTitle')
      : state.kind === 'iterate'
        ? t('reviews.iterateDialogTitle')
        : t('reviews.rejectDialogTitle')

  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      size="sm"
      data-testid="review-decision-dialog"
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            {t('reviews.dialogCancel')}
          </button>
          <button
            type="button"
            className={'btn btn--sm ' + (state.kind === 'reject' ? 'btn--danger' : 'btn--primary')}
            disabled={submitting}
            onClick={onConfirm}
          >
            {t('reviews.dialogConfirm')}
          </button>
        </>
      }
    >
      {state.kind === 'approve' && (
        <>
          {state.commentCount > 0 && (
            <p>{t('reviews.approveCommentWarning', { count: state.commentCount })}</p>
          )}
          {state.draftCount > 0 && (
            <p>{t('reviews.approveDraftWarning', { count: state.draftCount })}</p>
          )}
          <p>{t('reviews.approveDraftConfirm')}</p>
        </>
      )}
      {state.kind === 'iterate' && (
        <>
          {state.noComments && (
            <p className="review-decision-dialog__warn">{t('reviews.iterateNoCommentsWarning')}</p>
          )}
          <p>{t('reviews.iterateConfirm', { willRerun: state.willRerun })}</p>
        </>
      )}
      {state.kind === 'reject' && (
        <>
          <p>{t('reviews.rejectPrompt', { willRerun: state.willRerun })}</p>
          <label className="review-decision-dialog__label">
            {t('reviews.rejectReasonLabel')}
            <TextArea
              className="review-decision-dialog__textarea"
              autoFocus
              rows={4}
              value={state.reason}
              onChange={(reason) => onChange({ ...state, reason, reasonError: false })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  onConfirm()
                }
              }}
            />
          </label>
          {state.reasonError && (
            <p className="review-decision-dialog__error">{t('reviews.rejectReasonRequired')}</p>
          )}
        </>
      )}
    </Dialog>
  )
}
