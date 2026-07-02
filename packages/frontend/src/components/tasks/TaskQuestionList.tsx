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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import {
  CentralizedAnswerDialog,
  groupAnswerableQuestions,
} from '@/components/clarify/CentralizedAnswerDialog'
import { QuestionAuthorForm } from '@/components/tasks/QuestionAuthorForm'

export type TaskQuestionPhase = 'pending' | 'staged' | 'processing' | 'awaiting_confirm' | 'done'
// RFC-126: 'closed' 相位移除（不再有 abandon/closed 终态；问题留在原地）。

export interface TaskQuestionEntry {
  id: string
  questionId: string
  questionTitle: string
  /** The clarify/cross-clarify node-run id — the `/clarify/$nodeRunId` answer page. NULL
   *  for a manual question (RFC-120 §15): it has no clarify round / answer page. */
  originNodeRunId: string | null
  sourceKind: 'self' | 'cross' | 'manual'
  /** RFC-134: + 'echo' — 改派回执（只读知会卡：目标=提问节点、生来已下发；无改派/stage，
   *  confirm 任意相位可关，D3）。 */
  roleKind: 'self' | 'questioner' | 'designer' | 'echo'
  /** The node that ASKED the question. NULL for a manual question (board shows "手动"). */
  sourceNodeId: string | null
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  effectiveTargetNodeId: string | null
  phase: TaskQuestionPhase
  confirmation: 'open' | 'confirmed'
  staged: boolean
  /** RFC-128 §10 — this (question × role) entry's answer is sealed/locked (per-question
   *  `sealed_at != null` OR the whole round answered). Drives the centralized-answer pane
   *  (which UNSEALED questions still need answering) and the /clarify grey-out. MUST be
   *  used over `answerSummary !== null` — a partial round leaves answerSummary unreliable
   *  (Codex design gate F3). */
  sealed: boolean
  answerSummary: string | null
}

export interface TaskQuestionListProps {
  taskId: string
  /** Agent node ids of the task's workflow (reassign candidates), with labels. */
  nodeOptions?: { id: string; label: string }[]
  /**
   * RFC-120 D13: a canvas question-badge click pushes `{ nodeId, key }` here to
   * focus the board on that node. A fresh `key` each click re-applies the
   * filter even for the SAME node (clicking the same badge twice). Undefined /
   * null ⇒ no effect, so existing callers are unaffected (golden-lock).
   * 2026-07-02 badge-dimension fix: the focused node is the HANDLER (effective
   * target = override ?? default), matching the badge counts — NOT the asking
   * source node (a reassigned question must land on its handler's filter).
   */
  focusTargetNode?: { nodeId: string; key: number } | null
}

const PHASE_ORDER: TaskQuestionPhase[] = [
  'pending',
  'staged',
  'processing',
  'awaiting_confirm',
  'done',
]

const PHASE_KIND: Record<TaskQuestionPhase, 'neutral' | 'info' | 'warn' | 'success'> = {
  pending: 'neutral',
  staged: 'info',
  processing: 'info',
  awaiting_confirm: 'warn',
  done: 'success',
}

// RFC-120 §18 — batch-dispatch ConflictError codes → localized notice keys. These
// are the terminal (non-retryable) rejections from POST .../questions/dispatch
// (node busy / designer not ready / mixed-target round / unsafe target). The
// retryable `task-question-target-changed` is handled separately (re-fetch + retry
// prompt). Any unmapped code falls back to the raw server message via ErrorBanner.
// RFC-133: `task-question-node-dispatch-in-flight` now carries `details.nodeId` —
// when present the notice interpolates the blocker node (dispatchInFlightNode);
// the static dispatchInFlight text stays as the no-details fallback.
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
  focusTargetNode = null,
}: TaskQuestionListProps) {
  // RFC-132 PR-F: the deferred_question_dispatch flag is gone — the unified model makes
  // EVERY task deferred-dispatch, so the manual-question tools + control-channel buttons
  // (previously gated on the per-task prop) are always available.
  const deferred = true
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
  // 用户 2026-07-02 拍板（推翻 RFC-133 §4 逐卡勾选、恢复 RFC-128 §11.1 语义）：
  // 「进待下发=已确定，批量下发=全下」——一键下发当前视图（尊重节点 filter）的**全部**
  // staged 条目，无逐卡勾选/反选。后端请求体不变（仍接 entryIds）。
  const [dispatchError, setDispatchError] = useState<unknown>(null)
  // RFC-120 §15 — manual question author form (新增-only; the per-card 复制 prefill
  // was removed 2026-07-02, 用户拍板「去除复制待指派问题的功能」).
  const [authorOpen, setAuthorOpen] = useState(false)
  // RFC-128 P4 (T9) — centralized answer pane (control channel). Opens a single page
  // that flattens every UNSEALED 待指派 question of the task (grouped by clarify round)
  // and seals them all with ONE submit button (defer=true → 待指派, no rerun).
  const [answerPaneOpen, setAnswerPaneOpen] = useState(false)
  const openNewQuestion = () => {
    setAuthorOpen(true)
  }
  const dispatchM = useMutation({
    mutationFn: (entryIds: string[]) =>
      api.post(`/api/tasks/${taskId}/questions/dispatch`, { entryIds }),
    onSuccess: () => {
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
      // message otherwise so the user still understands the failure). RFC-133: the
      // in-flight rejection carries `details.nodeId` — name the blocker node (label via
      // nodeOptions, raw id fallback) so the user knows WHAT to wait for.
      if (err instanceof ApiError) {
        const nodeId = (err.details as { nodeId?: unknown } | undefined)?.nodeId
        if (err.code === 'task-question-node-dispatch-in-flight' && typeof nodeId === 'string') {
          const label = nodeOptions.find((n) => n.id === nodeId)?.label ?? nodeId
          setDispatchError(new Error(t('taskQuestions.dispatchInFlightNode', { node: label })))
          return
        }
        const mapped = DISPATCH_ERROR_KEYS[err.code]
        setDispatchError(mapped ? new Error(t(mapped)) : err)
        return
      }
      setDispatchError(err)
    },
  })
  // RFC-120 D13 (2026-07-02 badge-dimension fix): node filter keyed by the
  // HANDLER node (effective target = override ?? default) — the node that will
  // process the question — matching the canvas badge counts. Grouping by the
  // asking source node put a reassigned question on the WRONG node's filter.
  const [targetFilter, setTargetFilter] = useState<string | null>(null)
  // RFC-120 D13: a canvas badge click focuses the board on a handler node. Keyed
  // off `focusTargetNode.key` (not nodeId) so clicking the SAME node twice still
  // re-applies the filter — each click mints a fresh key in tasks.detail.
  const focusKey = focusTargetNode?.key
  const focusNodeId = focusTargetNode?.nodeId
  useEffect(() => {
    if (focusNodeId !== undefined) setTargetFilter(focusNodeId)
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
  const addBtn = deferred ? (
    <button
      type="button"
      className="btn btn--sm"
      onClick={openNewQuestion}
      data-testid="tq-add-question"
    >
      {t('taskQuestions.addQuestion')}
    </button>
  ) : null
  const authorForm = deferred ? (
    <QuestionAuthorForm
      open={authorOpen}
      onClose={() => setAuthorOpen(false)}
      taskId={taskId}
      nodeOptions={nodeOptions}
    />
  ) : null

  if (entries.length === 0) {
    return (
      <div className="task-questions-wrap">
        {addBtn !== null && (
          <div className="task-questions__toolbar">
            <div className="task-questions__filter" />
            <div className="task-questions__actions">{addBtn}</div>
          </div>
        )}
        <EmptyState title={t('taskQuestions.empty')} />
        {authorForm}
      </div>
    )
  }

  const labelFor = (nodeId: string | null) =>
    nodeId
      ? (nodeOptions.find((n) => n.id === nodeId)?.label ?? nodeId)
      : t('taskQuestions.noTarget')

  // RFC-128 (用户 2026-06-30): the node filter lists EVERY node that has questions (ANY
  // phase) so the board can be filtered by any of them — including nodes whose questions
  // are all done. The chip count is that node's total card count (matches the board it
  // filters to). 2026-07-02 badge-dimension fix (用户拍板): chips group by the HANDLER
  // node (effectiveTargetNodeId), not the asking source — a question reassigned to a
  // downstream node counts on ITS chip, and a manual question (no source node) now has a
  // chip via its target.
  const counts = new Map<string, number>()
  for (const e of entries) {
    if (e.effectiveTargetNodeId !== null) {
      counts.set(e.effectiveTargetNodeId, (counts.get(e.effectiveTargetNodeId) ?? 0) + 1)
    }
  }
  const shown = targetFilter
    ? entries.filter((e) => e.effectiveTargetNodeId === targetFilter)
    : entries

  // Only staged (待下发) cards are dispatch candidates. The board action bar renders ONLY
  // when ≥1 staged card is visible in the CURRENT view (golden-lock: no staged cards ⇒ no
  // batch-dispatch bar). 用户 2026-07-02 拍板（推翻 RFC-133 勾选）：批量下发 = 这批
  // stagedShown 的**全部** id（尊重节点 filter；无 filter 时=全部 staged）。
  const stagedShown = shown.filter((e) => e.phase === 'staged')

  return (
    <div className="task-questions-wrap">
      {/* RFC-124 — single-row toolbar: handler-node filter (left) + actions (right). */}
      <div className="task-questions__toolbar">
        <div className="task-questions__filter" data-testid="tq-node-filter">
          <button
            type="button"
            className={
              'task-questions__filter-chip' +
              (targetFilter === null ? ' task-questions__filter-chip--active' : '')
            }
            onClick={() => setTargetFilter(null)}
          >
            {t('taskQuestions.allNodes')} ({entries.length})
          </button>
          {[...counts.entries()].map(([nodeId, n]) => (
            <button
              key={nodeId}
              type="button"
              className={
                'task-questions__filter-chip' +
                (targetFilter === nodeId ? ' task-questions__filter-chip--active' : '')
              }
              onClick={() => setTargetFilter(nodeId)}
              data-testid={`tq-node-filter-${nodeId}`}
            >
              {labelFor(nodeId)} ({n})
            </button>
          ))}
        </div>
        <div className="task-questions__actions">
          {/* 批量下发（用户 2026-07-02 拍板恢复 RFC-128 §11.1 全下、删 RFC-133 逐卡勾选）。
              Only present when ≥1 staged card is visible (golden-lock: no staged ⇒ no bar);
              一键下发当前视图的全部 staged 条目。 */}
          {stagedShown.length > 0 && (
            <div className="task-questions__batch" data-testid="tq-batch-dispatch-bar">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                data-testid="tq-batch-dispatch"
                disabled={dispatchM.isPending}
                onClick={() => {
                  setDispatchError(null)
                  dispatchM.mutate(stagedShown.map((e) => e.id))
                }}
              >
                {t('taskQuestions.batchDispatchCount', { count: stagedShown.length })}
              </button>
            </div>
          )}
          {/* RFC-128 P4 §10.1 — entry to the centralized answer pane. Shown only when the pane
              would have work — the SAME oracle the pane uses (Codex P1-2), so button-shown ⟺
              pane-non-empty. RFC-136: the pool now includes SEALED 待指派 questions (re-answers,
              e.g. moved back out of 待下发), so the button shows for them too. The control
              channel (defer=true → 待指派 → dispatch) is deferred-gated, so the button follows
              the same `deferred` gate as the manual-question tools. */}
          {deferred && groupAnswerableQuestions(entries).length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => setAnswerPaneOpen(true)}
              data-testid="tq-open-answer-pane"
            >
              {t('taskQuestions.answerPaneButton')}
            </button>
          )}
          {addBtn}
        </div>
      </div>
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
              {col.map((e) => {
                // RFC-127 T4: 改派下拉对**任意角色**（self/questioner/designer）开放——
                // self/questioner 走借壳顶替，不再 deadlock。仍仅在「未下发态」(待指派
                // pending / 待下发 staged)：已下发的 processing/awaiting_confirm/done 后端
                // reassignTaskQuestion 以 `dispatched_at IS NULL` + 非终态拒改派（下发后换
                // handler 是 reopen 的职责），前端把入口收敛到未下发态与之对齐。
                // RFC-134：echo 生来已下发 → 相位永不落 pending/staged，reassignable/hasStage
                // 对它天然为 false（与后端 CAS/D10 守卫对齐，无需角色特判）。
                const reassignable = e.phase === 'pending' || e.phase === 'staged'
                // RFC-134 D3：回执任意相位可 confirm（「已知悉」收卡；confirm 不撤销投递）。
                const hasConfirm =
                  e.phase === 'awaiting_confirm' || (e.roleKind === 'echo' && e.phase !== 'done')
                // RFC-128 §11 (D5, 用户 2026-07-01) — 「加入待下发」only makes sense once the
                // answer is sealed: the server stage gate rejects staging an unsealed entry
                // (ConflictError 'task-question-not-sealed', services/taskQuestions.ts
                // isEntrySealed/stageTaskQuestion), so a shown-but-always-erroring 加入 button is
                // worse than an absent one — hide it for an unanswered card. 移出待下发 (unstage,
                // the e.staged direction) stays available regardless of seal so a mistaken stage
                // can be undone before the answer lands (mirrors the server allowing unstage on an
                // unsealed entry). Keeps `hasStage` in agreement with that server gate.
                const hasStage =
                  (e.phase === 'pending' || e.phase === 'staged') && (e.staged || e.sealed)
                const hasActions = hasConfirm || hasStage
                return (
                  <Card
                    key={e.id}
                    data-testid={`tq-card-${e.id}`}
                    interactive
                    footer={
                      hasActions ? (
                        <>
                          {/* RFC-128 P4/P5 (用户 2026-07-01): the per-card "去回答/查看" Link to
                              /clarify/$nodeRunId is REMOVED — the centralized answer pane is the
                              single answer entry now, and answered content is shown via the card's
                              answerSummary below. originNodeRunId stays on the DTO (the pane groups
                              unsealed questions by it). */}
                          {/* 2026-07-02 (用户拍板): the §15 per-card 复制 button is REMOVED —
                              "+ 新增问题" is the only manual-question entry. */}
                          {hasConfirm && (
                            <ConfirmButton
                              label={t('taskQuestions.confirm')}
                              size="sm"
                              onConfirm={() => confirmM.mutate(e.id)}
                            />
                          )}
                          {hasStage && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => stageM.mutate({ id: e.id, staged: !e.staged })}
                              data-testid={`tq-stage-${e.id}`}
                            >
                              {e.staged ? t('taskQuestions.unstage') : t('taskQuestions.stage')}
                            </button>
                          )}
                        </>
                      ) : undefined
                    }
                  >
                    {/* 用户 2026-07-02 拍板：RFC-133 的 staged 逐卡勾选（tq-select-*）已删——
                        批量下发恒为全下，卡片不再有选择控件。 */}
                    <div className="card__title">
                      {e.questionTitle}
                      {/* RFC-134 — 回执标签：与承接卡区分（知会提问节点，非承接义务）。 */}
                      {e.roleKind === 'echo' && (
                        <StatusChip kind="neutral" data-testid={`tq-echo-chip-${e.id}`}>
                          {t('taskQuestions.roleEcho')}
                        </StatusChip>
                      )}
                    </div>
                    {/* RFC-120 lock: 答案紧贴问题、排在 meta 之前（节点信息不得插在问与答之间）。 */}
                    {e.answerSummary && (
                      <div className="task-questions__answer">{e.answerSummary}</div>
                    )}
                    <div className="task-questions__meta">
                      <span className="task-questions__meta-pair">
                        <span className="task-questions__meta-k">{t('taskQuestions.source')}</span>
                        {/* §15 — a manual question has no source node: show "手动".
                            用户 2026-07-02: 显示节点名（labelFor 经 nodeOptions 解析，查无回退原 id）。 */}
                        <span className="task-questions__meta-v">
                          {e.sourceNodeId !== null
                            ? labelFor(e.sourceNodeId)
                            : t('taskQuestions.manualSource')}
                        </span>
                      </span>
                      <span className="task-questions__meta-flow" aria-hidden="true">
                        →
                      </span>
                      <span className="task-questions__meta-pair">
                        <span className="task-questions__meta-k">{t('taskQuestions.target')}</span>
                        {reassignable ? (
                          <Select
                            value={e.effectiveTargetNodeId ?? ''}
                            ariaLabel={t('taskQuestions.reassign')}
                            onChange={(v) => reassignM.mutate({ id: e.id, targetNodeId: v })}
                            options={nodeOptions.map((n) => ({ value: n.id, label: n.label }))}
                          />
                        ) : (
                          <span className="task-questions__meta-v">
                            {labelFor(e.effectiveTargetNodeId)}
                          </span>
                        )}
                      </span>
                    </div>
                  </Card>
                )
              })}
            </div>
          )
        })}
      </div>
      {authorForm}
      {/* RFC-128 P4 (T9) — centralized answer pane (no-op chrome while closed). */}
      <CentralizedAnswerDialog
        taskId={taskId}
        open={answerPaneOpen}
        onClose={() => setAnswerPaneOpen(false)}
      />
    </div>
  )
}
