// RFC-120 D12 / RFC-162 — the clarify page's per-question handler picker. Shows the
// question's CURRENT effective handler and lets a member re-target it. RFC-162 归一: a
// clarify question is never MOVED — reassign EDITS its designer handler group (targeting an
// upstream/downstream agent node ADDS a `designer` handler; targeting the asking node itself
// REMOVES it, back to the single default card). The asker's own self/questioner entry is
// always kept, so the asker reruns + gets the Q&A (no strand, no echo).
//
// Self-contained + degrades to null when its data is absent, so it can be dropped into the
// (dense, flaky-test-covered) clarify page without disturbing it: the existing clarify tests
// don't mock /api/tasks/:id/questions, so this renders nothing there.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Select } from '@/components/Select'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { resolveNodeNameFromSnapshot } from '@/lib/node-names'

interface ReassignResponse {
  ok: boolean
  action?: 'added-designer' | 'removed-designer' | 'moved-manual'
}

export interface ClarifyQuestionHandlerProps {
  taskId: string
  questionId: string
  /** RFC-128 P4 (Codex P2-2): restrict the entry match to THIS round. Clarify question ids are
   *  agent-provided + round-local, so two rounds can reuse the same id; without this the handler
   *  could show/mutate a SIBLING round's entry. Optional for back-compat — omitted ⇒ match by
   *  questionId across the task (legacy). */
  originNodeRunId?: string
  /** RFC-490: with a single candidate node there is nothing to choose, so the mindmap
   *  leaves the row out. The ordinary questionnaire keeps showing who handles it. */
  hideSingleChoice?: boolean
}

export function ClarifyQuestionHandler({
  taskId,
  questionId,
  originNodeRunId,
  hideSingleChoice,
}: ClarifyQuestionHandlerProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const entries = useQuery<TaskQuestionEntry[]>({
    queryKey: ['task-questions', taskId],
    queryFn: () => api.get<TaskQuestionEntry[]>(`/api/tasks/${taskId}/questions`),
  })
  const task = useQuery<{ workflowSnapshot?: WorkflowDefinition }>({
    queryKey: ['tasks', taskId, 'snapshot'],
    queryFn: () => api.get<{ workflowSnapshot?: WorkflowDefinition }>(`/api/tasks/${taskId}`),
  })
  const reassign = useMutation({
    mutationFn: (v: { id: string; targetNodeId: string }) =>
      api.post<ReassignResponse>(`/api/tasks/${taskId}/questions/${v.id}/reassign`, {
        targetNodeId: v.targetNodeId,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['task-questions', taskId] }),
  })

  // Defensive against any response shape (e.g. a test fetch-mock that doesn't serve this
  // endpoint) — never throw inside the (fragile) clarify page.
  const forThisQuestion = Array.isArray(entries.data)
    ? entries.data.filter(
        (e) =>
          e.questionId === questionId &&
          (originNodeRunId === undefined || e.originNodeRunId === originNodeRunId),
      )
    : []
  // The ASKER entry (self/questioner) is the reassign anchor — reassign(asker, X) EDITS the
  // designer group (X == asker's node ⇒ remove; else ⇒ add/update). Show the current effective
  // handler = the designer's target if one was added, else the asker's own node.
  const asker = forThisQuestion.find((e) => e.roleKind === 'self' || e.roleKind === 'questioner')
  const designer = forThisQuestion.find((e) => e.roleKind === 'designer')
  if (!asker) return null

  const currentTarget = designer?.effectiveTargetNodeId ?? asker.effectiveTargetNodeId

  const snapshot = task.data?.workflowSnapshot
  const snapNodes = snapshot?.nodes
  const nodes: WorkflowNode[] = Array.isArray(snapNodes) ? snapNodes : []
  const agentNodes = nodes
    .filter((n) => n.kind.startsWith('agent'))
    .map((n) => ({ value: n.id, label: resolveNodeNameFromSnapshot(snapshot, n.id) ?? n.id }))
  // RFC-163: post-dispatch reassign stays open (phase !== 'done') —「答完/重跑后让上游修订」
  // is a first-class flow: it ADDS an undispatched designer row that becomes its own 待指派
  // card on the board (dispatching it reruns the asker via the normal cascade). Only a
  // confirmed-done question is closed to edits.
  const editable = asker.phase !== 'done' && agentNodes.length > 0
  if (hideSingleChoice && agentNodes.length <= 1) return null

  return (
    <div className="clarify-handler" data-testid={`clarify-handler-${questionId}`}>
      <span className="muted">{t('taskQuestions.target')}:</span>{' '}
      {editable ? (
        <Select
          value={currentTarget ?? ''}
          ariaLabel={t('taskQuestions.reassign')}
          options={agentNodes}
          onChange={(v) => reassign.mutate({ id: asker.id, targetNodeId: v })}
        />
      ) : (
        <span>
          {currentTarget !== null
            ? (resolveNodeNameFromSnapshot(snapshot, currentTarget) ?? currentTarget)
            : t('taskQuestions.noTarget')}
        </span>
      )}
    </div>
  )
}
