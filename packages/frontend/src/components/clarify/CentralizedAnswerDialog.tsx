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
import { FeedbackStack } from '@/components/FeedbackStack'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { QuestionForm, type QuestionFormHandle } from '@/components/clarify/QuestionForm'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { answersEqual, isAnswerFilled } from '@/lib/clarify/answers'
import { deleteClarifyDraft, getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'
import {
  createClarifyDraftDurabilityController,
  projectClarifyDraftStatus,
  type ClarifyDraftDurabilityController,
  type ClarifyDraftGenerationState,
} from '@/lib/clarify/durability'
import { resolveNodeNameFromSnapshot } from '@/lib/node-names'

const DRAFT_DEBOUNCE_MS = 500
const INITIAL_DRAFT_GENERATION_STATE: ClarifyDraftGenerationState = {
  latestGeneration: 0,
  localAckGeneration: 0,
  latestQuestionGeneration: {},
  serverAckGenerationByQuestion: {},
  localPending: false,
  serverPending: false,
  localError: null,
  serverError: null,
  serverRetryable: false,
  sealed: false,
}

function emptyAnswer(questionId: string): ClarifyAnswer {
  return {
    questionId,
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText: '',
  }
}

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

interface RoundDurabilityHandle {
  flushLocal: () => Promise<void>
  seal: () => Promise<void>
}

class PartialRoundSubmitError extends Error {}

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
  const durabilityHandlesRef = useRef<Map<string, RoundDurabilityHandle>>(new Map())
  const completedRoundIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [completedRoundIds, setCompletedRoundIds] = useState<ReadonlySet<string>>(new Set())
  const [roundSubmitErrors, setRoundSubmitErrors] = useState<Record<string, unknown>>({})
  const submitMutatingRef = useRef(false)
  const closePendingRef = useRef(false)
  const [closePending, setClosePending] = useState(false)
  const [closeError, setCloseError] = useState<unknown>(null)
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
  const registerDurability = useCallback(
    (originNodeRunId: string, handle: RoundDurabilityHandle | null) => {
      if (handle === null) durabilityHandlesRef.current.delete(originNodeRunId)
      else durabilityHandlesRef.current.set(originNodeRunId, handle)
    },
    [],
  )
  const markRoundCompleted = useCallback(
    (originNodeRunId: string) => {
      if (completedRoundIdsRef.current.has(originNodeRunId)) return
      const next = new Set(completedRoundIdsRef.current)
      next.add(originNodeRunId)
      completedRoundIdsRef.current = next
      setCompletedRoundIds(next)
      onSubmissionChange(originNodeRunId, null)
      setRoundSubmitErrors((previous) => {
        if (!(originNodeRunId in previous)) return previous
        const remaining = { ...previous }
        delete remaining[originNodeRunId]
        return remaining
      })
    },
    [onSubmissionChange],
  )

  useEffect(() => {
    if (!open) {
      completedRoundIdsRef.current = new Set()
      setCompletedRoundIds(new Set())
      setRoundSubmitErrors({})
      closePendingRef.current = false
      setClosePending(false)
      setCloseError(null)
    }
  }, [open])

  const closeAfterLocalSave = useCallback(async () => {
    if (closePendingRef.current || submitMutatingRef.current) return
    closePendingRef.current = true
    setClosePending(true)
    setCloseError(null)
    try {
      // Save-and-leave intentionally waits for IndexedDB only. Each handle's
      // per-question server queue may continue after the dialog unmounts.
      await Promise.all(
        [...durabilityHandlesRef.current.values()].map((handle) => handle.flushLocal()),
      )
      onClose()
    } catch (error) {
      setCloseError(error)
    } finally {
      closePendingRef.current = false
      setClosePending(false)
    }
  }, [onClose])

  const activeGroups = useMemo(
    () => groups.filter((group) => !completedRoundIds.has(group.originNodeRunId)),
    [completedRoundIds, groups],
  )
  const filledTotal = useMemo(
    () =>
      activeGroups.reduce(
        (n, g) => n + (submissions[g.originNodeRunId]?.questionIds.length ?? 0),
        0,
      ),
    [activeGroups, submissions],
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
      const targets = activeGroups
        .map((g) => ({ originNodeRunId: g.originNodeRunId, sub: submissions[g.originNodeRunId] }))
        .filter(
          (x): x is { originNodeRunId: string; sub: RoundSubmission } =>
            x.sub !== undefined && x.sub.questionIds.length > 0,
        )
        .filter((x) => !completedRoundIdsRef.current.has(x.originNodeRunId))
      setRoundSubmitErrors((previous) => {
        const next = { ...previous }
        for (const target of targets) delete next[target.originNodeRunId]
        return next
      })

      const results = await Promise.all(
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
          try {
            await api.post(`/api/clarify/${originNodeRunId}/answers`, body)
          } catch (error) {
            return { kind: 'failed' as const, originNodeRunId, error }
          }

          // Settle each round independently. A successful round leaves both the visible
          // pane and every future retry target as soon as its own POST fulfills; it must
          // never be replayed merely because a sibling round later fails.
          const durability = durabilityHandlesRef.current.get(originNodeRunId)
          markRoundCompleted(originNodeRunId)
          void qc.invalidateQueries({ queryKey: ['task-questions', taskId] })
          void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
          void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
          void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
          void qc.invalidateQueries({ queryKey: ['clarify', 'detail', originNodeRunId] })

          try {
            // Stop the queued writer, wait for an already-running IDB transaction,
            // then delete only this successful round's local draft. Failed sibling
            // rounds deliberately keep both their controller and draft intact.
            await durability?.seal()
            await deleteClarifyDraft({
              taskId,
              intermediaryNodeRunId: originNodeRunId,
              roundId: sub.roundId,
            })
            return { kind: 'succeeded' as const, originNodeRunId }
          } catch (error) {
            // The server submission already succeeded, so this remains completed and
            // excluded from retries even if local cleanup reports an error.
            return { kind: 'cleanup-failed' as const, originNodeRunId, error }
          }
        }),
      )
      const failed = results.filter(
        (result): result is Extract<(typeof results)[number], { kind: 'failed' }> =>
          result.kind === 'failed',
      )
      if (failed.length > 0) {
        setRoundSubmitErrors((previous) => ({
          ...previous,
          ...Object.fromEntries(failed.map((result) => [result.originNodeRunId, result.error])),
        }))
      }

      const cleanupFailure = results.find((result) => result.kind === 'cleanup-failed')
      if (cleanupFailure !== undefined) {
        const reason = cleanupFailure.error
        throw reason instanceof Error ? reason : new Error(String(reason))
      }
      if (failed.length > 0) {
        throw new PartialRoundSubmitError(
          t('taskQuestions.answerPanePartialFailed', { count: failed.length }),
        )
      }
    },
    onSuccess: () => {
      onClose()
    },
    onSettled: () => {
      submitMutatingRef.current = false
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
        {activeGroups.map((g) => (
          <RoundAnswerBlock
            key={g.originNodeRunId}
            taskId={taskId}
            originNodeRunId={g.originNodeRunId}
            answerableQuestionIds={g.questionIds}
            resubmitQuestionIds={g.resubmitQuestionIds}
            submitError={roundSubmitErrors[g.originNodeRunId] ?? null}
            disabled={submitMut.isPending || closePending}
            onSubmissionChange={onSubmissionChange}
            registerDurability={registerDurability}
            registerQuestionRef={registerQuestionRef}
            reportRoundOrder={reportRoundOrder}
            onAdvance={advanceFromQuestion}
          />
        ))}
        {submitMut.error !== null &&
          submitMut.error !== undefined &&
          !(submitMut.error instanceof PartialRoundSubmitError) && (
            <ErrorBanner error={submitMut.error} />
          )}
        {closeError !== null && closeError !== undefined && (
          <ErrorBanner
            error={closeError}
            message={t('clarify.detail.draftSaveFailed')}
            onRetry={() => void closeAfterLocalSave()}
            testid="centralized-draft-close-error"
          />
        )}
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={() => void closeAfterLocalSave()}
      dismissDisabled={closePending || submitMut.isPending}
      title={t('taskQuestions.answerPaneTitle')}
      size="lg"
      data-testid="centralized-answer-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={closePending || submitMut.isPending}
            onClick={() => void closeAfterLocalSave()}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={filledTotal === 0 || submitMut.isPending || closePending}
            onClick={() => {
              if (submitMutatingRef.current || closePendingRef.current) return
              submitMutatingRef.current = true
              submitMut.mutate()
            }}
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
  submitError: unknown | null
  disabled: boolean
  onSubmissionChange: (originNodeRunId: string, sub: RoundSubmission | null) => void
  registerDurability: (originNodeRunId: string, handle: RoundDurabilityHandle | null) => void
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
  submitError,
  disabled,
  onSubmissionChange,
  registerDurability,
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
  const persistedQuestionIds = useMemo(
    () =>
      round?.status === 'awaiting_human'
        ? visibleQuestions.filter((q) => !resubmitSet.has(q.id)).map((q) => q.id)
        : [],
    [round?.status, visibleQuestions, resubmitSet],
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
  const answersRef = useRef<Record<string, ClarifyAnswer>>({})
  const [seeded, setSeeded] = useState(false)
  const [draftGenerationState, setDraftGenerationState] = useState<ClarifyDraftGenerationState>(
    INITIAL_DRAFT_GENERATION_STATE,
  )
  const durabilityRef = useRef<ClarifyDraftDurabilityController | null>(null)
  const durabilityUnsubscribeRef = useRef<(() => void) | null>(null)

  // UI listeners/parent handles are component-scoped, but removing them must not cancel
  // the controller itself: an already-enqueued IDB write and a debounced server PUT stay
  // alive after the dialog unmounts.
  useEffect(
    () => () => {
      durabilityUnsubscribeRef.current?.()
      durabilityUnsubscribeRef.current = null
      registerDurability(originNodeRunId, null)
    },
    [originNodeRunId, registerDurability],
  )

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
      fresh[q.id] = emptyAnswer(q.id)
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
    let cancelled = false
    const attachController = (
      initial: Record<string, ClarifyAnswer>,
      serverBaseline: Record<string, ClarifyAnswer>,
      initialLocalPersisted: boolean,
    ) => {
      if (cancelled) return
      // The durability queues intentionally outlive this component's UI listener.
      // Capture their concrete writers so an unmounted round cannot be redirected
      // through a later module/mock replacement.
      const persistDraft = setClarifyDraft
      const putServerDraft = api.put
      const toArray = (record: Record<string, ClarifyAnswer>) =>
        visibleQuestions.map((question) => record[question.id] ?? emptyAnswer(question.id))
      const controller = createClarifyDraftDurabilityController({
        initialAnswers: toArray(initial),
        serverAnswers: toArray(serverBaseline),
        initialLocalPersisted,
        persistedQuestionIds,
        debounceMs: DRAFT_DEBOUNCE_MS,
        writeLocal: ({ answers: next }) =>
          persistDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId: round.id }, next),
        writeServer: async ({ answer }) => {
          await putServerDraft(`/api/clarify/${originNodeRunId}/draft`, {
            roundId: round.id,
            questionId: answer.questionId,
            selectedOptionIndices: answer.selectedOptionIndices,
            customText: answer.customText,
          })
        },
      })
      durabilityUnsubscribeRef.current?.()
      durabilityRef.current = controller
      durabilityUnsubscribeRef.current = controller.subscribe(setDraftGenerationState)
      registerDurability(originNodeRunId, {
        flushLocal: () => controller.flushLocal(),
        seal: () => controller.seal(),
      })
      answersRef.current = initial
      setAnswers(initial)
      setSeeded(true)
    }
    const serverDrafts = round.draftAnswers ?? null
    if (serverDrafts !== null && Object.keys(serverDrafts).length > 0) {
      const serverBaseline = { ...fresh }
      for (const [qid, v] of Object.entries(serverDrafts)) {
        if (serverBaseline[qid] !== undefined && !resubmitSet.has(qid)) {
          serverBaseline[qid] = {
            questionId: qid,
            selectedOptionIndices: v.selectedOptionIndices ?? [],
            selectedOptionLabels: [],
            customText: v.customText ?? '',
          }
        }
      }
      attachController(serverBaseline, serverBaseline, false)
      return () => {
        cancelled = true
      }
    }
    void getClarifyDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId: round.id })
      .then((stored) => {
        if (cancelled) return
        const initial = { ...fresh }
        if (stored !== null) {
          for (const a of stored) {
            if (initial[a.questionId] !== undefined && !resubmitSet.has(a.questionId)) {
              initial[a.questionId] = a
            }
          }
        }
        attachController(initial, fresh, stored !== null)
      })
      .catch(() => attachController(fresh, fresh, false))
    return () => {
      cancelled = true
    }
  }, [
    round,
    seeded,
    visibleQuestions,
    resubmitSet,
    persistedQuestionIds,
    taskId,
    originNodeRunId,
    registerDurability,
  ])

  // RFC-250 T15-T17: every material answer edit enters the shared generation controller
  // synchronously. Local IDB snapshots are serial/coalesced; server writes remain debounced
  // and single-flight per question. RFC-136 re-answer questions retain their established
  // committed-answer baseline and remain excluded from drafts.
  const updateAnswer = (questionId: string, nextAnswer: ClarifyAnswer): void => {
    const next = { ...answersRef.current, [questionId]: nextAnswer }
    answersRef.current = next
    setAnswers(next)
    durabilityRef.current?.recordChange(
      visibleQuestions.map((question) => next[question.id] ?? emptyAnswer(question.id)),
      questionId,
    )
  }

  // RFC-099 D14: adopt a collaborative remote draft only while this question has not
  // diverged from the last acknowledged server value. A late refetch can never overwrite
  // a queued/newer local generation.
  useEffect(() => {
    if (round === undefined || !seeded || round.status !== 'awaiting_human') return
    const serverDrafts = round.draftAnswers ?? null
    const controller = durabilityRef.current
    if (serverDrafts === null || controller === null) return
    const current = answersRef.current
    const next = { ...current }
    let changed = false
    for (const [questionId, value] of Object.entries(serverDrafts)) {
      const local = current[questionId]
      if (local === undefined || resubmitSet.has(questionId)) continue
      const remote: ClarifyAnswer = {
        questionId,
        selectedOptionIndices: value.selectedOptionIndices ?? [],
        selectedOptionLabels: [],
        customText: value.customText ?? '',
      }
      if (!controller.tryAdoptRemote(questionId, local, remote)) continue
      if (!answersEqual(local, remote)) {
        next[questionId] = remote
        changed = true
      }
    }
    if (changed) {
      answersRef.current = next
      setAnswers(next)
    }
  }, [round, seeded, resubmitSet])

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
  const draftStatus = projectClarifyDraftStatus(draftGenerationState)
  const draftStatusLabel =
    draftStatus.kind === 'sealed'
      ? t('clarify.detail.roundSealedFooter')
      : draftStatus.kind === 'saving'
        ? t('clarify.detail.draftSaving')
        : draftStatus.kind === 'saved'
          ? t('clarify.detail.draftSaved')
          : draftStatus.kind === 'local-only'
            ? t('clarify.detail.draftLocalOnly')
            : t('clarify.detail.draftSaveFailed')

  return (
    <Card data-testid={`centralized-round-${originNodeRunId}`}>
      <div className="card__title">{header}</div>
      {submitError !== null && (
        <ErrorBanner error={submitError} testid={`centralized-submit-error-${originNodeRunId}`} />
      )}
      {roundQuery.isLoading && <LoadingState />}
      {roundQuery.error !== null && roundQuery.error !== undefined && (
        <ErrorBanner error={roundQuery.error} />
      )}
      {seeded && persistedQuestionIds.length > 0 && (
        <FeedbackStack>
          {draftStatus.kind === 'error' && (
            <ErrorBanner
              error={draftStatus.error}
              message={t('clarify.detail.draftSaveFailed')}
              onRetry={() => {
                void durabilityRef.current?.retryLocal().catch(() => {})
              }}
              testid={`centralized-draft-local-error-${originNodeRunId}`}
            />
          )}
          {draftStatus.kind === 'local-only' && (
            <NoticeBanner
              tone="warning"
              size="compact"
              testid={`centralized-draft-local-only-${originNodeRunId}`}
              action={
                draftStatus.canRetryServer ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => durabilityRef.current?.retryServer()}
                    data-testid={`centralized-draft-server-retry-${originNodeRunId}`}
                  >
                    {t('common.retry')}
                  </button>
                ) : undefined
              }
            >
              {t('clarify.detail.draftLocalOnly')}
            </NoticeBanner>
          )}
          <p
            className="muted"
            role="status"
            data-draft-status={draftStatus.kind}
            data-testid={`centralized-draft-indicator-${originNodeRunId}`}
          >
            {draftStatusLabel}
          </p>
        </FeedbackStack>
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
                onChange={(next) => updateAnswer(q.id, next)}
                onAdvance={() => onAdvance(originNodeRunId, q.id)}
              />
            </div>
          )
        })}
    </Card>
  )
}
