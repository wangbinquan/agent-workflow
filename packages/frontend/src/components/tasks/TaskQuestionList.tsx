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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'

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
  /** The clarify/cross-clarify node-run id — the `/clarify/$nodeRunId` answer page. */
  originNodeRunId: string
  sourceKind: 'self' | 'cross'
  roleKind: 'self' | 'questioner' | 'designer'
  sourceNodeId: string
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

export function TaskQuestionList({ taskId, nodeOptions = [] }: TaskQuestionListProps) {
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
  // RFC-120 D13: source-node filter (per-node pending counts → click to view
  // that node's questions). Delivers the node-badge feature on the board surface.
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)

  if (query.isLoading) return <LoadingState />
  if (query.error) return <ErrorBanner error={query.error} />
  const entries = query.data ?? []
  if (entries.length === 0) {
    return <EmptyState title={t('taskQuestions.empty')} />
  }

  const labelFor = (nodeId: string | null) =>
    nodeId
      ? (nodeOptions.find((n) => n.id === nodeId)?.label ?? nodeId)
      : t('taskQuestions.noTarget')

  // Per source-node count of questions still needing attention (non-terminal).
  const counts = new Map<string, number>()
  for (const e of entries) {
    if (e.phase !== 'done' && e.phase !== 'closed') {
      counts.set(e.sourceNodeId, (counts.get(e.sourceNodeId) ?? 0) + 1)
    }
  }
  const shown = sourceFilter ? entries.filter((e) => e.sourceNodeId === sourceFilter) : entries

  return (
    <div className="task-questions-wrap">
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
                  <div className="task-questions__title">{e.questionTitle}</div>
                  <dl className="task-questions__meta">
                    <dt>{t('taskQuestions.source')}</dt>
                    <dd>{e.sourceNodeId}</dd>
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
                  {e.answerSummary && (
                    <div className="task-questions__answer">{e.answerSummary}</div>
                  )}
                  <div className="task-questions__actions">
                    {/* RFC-120: the path to ANSWER each question — links to its
                        clarify/cross-clarify page (answer if unanswered, view if
                        answered). The task center was missing this entirely. */}
                    <Link
                      to="/clarify/$nodeRunId"
                      params={{ nodeRunId: e.originNodeRunId }}
                      className="btn btn--xs"
                      data-testid={`tq-answer-${e.id}`}
                    >
                      {e.answerSummary ? t('taskQuestions.viewClarify') : t('taskQuestions.answer')}
                    </Link>
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
    </div>
  )
}
