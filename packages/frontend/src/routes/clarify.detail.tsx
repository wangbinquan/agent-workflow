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
  ClarifyQuestionScope,
  ClarifyRound,
  ClarifyRoundSummary,
  SubmitClarifyAnswers,
  SubmitClarifyAnswersResponse,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { CLARIFY_QUESTION_SCOPE_DEFAULT } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { AttributionChip } from '@/components/AttributionChip'
import { LoadingState } from '@/components/LoadingState'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { QuestionForm, type QuestionFormHandle } from '@/components/clarify/QuestionForm'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { answersEqual, isAnswerFilled } from '@/lib/clarify/answers'
import { useActor } from '@/hooks/useActor'
import { useUserLookup } from '@/hooks/useUserLookup'
import { Dialog } from '@/components/Dialog'
import { useClarifyWs } from '@/hooks/useClarifyWs'
import { deleteClarifyDraft, getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'
import { goToTaskDetail } from '@/lib/nav/taskNav'
import { resolveNodeNameFromSnapshot } from '@/lib/node-names'
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
  // 用户 2026-07-02: also carries the frozen workflowSnapshot so this page
  // resolves node display names (提问节点 / 处理节点 / 中间节点) instead of raw
  // ids. Same queryKey as ClarifyQuestionHandler (rendered per question below),
  // so the two dedupe to ONE request.
  const taskQuery = useQuery<{ name: string; workflowSnapshot?: WorkflowDefinition }>({
    queryKey: ['tasks', session.data?.taskId, 'snapshot'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${session.data?.taskId}`, undefined, signal) as Promise<{
        name: string
        workflowSnapshot?: WorkflowDefinition
      }>,
    enabled: typeof session.data?.taskId === 'string',
    refetchOnWindowFocus: false,
  })
  // 节点名解析（title → agentName → id 回退）；快照未载/查无节点时回退原 id。
  const workflowSnapshot = taskQuery.data?.workflowSnapshot
  const nodeName = (id: string) => resolveNodeNameFromSnapshot(workflowSnapshot, id) ?? id

  // RFC-128 P4 (T10) — coordination grey-out. Read the task's per-question seal /
  // dispatch state so this page can render any question already sealed/dispatched via
  // the centralized answer pane or the board as read-only AND exclude it from submit —
  // never re-sealing / re-dispatching a sibling another channel already handled
  // (dispatched_at IS NULL CAS is the backend backstop; this is the UX layer).
  // Defensive: retry:false + non-array guard ⇒ a non-member / unmocked response yields
  // an empty locked set ⇒ byte-for-byte the pre-RFC-128 page (golden lock).
  const taskQuestionsQuery = useQuery<TaskQuestionEntry[], ApiError>({
    queryKey: ['task-questions', session.data?.taskId],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${session.data?.taskId}/questions`, undefined, signal),
    enabled: typeof session.data?.taskId === 'string',
    retry: false,
  })
  const lockedQuestionIds = useMemo(() => {
    const data = taskQuestionsQuery.data
    const locked = new Set<string>()
    if (!Array.isArray(data)) return locked
    for (const e of data) {
      // RFC-128 P4 (Codex P2-1): clarify question ids are agent-provided + round-local, so a
      // sibling round can reuse the same id. Only THIS round's entries (originNodeRunId ==
      // this clarify node-run id) may lock a question here — otherwise sealing q1 in another
      // round would wrongly grey out this round's q1.
      if (e.originNodeRunId !== nodeRunId) continue
      // sealed (answered here or via the pane) OR already dispatched (processing /
      // awaiting_confirm / done). dispatched ⇒ sealed, but OR both to match design §6
      // ("已 seal / 已下发的题") and stay robust to any backend skew.
      if (
        e.sealed ||
        e.phase === 'processing' ||
        e.phase === 'awaiting_confirm' ||
        e.phase === 'done'
      ) {
        locked.add(e.questionId)
      }
    }
    return locked
  }, [taskQuestionsQuery.data, nodeRunId])

  // Subscribe to the host task's WS channel for clarify.* events so
  // sibling tabs picking up the same session see a real-time re-fetch
  // when the other tab submits.
  // RFC-099 (D14) — live "X just edited question N" hint, auto-cleared.
  const actorQuery = useActor()
  const [draftHint, setDraftHint] = useState<{ name: string; question: string } | null>(null)
  const draftHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useClarifyWs({
    taskId: session.data?.taskId ?? null,
    intermediaryNodeRunId: nodeRunId,
    onDraftUpdated: (frame) => {
      const myId = actorQuery.data?.user.id
      if (myId !== undefined && frame.editor.userId === myId) return
      const question = session.data?.questions.find((q) => q.id === frame.questionId)
      setDraftHint({ name: frame.editor.displayName, question: question?.title ?? '' })
      if (draftHintTimerRef.current !== null) clearTimeout(draftHintTimerRef.current)
      draftHintTimerRef.current = setTimeout(() => setDraftHint(null), 5000)
    },
  })

  // ----------------------------------------------------------------------
  // local answer state — seeded from session.questions, then overwritten
  // by IDB draft if one exists for this (taskId, nodeRunId, sessionId).
  // ----------------------------------------------------------------------

  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({})
  // RFC-059: per-question scope decisions for cross-clarify sessions. Map
  // questionId → 'designer' | 'questioner'. Empty for self-clarify (the
  // asking agent is itself the consumer, so there's no designer/questioner
  // split; the submit body does NOT include this field on the self path).
  const [scopes, setScopes] = useState<Record<string, ClarifyQuestionScope>>({})
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // RFC-099 (D8/D14) — server-side collaborative drafts. `serverDraftRef`
  // mirrors the last server-acknowledged value per question; the autosave
  // diff and the remote-merge effect both compare against it so a remote
  // editor's change never clobbers text the local user typed since.
  const serverDraftRef = useRef<Record<string, ClarifyAnswer>>({})
  const serverDraftDisabledRef = useRef(false)
  // Resolve attribution ids (per-question editors + submitter) to names.
  const attributionUserIds = useMemo(() => {
    const s = session.data
    if (s === undefined) return [] as string[]
    return [
      ...Object.values(s.answerAttributions ?? {}).map((a) => a.userId),
      ...(s.answeredBy !== null ? [s.answeredBy] : []),
    ]
  }, [session.data])
  const attributionLookup = useUserLookup(attributionUserIds)
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
    setScopes({})
    setDraftLoaded(false)
    initialFocusedRef.current = false
    serverDraftRef.current = {}
    serverDraftDisabledRef.current = false
    setDraftHint(null)
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
  }, [nodeRunId])

  // RFC-059: seed `scopes` from the session (kind='cross' only).
  //   - awaiting_human + no persisted scopes → every question defaults to
  //     'designer' (preserves RFC-056 byte-level behaviour).
  //   - sealed (answered/abandoned) with persisted scopes → restore them so
  //     the readonly chip shows what the user actually selected.
  //   - sealed with NULL scopes (rows from before RFC-059) → fall back to
  //     'designer' so the chip says "designer" — matches the runtime path.
  //   - self-clarify → never seed; `scopes` stays `{}` and the UI does not
  //     render any scope control.
  useEffect(() => {
    const s = session.data
    if (s === undefined || s.kind !== 'cross') return
    const initial: Record<string, ClarifyQuestionScope> = {}
    for (const q of s.questions) {
      initial[q.id] = s.questionScopes?.[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
    }
    setScopes(initial)
  }, [session.data])

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
    // RFC-099 (D8): the SERVER draft is the collaborative source of truth.
    // When present it wins over the local IDB copy (another member may have
    // edited from a different machine); IDB stays as the single-user /
    // offline fallback only.
    const serverDrafts = s.draftAnswers ?? null
    if (serverDrafts !== null && Object.keys(serverDrafts).length > 0) {
      for (const [qid, v] of Object.entries(serverDrafts)) {
        if (fresh[qid] !== undefined) {
          fresh[qid] = {
            questionId: qid,
            selectedOptionIndices: v.selectedOptionIndices ?? [],
            selectedOptionLabels: [],
            customText: v.customText ?? '',
          }
        }
      }
      serverDraftRef.current = { ...fresh }
      setAnswers(fresh)
      setDraftLoaded(true)
      return
    }
    serverDraftRef.current = { ...fresh }
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

  // Debounced draft write: IDB (offline fallback) + RFC-099 server drafts —
  // one PUT per question whose value changed since the last server ack, so
  // concurrent members editing DIFFERENT questions merge (D14 per-question
  // last-write-wins).
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
      const serverPuts: Array<Promise<unknown>> = []
      if (!serverDraftDisabledRef.current) {
        for (const a of arr) {
          const prev = serverDraftRef.current[a.questionId]
          if (prev !== undefined && answersEqual(prev, a)) continue
          serverDraftRef.current[a.questionId] = a
          serverPuts.push(
            api
              .put(`/api/clarify/${s.intermediaryNodeRunId}/draft`, {
                roundId: s.id,
                questionId: a.questionId,
                selectedOptionIndices: a.selectedOptionIndices,
                customText: a.customText,
              })
              .catch(() => {
                // 403 (not a member) / 409 (round sealed under us) — stop
                // hammering the server; the IDB draft keeps working locally.
                serverDraftDisabledRef.current = true
              }),
          )
        }
      }
      void Promise.allSettled([
        setClarifyDraft(
          { taskId: s.taskId, intermediaryNodeRunId: s.intermediaryNodeRunId, roundId: s.id },
          arr,
        ),
        ...serverPuts,
      ]).finally(() => setDraftSaving(false))
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    }
  }, [answers, draftLoaded, session.data])

  // RFC-099 (D14) — merge REMOTE draft changes (refetched after a
  // clarify.draft.updated frame) into the form. A remote value is adopted
  // only when the local user hasn't diverged from the last server-acked
  // value for that question — the local editor always wins locally, and
  // their next autosave settles the race server-side (LWW).
  useEffect(() => {
    const s = session.data
    if (s === undefined || !draftLoaded || s.status !== 'awaiting_human') return
    const serverDrafts = s.draftAnswers ?? null
    if (serverDrafts === null) return
    setAnswers((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [qid, v] of Object.entries(serverDrafts)) {
        if (prev[qid] === undefined) continue
        const remote: ClarifyAnswer = {
          questionId: qid,
          selectedOptionIndices: v.selectedOptionIndices ?? [],
          selectedOptionLabels: [],
          customText: v.customText ?? '',
        }
        const acked = serverDraftRef.current[qid]
        if (answersEqual(remote, prev[qid])) {
          serverDraftRef.current[qid] = remote
          continue
        }
        if (acked !== undefined && answersEqual(prev[qid], acked)) {
          next[qid] = remote
          serverDraftRef.current[qid] = remote
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [session.data, draftLoaded])

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
      // RFC-128 P4 (T10): exclude any question already sealed/dispatched via another channel
      // (the centralized pane / board) so this quick-channel submit never re-seals it. We do
      // NOT send `questionIds` here: that subset cap is gated to defer=true on the backend
      // (clarify.ts: 'clarify-question-ids-requires-defer'), and it's unnecessary — the quick
      // channel re-merges the already-sealed (locked) answers via loadSealedQuestionIds +
      // mergeSealedAnswers(lockedIds), so sending only the unlocked answers still finalizes the
      // WHOLE round (answered). Excluding locked from `arr` just avoids re-seal attempts.
      const arr = s.questions
        .filter((q) => !lockedQuestionIds.has(q.id))
        .map(
          (q) =>
            answers[q.id] ?? {
              questionId: q.id,
              selectedOptionIndices: [],
              selectedOptionLabels: [],
              customText: '',
            },
        )
      const body: SubmitClarifyAnswers = {
        answers: arr,
        ifMatchIteration: s.iteration,
        directive,
      }
      // RFC-059: only send questionScopes on cross-clarify (self-clarify submit ignores the
      // field). When some questions are locked, restrict the scope map to the unlocked subset
      // (the backend keeps a locked question's stored scope); no locked ⇒ send the full map
      // (byte-for-byte the pre-RFC-128 whole-round submit, golden lock).
      if (s.kind === 'cross') {
        body.questionScopes =
          lockedQuestionIds.size > 0
            ? Object.fromEntries(
                arr.map((a) => [
                  a.questionId,
                  scopes[a.questionId] ?? CLARIFY_QUESTION_SCOPE_DEFAULT,
                ]),
              )
            : scopes
      }
      const resp = await api.post<SubmitClarifyAnswersResponse>(
        `/api/clarify/${s.intermediaryNodeRunId}/answers`,
        body,
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
        goToTaskDetail(qc, navigate, taskId)
      } else {
        void navigate({ to: '/clarify' })
      }
    },
  })

  // Unified stop-confirm modal state. Both self-clarify and cross-clarify
  // route the secondary "submit & stop" button through this two-step
  // confirmation: click opens the modal, explicit Confirm fires the 'stop'
  // directive, Cancel returns to the form unchanged. Cross-clarify variant
  // uses stronger copy (cross-loop persistence warning); self-clarify uses
  // the milder iteration-scoped copy.
  const [stopModalOpen, setStopModalOpen] = useState(false)

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
    return !isAnswerFilled(a)
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

  // Cross-clarify only: Q / W shortcut for the per-question scope picker.
  // Q → questioner, W → designer. The shortcut targets the question that
  // currently owns keyboard focus (walk up from `document.activeElement`
  // to a `[data-question-wrapper-id]` wrapper). When focus is outside any
  // question (e.g. after a stray click), fall back to the first question
  // so the keypress is never a silent no-op. Does NOT advance to the next
  // question — the reviewer may want to toggle the same question's scope
  // twice while comparing tooltips, and per spec this only sets scope.
  useEffect(() => {
    const s = session.data
    if (s === undefined) return
    if (s.kind !== 'cross') return
    if (s.status !== 'awaiting_human') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target !== null) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      const k = e.key.toLowerCase()
      let mode: ClarifyQuestionScope | null = null
      // Q / W mirror the visual order of the segmented control (Designer
      // is rendered left, Questioner right) so the keyboard row matches
      // page order.
      if (k === 'q') mode = 'designer'
      else if (k === 'w') mode = 'questioner'
      if (mode === null) return
      if (submitMut.isPending) return
      const active = document.activeElement
      const wrapper =
        active instanceof HTMLElement ? active.closest('[data-question-wrapper-id]') : null
      const qid =
        wrapper instanceof HTMLElement
          ? wrapper.getAttribute('data-question-wrapper-id')
          : (s.questions[0]?.id ?? null)
      if (qid === null || qid === undefined || qid.length === 0) return
      e.preventDefault()
      const nextMode = mode
      setScopes((prev) => ({ ...prev, [qid]: nextMode }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session.data, submitMut.isPending])

  // ----------------------------------------------------------------------
  // render
  // ----------------------------------------------------------------------

  if (session.isLoading) {
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  }
  if (session.error !== null && session.error !== undefined) {
    return <div className="page error-box">{(session.error as Error).message}</div>
  }
  const s = session.data
  if (s === undefined) return null

  const readonly = s.status !== 'awaiting_human'
  // RFC-128 P4 (T10): every question already sealed/dispatched elsewhere → nothing left
  // to submit here. Disable the submit buttons (the form is all read-only anyway).
  const allLocked = s.questions.length > 0 && s.questions.every((q) => lockedQuestionIds.has(q.id))
  // RFC-058: ClarifyRound unified — intermediary == clarify / clarify-cross
  // node, asking == source agent / questioner, iteration == round counter.
  const nodeId = s.intermediaryNodeId
  const nodeTitle =
    typeof s.intermediaryNodeTitle === 'string' &&
    s.intermediaryNodeTitle.length > 0 &&
    s.intermediaryNodeTitle !== s.intermediaryNodeId
      ? s.intermediaryNodeTitle
      : null
  // 用户 2026-07-02: 提问节点显示节点名（快照解析，查无回退原 id）。
  const sourceName = nodeName(s.askingNodeId)
  const iteration = s.iteration
  const shardKey = s.kind === 'cross' ? null : s.askingShardKey
  const truncationWarnings = s.kind === 'self' ? s.truncationWarnings : undefined
  const isCross = s.kind === 'cross'

  return (
    <div
      className="page page--clarify-detail"
      data-testid="clarify-detail-page"
      data-status={s.status}
      data-kind={s.kind}
    >
      <header className="page__header">
        {/* RFC-037 + follow-up: lead with the user-supplied task name (when
            loaded), then the clarify node title (workflowSnapshot's
            `WorkflowNode.title`) with a fall-back to the clarify node id —
            same pattern as the review detail page so the two surfaces read
            identically. 用户 2026-07-02: cross-clarify (whose DTO carries no
            intermediaryNodeTitle) now resolves via the frozen snapshot before
            the id fallback. */}
        <h1>
          {(() => {
            const nodeLabel = nodeTitle ?? nodeName(nodeId)
            const hasTaskName =
              typeof taskQuery.data?.name === 'string' && taskQuery.data.name.length > 0
            if (!hasTaskName) return nodeLabel
            return (
              <>
                {/* Task name links to the owning task detail page, kept inline
                    in the H1 (no extra row) so the clarify header stays compact.
                    data-testid preserved here for the baseline source-lock that
                    used to sit on the now-removed standalone task-name row. */}
                <Link
                  to="/tasks/$id"
                  params={{ id: s.taskId }}
                  className="link"
                  data-testid="clarify-detail-task-name"
                >
                  {taskQuery.data!.name}
                </Link>
                {` / ${nodeLabel}`}
              </>
            )
          })()}
        </h1>
        <p className="page__hint" data-testid="clarify-context-card">
          {isCross
            ? t('crossClarify.contextCard', { name: sourceName, n: iteration })
            : t('clarify.detail.contextCard', { name: sourceName, n: iteration })}
          {isCross && s.targetConsumerNodeId !== null && (
            <>
              {' · '}
              <span data-testid="cross-clarify-target-designer">
                {t('crossClarify.targetDesigner', { name: nodeName(s.targetConsumerNodeId) })}
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
                        {/* 用户 2026-07-02: 显示节点名（testid 保持原 id 以稳定测试锚点）。 */}
                        {t('crossClarify.multiSourcePendingLinkLabel')}:{' '}
                        {nodeName(p.intermediaryNodeId)}
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
        <StatusChip
          kind="danger"
          data-testid="cross-clarify-abandoned-chip"
          title={t('crossClarify.abandonedTooltip')}
        >
          {t('crossClarify.abandonedChip')}
        </StatusChip>
      )}

      {!readonly && (
        <p className="muted clarify-detail__keyboard-hint" data-testid="clarify-keyboard-hint">
          {t('clarify.detail.keyboardHint')}
          {isCross && <> · {t('crossClarify.questionScope.shortcutHint')}</>}
        </p>
      )}
      {draftHint !== null && (
        <div className="clarify-draft-hint" role="status" data-testid="clarify-draft-hint">
          {t('attribution.justEdited', { name: draftHint.name, question: draftHint.question })}
        </div>
      )}
      {/* RFC-099 (D7): sealed rounds show who submitted, with their task role. */}
      {s.status === 'answered' && s.answeredBy !== null && (
        <p className="page__hint" data-testid="clarify-submitter">
          {t('attribution.submittedBy')}:{' '}
          <AttributionChip
            userId={s.answeredBy}
            role={s.submittedByRole ?? null}
            user={attributionLookup.get(s.answeredBy)}
          />
        </p>
      )}
      <section className="clarify-questions">
        {s.questions.map((q, idx) => {
          const a = answers[q.id]
          if (a === undefined) return null
          const scope: ClarifyQuestionScope = scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
          // RFC-128 P4 (T10): this question was already sealed/dispatched via another
          // channel (the centralized pane / board) → read-only here + excluded from submit.
          const locked = lockedQuestionIds.has(q.id)
          return (
            <div
              key={q.id}
              className={
                'clarify-question-wrapper' + (locked ? ' clarify-question-wrapper--locked' : '')
              }
              data-question-wrapper-id={q.id}
              data-locked={locked ? 'true' : undefined}
            >
              {/* RFC-120 D12: per-question handler echo + picker. Self-filters to
                  designer-domain questions (renders null otherwise) and reads the
                  same override SoT the board edits. */}
              <ClarifyQuestionHandler
                taskId={s.taskId}
                questionId={q.id}
                originNodeRunId={s.intermediaryNodeRunId}
              />
              {/* RFC-128 P4 (T10): coordination notice for an already-handled question. */}
              {locked && (
                <p className="muted" data-testid={`clarify-locked-note-${q.id}`}>
                  {t('clarify.detail.lockedNote')}
                </p>
              )}
              {/* RFC-059: per-question scope picker. Only rendered for
                  cross-clarify nodes (self-clarify has no scope split).
                  In awaiting_human → editable Segmented; in sealed states
                  (answered/abandoned) → readonly chip. */}
              {isCross && (
                <div className="clarify-question-scope" data-testid={`clarify-scope-${q.id}`}>
                  <span className="muted">{t('crossClarify.questionScope.label')}:</span>
                  {readonly ? (
                    <StatusChip
                      // flag-audit W0 Codex 实现门 P2：legacy 别名（'blue'）已删，
                      // 语义 kind 走统一原语。
                      kind={scope === 'questioner' ? 'info' : 'neutral'}
                      data-testid={`clarify-scope-chip-${q.id}`}
                    >
                      {scope === 'questioner'
                        ? t('crossClarify.questionScope.questioner')
                        : t('crossClarify.questionScope.designer')}
                    </StatusChip>
                  ) : (
                    <Segmented<ClarifyQuestionScope>
                      value={scope}
                      onChange={(mode) => setScopes((prev) => ({ ...prev, [q.id]: mode }))}
                      options={(['designer', 'questioner'] as const).map((mode) => ({
                        value: mode,
                        label:
                          mode === 'designer'
                            ? t('crossClarify.questionScope.designer')
                            : t('crossClarify.questionScope.questioner'),
                        title: t(
                          mode === 'designer'
                            ? 'crossClarify.questionScope.designerTooltip'
                            : 'crossClarify.questionScope.questionerTooltip',
                        ),
                        shortcut: mode === 'designer' ? 'Q' : 'W',
                        testid: `clarify-scope-${q.id}-${mode}`,
                        shortcutTestid: `clarify-scope-${q.id}-${mode}-kbd`,
                      }))}
                      ariaLabel={t('crossClarify.questionScope.label')}
                      rootTestid={`clarify-scope-segmented-${q.id}`}
                      disabled={submitMut.isPending || locked}
                    />
                  )}
                </div>
              )}
              <QuestionForm
                ref={(h) => {
                  if (h === null) questionRefs.current.delete(q.id)
                  else questionRefs.current.set(q.id, h)
                }}
                question={q}
                value={a}
                index={idx + 1}
                disabled={readonly || submitMut.isPending || locked}
                onChange={(next) => setAnswers((prev) => ({ ...prev, [q.id]: next }))}
                onAdvance={() => advanceFromQuestion(q.id)}
              />
              {/* RFC-099 (D7/D8): per-question last editor, live while
                  drafting and frozen after submit. Audit display only. */}
              {(() => {
                const attr = s.answerAttributions?.[q.id]
                if (attr === undefined) return null
                return (
                  <div
                    className="clarify-question__attribution"
                    data-testid={`clarify-attribution-${q.id}`}
                  >
                    {t('attribution.lastEditedBy')}:{' '}
                    <AttributionChip
                      userId={attr.userId}
                      role={attr.role}
                      user={attributionLookup.get(attr.userId)}
                    />
                  </div>
                )
              })()}
            </div>
          )
        })}
      </section>

      <footer className="clarify-detail__footer">
        <span className="muted" data-testid="clarify-draft-indicator">
          {draftSaving ? t('clarify.detail.draftSaving') : t('clarify.detail.draftSaved')}
        </span>
        {/* RFC-059: scope-distribution hint right above the submit row, only
            for cross-clarify in awaiting_human. Three variants
            (allDesigner / allQuestioner / mixed) make the routing decision
            visible BEFORE the user hits submit. */}
        {isCross &&
          !readonly &&
          (() => {
            const total = s.questions.length
            const designerCount = s.questions.filter(
              (q) => (scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT) === 'designer',
            ).length
            const questionerCount = total - designerCount
            let hintKey: string
            let hintData: Record<string, number>
            if (designerCount === 0) {
              hintKey = 'crossClarify.submitHint.allQuestioner'
              hintData = { n: questionerCount }
            } else if (questionerCount === 0) {
              hintKey = 'crossClarify.submitHint.allDesigner'
              hintData = { n: designerCount }
            } else {
              hintKey = 'crossClarify.submitHint.mixed'
              hintData = { d: designerCount, q: questionerCount, total }
            }
            return (
              <p className="muted" data-testid="cross-clarify-submit-hint" data-hint-kind={hintKey}>
                {t(hintKey, hintData)}
              </p>
            )
          })()}
        <div className="clarify-detail__submit-group" data-testid="clarify-submit-group">
          <button
            ref={submitContinueRef}
            type="button"
            className="btn btn--primary"
            disabled={readonly || submitMut.isPending || allLocked}
            onClick={() => submitMut.mutate('continue')}
            data-testid="clarify-submit-continue"
            data-directive="continue"
          >
            {t('clarify.detail.submitContinue')}
          </button>
          {/* Both self- and cross-clarify share one secondary button:
              ghost-styled "Submit & stop clarifying" that opens a confirm
              modal before actually firing the 'stop' directive. The modal
              copy differs per kind (cross is irreversible across loop
              iterations; self is iteration-scoped) but the button surface
              is identical so the two pages read the same. */}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={readonly || submitMut.isPending || allLocked}
            onClick={() => setStopModalOpen(true)}
            data-testid="clarify-submit-stop"
            data-directive="stop"
          >
            {t('clarify.detail.submitStop')}
          </button>
        </div>
        {submitMut.error !== null && submitMut.error !== undefined && (
          <div className="error-box">{(submitMut.error as Error).message}</div>
        )}
      </footer>

      {/* Unified stop-confirm modal. Both kinds share the same dialog
          shell + testids so the two pages look and behave identically;
          only the title / body / confirm-label i18n differs (cross keeps
          the RFC-056 cross-loop persistence warning, self uses milder
          iteration-scoped copy). */}
      <Dialog
        open={stopModalOpen}
        onClose={() => setStopModalOpen(false)}
        title={t(isCross ? 'crossClarify.rejectModal.title' : 'clarify.detail.stopModal.title')}
        data-testid="clarify-stop-modal"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setStopModalOpen(false)}
              data-testid="clarify-stop-cancel"
            >
              {t('clarify.detail.stopModal.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setStopModalOpen(false)
                submitMut.mutate('stop')
              }}
              data-testid="clarify-stop-confirm"
            >
              {t(isCross ? 'crossClarify.rejectModal.confirm' : 'clarify.detail.stopModal.confirm')}
            </button>
          </>
        }
      >
        <p>{t(isCross ? 'crossClarify.rejectModal.body' : 'clarify.detail.stopModal.body')}</p>
      </Dialog>
    </div>
  )
}
