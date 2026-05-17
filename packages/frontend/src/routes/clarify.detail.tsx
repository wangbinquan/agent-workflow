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
  ClarifySession,
  ClarifySessionSummary,
  SubmitClarifyAnswersResponse,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { QuestionForm } from '@/components/clarify/QuestionForm'
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

  const submitMut = useMutation<SubmitClarifyAnswersResponse, Error>({
    mutationFn: async () => {
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
        { answers: arr, ifMatchIteration: s.iterationIndex },
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
      void navigate({ to: '/clarify' })
    },
  })

  const requiredMissing = useMemo(() => {
    const s = session.data
    if (s === undefined) return false
    for (const q of s.questions) {
      if (!q.recommended) continue
      const a = answers[q.id]
      if (a === undefined) return true
      if (a.selectedOptionIndices.length === 0 && a.customText.trim().length === 0) return true
    }
    return false
  }, [answers, session.data])

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
        <h1>{s.clarifyNodeId}</h1>
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

      <section className="clarify-questions">
        {s.questions.map((q, idx) => {
          const a = answers[q.id]
          if (a === undefined) return null
          return (
            <QuestionForm
              key={q.id}
              question={q}
              value={a}
              index={idx + 1}
              disabled={readonly || submitMut.isPending}
              onChange={(next) => setAnswers((prev) => ({ ...prev, [q.id]: next }))}
            />
          )
        })}
      </section>

      <footer className="clarify-detail__footer">
        <span className="muted" data-testid="clarify-draft-indicator">
          {draftSaving ? t('clarify.detail.draftSaving') : t('clarify.detail.draftSaved')}
        </span>
        <button
          type="button"
          className="button button--primary"
          disabled={readonly || submitMut.isPending || requiredMissing}
          onClick={() => submitMut.mutate()}
          data-testid="clarify-submit"
        >
          {t('clarify.detail.submit')}
        </button>
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
