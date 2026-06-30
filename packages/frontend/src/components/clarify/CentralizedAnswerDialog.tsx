// RFC-128 P4 (T9) — centralized answer pane.
//
// A single page (full-width Dialog) that flattens EVERY unsealed 待指派 clarify
// question of a task, grouped by its originating clarify round, and seals them all
// with ONE submit button. Per user (2026-06-30): "页面和反问界面功能一致、只是只有
// 一个提交按钮" — so it reuses the /clarify primitives wholesale (QuestionForm /
// ClarifyQuestionHandler / the .segmented scope control / Card / Dialog / EmptyState
// / ErrorBanner / LoadingState) and only collapses the per-round submit into one.
//
// Channel = control (defer=true): each round's filled subset is POSTed to
// `/api/clarify/:nodeRunId/answers` with `defer:true` + a `questionIds` cap, which
// seals those questions into 待指派 WITHOUT minting a rerun. The board then picks an
// agent + dispatches. Which questions remain to answer is read from the per-question
// `sealed` DTO field (NOT answerSummary — Codex design gate F3: a partial round leaves
// answerSummary unreliable). An unsealed question is necessarily in the 'pending' phase.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  ClarifyAnswer,
  ClarifyQuestionScope,
  ClarifyRound,
  SubmitClarifyAnswers,
} from '@agent-workflow/shared'
import { CLARIFY_QUESTION_SCOPE_DEFAULT } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { QuestionForm } from '@/components/clarify/QuestionForm'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { answersEqual, isAnswerFilled } from '@/lib/clarify/answers'
import { getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'

const DRAFT_DEBOUNCE_MS = 500

export interface CentralizedAnswerGroup {
  originNodeRunId: string
  questionIds: string[]
}

/** Pure oracle (unit-tested): the task's UNSEALED clarify questions grouped by their
 *  originating clarify round (originNodeRunId), in stable first-appearance order.
 *
 *  RFC-128 P5-BC — the pane now surfaces SELF-clarify AND cross (questioner/designer) questions:
 *  the P4 designer-only filter (sourceKind === 'cross') is GONE. P5-BC's self/questioner park +
 *  dispatch path means a defer-sealed self/questioner question is NO LONGER stranded — it parks
 *  its home (loadUndispatchedSelfQuestionerTargets) until board dispatch mints the continuation.
 *  Cross questions get a per-question scope picker (designer ↔ questioner) below.
 *
 *  Excluded: already-sealed questions (`sealed` per-question DTO field, NOT
 *  `answerSummary !== null` — F3) and manual questions (originNodeRunId null — the
 *  instruction IS the content, nothing to answer). Dedup is by (round, questionId): a cross
 *  round's questioner + designer entries share a questionId → one render. */
export function groupUnsealedQuestions(entries: TaskQuestionEntry[]): CentralizedAnswerGroup[] {
  const order: string[] = []
  const byRound = new Map<string, string[]>()
  for (const e of entries) {
    if (e.sealed) continue
    if (e.originNodeRunId === null) continue
    let qids = byRound.get(e.originNodeRunId)
    if (qids === undefined) {
      qids = []
      byRound.set(e.originNodeRunId, qids)
      order.push(e.originNodeRunId)
    }
    if (!qids.includes(e.questionId)) qids.push(e.questionId)
  }
  return order.map((originNodeRunId) => ({
    originNodeRunId,
    questionIds: byRound.get(originNodeRunId)!,
  }))
}

/** One round's pending submission, reported up to the dialog by its RoundAnswerBlock. */
interface RoundSubmission {
  roundId: string
  iteration: number
  kind: ClarifyRound['kind']
  /** Filled answers only (a question with no pick / text is left for later). */
  answers: ClarifyAnswer[]
  /** questionIds of `answers` — the subset cap sent to the backend. */
  questionIds: string[]
  /** cross only — per-question scope for the filled questions. */
  questionScopes?: Record<string, ClarifyQuestionScope>
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
    () => groupUnsealedQuestions(Array.isArray(tqQuery.data) ? tqQuery.data : []),
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
          if (sub.kind === 'cross' && sub.questionScopes !== undefined) {
            body.questionScopes = sub.questionScopes
          }
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
            unsealedQuestionIds={g.questionIds}
            disabled={submitMut.isPending}
            onSubmissionChange={onSubmissionChange}
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
  unsealedQuestionIds: string[]
  disabled: boolean
  onSubmissionChange: (originNodeRunId: string, sub: RoundSubmission | null) => void
}

/** One clarify round's answer block. Owns its local answer state + draft autosave (the
 *  SAME server draft endpoint the /clarify page uses, so drafts are shared across both
 *  entry points) and reports its filled subset up. RFC-128 P5-BC: a CROSS round renders a
 *  per-question scope picker (designer ↔ questioner) — both routes now defer-dispatch via the
 *  board (designer via §18, questioner via the P5-BC self/questioner park). A SELF round has
 *  no scope (the asking agent is its own consumer). */
function RoundAnswerBlock({
  taskId,
  originNodeRunId,
  unsealedQuestionIds,
  disabled,
  onSubmissionChange,
}: RoundAnswerBlockProps) {
  const { t } = useTranslation()
  const roundQuery = useQuery<ClarifyRound, ApiError>({
    queryKey: ['clarify', 'detail', originNodeRunId],
    queryFn: ({ signal }) => api.get(`/api/clarify/${originNodeRunId}`, undefined, signal),
    retry: false,
  })
  const round = roundQuery.data
  const isCross = round?.kind === 'cross'

  const unsealedSet = useMemo(() => new Set(unsealedQuestionIds), [unsealedQuestionIds])
  const visibleQuestions = useMemo(
    () => (round?.questions ?? []).filter((q) => unsealedSet.has(q.id)),
    [round?.questions, unsealedSet],
  )

  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({})
  // RFC-128 P5-BC: per-question scope for a CROSS round (designer ↔ questioner). Defaults to
  // designer (CLARIFY_QUESTION_SCOPE_DEFAULT) — the user toggles to route a question to the
  // questioner. Empty / unused for a self round.
  const [scopes, setScopes] = useState<Record<string, ClarifyQuestionScope>>({})
  const [seeded, setSeeded] = useState(false)
  // Mirrors the last server-acknowledged draft per question, so the autosave only PUTs
  // the questions that actually changed (RFC-099 per-question last-write-wins).
  const serverDraftRef = useRef<Record<string, ClarifyAnswer>>({})
  const serverDraftDisabledRef = useRef(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed once the round loads: server drafts (collaborative SoT, shared with /clarify)
  // win; the local IDB draft is the offline fallback when there's no server draft.
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
    const finalize = () => {
      serverDraftRef.current = { ...fresh }
      setAnswers(fresh)
      setSeeded(true)
    }
    const serverDrafts = round.draftAnswers ?? null
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
      finalize()
      return
    }
    let cancelled = false
    void getClarifyDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId: round.id })
      .then((stored) => {
        if (cancelled || stored === null) return
        for (const a of stored) {
          if (fresh[a.questionId] !== undefined) fresh[a.questionId] = a
        }
      })
      .finally(() => {
        if (!cancelled) finalize()
      })
    return () => {
      cancelled = true
    }
  }, [round, seeded, visibleQuestions, taskId, originNodeRunId])

  // Debounced draft autosave — one server PUT per changed question (shared key with
  // /clarify) + an IDB mirror. Only while the round is still awaiting answers.
  useEffect(() => {
    if (round === undefined || !seeded || round.status !== 'awaiting_human') return
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    const roundId = round.id
    draftTimerRef.current = setTimeout(() => {
      const arr = visibleQuestions.map(
        (q) =>
          answers[q.id] ?? {
            questionId: q.id,
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: '',
          },
      )
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
  }, [answers, seeded, round, visibleQuestions, taskId, originNodeRunId])

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
      kind: round.kind,
      answers: filled,
      questionIds,
    }
    // RFC-128 P5-BC: send the per-question scope the user chose (default designer). A
    // designer-scope question → §18 designer dispatch; a questioner-scope question → P5-BC
    // self/questioner park + dispatch. Self rounds carry no scope.
    if (round.kind === 'cross') {
      const qs: Record<string, ClarifyQuestionScope> = {}
      for (const qid of questionIds) qs[qid] = scopes[qid] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
      sub.questionScopes = qs
    }
    onSubmissionChange(originNodeRunId, sub)
  }, [answers, scopes, seeded, round, visibleQuestions, originNodeRunId, onSubmissionChange])

  // Drop this round's contribution when it unmounts (left `groups`).
  useEffect(
    () => () => onSubmissionChange(originNodeRunId, null),
    [originNodeRunId, onSubmissionChange],
  )

  const header =
    round === undefined
      ? originNodeRunId
      : isCross
        ? t('crossClarify.contextCard', { name: round.askingNodeId, n: round.iteration })
        : t('clarify.detail.contextCard', { name: round.askingNodeId, n: round.iteration })

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
              {/* RFC-128 P5-BC: per-question scope picker for a CROSS round (designer ↔
                  questioner). Mirrors the /clarify .segmented control; reuses its i18n. A self
                  round renders none (the asking agent is its own consumer). */}
              {isCross && (
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label={t('crossClarify.questionScope.label')}
                  data-testid={`centralized-scope-${q.id}`}
                >
                  {(['designer', 'questioner'] as const).map((mode) => {
                    const active = (scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT) === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={
                          'segmented__option' + (active ? ' segmented__option--active' : '')
                        }
                        disabled={disabled}
                        onClick={() => setScopes((prev) => ({ ...prev, [q.id]: mode }))}
                      >
                        {mode === 'designer'
                          ? t('crossClarify.questionScope.designer')
                          : t('crossClarify.questionScope.questioner')}
                      </button>
                    )
                  })}
                </div>
              )}
              <QuestionForm
                question={q}
                value={a}
                index={idx + 1}
                disabled={disabled}
                onChange={(next) => setAnswers((prev) => ({ ...prev, [q.id]: next }))}
              />
            </div>
          )
        })}
    </Card>
  )
}
