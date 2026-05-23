// /clarify/$nodeRunId — RFC-023 PR-C T23.
//
// Detail page for one clarify session. Renders:
//   1. Context card (asking agent · iteration · shard if any).
//   2. Truncation warning bar (when the agent over-emitted).
//   3. Shard switcher (only when the same task + clarifyNodeId has ≥ 2
//      awaiting_human sessions across different sourceShardKeys).
//   4. QuestionForm list (each question gets its own QuestionForm; answers
//      flow through local state with debounce-to-IDB draft persistence).
//   5. Submit button + draft saving indicator.
//   6. History rows (other answered sessions for the same agent+clarify
//      pair) underneath, read-only.
//
// The session is fetched via `GET /api/clarify/:nodeRunId`. The peer
// awaiting sessions for the shard switcher come from
// `GET /api/clarify?status=awaiting_human&taskId=…`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ClarifyAnswer,
  ClarifyDirective,
  ClarifyRound,
  ClarifyRoundSummary,
  SubmitClarifyAnswersResponse,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { QuestionForm, type QuestionFormHandle } from '@/components/clarify/QuestionForm'
import { Dialog } from '@/components/Dialog'
import { useClarifyWs } from '@/hooks/useClarifyWs'
import { deleteClarifyDraft, getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'
import { Route as RootRoute } from './__root'

/** RFC-058: REST returns a single ClarifyRound shape with `kind` discriminator. */
type ClarifyDetailEntry = ClarifyRound

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/clarify/$nodeRunId',
  component: ClarifyDetailPage,
})

const DRAFT_DEBOUNCE_MS = 500

export function ClarifyDetailPage() {
  const { t } = useTranslation()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeRunId = (Route as any).useParams().nodeRunId as string
  const qc = useQueryClient()
  const navigate = useNavigate()

  const session = useQuery<ClarifyDetailEntry>({
    queryKey: ['clarify', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get<ClarifyRound>(`/api/clarify/${nodeRunId}`, undefined, signal),
    refetchOnWindowFocus: false,
  })

  // RFC-037: fetch the host task once we know the taskId so the header can
  // render the user-supplied task name as a breadcrumb. Cheap because tasks
  // detail is already React-Query-cached if the user came from /tasks.
  const taskQuery = useQuery<{ name: string }>({
    queryKey: ['tasks', session.data?.taskId, 'name-only'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${session.data?.taskId}`, undefined, signal) as Promise<{ name: string }>,
    enabled: typeof session.data?.taskId === 'string',
    refetchOnWindowFocus: false,
  })

  // Subscribe to the host task's WS channel for clarify.* events so
  // sibling tabs picking up the same session see a real-time re-fetch
  // when the other tab submits.
  useClarifyWs({
    taskId: session.data?.taskId ?? null,
    intermediaryNodeRunId: nodeRunId,
  })

  // ----------------------------------------------------------------------
  // local answer state — seeded from session.questions, then overwritten
  // by IDB draft if one exists for this (taskId, nodeRunId, sessionId).
  // ----------------------------------------------------------------------

  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({})
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // RFC-051: `initialFocusedRef` is declared up here (alongside the other
  // session-scoped refs) instead of further down with the keyboard-nav
  // refs, because the reset-on-nodeRunId effect right below needs to
  // clear it. Same-route nav between two clarify sessions reuses this
  // component, so per-session refs must be reachable by the reset.
  const initialFocusedRef = useRef(false)

  // RFC-051: same-route navigation between two clarify sessions (e.g.
  // clicking through the inbox queue from session A's nodeRunId to
  // session B's) keeps this ClarifyDetailPage mounted — TanStack Router
  // reuses the component when only the path param changes. Without
  // resetting on `nodeRunId` flip, the one-shot `draftLoaded` flag blocks
  // the seeding effect below from re-running, and the `answers` map
  // keeps stale `question.id` keys from the previous session. The
  // questions-list render then maps the *new* session's questions through
  // the *old* dictionary, every lookup returns `undefined`, the
  // `if (a === undefined) return null` branch fires for every question,
  // and the user sees an empty form (the user-reported bug).
  //
  // We reset state here rather than putting `key={nodeRunId}` on the
  // route component because the surrounding `useClarifyWs` hook prefers
  // a stable mount — remounting tears down + reconnects the WS for the
  // same taskId on every clarify swap, which is wasteful and racy.
  useEffect(() => {
    setAnswers({})
    setDraftLoaded(false)
    initialFocusedRef.current = false
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
  }, [nodeRunId])

  useEffect(() => {
    const s = session.data
    if (s === undefined || draftLoaded) return
    const fresh: Record<string, ClarifyAnswer> = {}
    for (const q of s.questions) {
      fresh[q.id] = {
        questionId: q.id,
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
      }
    }
    // RFC-023 bugfix #5 — when this session has already been sealed
    // (status != 'awaiting_human' → 'answered' or 'canceled'), pre-fill
    // the form with the submitted answers so the history view shows what
    // the user actually picked. Without this, opening a past session
    // renders an empty form which (a) misrepresents what was answered and
    // (b) is unreviewable.
    if (s.status !== 'awaiting_human' && Array.isArray(s.answers)) {
      for (const a of s.answers) {
        if (fresh[a.questionId] !== undefined) fresh[a.questionId] = a
      }
      // Sealed sessions never reload from IDB drafts — the answer is what
      // got persisted server-side. Mark loaded immediately and skip the
      // draft restore branch below.
      setAnswers(fresh)
      setDraftLoaded(true)
      return
    }
    // Try to restore the IDB draft (if any) for this session.
    const key = {
      taskId: s.taskId,
      intermediaryNodeRunId: s.intermediaryNodeRunId,
      roundId: s.id,
    }
    getClarifyDraft(key)
      .then((stored) => {
        if (stored !== null) {
          for (const a of stored) {
            if (fresh[a.questionId] !== undefined) fresh[a.questionId] = a
          }
        }
      })
      .finally(() => {
        setAnswers(fresh)
        setDraftLoaded(true)
      })
  }, [draftLoaded, session.data])

  // Debounced IDB write.
  useEffect(() => {
    const s = session.data
    if (s === undefined || !draftLoaded) return
    if (s.status !== 'awaiting_human') return
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    setDraftSaving(true)
    draftTimerRef.current = setTimeout(() => {
      const arr = s.questions.map(
        (q) =>
          answers[q.id] ?? {
            questionId: q.id,
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: '',
          },
      )
      void setClarifyDraft(
        { taskId: s.taskId, intermediaryNodeRunId: s.intermediaryNodeRunId, roundId: s.id },
        arr,
      ).finally(() => setDraftSaving(false))
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    }
  }, [answers, draftLoaded, session.data])

  // ----------------------------------------------------------------------
  // RFC-023 shard switcher — peer awaiting_human sessions for the same task +
  // clarifyNodeId. Only renders when there are ≥ 2 in scope.
  // RFC-056 multi-source banner — peer awaiting_human CROSS-clarify sessions
  // for the same task pointing at the same designer. Reuses the same /api/clarify
  // list endpoint (mixed self+cross) and filters client-side.
  // ----------------------------------------------------------------------

  const peerScopeTaskId = session.data?.taskId
  const peers = useQuery<ClarifyRoundSummary[]>({
    queryKey: ['clarify', 'peers', peerScopeTaskId],
    queryFn: ({ signal }) => {
      const taskId = peerScopeTaskId ?? ''
      return api.get<ClarifyRoundSummary[]>(
        `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        undefined,
        signal,
      )
    },
    enabled: session.data !== undefined,
    refetchInterval: 10000,
  })

  // RFC-058: same task + same intermediary (clarify) node has ≥ 2 awaiting
  // shards → render the shard switcher.
  const shardPeers = useMemo(() => {
    if (session.data === undefined || session.data.kind !== 'self') return []
    const me = session.data
    const list = (peers.data ?? []).filter(
      (p) => p.kind === 'self' && p.intermediaryNodeId === me.intermediaryNodeId,
    )
    if (list.length < 2) return []
    return [...list].sort((a, b) => (a.askingShardKey ?? '').localeCompare(b.askingShardKey ?? ''))
  }, [peers.data, session.data])

  /** RFC-058: cross-clarify peers — awaiting cross rounds targeting the
   *  same designer. Used to render the multi-source waiting banner after
   *  the user submits THIS cross-clarify but ≥ 1 sibling is still awaiting. */
  const crossPeers = useMemo(() => {
    if (session.data === undefined || session.data.kind !== 'cross') return []
    const me = session.data
    if (me.targetConsumerNodeId === null) return []
    return (peers.data ?? []).filter(
      (p) =>
        p.kind === 'cross' &&
        p.intermediaryNodeRunId !== me.intermediaryNodeRunId &&
        p.targetConsumerNodeId === me.targetConsumerNodeId &&
        p.status === 'awaiting_human',
    )
  }, [peers.data, session.data])

  // ----------------------------------------------------------------------
  // submit
  // ----------------------------------------------------------------------

  // RFC-056: when the cross-clarify submit lands but the multi-source
  // readiness scan is still waiting on siblings, the server returns
  // outcome.kind='designer-waiting' with the pending nodeIds. We stash that
  // here so the banner renders even after navigation back to this page (the
  // list refetch fills in the data otherwise). For self-clarify this stays
  // false and the legacy redirect-to-task-detail behavior is preserved.
  const [crossWaiting, setCrossWaiting] = useState<{ pending: string[] } | null>(null)

  const submitMut = useMutation<SubmitClarifyAnswersResponse, Error, ClarifyDirective>({
    mutationFn: async (directive) => {
      const s = session.data
      if (s === undefined) throw new Error('no session loaded')
      const arr = s.questions.map(
        (q) =>
          answers[q.id] ?? {
            questionId: q.id,
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: '',
          },
      )
      const resp = await api.post<SubmitClarifyAnswersResponse>(
        `/api/clarify/${s.intermediaryNodeRunId}/answers`,
        { answers: arr, ifMatchIteration: s.iteration, directive },
      )
      // Clear the IDB draft; the answer is committed server-side.
      await deleteClarifyDraft({
        taskId: s.taskId,
        intermediaryNodeRunId: s.intermediaryNodeRunId,
        roundId: s.id,
      })
      return resp
    },
    onSuccess: (resp) => {
      void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
      // RFC-056: cross-clarify "designer-waiting" outcome — stay on the
      // page and surface the multi-source banner; don't navigate away.
      // The waiting banner tells the user another cross-clarify is still
      // open and the designer rerun is pending the batch.
      const respMaybeCross = resp as unknown as {
        kind?: string
        outcome?: { kind: string; pendingCrossClarifyNodeIds?: string[] }
      }
      if (respMaybeCross.kind === 'cross' && respMaybeCross.outcome?.kind === 'designer-waiting') {
        setCrossWaiting({
          pending: respMaybeCross.outcome.pendingCrossClarifyNodeIds ?? [],
        })
        void qc.invalidateQueries({ queryKey: ['clarify', 'detail', nodeRunId] })
        return
      }
      // RFC-023 bugfix #8 — after answering, take the user to the task
      // detail page so they immediately see the agent re-run kick off
      // (via the WS `clarify.answered` → node-runs invalidation in
      // useTaskSync). The previous behavior navigated to /clarify (the
      // list page), which had NO live WS sync, so users believed "nothing
      // happened" until they manually opened the task. Also invalidate
      // the task's queries upfront in case WS is delayed/dropped.
      const taskId = session.data?.taskId
      if (taskId !== undefined) {
        void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
        void navigate({ to: '/tasks/$id', params: { id: taskId } })
      } else {
        void navigate({ to: '/clarify' })
      }
    },
  })

  // RFC-056: confirm modal state for the cross-clarify Reject button. Modal
  // opens on Reject click; user must explicitly confirm to fire the 'stop'
  // directive. Cancel returns to the form unchanged.
  const [rejectModalOpen, setRejectModalOpen] = useState(false)

  // RFC-023 iter #2: the per-question `recommended` flag was deprecated when
  // "recommended" moved to the option level. All questions are now optional
  // to answer (the submit button is always enabled in awaiting_human mode).
  // Keep the variable so the JSX hint can simply not render.
  const requiredMissing = false

  // ----------------------------------------------------------------------
  // Keyboard navigation between questions. The reviewer ergonomics flow:
  //   1. On mount (after draft / sealed answers loaded), focus the first
  //      *unanswered* question so digit / Enter hotkeys work without a click.
  //   2. Each QuestionForm calls `onAdvance` after Enter or a single-choice
  //      digit pick → we focus the next QuestionForm; on the last question
  //      we focus the submit button so a follow-up Enter actually submits.
  // ----------------------------------------------------------------------
  const questionRefs = useRef<Map<string, QuestionFormHandle | null>>(new Map())
  // Two submit buttons now (RFC-023 directive iteration): the primary
  // "submit & keep clarifying" gets keyboard focus after the last question's
  // Enter, matching the "continue is default" semantics. Users who actually
  // want to stop can tab once or click the secondary button.
  const submitContinueRef = useRef<HTMLButtonElement | null>(null)
  // `initialFocusedRef` is declared near the top of the component
  // (RFC-051) so the reset-on-nodeRunId effect can reach it.

  function isAnswerEmpty(a: ClarifyAnswer | undefined): boolean {
    if (a === undefined) return true
    return a.selectedOptionIndices.length === 0 && a.customText.length === 0
  }

  const advanceFromQuestion = (currentId: string) => {
    const qs = session.data?.questions ?? []
    const idx = qs.findIndex((q) => q.id === currentId)
    if (idx === -1) return
    const next = qs[idx + 1]
    if (next !== undefined) {
      questionRefs.current.get(next.id)?.focus()
    } else {
      submitContinueRef.current?.focus()
    }
  }

  useEffect(() => {
    if (!draftLoaded || initialFocusedRef.current) return
    const s = session.data
    if (s === undefined) return
    if (s.status !== 'awaiting_human') return
    const firstUnanswered = s.questions.find((q) => isAnswerEmpty(answers[q.id]))
    const target = firstUnanswered ?? s.questions[0]
    if (target === undefined) return
    // rAF defers focus until after the QuestionForms have mounted + their
    // refs settled (the ref callbacks fire during the same commit).
    requestAnimationFrame(() => {
      questionRefs.current.get(target.id)?.focus()
      initialFocusedRef.current = true
    })
  }, [answers, draftLoaded, session.data])

  // ----------------------------------------------------------------------
  // render
  // ----------------------------------------------------------------------

  if (session.isLoading) {
    return <div className="page muted">{t('common.loading')}</div>
  }
  if (session.error !== null && session.error !== undefined) {
    return <div className="page error-box">{(session.error as Error).message}</div>
  }
  const s = session.data
  if (s === undefined) return null

  const readonly = s.status !== 'awaiting_human'
  // RFC-058: ClarifyRound unified — intermediary == clarify / clarify-cross
  // node, asking == source agent / questioner, iteration == round counter.
  const nodeId = s.intermediaryNodeId
  const nodeTitle =
    typeof s.intermediaryNodeTitle === 'string' &&
    s.intermediaryNodeTitle.length > 0 &&
    s.intermediaryNodeTitle !== s.intermediaryNodeId
      ? s.intermediaryNodeTitle
      : null
  const sourceName = s.askingNodeId
  const iteration = s.iteration
  const shardKey = s.kind === 'cross' ? null : s.askingShardKey
  const truncationWarnings = s.kind === 'self' ? s.truncationWarnings : undefined
  const isCross = s.kind === 'cross'

  return (
    <div
      className="page"
      data-testid="clarify-detail-page"
      data-status={s.status}
      data-kind={s.kind}
    >
      <header className="page__header">
        <Link to="/clarify" className="link">
          {t('clarify.detail.back')}
        </Link>
        {/* RFC-037 + follow-up: lead with the user-supplied task name (when
            loaded), then the clarify node title (workflowSnapshot's
            `WorkflowNode.title`) with a fall-back to the clarify node id —
            same pattern as the review detail page so the two surfaces read
            identically. RFC-056: cross-clarify doesn't expose nodeTitle, so
            the label is just the cross-clarify nodeId. */}
        <h1>
          {(() => {
            const nodeLabel = nodeTitle ?? nodeId
            const hasTaskName =
              typeof taskQuery.data?.name === 'string' && taskQuery.data.name.length > 0
            return hasTaskName ? `${taskQuery.data!.name} / ${nodeLabel}` : nodeLabel
          })()}
        </h1>
        {taskQuery.data?.name && taskQuery.data.name.length > 0 && (
          <div className="muted" data-testid="clarify-detail-task-name">
            <Link to="/tasks/$id" params={{ id: s.taskId }} className="link">
              {t('clarify.taskNameLabel')}: {taskQuery.data.name}
            </Link>
          </div>
        )}
        <p className="page__hint" data-testid="clarify-context-card">
          {isCross
            ? t('crossClarify.contextCard', { name: sourceName, n: iteration })
            : t('clarify.detail.contextCard', { name: sourceName, n: iteration })}
          {isCross && s.targetConsumerNodeId !== null && (
            <>
              {' · '}
              <span data-testid="cross-clarify-target-designer">
                {t('crossClarify.targetDesigner', { name: s.targetConsumerNodeId })}
              </span>
            </>
          )}
          {!isCross && shardKey !== null && (
            <>
              {' · '}
              <span data-testid="clarify-context-shard">
                {t('clarify.detail.contextCardShard', { shard: shardKey })}
              </span>
            </>
          )}
        </p>
      </header>

      {truncationWarnings !== undefined && truncationWarnings.length > 0 && (
        <div className="error-box" data-testid="clarify-truncation-warning">
          {truncationWarnings.map((w) => (
            <div key={w.code}>
              [{w.code}] {w.detail}
            </div>
          ))}
        </div>
      )}

      {!isCross && shardPeers.length > 0 && (
        <section className="clarify-shard-switcher" data-testid="clarify-shard-switcher">
          <span className="muted">{t('clarify.detail.shardSwitcherLabel')}:</span>{' '}
          {shardPeers.map((p) => (
            <Link
              key={p.id}
              to="/clarify/$nodeRunId"
              params={{ nodeRunId: p.intermediaryNodeRunId }}
              className={
                'tabs__tab' +
                (p.intermediaryNodeRunId === s.intermediaryNodeRunId ? ' tabs__tab--active' : '')
              }
              data-shard-key={p.askingShardKey ?? ''}
              data-testid={`clarify-shard-${p.askingShardKey ?? 'main'}`}
            >
              {p.askingShardKey ?? '—'}
            </Link>
          ))}
        </section>
      )}

      {/* RFC-056: multi-source waiting banner — appears after this
          cross-clarify has been answered but sibling cross-clarify nodes
          targeting the same designer are still awaiting. Sources its data
          either from the just-submitted response (crossWaiting state) or
          from the peers query. */}
      {isCross &&
        (crossWaiting !== null || crossPeers.length > 0) &&
        (() => {
          const pending = crossWaiting?.pending ?? crossPeers.map((p) => p.intermediaryNodeId)
          const pendingPeers = crossPeers.filter((p) => pending.includes(p.intermediaryNodeId))
          if (pending.length === 0) return null
          return (
            <section
              className="error-box"
              role="status"
              data-testid="cross-clarify-multi-source-banner"
            >
              <div>{t('crossClarify.multiSourceBanner', { remaining: pending.length })}</div>
              {pendingPeers.length > 0 && (
                <ul>
                  {pendingPeers.map((p) => (
                    <li key={p.id}>
                      <Link
                        to="/clarify/$nodeRunId"
                        params={{ nodeRunId: p.intermediaryNodeRunId }}
                        className="link"
                        data-testid={`cross-clarify-multi-source-link-${p.intermediaryNodeId}`}
                      >
                        {t('crossClarify.multiSourcePendingLinkLabel')}: {p.intermediaryNodeId}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })()}

      {/* RFC-056: abandoned chip — surfaces when the session was answered
          but its parent task failed before the designer consumed the
          feedback. The CR-1 invariant flipped status='abandoned'. */}
      {isCross && s.status === 'abandoned' && (
        <div
          className="status-chip status-chip--red"
          data-testid="cross-clarify-abandoned-chip"
          title={t('crossClarify.abandonedTooltip')}
        >
          {t('crossClarify.abandonedChip')}
        </div>
      )}

      {!readonly && (
        <p className="muted clarify-detail__keyboard-hint" data-testid="clarify-keyboard-hint">
          {t('clarify.detail.keyboardHint')}
        </p>
      )}
      <section className="clarify-questions">
        {s.questions.map((q, idx) => {
          const a = answers[q.id]
          if (a === undefined) return null
          return (
            <QuestionForm
              key={q.id}
              ref={(h) => {
                if (h === null) questionRefs.current.delete(q.id)
                else questionRefs.current.set(q.id, h)
              }}
              question={q}
              value={a}
              index={idx + 1}
              disabled={readonly || submitMut.isPending}
              onChange={(next) => setAnswers((prev) => ({ ...prev, [q.id]: next }))}
              onAdvance={() => advanceFromQuestion(q.id)}
            />
          )
        })}
      </section>

      <footer className="clarify-detail__footer">
        <span className="muted" data-testid="clarify-draft-indicator">
          {draftSaving ? t('clarify.detail.draftSaving') : t('clarify.detail.draftSaved')}
        </span>
        <div className="clarify-detail__submit-group" data-testid="clarify-submit-group">
          <button
            ref={submitContinueRef}
            type="button"
            className="btn btn--primary"
            disabled={readonly || submitMut.isPending || requiredMissing}
            onClick={() => submitMut.mutate('continue')}
            data-testid="clarify-submit-continue"
            data-directive="continue"
          >
            {t('clarify.detail.submitContinue')}
          </button>
          {/* RFC-023 self-clarify shows "submit & stop clarifying";
              RFC-056 cross-clarify replaces it with a Reject button + 2nd
              confirm modal because reject is a much heavier decision
              (persistent across loop iters, can't be undone in-task). */}
          {isCross ? (
            <button
              type="button"
              className="btn btn--danger"
              disabled={readonly || submitMut.isPending || requiredMissing}
              onClick={() => setRejectModalOpen(true)}
              data-testid="cross-clarify-reject"
              data-directive="stop"
            >
              {t('crossClarify.button.reject')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={readonly || submitMut.isPending || requiredMissing}
              onClick={() => submitMut.mutate('stop')}
              data-testid="clarify-submit-stop"
              data-directive="stop"
            >
              {t('clarify.detail.submitStop')}
            </button>
          )}
        </div>
        {requiredMissing && (
          <span className="error-box" data-testid="clarify-required-missing">
            {t('clarify.detail.submitDisabledRequired')}
          </span>
        )}
        {submitMut.error !== null && submitMut.error !== undefined && (
          <div className="error-box">{(submitMut.error as Error).message}</div>
        )}
      </footer>

      {/* RFC-056 cross-clarify reject confirm modal. Two-step interaction
          so an accidental click in the footer can't push the questioner
          into persistent STOP CLARIFYING mode. */}
      {isCross && (
        <Dialog
          open={rejectModalOpen}
          onClose={() => setRejectModalOpen(false)}
          title={t('crossClarify.rejectModal.title')}
          data-testid="cross-clarify-reject-modal"
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setRejectModalOpen(false)}
                data-testid="cross-clarify-reject-cancel"
              >
                {t('clarify.detail.back')}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setRejectModalOpen(false)
                  submitMut.mutate('stop')
                }}
                data-testid="cross-clarify-reject-confirm"
              >
                {t('crossClarify.rejectModal.confirm')}
              </button>
            </>
          }
        >
          <p>{t('crossClarify.rejectModal.body')}</p>
        </Dialog>
      )}
    </div>
  )
}
