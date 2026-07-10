// RFC-128 P4 (T9) — centralized answer pane.
//
// A single page (full-width Dialog) that flattens EVERY unsealed question that is still
// in the 待指派 ('pending') phase of a task, grouped by its originating clarify round, and
// seals them all with ONE submit button. Per user (2026-06-30): "页面和反问界面功能一致、只是只有
// 一个提交按钮" — so it reuses the /clarify primitives wholesale (QuestionForm /
// ClarifyQuestionHandler / Card / Dialog / EmptyState / ErrorBanner / LoadingState) and
// only collapses the per-round submit into one. RFC-137 (用户 2026-07-03): the pane answers
// self and cross rounds UNIFORMLY. RFC-162 removed the scope concept entirely — there is no
// per-question designer↔questioner picker anywhere, and no scopes are ever sent.
//
// Channel = control (defer=true): each round's filled subset is POSTed to
// `/api/clarify/:nodeRunId/answers` with `defer:true` + a `questionIds` cap, which
// seals those questions into 待指派 WITHOUT minting a rerun. The board then picks an
// agent + dispatches. Which questions remain to answer is read from the per-question
// `sealed` DTO field (NOT answerSummary — Codex design gate F3: a partial round leaves
// answerSummary unreliable). RFC-128 P4/P5 (用户 2026-07-01): the pool is now EXPLICITLY
// gated to the 待指派 ('pending') phase — this replaces the earlier "unsealed ⟹ pending"
// assumption the code never actually enforced (an unsealed-but-dispatched entry could leak).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  ClarifyAnswer,
  ClarifyRound,
  SubmitClarifyAnswers,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { QuestionForm, type QuestionFormHandle } from '@/components/clarify/QuestionForm'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { answersEqual, isAnswerFilled } from '@/lib/clarify/answers'
import { getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'
import { resolveNodeNameFromSnapshot } from '@/lib/node-names'

const DRAFT_DEBOUNCE_MS = 500

export interface CentralizedAnswerGroup {
  originNodeRunId: string
  questionIds: string[]
  /** RFC-136 — the subset of questionIds that are RE-answers (sealed 待指派 questions,
   *  e.g. moved back out of 待下发): prefilled from the committed answer, resubmission
   *  overwrites in place. Empty when the round only has fresh questions. */
  resubmitQuestionIds: string[]
}

/** Pure oracle (unit-tested): the task's UNSEALED clarify questions grouped by their
 *  originating clarify round (originNodeRunId), in stable first-appearance order.
 *
 *  RFC-128 P5-BC — the pane now surfaces SELF-clarify AND cross (questioner/designer) questions:
 *  the P4 designer-only filter (sourceKind === 'cross') is GONE. P5-BC's self/questioner park +
 *  dispatch path means a defer-sealed self/questioner question is NO LONGER stranded — it parks
 *  its home (loadUndispatchedSelfQuestionerTargets) until board dispatch mints the continuation.
 *  RFC-162: self and cross questions render identically here — no scope picker (scope removed).
 *
 *  Excluded: manual questions (originNodeRunId null — the instruction IS the content,
 *  nothing to answer), and — RFC-128 P4/P5 (用户 2026-07-01) — any entry past the 待指派
 *  ('pending') phase: the defer→待指派→dispatch control channel only applies before
 *  dispatch, so a staged/processing/awaiting_confirm/done entry is out. Dedup is by (round,
 *  questionId): a cross round's questioner + designer entries share a questionId → one render.
 *
 *  RFC-136 (用户 2026-07-02「问题返回待指派应允许修改答案」) — SEALED pending questions are
 *  now INCLUDED as re-answers (`resubmitQuestionIds`): the pane prefills the committed answer
 *  and resubmission overwrites it in place (直接覆盖). The seal state is judged per (round,
 *  question) — every entry of the question carries the same `sealed` (seal stamps all roles).
 *  (Renamed from groupUnsealedQuestions — the pool is no longer unsealed-only.) */
export function groupAnswerableQuestions(entries: TaskQuestionEntry[]): CentralizedAnswerGroup[] {
  // RFC-136 — a SEALED question is only re-answerable when EVERY entry of its (round,
  // question) is still 待指派: the server re-seal guard rejects a question with any
  // staged/dispatched sibling row (半新半旧守卫), so pooling a half-staged question would
  // build a dead-end UI (editable but guaranteed 409). Pre-compute the blocked keys.
  // (An UNSEALED question can't have a staged sibling — the stage gate requires sealed —
  // so this only ever excludes re-answers; fresh behaviour is untouched.)
  const pastPending = new Set<string>()
  for (const e of entries) {
    if (e.originNodeRunId === null) continue
    if (e.phase !== 'pending') pastPending.add(`${e.originNodeRunId}\x1f${e.questionId}`)
  }
  const order: string[] = []
  const byRound = new Map<string, string[]>()
  const resubmitByRound = new Map<string, Set<string>>()
  for (const e of entries) {
    if (e.originNodeRunId === null) continue
    // RFC-128 P4/P5 (用户 2026-07-01): pool is gated to the 待指派 ('pending') phase. The
    // control channel (defer → 待指派 → board dispatch) only applies BEFORE dispatch, so a
    // past-pending entry (staged/processing/awaiting_confirm/done) is excluded.
    if (e.phase !== 'pending') continue
    if (e.sealed && pastPending.has(`${e.originNodeRunId}\x1f${e.questionId}`)) continue
    let qids = byRound.get(e.originNodeRunId)
    if (qids === undefined) {
      qids = []
      byRound.set(e.originNodeRunId, qids)
      resubmitByRound.set(e.originNodeRunId, new Set())
      order.push(e.originNodeRunId)
    }
    if (!qids.includes(e.questionId)) qids.push(e.questionId)
    if (e.sealed) resubmitByRound.get(e.originNodeRunId)!.add(e.questionId)
  }
  return order.map((originNodeRunId) => ({
    originNodeRunId,
    questionIds: byRound.get(originNodeRunId)!,
    resubmitQuestionIds: [...resubmitByRound.get(originNodeRunId)!],
  }))
}

/** RFC-128 (用户 2026-07-01) — keyboard-nav order oracle (unit-tested). Flattens EVERY round's
 *  questions into a single global navigation order of `${originNodeRunId}:${questionId}` keys,
 *  preserving round order (`groups`) and, WITHIN a round, that round's VISIBLE render order
 *  (reported by each RoundAnswerBlock — round.questions order filtered to the unsealed subset).
 *
 *  Why a reported per-round order instead of `groups[].questionIds`: the render order is the
 *  round's questionsJson order (RoundAnswerBlock filters round.questions), whereas a group's
 *  questionIds is task_questions storage order (listTaskQuestions has no ORDER BY) — the two can
 *  diverge. Keyboard "advance to next" must follow what the reviewer SEES, so we key off the
 *  reported render order; `groups[].questionIds` is the fallback until a round has reported (its
 *  first render), which keeps a just-mounted round navigable. */
export function flattenCentralizedNavKeys(
  groups: readonly CentralizedAnswerGroup[],
  roundVisibleOrder: ReadonlyMap<string, readonly string[]>,
): string[] {
  const keys: string[] = []
  for (const g of groups) {
    const reported = roundVisibleOrder.get(g.originNodeRunId)
    const qids = reported !== undefined && reported.length > 0 ? reported : g.questionIds
    for (const qid of qids) keys.push(`${g.originNodeRunId}:${qid}`)
  }
  return keys
}

/** One round's pending submission, reported up to the dialog by its RoundAnswerBlock. */
interface RoundSubmission {
  roundId: string
  iteration: number
  /** Filled answers only (a question with no pick / text is left for later). */
  answers: ClarifyAnswer[]
  /** questionIds of `answers` — the subset cap sent to the backend. */
  questionIds: string[]
  /** RFC-136 (Codex 实现门 P2) — the RE-answer declaration: the subset of questionIds the
   *  pane prefilled from a committed answer (the user SAW and edited it). The server only
   *  overwrites a sealed question when it is declared here. */
  resubmitQuestionIds: string[]
}

export interface CentralizedAnswerDialogProps {
  taskId: string
  open: boolean
  onClose: () => void
}

export function CentralizedAnswerDialog({ taskId, open, onClose }: CentralizedAnswerDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const tqQuery = useQuery<TaskQuestionEntry[], ApiError>({
    queryKey: ['task-questions', taskId],
    queryFn: ({ signal }) => api.get(`/api/tasks/${taskId}/questions`, undefined, signal),
    enabled: open,
    retry: false,
  })
  const groups = useMemo(
    () => groupAnswerableQuestions(Array.isArray(tqQuery.data) ? tqQuery.data : []),
    [tqQuery.data],
  )

  // Per-round filled submissions, keyed by originNodeRunId. Children own their answer
  // state + draft autosave and report a compact submission up here (stable callback ⇒
  // no feedback render loop). Stale keys (a round that left `groups`) are ignored at
  // submit because we iterate `groups`, not the raw map.
  const [submissions, setSubmissions] = useState<Record<string, RoundSubmission>>({})
  const onSubmissionChange = useCallback((originNodeRunId: string, sub: RoundSubmission | null) => {
    setSubmissions((prev) => {
      if (sub === null) {
        if (prev[originNodeRunId] === undefined) return prev
        const next = { ...prev }
        delete next[originNodeRunId]
        return next
      }
      return { ...prev, [originNodeRunId]: sub }
    })
  }, [])

  const filledTotal = useMemo(
    () => groups.reduce((n, g) => n + (submissions[g.originNodeRunId]?.questionIds.length ?? 0), 0),
    [groups, submissions],
  )

  // RFC-128 (用户 2026-07-01) — cross-round keyboard navigation. The reference (/clarify page,
  // clarify.detail.tsx) drives QuestionForm digit/Enter hotkeys by passing each form a `ref`
  // (into a per-question Map) + an `onAdvance` that focuses the NEXT question. This pane omitted
  // both, so onAdvance was undefined → the hotkeys were a silent no-op. Here we rebuild the SAME
  // mechanism but GLOBAL: one Map spanning EVERY round's questions (keyed `${origin}:${qid}`),
  // navigating the flattened order across round boundaries. QuestionForm itself is unchanged.
  //
  // 用户拍板 (2026-07-01): the shortcut ONLY drives cross-round advance. The earlier "last question →
  // auto-focus submit" convenience (plus its whole pending/flush deferred-focus machinery) is
  // REMOVED — it was the source of a 4-round focus-timing edge (a single-choice DIGIT commits
  // onChange→onAdvance in ONE keydown, so submit was still `disabled` at advance time, forcing a
  // deferred flush that could later steal focus). Advancing off the LAST question is now a NO-OP:
  // focus stays put and submit is NEVER auto-focused — the reviewer clicks / Tabs to submit.
  const questionRefs = useRef<Map<string, QuestionFormHandle | null>>(new Map())
  // Each RoundAnswerBlock reports its VISIBLE question order (round.questions filtered), so the
  // flat nav order matches what the reviewer sees (see flattenCentralizedNavKeys). Written from a
  // child effect (ref only ⇒ no re-render / loop); stale rounds are ignored (advance iterates
  // `groups`).
  const roundOrderRef = useRef<Map<string, string[]>>(new Map())
  // 用户 2026-07-10 — 打开弹框即聚焦第一题（数字/Enter 热键直接可用，同 /clarify 详情页的
  // rAF auto-focus 先例）。时序上 open → groups(tqQuery) → 每轮 detail → QuestionForm 挂载
  // 是多段异步，单次 rAF 必抢跑，故用「一次性 pending 标志 + 事件驱动重试」：open 置位；
  // ref 注册 / 轮序上报 / groups 就绪三个时机各试一次，首 key 的 handle 就绪即消费（focus
  // 恰好一次，不会在后续注册时再抢焦）。关闭清位。
  const pendingInitialFocusRef = useRef(false)
  const tryInitialFocus = useCallback(() => {
    if (!pendingInitialFocusRef.current) return
    const first = flattenCentralizedNavKeys(groups, roundOrderRef.current)[0]
    if (first === undefined) return
    const handle = questionRefs.current.get(first)
    if (!handle) return
    pendingInitialFocusRef.current = false
    // rAF: QuestionForm 刚挂载的同一 commit 里 ref 先于布局稳定，推迟一帧再落焦。
    requestAnimationFrame(() => handle.focus())
  }, [groups])
  useEffect(() => {
    // 只随 open 翻转置/清位——不得依赖 tryInitialFocus（groups 刷新会换其身份，若在此
    // 重跑置位，已消费的 pending 会被复活、下一次 ref 注册再次抢焦）。
    pendingInitialFocusRef.current = open
  }, [open])
  useEffect(() => {
    if (open) tryInitialFocus() // 重开场景：refs/order 都已在缓存，直接消费；已消费则 no-op。
  }, [open, tryInitialFocus])
  const registerQuestionRef = useCallback(
    (key: string, handle: QuestionFormHandle | null) => {
      if (handle === null) questionRefs.current.delete(key)
      else {
        questionRefs.current.set(key, handle)
        tryInitialFocus()
      }
    },
    [tryInitialFocus],
  )
  const reportRoundOrder = useCallback(
    (originNodeRunId: string, questionIds: string[]) => {
      roundOrderRef.current.set(originNodeRunId, questionIds)
      tryInitialFocus()
    },
    [tryInitialFocus],
  )
  const advanceFromQuestion = useCallback(
    (originNodeRunId: string, questionId: string) => {
      const keys = flattenCentralizedNavKeys(groups, roundOrderRef.current)
      const idx = keys.indexOf(`${originNodeRunId}:${questionId}`)
      if (idx === -1) return
      const nextKey = keys[idx + 1]
      // LAST question in the flattened order → NO-OP (用户拍板 2026-07-01): stay put, do NOT
      // auto-focus submit. Otherwise focus the next question — same-round next OR the first
      // question of the next round (one flat order across round boundaries).
      if (nextKey === undefined) return
      questionRefs.current.get(nextKey)?.focus()
    },
    [groups],
  )

  const submitMut = useMutation<void, Error, void>({
    mutationFn: async () => {
      const targets = groups
        .map((g) => ({ originNodeRunId: g.originNodeRunId, sub: submissions[g.originNodeRunId] }))
        .filter(
          (x): x is { originNodeRunId: string; sub: RoundSubmission } =>
            x.sub !== undefined && x.sub.questionIds.length > 0,
        )
      const results = await Promise.allSettled(
        targets.map(async ({ originNodeRunId, sub }) => {
          const body: SubmitClarifyAnswers = {
            answers: sub.answers,
            questionIds: sub.questionIds,
            directive: 'continue',
            // Control channel: seal into 待指派 without minting a rerun / resuming.
            defer: true,
            ifMatchIteration: sub.iteration,
          }
          // RFC-136 — declare the re-answers so the server may overwrite ONLY those
          // (an undeclared sealed question keeps the exactly-once 409, closing the
          // cross-channel race with a quick submit's seal→dispatch window).
          if (sub.resubmitQuestionIds.length > 0) {
            body.resubmitQuestionIds = sub.resubmitQuestionIds
          }
          // RFC-162: no questionScopes exist — self and cross answers post identically; the
          // asker's own handler entry (self/questioner) reruns to consume the answer.
          await api.post(`/api/clarify/${originNodeRunId}/answers`, body)
        }),
      )
      const failed = results.find((r) => r.status === 'rejected')
      if (failed !== undefined) {
        const reason = (failed as PromiseRejectedResult).reason
        throw reason instanceof Error ? reason : new Error(String(reason))
      }
    },
    onSuccess: () => {
      // Sealed questions leave the unsealed pool (board / pane / badge) + each round
      // detail flips its draft → answer. useTaskSync also refreshes via clarify.* WS.
      void qc.invalidateQueries({ queryKey: ['task-questions', taskId] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
      // RFC-161: a full seal here flips the clarify node_run awaiting_human → done, so
      // the task-detail canvas's clarify-node click target (clarifyNavKind) changes.
      // The defer control channel emits no answered WS event for THIS client, so
      // invalidate node-runs locally (the backend also broadcasts node.status for other
      // open clients — routes/clarify.ts).
      void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      for (const g of groups) {
        void qc.invalidateQueries({ queryKey: ['clarify', 'detail', g.originNodeRunId] })
      }
      onClose()
    },
  })

  let body: ReactNode
  if (tqQuery.isLoading) {
    body = <LoadingState />
  } else if (tqQuery.error !== null && tqQuery.error !== undefined) {
    body = <ErrorBanner error={tqQuery.error} />
  } else if (groups.length === 0) {
    body = <EmptyState title={t('taskQuestions.answerPaneEmpty')} />
  } else {
    body = (
      <div className="centralized-answer">
        <p className="muted" data-testid="centralized-answer-hint">
          {t('taskQuestions.answerPaneHint')}
        </p>
        {groups.map((g) => (
          <RoundAnswerBlock
            key={g.originNodeRunId}
            taskId={taskId}
            originNodeRunId={g.originNodeRunId}
            answerableQuestionIds={g.questionIds}
            resubmitQuestionIds={g.resubmitQuestionIds}
            disabled={submitMut.isPending}
            onSubmissionChange={onSubmissionChange}
            registerQuestionRef={registerQuestionRef}
            reportRoundOrder={reportRoundOrder}
            onAdvance={advanceFromQuestion}
          />
        ))}
        {submitMut.error !== null && submitMut.error !== undefined && (
          <ErrorBanner error={submitMut.error} />
        )}
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('taskQuestions.answerPaneTitle')}
      size="lg"
      data-testid="centralized-answer-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={filledTotal === 0 || submitMut.isPending}
            onClick={() => submitMut.mutate()}
            data-testid="centralized-answer-submit"
          >
            {filledTotal > 0
              ? t('taskQuestions.answerPaneSubmitCount', { count: filledTotal })
              : t('taskQuestions.answerPaneSubmit')}
          </button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}

interface RoundAnswerBlockProps {
  taskId: string
  originNodeRunId: string
  /** The answerable (待指派) question ids of this round — fresh AND re-answers (RFC-136). */
  answerableQuestionIds: string[]
  /** RFC-136 — subset of answerableQuestionIds that are RE-answers (sealed, prefilled from
   *  the committed answer; resubmission overwrites). */
  resubmitQuestionIds: string[]
  disabled: boolean
  onSubmissionChange: (originNodeRunId: string, sub: RoundSubmission | null) => void
  /** RFC-128 (用户 2026-07-01) cross-round keyboard nav — register/unregister this round's
   *  QuestionForm imperative handles into the dialog's global Map (key `${origin}:${qid}`). */
  registerQuestionRef: (key: string, handle: QuestionFormHandle | null) => void
  /** Report this round's VISIBLE question order up so the dialog's flat nav order matches the
   *  reviewer's render order (see flattenCentralizedNavKeys). */
  reportRoundOrder: (originNodeRunId: string, questionIds: string[]) => void
  /** Advance keyboard focus from (round, question) to the next question in the flattened global
   *  order. A NO-OP at the very last question (用户拍板 2026-07-01 — submit is never auto-focused). */
  onAdvance: (originNodeRunId: string, questionId: string) => void
}

/** One clarify round's answer block. Owns its local answer state + draft autosave (the
 *  SAME server draft endpoint the /clarify page uses, so drafts are shared across both
 *  entry points) and reports its filled subset up. RFC-137/RFC-162: a CROSS round answers
 *  uniformly with a SELF round — no per-question scope UI, and scope no longer exists. The
 *  asker's own handler entry (self/questioner) reruns to consume the answer; "let the upstream
 *  revise" is a separate manual reassign that adds a designer handler row on the board. */
function RoundAnswerBlock({
  taskId,
  originNodeRunId,
  answerableQuestionIds,
  resubmitQuestionIds,
  disabled,
  onSubmissionChange,
  registerQuestionRef,
  reportRoundOrder,
  onAdvance,
}: RoundAnswerBlockProps) {
  const { t } = useTranslation()
  const roundQuery = useQuery<ClarifyRound, ApiError>({
    queryKey: ['clarify', 'detail', originNodeRunId],
    queryFn: ({ signal }) => api.get(`/api/clarify/${originNodeRunId}`, undefined, signal),
    retry: false,
  })
  // Frozen workflow snapshot — resolves the header's asking-node display name. Same
  // queryKey as ClarifyQuestionHandler (below), so the two share one cache entry.
  const task = useQuery<{ workflowSnapshot?: WorkflowDefinition }>({
    queryKey: ['tasks', taskId, 'snapshot'],
    queryFn: () => api.get<{ workflowSnapshot?: WorkflowDefinition }>(`/api/tasks/${taskId}`),
  })
  const round = roundQuery.data
  const isCross = round?.kind === 'cross'

  const answerableSet = useMemo(() => new Set(answerableQuestionIds), [answerableQuestionIds])
  const resubmitSet = useMemo(() => new Set(resubmitQuestionIds), [resubmitQuestionIds])
  const visibleQuestions = useMemo(
    () => (round?.questions ?? []).filter((q) => answerableSet.has(q.id)),
    [round?.questions, answerableSet],
  )

  // Report this round's visible render order up for the dialog's cross-round nav order. Ref-only
  // write in the parent (no state) ⇒ no re-render / loop. Runs whenever the visible set changes.
  useEffect(() => {
    reportRoundOrder(
      originNodeRunId,
      visibleQuestions.map((q) => q.id),
    )
  }, [originNodeRunId, visibleQuestions, reportRoundOrder])

  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({})
  const [seeded, setSeeded] = useState(false)
  // Mirrors the last server-acknowledged draft per question, so the autosave only PUTs
  // the questions that actually changed (RFC-099 per-question last-write-wins).
  const serverDraftRef = useRef<Record<string, ClarifyAnswer>>({})
  const serverDraftDisabledRef = useRef(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed once the round loads: server drafts (collaborative SoT, shared with /clarify)
  // win; the local IDB draft is the offline fallback when there's no server draft.
  // RFC-136 (D5): a RE-answer question seeds from its COMMITTED answer (round.answers) and
  // ignores any leftover draft — the seal path never clears drafts, so a stale pre-commit
  // draft would pollute the "edit the committed answer" mental model. Codex 实现门 P3 fold:
  // re-answer edits are deliberately NOT draft-persisted either (the autosave below is gated
  // to awaiting_human rounds, and seed ignores drafts for resubmit ids anyway) — the
  // committed answer IS the durable baseline; closing the pane discards an un-submitted
  // edit, same as any unsaved form.
  useEffect(() => {
    if (round === undefined || seeded) return
    const fresh: Record<string, ClarifyAnswer> = {}
    for (const q of visibleQuestions) {
      fresh[q.id] = {
        questionId: q.id,
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
      }
    }
    for (const a of round.answers ?? []) {
      if (resubmitSet.has(a.questionId) && fresh[a.questionId] !== undefined) {
        fresh[a.questionId] = {
          questionId: a.questionId,
          selectedOptionIndices: a.selectedOptionIndices ?? [],
          selectedOptionLabels: [],
          customText: a.customText ?? '',
        }
      }
    }
    const finalize = () => {
      serverDraftRef.current = { ...fresh }
      setAnswers(fresh)
      setSeeded(true)
    }
    const serverDrafts = round.draftAnswers ?? null
    if (serverDrafts !== null && Object.keys(serverDrafts).length > 0) {
      for (const [qid, v] of Object.entries(serverDrafts)) {
        if (fresh[qid] !== undefined && !resubmitSet.has(qid)) {
          fresh[qid] = {
            questionId: qid,
            selectedOptionIndices: v.selectedOptionIndices ?? [],
            selectedOptionLabels: [],
            customText: v.customText ?? '',
          }
        }
      }
      finalize()
      return
    }
    let cancelled = false
    void getClarifyDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId: round.id })
      .then((stored) => {
        if (cancelled || stored === null) return
        for (const a of stored) {
          if (fresh[a.questionId] !== undefined && !resubmitSet.has(a.questionId)) {
            fresh[a.questionId] = a
          }
        }
      })
      .finally(() => {
        if (!cancelled) finalize()
      })
    return () => {
      cancelled = true
    }
  }, [round, seeded, visibleQuestions, resubmitSet, taskId, originNodeRunId])

  // Debounced draft autosave — one server PUT per changed question (shared key with
  // /clarify) + an IDB mirror. Only while the round is still awaiting answers.
  // RFC-136 (Codex 实现门 P3 fold): resubmit (re-answer) questions are EXCLUDED — their
  // durable baseline is the committed answer (seed ignores drafts for them, D5), so a
  // draft write would only pollute the shared /clarify draft face without ever being read.
  useEffect(() => {
    if (round === undefined || !seeded || round.status !== 'awaiting_human') return
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    const roundId = round.id
    draftTimerRef.current = setTimeout(() => {
      const arr = visibleQuestions
        .filter((q) => !resubmitSet.has(q.id))
        .map(
          (q) =>
            answers[q.id] ?? {
              questionId: q.id,
              selectedOptionIndices: [],
              selectedOptionLabels: [],
              customText: '',
            },
        )
      if (arr.length === 0) return
      const puts: Array<Promise<unknown>> = []
      if (!serverDraftDisabledRef.current) {
        for (const a of arr) {
          const prev = serverDraftRef.current[a.questionId]
          if (prev !== undefined && answersEqual(prev, a)) continue
          serverDraftRef.current[a.questionId] = a
          puts.push(
            api
              .put(`/api/clarify/${originNodeRunId}/draft`, {
                roundId,
                questionId: a.questionId,
                selectedOptionIndices: a.selectedOptionIndices,
                customText: a.customText,
              })
              .catch(() => {
                // 403 (not a member) / 409 (round sealed under us) — stop hammering;
                // the IDB mirror keeps working locally.
                serverDraftDisabledRef.current = true
              }),
          )
        }
      }
      void Promise.allSettled([
        setClarifyDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId }, arr),
        ...puts,
      ])
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    }
  }, [answers, seeded, round, visibleQuestions, resubmitSet, taskId, originNodeRunId])

  // Report the filled subset up so the dialog's single submit can collect it.
  useEffect(() => {
    if (round === undefined || !seeded) {
      onSubmissionChange(originNodeRunId, null)
      return
    }
    const filled = visibleQuestions
      .map((q) => answers[q.id])
      .filter((a): a is ClarifyAnswer => isAnswerFilled(a))
    if (filled.length === 0) {
      onSubmissionChange(originNodeRunId, null)
      return
    }
    const questionIds = filled.map((a) => a.questionId)
    const sub: RoundSubmission = {
      roundId: round.id,
      iteration: round.iteration,
      answers: filled,
      questionIds,
      // RFC-136 — declare which of the filled ids are re-answers (prefilled from the
      // committed answer); the server only overwrites declared ids.
      resubmitQuestionIds: questionIds.filter((qid) => resubmitSet.has(qid)),
    }
    onSubmissionChange(originNodeRunId, sub)
  }, [answers, seeded, round, visibleQuestions, resubmitSet, originNodeRunId, onSubmissionChange])

  // Drop this round's contribution when it unmounts (left `groups`).
  useEffect(
    () => () => onSubmissionChange(originNodeRunId, null),
    [originNodeRunId, onSubmissionChange],
  )

  // 用户 2026-07-02: 分组头显示提问节点的节点名（title → agentName → id 回退）。快照查询与
  // ClarifyQuestionHandler 共用同一 queryKey，React Query 去重为一次请求。
  const askingNodeName =
    round === undefined
      ? null
      : (resolveNodeNameFromSnapshot(task.data?.workflowSnapshot, round.askingNodeId) ??
        round.askingNodeId)
  const header =
    round === undefined
      ? originNodeRunId
      : isCross
        ? t('crossClarify.contextCard', { name: askingNodeName, n: round.iteration })
        : t('clarify.detail.contextCard', { name: askingNodeName, n: round.iteration })

  return (
    <Card data-testid={`centralized-round-${originNodeRunId}`}>
      <div className="card__title">{header}</div>
      {roundQuery.isLoading && <LoadingState />}
      {roundQuery.error !== null && roundQuery.error !== undefined && (
        <ErrorBanner error={roundQuery.error} />
      )}
      {round !== undefined &&
        visibleQuestions.map((q, idx) => {
          const a = answers[q.id]
          if (a === undefined) return null
          const isResubmit = resubmitSet.has(q.id)
          return (
            <div key={q.id} className="clarify-question-wrapper" data-question-wrapper-id={q.id}>
              {/* designer-domain reassign picker — scoped to THIS round (Codex P2-2) so it
                  never matches a sibling round's designer entry that reused the same id;
                  self-degrades to null until the question is sealed (post-seal, on the board). */}
              <ClarifyQuestionHandler
                taskId={taskId}
                questionId={q.id}
                originNodeRunId={originNodeRunId}
              />
              {/* RFC-136 — 重答提示：预填的是已提交答案，重新提交将就地覆盖。 */}
              {isResubmit && (
                <p className="muted" data-testid={`centralized-resubmit-hint-${q.id}`}>
                  {t('taskQuestions.answerPaneResubmitHint')}
                </p>
              )}
              {/* RFC-137/RFC-162: no per-question scope UI — self and cross questions answer
                  identically here (scope removed entirely). */}
              <QuestionForm
                ref={(h) => registerQuestionRef(`${originNodeRunId}:${q.id}`, h)}
                question={q}
                value={a}
                index={idx + 1}
                disabled={disabled}
                onChange={(next) => setAnswers((prev) => ({ ...prev, [q.id]: next }))}
                onAdvance={() => onAdvance(originNodeRunId, q.id)}
              />
            </div>
          )
        })}
    </Card>
  )
}
