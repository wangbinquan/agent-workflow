import { and, eq, isNotNull } from 'drizzle-orm'
import {
  clarifyContentKey,
  clarifyFollowupContext,
  effectiveClarifyAnswers,
  isMindmapRound,
  validateClarifyMindmap,
  type ClarifyDraftValue,
  type ClarifyQuestion,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, taskQuestions, tasks } from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  ClarifyFollowupSnapshot,
  ClarifyFollowupStore,
} from '../application/ports/clarifyFollowup'
import type { CollaborationClarifyDraftEventPublisher } from '../application/ports/collaborationRouteOperations'

type Reader = ProviderNeutralDatabase | DatabaseTransaction
export function createClarifyFollowupStore(
  db: ProviderNeutralDatabase,
  events: CollaborationClarifyDraftEventPublisher,
): ClarifyFollowupStore {
  const read = async (
    reader: Reader,
    nodeRunId: string,
    parentId: string,
  ): Promise<ClarifyFollowupSnapshot> => {
    const round = (
      await reader
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, nodeRunId))
        .limit(1)
    )[0]
    if (!round) throw new NotFoundError('clarify-round-not-found', 'Clarify round not found.')
    const task = (
      await reader
        .select({ status: tasks.status, workflowSnapshot: tasks.workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, round.taskId))
        .limit(1)
    )[0]
    const questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
    if (!isMindmapRound(questions))
      throw new ConflictError(
        'clarify-followup-mode',
        'Follow-up is only available in mindmap mode.',
      )
    if (!task) throw new NotFoundError('task-not-found', 'Task not found.')
    if (!questions.some((q) => q.id === parentId))
      throw new NotFoundError('clarify-question-not-found', 'Parent question not found.')
    const sealed = await reader
      .select({ id: taskQuestions.id })
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, nodeRunId),
          eq(taskQuestions.questionId, parentId),
          isNotNull(taskQuestions.sealedAt),
        ),
      )
      .limit(1)

    const definition = JSON.parse(task.workflowSnapshot) as WorkflowDefinition
    const gate = definition.nodes.find((n) => n.id === round.intermediaryNodeId)
    return {
      canAppend:
        round.status === 'awaiting_human' &&
        task.status !== 'done' &&
        task.status !== 'canceled' &&
        sealed.length === 0,
      roundId: round.id,
      taskId: round.taskId,
      askingNodeRunId: round.askingNodeRunId!,
      questions,
      drafts: effectiveClarifyAnswers(
        JSON.parse(round.draftAnswersJson ?? '{}') as Record<string, ClarifyDraftValue>,
        JSON.parse(round.answersJson ?? '[]'),
      ),
      instruction:
        typeof gate?.mindmap === 'object' && gate.mindmap
          ? String((gate.mindmap as { instructions?: string }).instructions ?? '')
          : '',
    }
  }
  return {
    async read(nodeRunId, parentId) {
      const first = await read(db, nodeRunId, parentId)
      return getTaskQuestionWriteSem(first.taskId).run(() => read(db, nodeRunId, parentId))
    },
    async append(nodeRunId, request, additions, signal, editor) {
      const first = await read(db, nodeRunId, request.parentQuestionId)
      await getTaskQuestionWriteSem(first.taskId).run(async () => {
        await databaseSessionFor(db).transaction(async (tx) => {
          await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, first.taskId)
          const current = await read(tx, nodeRunId, request.parentQuestionId)
          if (!current.canAppend)
            throw new ConflictError(
              'clarify-followup-closed',
              'This question no longer accepts follow-ups.',
            )
          if (signal.aborted)
            throw new ConflictError('clarify-followup-canceled', 'Follow-up canceled.')
          const existing = current.questions.filter(
            (q) => q.mindmap?.requestId === request.requestId,
          )
          if (existing.length) {
            if (existing.some((q) => q.mindmap?.requestBasis !== clarifyContentKey(request)))
              throw new ConflictError('clarify-followup-request-conflict', 'Request ID was reused.')
            return
          }
          if (
            clarifyContentKey(
              clarifyFollowupContext(current.questions, current.drafts, request.parentQuestionId),
            ) !== request.basis
          )
            throw new ConflictError(
              'clarify-followup-stale',
              'The branch changed while generating. Retry with the current answers.',
            )
          const questions = [...current.questions, ...additions]
          const error = validateClarifyMindmap(questions, true)
          if (error) throw new ConflictError('clarify-followup-invalid', error)
          await tx
            .update(clarifyRounds)
            .set({ questionsJson: JSON.stringify(questions) })
            .where(eq(clarifyRounds.id, current.roundId))
        })
      })
      await events.publish({
        taskId: first.taskId,
        nodeRunId,
        roundId: first.roundId,
        questionId: request.parentQuestionId,
        editor,
        occurredAt: Date.now(),
      })
    },
  }
}
