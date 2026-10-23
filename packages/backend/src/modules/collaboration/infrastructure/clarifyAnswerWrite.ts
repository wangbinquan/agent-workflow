import { createHumanGatePersistenceParticipantInTx } from '@/modules/task-execution/public/participants'
import { and, eq } from 'drizzle-orm'
import type { ClarifyQuestion } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { ClarifyAnswerWritePort } from '../application/ports/clarifyAnswerWrite'
import {
  clarifyRoundTransition,
  projectClarifyAnswers,
  saveClarifyQuestionDraft,
} from '../domain/clarifyAnswers'
import { decodeLegacyClarifyAnswerColumns } from './clarifyAnswerCodec'

/** 当前列的适配器：II-b 替换这里的 map RMW；Task 锁和调用者事务暂时原样保留。 */
export function createClarifyAnswerWritePort(db: PersistenceDb): ClarifyAnswerWritePort {
  return {
    async saveDraft(input) {
      const { clarifyRounds } = tablesOf(db)
      const [row] = await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.id, input.roundId))
        .limit(1)
      if (row === undefined || row.intermediaryNodeRunId !== input.intermediaryNodeRunId) {
        throw new NotFoundError(
          'clarify-round-not-found',
          `clarify round '${input.roundId}' not found`,
        )
      }
      if (row.status !== 'awaiting_human') {
        throw new ConflictError(
          'clarify-round-not-awaiting',
          `clarify round '${input.roundId}' is '${row.status}' — drafts only apply while awaiting_human`,
        )
      }
      const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
      if (!questions.some((q) => q.id === input.questionId)) {
        throw new NotFoundError(
          'clarify-question-not-found',
          `question '${input.questionId}' not in round '${input.roundId}'`,
        )
      }
      const now = Date.now()
      await databaseSessionFor(db).transaction(async (tx) => {
        const { clarifyRounds } = tablesOf(tx)
        const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
        await taskHumanGate.lockTask(row.taskId)
        const [fresh] = await tx
          .select({
            draftAnswersJson: clarifyRounds.draftAnswersJson,
            answerAttributionsJson: clarifyRounds.answerAttributionsJson,
            status: clarifyRounds.status,
          })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.id, input.roundId))
        if (fresh === undefined || fresh.status !== 'awaiting_human') {
          throw new ConflictError(
            'clarify-round-not-awaiting',
            `clarify round '${input.roundId}' is no longer awaiting_human`,
          )
        }
        const state = saveClarifyQuestionDraft(
          decodeLegacyClarifyAnswerColumns(fresh).state,
          input.questionId,
          input.value,
          input.editor,
          now,
        )
        const projection = projectClarifyAnswers(state)
        await tx
          .update(clarifyRounds)
          .set({
            draftAnswersJson: JSON.stringify(projection.draftAnswers),
            answerAttributionsJson: JSON.stringify(projection.answerAttributions),
          })
          .where(eq(clarifyRounds.id, input.roundId))
      })
      return { taskId: row.taskId, updatedAt: now }
    },
    async seal(tx, roundId, transition) {
      const { clarifyRounds } = tablesOf(tx)
      const projection = projectClarifyAnswers(transition.state)
      await tx
        .update(clarifyRounds)
        .set({
          answersJson: JSON.stringify(projection.answers),
          ...(transition.flipNow ? { directive: transition.directive } : {}),
          ...(transition.freeze
            ? {
                submittedByRole: transition.sealedByRole!,
                answerAttributionsJson: JSON.stringify(projection.answerAttributions),
                draftAnswersJson: null,
              }
            : {}),
          ...(transition.flipNow
            ? {
                status: 'answered' as const,
                answeredAt: transition.now,
                ...(transition.sealedBy !== undefined ? { answeredBy: transition.sealedBy } : {}),
              }
            : {}),
        })
        .where(eq(clarifyRounds.id, roundId))
    },
    async appendQuestions(tx, roundId, revision) {
      const { clarifyRounds } = tablesOf(tx)
      await tx
        .update(clarifyRounds)
        .set({ questionsJson: JSON.stringify(revision.questions) })
        .where(eq(clarifyRounds.id, roundId))
    },
    async transition(input, tx) {
      const writer = tx ?? db
      const { clarifyRounds } = tablesOf(writer)
      const transition = clarifyRoundTransition(input.kind, input.now ?? Date.now())
      const { answers, ...metadata } = { answers: undefined, ...transition }
      const changed = await writer
        .update(clarifyRounds)
        .set({
          ...metadata,
          ...(answers === null ? { answersJson: null } : {}),
        })
        .where(
          and(
            eq(clarifyRounds.id, input.roundId),
            ...(input.taskId !== undefined ? [eq(clarifyRounds.taskId, input.taskId)] : []),
            ...(input.roundKind !== undefined ? [eq(clarifyRounds.kind, input.roundKind)] : []),
            ...(input.expectedStatus !== undefined
              ? [eq(clarifyRounds.status, input.expectedStatus)]
              : []),
          ),
        )
        .returning({ id: clarifyRounds.id })
      return changed.length === 1
    },
  }
}
