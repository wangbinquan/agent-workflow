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
  ClarifySession,
  ClarifySessionSummary,
  SubmitClarifyAnswersResponse,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { QuestionForm, type QuestionFormHandle } from '@/components/clarify/QuestionForm'
import { useClarifyWs } from '@/hooks/useClarifyWs'
import { deleteClarifyDraft, getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'
import { Route as RootRoute } from './__root'

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

  const session = useQuery<ClarifySession>({
    queryKey: ['clarify', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/clarify/${nodeRunId}`, undefined, signal),
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
    clarifyNodeRunId: nodeRunId,
  })

  // ----------------------------------------------------------------------
  // local answer state — seeded from session.questions, then overwritten
  // by IDB draft if one exists for this (taskId, nodeRunId, sessionId).
  // ----------------------------------------------------------------------

  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({})
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    const key = { taskId: s.taskId, clarifyNodeRunId: s.clarifyNodeRunId, sessionId: s.id }
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
        { taskId: s.taskId, clarifyNodeRunId: s.clarifyNodeRunId, sessionId: s.id },
        arr,
      ).finally(() => setDraftSaving(false))
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    }
  }, [answers, draftLoaded, session.data])

  // ----------------------------------------------------------------------
  // shard switcher — peer awaiting_human sessions for the same task +
  // clarifyNodeId. Only renders when there are ≥ 2 in scope.
  // ----------------------------------------------------------------------

  const peers = useQuery<ClarifySessionSummary[]>({
    queryKey: ['clarify', 'peers', session.data?.taskId, session.data?.clarifyNodeId],
    queryFn: ({ signal }) => {
      const taskId = session.data?.taskId ?? ''
      return api.get<ClarifySessionSummary[]>(
        `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        undefined,
        signal,
      )
    },
    enabled: session.data !== undefined,
    refetchInterval: 10000,
  })

  const shardPeers: ClarifySessionSummary[] = useMemo(() => {
    if (session.data === undefined) return []
    const list = (peers.data ?? []).filter((p) => p.clarifyNodeId === session.data!.clarifyNodeId)
    if (list.length < 2) return []
    return [...list].sort((a, b) => (a.sourceShardKey ?? '').localeCompare(b.sourceShardKey ?? ''))
  }, [peers.data, session.data])

  // ----------------------------------------------------------------------
  // submit
  // ----------------------------------------------------------------------

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
        `/api/clarify/${s.clarifyNodeRunId}/answers`,
        { answers: arr, ifMatchIteration: s.iterationIndex, directive },
      )
      // Clear the IDB draft; the answer is committed server-side.
      await deleteClarifyDraft({
        taskId: s.taskId,
        clarifyNodeRunId: s.clarifyNodeRunId,
        sessionId: s.id,
      })
      return resp
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
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
  const initialFocusedRef = useRef(false)

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

  return (
    <div className="page" data-testid="clarify-detail-page" data-status={s.status}>
      <header className="page__header">
        <Link to="/clarify" className="link">
          {t('clarify.detail.back')}
        </Link>
        {/* RFC-037 + follow-up: lead with the user-supplied task name (when
            loaded), then the clarify node title (workflowSnapshot's
            `WorkflowNode.title`) with a fall-back to the clarify node id —
            same pattern as the review detail page so the two surfaces read
            identically. */}
        <h1>
          {(() => {
            const nodeLabel =
              typeof s.clarifyNodeTitle === 'string' &&
              s.clarifyNodeTitle.length > 0 &&
              s.clarifyNodeTitle !== s.clarifyNodeId
                ? s.clarifyNodeTitle
                : s.clarifyNodeId
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
          {t('clarify.detail.contextCard', { name: s.sourceAgentNodeId, n: s.iterationIndex })}
          {s.sourceShardKey !== null && (
            <>
              {' · '}
              <span data-testid="clarify-context-shard">
                {t('clarify.detail.contextCardShard', { shard: s.sourceShardKey })}
              </span>
            </>
          )}
        </p>
      </header>

      {s.truncationWarnings !== undefined && s.truncationWarnings.length > 0 && (
        <div className="error-box" data-testid="clarify-truncation-warning">
          {s.truncationWarnings.map((w) => (
            <div key={w.code}>
              [{w.code}] {w.detail}
            </div>
          ))}
        </div>
      )}

      {shardPeers.length > 0 && (
        <section className="clarify-shard-switcher" data-testid="clarify-shard-switcher">
          <span className="muted">{t('clarify.detail.shardSwitcherLabel')}:</span>{' '}
          {shardPeers.map((p) => (
            <Link
              key={p.id}
              to="/clarify/$nodeRunId"
              params={{ nodeRunId: p.clarifyNodeRunId }}
              className={
                'tabs__tab' +
                (p.clarifyNodeRunId === s.clarifyNodeRunId ? ' tabs__tab--active' : '')
              }
              data-shard-key={p.sourceShardKey ?? ''}
              data-testid={`clarify-shard-${p.sourceShardKey ?? 'main'}`}
            >
              {p.sourceShardKey ?? '—'}
            </Link>
          ))}
        </section>
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
    </div>
  )
}
