import { createHumanGatePersistenceParticipantInTx } from '@/modules/task-execution/public/participants'
import { createTaskGateQueries } from '@/modules/task-execution/public/queries'
import { decodeLegacyClarifyAnswerColumns } from './clarifyAnswerCodec'
import { createClarifyAnswerWritePort } from './clarifyAnswerWrite'
import { appendClarifyQuestions, clarifyQuestionsRevision } from '../domain/clarifyQuestions'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, isNotNull } from 'drizzle-orm'
import {
  clarifyCategoryPaths,
  ClarifyMindmapConfigSchema,
  clarifyContentKey,
  clarifyFollowupContext,
  isMindmapRound,
  type ClarifyFollowupTarget,
  type ClarifyQuestion,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  ClarifyFollowupSnapshot,
  ClarifyFollowupStore,
} from '../application/ports/clarifyFollowup'
import type { CollaborationClarifyDraftEventPublisher } from '../application/ports/collaborationRouteOperations'

type Reader = PersistenceDb | PersistenceTx
export function createClarifyFollowupStore(
  db: PersistenceDb,
  events: CollaborationClarifyDraftEventPublisher,
): ClarifyFollowupStore {
  const read = async (
    reader: Reader,
    nodeRunId: string,
    target: ClarifyFollowupTarget,
  ): Promise<ClarifyFollowupSnapshot> => {
    const { clarifyRounds, taskQuestions } = tablesOf(reader)
    const round = (
      await reader
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, nodeRunId))
        .limit(1)
    )[0]
    if (!round) throw new NotFoundError('clarify-round-not-found', 'Clarify round not found.')
    const task = (
      await createTaskGateQueries(reader)
        .listDefinitionContexts([round.taskId])
        .then((rows) =>
          rows.map((row) => ({ status: row.status, workflowSnapshot: row.workflowSnapshot })),
        )
    )[0]
    const questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
    if (!isMindmapRound(questions))
      throw new ConflictError(
        'clarify-followup-mode',
        'Follow-up is only available in mindmap mode.',
      )
    if (!task) throw new NotFoundError('task-not-found', 'Task not found.')
    const targetIds =
      typeof target === 'string'
        ? [target]
        : clarifyFollowupContext(questions, {}, target).map(({ question }) => question.id)
    if (!targetIds.length || !questions.some((q) => q.id === targetIds[0]))
      throw new NotFoundError('clarify-question-not-found', 'Question or category not found.')
    const sealed = await reader
      .select({ questionId: taskQuestions.questionId })
      .from(taskQuestions)
      .where(and(eq(taskQuestions.originNodeRunId, nodeRunId), isNotNull(taskQuestions.sealedAt)))
    const sealedIds = new Set(sealed.map((row) => row.questionId))

    const definition = JSON.parse(task.workflowSnapshot) as WorkflowDefinition
    const gate = definition.nodes.find((n) => n.id === round.intermediaryNodeId)
    const config = ClarifyMindmapConfigSchema.safeParse(gate?.mindmap)
    return {
      canAppend:
        round.status === 'awaiting_human' &&
        task.status !== 'done' &&
        task.status !== 'canceled' &&
        targetIds.some((id) => !sealedIds.has(id)),
      roundId: round.id,
      taskId: round.taskId,
      askingNodeRunId: round.askingNodeRunId!,
      questions,
      categoryPaths: config.success ? clarifyCategoryPaths(config.data.categories) : [],
      drafts: decodeLegacyClarifyAnswerColumns(round).requireEffectiveAnswers(),
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
      const target = request.parentQuestionId ?? request.categoryPath!
      const first = await read(db, nodeRunId, target)
      await getTaskQuestionWriteSem(first.taskId).run(async () => {
        await databaseSessionFor(db).transaction(async (tx) => {
          const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
          await taskHumanGate.lockTask(first.taskId)
          const current = await read(tx, nodeRunId, target)
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
            clarifyContentKey(clarifyFollowupContext(current.questions, current.drafts, target)) !==
            request.basis
          )
            throw new ConflictError(
              'clarify-followup-stale',
              'The branch changed while generating. Retry with the current answers.',
            )
          const revision = appendClarifyQuestions(
            clarifyQuestionsRevision(current.questions),
            additions,
          )
          const error = revision.error
          if (error) throw new ConflictError('clarify-followup-invalid', error)
          await createClarifyAnswerWritePort(db).appendQuestions(tx, current.roundId, revision)
        })
      })
      await events.publish({
        taskId: first.taskId,
        nodeRunId,
        roundId: first.roundId,
        questionId: request.parentQuestionId ?? additions[0]!.id,
        editor,
        occurredAt: Date.now(),
      })
    },
  }
}
