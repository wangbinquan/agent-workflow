// RFC-120 — task question list / 任务中心 board (v1-A kanban embryo).
//
// Columns = the lifecycle phases (待指派 / 待下发 / 处理中 / 已处理待确认 / 完成 /
// 已关闭). RFC-163（用户 2026-07-10「下发前一问一卡、下发后各处理节点拆开」）: cards come from
// `groupBoardEntries` — an UNDISPATCHED question is ONE card whose handler rows list its
// processing nodes (the asker itself + any reassign-added designer), so a reassign edits a row
// inside the same card instead of conjuring a second card; DISPATCHED entries split into
// per-handler cards (independently tracked / confirmed). Actions:
//   - confirm  (已处理待确认 → 完成; dispatched single cards only)
//   - stage / unstage (待指派 ↔ 待下发; GROUP-level — the whole handler set stages/dispatches
//     together so the asker never dispatches without its coexisting designer, one frontier)
//   - reassign (card-level Select anchored on the asker entry → adds/removes/re-targets the
//     designer handler row, RFC-162 semantics)
// Data: GET /api/tasks/:id/questions; writes POST .../{confirm,reassign,stage}.

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
import { groupBoardEntries } from '@/lib/task-question-board'

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
  /** RFC-162: 'echo' 已删。default self/questioner；designer = 人工增派的修订 handler。 */
  roleKind: 'self' | 'questioner' | 'designer'
  /** The node that ASKED the question. NULL for a manual question (board shows "手动"). */
  sourceNodeId: string | null
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  effectiveTargetNodeId: string | null
  phase: TaskQuestionPhase
  confirmation: 'open' | 'confirmed'
  staged: boolean
  /** RFC-140 W2 — auto-split-deferred out of a clicked batch dispatch; the scheduler will
   *  auto-redispatch it once its home's in-flight rerun finishes (staged badge). */
  autoDispatchDeferred: boolean
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
  // RFC-163 — GROUP-level stage: a pre-dispatch card carries the question's WHOLE handler set
  // (asker + reassign-added designer), and「加入待下发」moves them together so batch dispatch
  // hands the full group to ONE computeUpstreamFrontier (asker never dispatches without its
  // coexisting designer — the board-path dual of RFC-162 Finding-2). Reuses the per-id /stage
  // endpoint (no backend change); Promise.all + single invalidate.
  const stageM = useMutation({
    mutationFn: (v: { ids: string[]; staged: boolean }) =>
      Promise.all(
        v.ids.map((id) =>
          api.post(`/api/tasks/${taskId}/questions/${id}/stage`, { staged: v.staged }),
        ),
      ),
    onSuccess: invalidate,
  })
  // RFC-162: reassign 改派语义归一——不再移动提问者条目，而是「增派/移除一条 designer 处理
  // 节点」（改派给上游/下游 ⇒ 该问题多一张 designer 卡；改派回提问节点 ⇒ 移除 designer 卡回到
  // 单卡）。collapse/scope/echo 全删，看板只需 invalidate 后重渲染。
  const reassignM = useMutation({
    mutationFn: (v: { id: string; targetNodeId: string }) =>
      api.post<{
        ok: boolean
        action?: 'added-designer' | 'removed-designer' | 'moved-manual'
      }>(`/api/tasks/${taskId}/questions/${v.id}/reassign`, { targetNodeId: v.targetNodeId }),
    onSuccess: () => invalidate(),
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
      api.post<{ resume?: { ok: false; code: string; message: string } }>(
        `/api/tasks/${taskId}/questions/dispatch`,
        { entryIds },
      ),
    onSuccess: (res) => {
      // RFC-202 T8: dispatch landed but the task resume kick failed — say so
      // (the old fire-and-forget path reported unqualified success while the
      // task stayed parked).
      if (res.resume !== undefined && res.resume.ok === false) {
        setDispatchError(new Error(t('common.resumeFailedAfterSubmit', { code: res.resume.code })))
      } else {
        setDispatchError(null)
      }
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
        // RFC-203 T5c: keep the raw ApiError — the banner resolves it through
        // resolveApiError with DISPATCH_ERROR_KEYS as caller-local overrides
        // (override tier beats the exact errors.<code> entries, preserving
        // this board's established per-surface copy), and the raw server
        // message survives in the collapsible detail instead of being lost.
        setDispatchError(err)
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
  // is empty (so the first manual question can be added). The form is a portal Dialog
  // (no-op chrome while closed). RFC-132 made every task deferred-dispatch, so the former
  // per-task gate is gone.
  const addBtn = (
    <button
      type="button"
      className="btn btn--sm"
      onClick={openNewQuestion}
      data-testid="tq-add-question"
    >
      {t('taskQuestions.addQuestion')}
    </button>
  )
  const authorForm = (
    <QuestionAuthorForm
      open={authorOpen}
      onClose={() => setAuthorOpen(false)}
      taskId={taskId}
      nodeOptions={nodeOptions}
    />
  )

  if (entries.length === 0) {
    return (
      <div className="task-questions-wrap">
        <div className="task-questions__toolbar">
          <div className="task-questions__filter" />
          <div className="task-questions__actions">{addBtn}</div>
        </div>
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
  // RFC-163 — group first, THEN filter by group (Codex design-gate P1): a node filter matches a
  // card when ANY of its handlers lands on that node, and the matched card keeps its WHOLE
  // handler set. Filtering entries before grouping would drop the non-matching sibling handlers
  // from the card, and the batch-dispatch expansion below would then send a PARTIAL group —
  // exactly the out-of-order dispatch AC-3 forbids. The chip count stays per-entry (matches the
  // canvas badges); showing an off-filter sibling row inside a matched card is intentional.
  const cards = groupBoardEntries(entries)
  const shown = targetFilter
    ? cards.filter((c) => c.handlers.some((h) => h.entry.effectiveTargetNodeId === targetFilter))
    : cards

  // Only staged (待下发) cards are dispatch candidates. The board action bar renders ONLY
  // when ≥1 staged card is visible in the CURRENT view (golden-lock: no staged cards ⇒ no
  // batch-dispatch bar). 用户 2026-07-02 拍板（推翻 RFC-133 勾选）：批量下发 = 当前视图全部
  // staged 卡（尊重节点 filter；无 filter 时=全部 staged）。RFC-163: 每张 staged 卡展开其
  // **整组** handler id（未经 filter 裁剪）——组内提问节点与增派 designer 一起进同一个
  // dispatch 批、走同一个 frontier。
  const stagedCards = shown.filter((c) => c.phase === 'staged')
  const stagedDispatchIds = stagedCards.flatMap((c) => c.handlers.map((h) => h.entry.id))

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
          {/* 2026-07-07 长节点名截断：label/count 拆成两个 span——label 单独 ellipsis，
              计数在任何截断下恒可见；title 让全名 hover 可达。 */}
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
              title={labelFor(nodeId)}
            >
              <span className="task-questions__filter-chip-label">{labelFor(nodeId)}</span>
              <span className="task-questions__filter-chip-count">({n})</span>
            </button>
          ))}
        </div>
        <div className="task-questions__actions">
          {/* 批量下发（用户 2026-07-02 拍板恢复 RFC-128 §11.1 全下、删 RFC-133 逐卡勾选）。
              Only present when ≥1 staged card is visible (golden-lock: no staged ⇒ no bar);
              一键下发当前视图的全部 staged 条目。 */}
          {stagedCards.length > 0 && (
            <div className="task-questions__batch" data-testid="tq-batch-dispatch-bar">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                data-testid="tq-batch-dispatch"
                disabled={dispatchM.isPending}
                onClick={() => {
                  setDispatchError(null)
                  dispatchM.mutate(stagedDispatchIds)
                }}
              >
                {t('taskQuestions.batchDispatchCount', { count: stagedDispatchIds.length })}
              </button>
            </div>
          )}
          {/* RFC-128 P4 §10.1 — entry to the centralized answer pane. Shown only when the pane
              would have work — the SAME oracle the pane uses (Codex P1-2), so button-shown ⟺
              pane-non-empty. RFC-136: the pool now includes SEALED 待指派 questions (re-answers,
              e.g. moved back out of 待下发), so the button shows for them too. */}
          {groupAnswerableQuestions(entries).length > 0 && (
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
      {dispatchError !== null && (
        <ErrorBanner error={dispatchError} overrides={DISPATCH_ERROR_KEYS} />
      )}
      <div className="task-questions" data-testid="task-questions-board">
        {PHASE_ORDER.map((phase) => {
          const col = shown.filter((c) => c.phase === phase)
          return (
            <div className="task-questions__col" key={phase} data-phase={phase}>
              <div className="task-questions__col-head">
                <StatusChip kind={PHASE_KIND[phase]}>
                  {t(`taskQuestions.phase.${phase}`)}
                </StatusChip>
                <span className="task-questions__count">{col.length}</span>
              </div>
              {col.map((card) => {
                // RFC-163: 代表条目 = handler 首行（分组卡的 asker〔self/questioner 排前〕、单卡
                // 的唯一条目、manual 卡的 manual 条目）——标题/答案/来源/testid 都取它。
                const rep = card.handlers[0]!.entry
                const undispatched = card.phase === 'pending' || card.phase === 'staged'
                // RFC-162/163: 改派在「未下发态」开放——卡级 Select 锚定 rep（asker/manual/落单
                // designer），编辑该问题的 designer 处理组（增派上游/下游 or 移回单卡）。已下发
                // 卡由后端 `dispatched_at IS NULL` + asker-dispatched 守卫拒改派。
                const reassignable = undispatched
                const hasConfirm = card.phase === 'awaiting_confirm'
                // RFC-128 §11 (D5) —「加入待下发」only makes sense once the answer is sealed (the
                // server stage gate rejects an unsealed entry). RFC-163 group form: STAGE needs
                // EVERY handler sealed (designer inherits the asker's seal, RFC-162, so lockstep);
                // UNSTAGE stays available whenever any handler is staged (mistaken stage undo).
                const anyStaged = card.handlers.some((h) => h.entry.staged)
                const allSealed = card.handlers.every((h) => h.entry.sealed)
                const hasStage = undispatched && (anyStaged || allSealed)
                const hasActions = hasConfirm || hasStage
                const anyAutoDeferred = card.handlers.some((h) => h.entry.autoDispatchDeferred)
                // 2026-07-07 长节点名截断：meta 值 CSS ellipsis 后全名靠 title hover 可达。
                const sourceLabel =
                  rep.sourceNodeId !== null
                    ? labelFor(rep.sourceNodeId)
                    : t('taskQuestions.manualSource')
                // 卡级改派 Select 的展示值 = designer 目标（有增派时）?? 代表条目目标——选回提问
                // 节点自己 ⇒ 后端删 designer 行、卡内行 -1（'removed-designer'）。
                const designerRow = card.handlers.find((h) => h.entry.roleKind === 'designer')
                const selectValue =
                  designerRow?.entry.effectiveTargetNodeId ?? rep.effectiveTargetNodeId ?? ''
                const targetLabel = labelFor(rep.effectiveTargetNodeId)
                return (
                  <Card
                    key={card.key}
                    data-testid={`tq-card-${rep.id}`}
                    className={card.grouped ? 'task-questions__card--grouped' : undefined}
                    interactive
                    footer={
                      hasActions ? (
                        <>
                          {/* RFC-128 P4/P5 (用户 2026-07-01): the per-card "去回答/查看" Link is
                              REMOVED — the centralized answer pane is the single answer entry;
                              answered content shows via answerSummary below. */}
                          {hasConfirm && (
                            <ConfirmButton
                              label={t('taskQuestions.confirm')}
                              size="sm"
                              onConfirm={() => confirmM.mutate(rep.id)}
                            />
                          )}
                          {hasStage && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => {
                                // 组级 stage：进待下发=整组全进；移出=只撤已 staged 的（混态防御，
                                // 见 lib/task-question-board groupPhase）。
                                const next = !anyStaged
                                const ids = card.handlers
                                  .filter((h) => (next ? !h.entry.staged : h.entry.staged))
                                  .map((h) => h.entry.id)
                                stageM.mutate({ ids, staged: next })
                              }}
                              data-testid={`tq-stage-${rep.id}`}
                            >
                              {anyStaged ? t('taskQuestions.unstage') : t('taskQuestions.stage')}
                            </button>
                          )}
                        </>
                      ) : undefined
                    }
                  >
                    <div className="card__title">
                      {rep.questionTitle}
                      {/* RFC-140 W2 — auto-split defer 徽标：已点过批量下发、等 home 当前续跑
                          结束后由系统自动补发。组卡=任一 handler 带标即显。 */}
                      {anyAutoDeferred && (
                        <StatusChip kind="info" data-testid={`tq-auto-dispatch-chip-${rep.id}`}>
                          {t('taskQuestions.autoDispatchQueued')}
                        </StatusChip>
                      )}
                    </div>
                    {/* RFC-120 lock: 答案紧贴问题、排在 meta 之前（节点信息不得插在问与答之间）。 */}
                    {rep.answerSummary && (
                      <div className="task-questions__answer">{rep.answerSummary}</div>
                    )}
                    {/* RFC-163 — 分组卡的处理节点行：提问节点（自己续跑）+ 增派的修订 handler。
                        改派＝下方 Select 增/删/改这里的行，卡数不变。 */}
                    {card.grouped && (
                      <div
                        className="task-questions__handlers"
                        data-testid={`tq-handlers-${rep.id}`}
                      >
                        {card.handlers.map((h) => (
                          <div
                            className="task-questions__handler-row"
                            key={h.entry.id}
                            data-testid={`tq-handler-${h.entry.id}`}
                          >
                            <span className="task-questions__handler-role">
                              {h.entry.roleKind === 'designer'
                                ? t('taskQuestions.handlerDesigner')
                                : t('taskQuestions.handlerAsker')}
                            </span>
                            <span
                              className="task-questions__handler-node"
                              title={labelFor(h.entry.effectiveTargetNodeId)}
                            >
                              {labelFor(h.entry.effectiveTargetNodeId)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="task-questions__meta">
                      <span className="task-questions__meta-pair">
                        <span className="task-questions__meta-k">{t('taskQuestions.source')}</span>
                        {/* §15 — a manual question has no source node: show "手动". */}
                        <span className="task-questions__meta-v" title={sourceLabel}>
                          {sourceLabel}
                        </span>
                      </span>
                      <span className="task-questions__meta-flow" aria-hidden="true">
                        →
                      </span>
                      <span className="task-questions__meta-pair">
                        <span className="task-questions__meta-k">{t('taskQuestions.target')}</span>
                        {reassignable ? (
                          <Select
                            value={selectValue}
                            ariaLabel={t('taskQuestions.reassign')}
                            onChange={(v) => reassignM.mutate({ id: rep.id, targetNodeId: v })}
                            options={nodeOptions.map((n) => ({ value: n.id, label: n.label }))}
                          />
                        ) : (
                          <span className="task-questions__meta-v" title={targetLabel}>
                            {targetLabel}
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
