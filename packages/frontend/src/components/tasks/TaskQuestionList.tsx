// RFC-120 — task question list / 任务中心 board (v1-A kanban embryo).
//
// Columns = the lifecycle phases (待指派 / 待下发 / 处理中 / 已处理待确认 / 完成 /
// 已关闭). Each card is one handler entry (问题 × 承接角色) showing its source node
// and target (handler) node. Actions:
//   - confirm  (已处理待确认 → 完成)
//   - stage / unstage (待指派 ↔ 待下发)
//   - reassign designer entries to another workflow agent node (Select)
// Data: GET /api/tasks/:id/questions; writes POST .../{confirm,reassign,stage}.
// Re-target/dispatch execution that mints reruns is gated on RFC-119 (see RFC
// design §11.7); v1-A records the override + stage intent + closes the loop on
// the existing auto-dispatch flow.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { QuestionAuthorForm } from '@/components/tasks/QuestionAuthorForm'

export type TaskQuestionPhase =
  | 'pending'
  | 'staged'
  | 'processing'
  | 'awaiting_confirm'
  | 'done'
  | 'closed'

export interface TaskQuestionEntry {
  id: string
  questionId: string
  questionTitle: string
  /** The clarify/cross-clarify node-run id — the `/clarify/$nodeRunId` answer page. NULL
   *  for a manual question (RFC-120 §15): it has no clarify round / answer page. */
  originNodeRunId: string | null
  sourceKind: 'self' | 'cross' | 'manual'
  roleKind: 'self' | 'questioner' | 'designer'
  /** The node that ASKED the question. NULL for a manual question (board shows "手动"). */
  sourceNodeId: string | null
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  effectiveTargetNodeId: string | null
  phase: TaskQuestionPhase
  confirmation: 'open' | 'confirmed'
  staged: boolean
  answerSummary: string | null
}

export interface TaskQuestionListProps {
  taskId: string
  /** Agent node ids of the task's workflow (reassign candidates), with labels. */
  nodeOptions?: { id: string; label: string }[]
  /**
   * RFC-120 D13: a canvas question-badge click pushes `{ nodeId, key }` here to
   * focus the board on that source node. A fresh `key` each click re-applies the
   * filter even for the SAME node (clicking the same badge twice). Undefined /
   * null ⇒ no effect, so existing callers are unaffected (golden-lock).
   */
  focusSourceNode?: { nodeId: string; key: number } | null
  /**
   * RFC-120 §15 — the manual-question entry points ("+ 新增问题" + per-card "复制") are
   * shown ONLY for a deferred-dispatch task, because dispatch + injection of a manual
   * question are deferred-gated (a manual row on a non-deferred task is undispatchable
   * orphan data; the create route rejects it too). Default false ⇒ a board rendered
   * without this prop (or a non-deferred task) shows NO manual buttons (golden-lock:
   * today's board, unchanged).
   */
  deferred?: boolean
}

const PHASE_ORDER: TaskQuestionPhase[] = [
  'pending',
  'staged',
  'processing',
  'awaiting_confirm',
  'done',
  'closed',
]

const PHASE_KIND: Record<TaskQuestionPhase, 'neutral' | 'info' | 'warn' | 'success'> = {
  pending: 'neutral',
  staged: 'info',
  processing: 'info',
  awaiting_confirm: 'warn',
  done: 'success',
  closed: 'neutral',
}

// RFC-120 §18 — batch-dispatch ConflictError codes → localized notice keys. These
// are the terminal (non-retryable) rejections from POST .../questions/dispatch
// (node busy / designer not ready / mixed-target round / unsafe target). The
// retryable `task-question-target-changed` is handled separately (re-fetch + retry
// prompt). Any unmapped code falls back to the raw server message via ErrorBanner.
const DISPATCH_ERROR_KEYS: Record<string, string> = {
  'task-question-node-dispatch-in-flight': 'taskQuestions.dispatchInFlight',
  'task-question-designer-not-ready': 'taskQuestions.dispatchDesignerNotReady',
  'task-question-round-multi-target': 'taskQuestions.dispatchRoundMultiTarget',
  'task-question-unsafe-dispatch-target': 'taskQuestions.dispatchUnsafeTarget',
  // RFC-120 §15: dispatch (mint + inject) reuses the §18 per-node queue, which only runs on
  // a deferred-dispatch task — defensive mapping (the board only shows manual buttons when
  // deferred, so this is a belt-and-suspenders for any edge path).
  'task-not-deferred-dispatch': 'taskQuestions.dispatchNotDeferred',
}

export function TaskQuestionList({
  taskId,
  nodeOptions = [],
  focusSourceNode = null,
  deferred = false,
}: TaskQuestionListProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const key = ['task-questions', taskId]
  const query = useQuery<TaskQuestionEntry[], ApiError>({
    queryKey: key,
    queryFn: () => api.get<TaskQuestionEntry[]>(`/api/tasks/${taskId}/questions`),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: key })
  const confirmM = useMutation({
    mutationFn: (id: string) => api.post(`/api/tasks/${taskId}/questions/${id}/confirm`),
    onSuccess: invalidate,
  })
  const stageM = useMutation({
    mutationFn: (v: { id: string; staged: boolean }) =>
      api.post(`/api/tasks/${taskId}/questions/${v.id}/stage`, { staged: v.staged }),
    onSuccess: invalidate,
  })
  const reassignM = useMutation({
    mutationFn: (v: { id: string; targetNodeId: string }) =>
      api.post(`/api/tasks/${taskId}/questions/${v.id}/reassign`, { targetNodeId: v.targetNodeId }),
    onSuccess: invalidate,
  })
  // RFC-120 §18 — 批量下发 (batch-dispatch) of staged (待下发) designer questions.
  // Selection is LOCAL (a Set of entry ids); only staged cards are selectable
  // (the backend dispatch operates on dispatched_at IS NULL designer rows). Cleared
  // on a successful dispatch.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dispatchError, setDispatchError] = useState<unknown>(null)
  // RFC-120 §15 — manual question author form. `authorInitial` null = 新增 (empty form);
  // a {title,body} = 复制 (prefilled from a 待指派 card → Save creates a NEW manual row).
  const [authorOpen, setAuthorOpen] = useState(false)
  const [authorInitial, setAuthorInitial] = useState<{ title: string; body: string } | null>(null)
  const openNewQuestion = () => {
    setAuthorInitial(null)
    setAuthorOpen(true)
  }
  const openCopyQuestion = (e: TaskQuestionEntry) => {
    setAuthorInitial({ title: e.questionTitle, body: e.answerSummary ?? '' })
    setAuthorOpen(true)
  }
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const dispatchM = useMutation({
    mutationFn: (entryIds: string[]) =>
      api.post(`/api/tasks/${taskId}/questions/dispatch`, { entryIds }),
    onSuccess: () => {
      setSelected(new Set())
      setDispatchError(null)
      invalidate()
      // Dispatch flips entries into 处理中 and resumes the task → refresh the task +
      // node-runs queries so the rest of the detail page reflects the processing state.
      void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
      void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
    },
    onError: (err) => {
      // RETRYABLE: a concurrent reassign moved a target out from under us. Re-fetch
      // the board so the user sees the new handler, then prompt re-select + redispatch.
      if (err instanceof ApiError && err.code === 'task-question-target-changed') {
        invalidate()
        setDispatchError(new Error(t('taskQuestions.dispatchTargetChanged')))
        return
      }
      // Terminal ConflictErrors — surface WHY (localized for known codes, raw server
      // message otherwise so the user still understands the failure).
      if (err instanceof ApiError) {
        const mapped = DISPATCH_ERROR_KEYS[err.code]
        setDispatchError(mapped ? new Error(t(mapped)) : err)
        return
      }
      setDispatchError(err)
    },
  })
  // RFC-120 D13: source-node filter (per-node pending counts → click to view
  // that node's questions). Delivers the node-badge feature on the board surface.
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  // RFC-120 D13: a canvas badge click focuses the board on a source node. Keyed
  // off `focusSourceNode.key` (not nodeId) so clicking the SAME node twice still
  // re-applies the filter — each click mints a fresh key in tasks.detail.
  const focusKey = focusSourceNode?.key
  const focusNodeId = focusSourceNode?.nodeId
  useEffect(() => {
    if (focusNodeId !== undefined) setSourceFilter(focusNodeId)
    // Fire on a NEW click (fresh key) only — depending on focusNodeId would
    // defeat the same-node-twice case (each click mints a fresh key in tasks.detail).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  if (query.isLoading) return <LoadingState />
  if (query.error) return <ErrorBanner error={query.error} />
  const entries = query.data ?? []

  // RFC-120 §15 — the "+ 新增问题" toolbar + author form are available even when the board
  // is empty (so the first manual question can be added), but ONLY on a deferred-dispatch
  // task (a manual question is undispatchable otherwise — H2). The form is a portal Dialog
  // (no-op chrome while closed). Non-deferred ⇒ null toolbar/form (golden-lock).
  const toolbar = deferred ? (
    <div className="task-questions__toolbar">
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={openNewQuestion}
        data-testid="tq-add-question"
      >
        {t('taskQuestions.addQuestion')}
      </button>
    </div>
  ) : null
  const authorForm = deferred ? (
    <QuestionAuthorForm
      open={authorOpen}
      onClose={() => setAuthorOpen(false)}
      taskId={taskId}
      nodeOptions={nodeOptions}
      initial={authorInitial}
    />
  ) : null

  if (entries.length === 0) {
    return (
      <div className="task-questions-wrap">
        {toolbar}
        <EmptyState title={t('taskQuestions.empty')} />
        {authorForm}
      </div>
    )
  }

  const labelFor = (nodeId: string | null) =>
    nodeId
      ? (nodeOptions.find((n) => n.id === nodeId)?.label ?? nodeId)
      : t('taskQuestions.noTarget')

  // Per source-node count of questions still needing attention (non-terminal). Manual
  // questions (sourceNodeId null) have no graph source node → they get no node chip.
  const counts = new Map<string, number>()
  for (const e of entries) {
    if (e.sourceNodeId !== null && e.phase !== 'done' && e.phase !== 'closed') {
      counts.set(e.sourceNodeId, (counts.get(e.sourceNodeId) ?? 0) + 1)
    }
  }
  const shown = sourceFilter ? entries.filter((e) => e.sourceNodeId === sourceFilter) : entries

  // RFC-120 §18 — only staged (待下发) cards are dispatch candidates. The board
  // action bar renders ONLY when ≥1 staged card is visible (golden-lock: no staged
  // cards ⇒ no batch-dispatch bar); the button enables once ≥1 of them is selected.
  const stagedShown = shown.filter((e) => e.phase === 'staged')
  const stagedSelectedIds = stagedShown.filter((e) => selected.has(e.id)).map((e) => e.id)

  return (
    <div className="task-questions-wrap">
      {toolbar}
      <div className="task-questions__filter" data-testid="tq-node-filter">
        <button
          type="button"
          className={'btn btn--xs' + (sourceFilter === null ? ' btn--primary' : '')}
          onClick={() => setSourceFilter(null)}
        >
          {t('taskQuestions.allNodes')} ({entries.length})
        </button>
        {[...counts.entries()].map(([nodeId, n]) => (
          <button
            key={nodeId}
            type="button"
            className={'btn btn--xs' + (sourceFilter === nodeId ? ' btn--primary' : '')}
            onClick={() => setSourceFilter(nodeId)}
            data-testid={`tq-node-filter-${nodeId}`}
          >
            {nodeId} ({n})
          </button>
        ))}
      </div>
      {/* RFC-120 §18 — batch-dispatch action bar. Only present when there is at
          least one staged card (golden-lock). The button dispatches the visible
          staged cards the user has selected. */}
      {stagedShown.length > 0 && (
        <div className="task-questions__dispatch-bar" data-testid="tq-batch-dispatch-bar">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-testid="tq-batch-dispatch"
            disabled={stagedSelectedIds.length === 0 || dispatchM.isPending}
            onClick={() => {
              if (stagedSelectedIds.length === 0) return
              setDispatchError(null)
              dispatchM.mutate(stagedSelectedIds)
            }}
          >
            {stagedSelectedIds.length > 0
              ? t('taskQuestions.batchDispatchCount', { count: stagedSelectedIds.length })
              : t('taskQuestions.batchDispatch')}
          </button>
        </div>
      )}
      {dispatchError !== null && <ErrorBanner error={dispatchError} />}
      <div className="task-questions" data-testid="task-questions-board">
        {PHASE_ORDER.map((phase) => {
          const col = shown.filter((e) => e.phase === phase)
          return (
            <div className="task-questions__col" key={phase} data-phase={phase}>
              <div className="task-questions__col-head">
                <StatusChip kind={PHASE_KIND[phase]}>
                  {t(`taskQuestions.phase.${phase}`)}
                </StatusChip>
                <span className="task-questions__count">{col.length}</span>
              </div>
              {col.map((e) => (
                <div className="task-questions__card" key={e.id} data-testid={`tq-card-${e.id}`}>
                  {/* RFC-120 §18 — staged cards are batch-dispatch selectable. */}
                  {phase === 'staged' && (
                    <label className="task-questions__select">
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggleSelected(e.id)}
                        aria-label={t('taskQuestions.selectForDispatch')}
                        data-testid={`tq-select-${e.id}`}
                      />
                      <span>{t('taskQuestions.selectForDispatch')}</span>
                    </label>
                  )}
                  <div className="task-questions__title">{e.questionTitle}</div>
                  {/* RFC-120: 答案紧贴问题——节点信息(meta)不得插在问与答之间（用户反馈）。 */}
                  {e.answerSummary && (
                    <div className="task-questions__answer">{e.answerSummary}</div>
                  )}
                  <dl className="task-questions__meta">
                    <dt>{t('taskQuestions.source')}</dt>
                    {/* RFC-120 §15 — a manual question has no source node: show "手动". */}
                    <dd>{e.sourceNodeId ?? t('taskQuestions.manualSource')}</dd>
                    <dt>{t('taskQuestions.target')}</dt>
                    <dd>
                      {/* RFC-120 Codex impl gate F3: only re-targetable while non-terminal. */}
                      {e.roleKind === 'designer' && e.phase !== 'done' && e.phase !== 'closed' ? (
                        <Select
                          value={e.effectiveTargetNodeId ?? ''}
                          ariaLabel={t('taskQuestions.reassign')}
                          onChange={(v) => reassignM.mutate({ id: e.id, targetNodeId: v })}
                          options={nodeOptions.map((n) => ({ value: n.id, label: n.label }))}
                        />
                      ) : (
                        <span>{labelFor(e.effectiveTargetNodeId)}</span>
                      )}
                    </dd>
                  </dl>
                  <div className="task-questions__actions">
                    {/* RFC-120: the path to ANSWER each clarify question — links to its
                        clarify/cross-clarify page (answer if unanswered, view if
                        answered). A manual question (originNodeRunId null) has no clarify
                        page, so the link is omitted (§15). */}
                    {e.originNodeRunId !== null && (
                      <Link
                        to="/clarify/$nodeRunId"
                        params={{ nodeRunId: e.originNodeRunId }}
                        className="btn btn--xs"
                        data-testid={`tq-answer-${e.id}`}
                      >
                        {e.answerSummary
                          ? t('taskQuestions.viewClarify')
                          : t('taskQuestions.answer')}
                      </Link>
                    )}
                    {/* RFC-120 §15 — 复制 a 待指派 card: open the author form prefilled with
                        its title/body; Save creates a NEW manual question. Deferred-only
                        (manual questions only dispatch on a deferred task — H2). */}
                    {deferred && e.phase === 'pending' && (
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => openCopyQuestion(e)}
                        data-testid={`tq-copy-${e.id}`}
                      >
                        {t('taskQuestions.copy')}
                      </button>
                    )}
                    {e.phase === 'awaiting_confirm' && (
                      <ConfirmButton
                        label={t('taskQuestions.confirm')}
                        onConfirm={() => confirmM.mutate(e.id)}
                      />
                    )}
                    {(e.phase === 'pending' || e.phase === 'staged') && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => stageM.mutate({ id: e.id, staged: !e.staged })}
                        data-testid={`tq-stage-${e.id}`}
                      >
                        {e.staged ? t('taskQuestions.unstage') : t('taskQuestions.stage')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {authorForm}
    </div>
  )
}
