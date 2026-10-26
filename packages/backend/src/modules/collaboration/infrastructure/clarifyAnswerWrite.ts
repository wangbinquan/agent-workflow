import { and, desc, eq } from 'drizzle-orm'
import { clarifyQuestionSetKey, type ClarifyQuestion } from '@agent-workflow/shared'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { ClarifyAnswerWritePort } from '../application/ports/clarifyAnswerWrite'
import { clarifyRoundTransition, projectClarifyAnswers } from '../domain/clarifyAnswers'

export async function lockClarifyRound(tx: PersistenceTx, roundId: string): Promise<void> {
  const { clarifyRounds } = tablesOf(tx)
  await engineOf(tx).lockAggregateRoot(tx, clarifyRounds, clarifyRounds.id, roundId)
}

function revisionConflict(): never {
  throw new ConflictError(
    'clarify-question-set-changed',
    'Questions changed. Refresh before writing.',
  )
}

/** A draft holds the round against sealing, then changes only its question's rows.
 * Same-question writers serialize for LWW; unrelated questions share the round hold.
 * New row ordinals use a short allocation lock, preserving historical map order.
 */
export function createClarifyAnswerWritePort(db: PersistenceDb): ClarifyAnswerWritePort {
  return {
    async saveDraft(input) {
      return databaseSessionFor(db).transaction(async (tx) => {
        const { clarifyRounds, clarifyAnswerDrafts, clarifyAnswerAttributions } = tablesOf(tx)
        await engineOf(tx).holdAggregateRoot(tx, clarifyRounds, clarifyRounds.id, input.roundId)
        const [round] = await tx
          .select()
          .from(clarifyRounds)
          .where(eq(clarifyRounds.id, input.roundId))
        if (!round || round.intermediaryNodeRunId !== input.intermediaryNodeRunId)
          throw new NotFoundError(
            'clarify-round-not-found',
            `clarify round '${input.roundId}' not found`,
          )
        if (round.status !== 'awaiting_human')
          throw new ConflictError(
            'clarify-round-not-awaiting',
            `clarify round '${input.roundId}' is no longer awaiting_human`,
          )
        const questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
        if (!questions.some((q) => q.id === input.questionId))
          throw new NotFoundError(
            'clarify-question-not-found',
            `question '${input.questionId}' not in round '${input.roundId}'`,
          )
        if (questions.filter((q) => q.id === input.questionId).length !== 1)
          throw new ConflictError(
            'clarify-question-ambiguous',
            'Historical duplicate question cannot be edited.',
          )
        await engineOf(tx).advisoryLock(tx, `clarify-question:${input.roundId}:${input.questionId}`)
        const now = Date.now()
        const key = and(
          eq(clarifyAnswerDrafts.roundId, input.roundId),
          eq(clarifyAnswerDrafts.questionId, input.questionId),
          eq(clarifyAnswerDrafts.occurrence, 0),
        )
        const [draft] = await tx.select().from(clarifyAnswerDrafts).where(key)
        const attributionKey = and(
          eq(clarifyAnswerAttributions.roundId, input.roundId),
          eq(clarifyAnswerAttributions.questionId, input.questionId),
          eq(clarifyAnswerAttributions.occurrence, 0),
        )
        const [attribution] = await tx
          .select()
          .from(clarifyAnswerAttributions)
          .where(attributionKey)
        if (!draft || !attribution)
          await engineOf(tx).advisoryLock(tx, `clarify-row-order:${input.roundId}`)
        if (draft) {
          const changed = await tx
            .update(clarifyAnswerDrafts)
            .set({
              valueJson: JSON.stringify(input.value),
              revision: draft.revision + 1,
              questionsRevision: round.questionsRevision,
              updatedAt: now,
            })
            .where(and(key, eq(clarifyAnswerDrafts.revision, draft.revision)))
            .returning({ revision: clarifyAnswerDrafts.revision })
          if (changed.length !== 1) revisionConflict()
        } else {
          const [last] = await tx
            .select({ ordinal: clarifyAnswerDrafts.ordinal })
            .from(clarifyAnswerDrafts)
            .where(eq(clarifyAnswerDrafts.roundId, input.roundId))
            .orderBy(desc(clarifyAnswerDrafts.ordinal))
            .limit(1)
          await tx.insert(clarifyAnswerDrafts).values({
            roundId: input.roundId,
            questionId: input.questionId,
            occurrence: 0,
            ordinal: (last?.ordinal ?? -1) + 1,
            valueJson: JSON.stringify(input.value),
            revision: 1,
            questionsRevision: round.questionsRevision,
            updatedAt: now,
          })
        }
        const valueJson = JSON.stringify({
          userId: input.editor.userId,
          role: input.editor.role,
          updatedAt: now,
        })
        if (attribution) {
          await tx.update(clarifyAnswerAttributions).set({ valueJson }).where(attributionKey)
        } else {
          const [last] = await tx
            .select({ ordinal: clarifyAnswerAttributions.ordinal })
            .from(clarifyAnswerAttributions)
            .where(eq(clarifyAnswerAttributions.roundId, input.roundId))
            .orderBy(desc(clarifyAnswerAttributions.ordinal))
            .limit(1)
          await tx.insert(clarifyAnswerAttributions).values({
            roundId: input.roundId,
            questionId: input.questionId,
            occurrence: 0,
            ordinal: (last?.ordinal ?? -1) + 1,
            valueJson,
          })
        }
        if (!round.draftsRecorded || !round.attributionsRecorded) {
          const changed = await tx
            .update(clarifyRounds)
            .set({ draftsRecorded: true, attributionsRecorded: true })
            .where(
              and(
                eq(clarifyRounds.id, input.roundId),
                eq(clarifyRounds.status, 'awaiting_human'),
                eq(clarifyRounds.questionsRevision, round.questionsRevision),
              ),
            )
            .returning({ id: clarifyRounds.id })
          if (changed.length !== 1) revisionConflict()
        }
        return { taskId: round.taskId, updatedAt: now }
      })
    },
    async seal(tx, roundId, transition) {
      await lockClarifyRound(tx, roundId)
      const { clarifyRounds, clarifyAnswers, clarifyAnswerDrafts, clarifyAnswerAttributions } =
        tablesOf(tx)
      const [round] = await tx.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId))
      if (!round || (round.status !== 'awaiting_human' && round.status !== 'answered'))
        throw new ConflictError('clarify-round-terminal', 'Clarify round is no longer sealable.')
      const questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
      const incoming = new Set(transition.incoming.map((answer) => answer.questionId))
      if (transition.incoming.some((answer) => !questions.some((q) => q.id === answer.questionId)))
        throw new NotFoundError(
          'clarify-question-not-found',
          'Answer references an unknown question.',
        )
      const projection = projectClarifyAnswers(transition.state)
      const existing = await tx
        .select()
        .from(clarifyAnswers)
        .where(eq(clarifyAnswers.roundId, roundId))
      const occurrences = new Map<string, number>()
      for (const [ordinal, answer] of (projection.answers ?? []).entries()) {
        const occurrence = occurrences.get(answer.questionId) ?? 0
        occurrences.set(answer.questionId, occurrence + 1)
        if (!incoming.has(answer.questionId)) continue
        const previous = existing.find(
          (row) => row.questionId === answer.questionId && row.occurrence === occurrence,
        )
        if (previous) {
          const changed = await tx
            .update(clarifyAnswers)
            .set({
              valueJson: JSON.stringify(answer),
              revision: previous.revision + 1,
              questionsRevision: round.questionsRevision,
              updatedAt: transition.now,
            })
            .where(
              and(
                eq(clarifyAnswers.roundId, roundId),
                eq(clarifyAnswers.questionId, answer.questionId),
                eq(clarifyAnswers.occurrence, occurrence),
                eq(clarifyAnswers.revision, previous.revision),
              ),
            )
            .returning({ revision: clarifyAnswers.revision })
          if (changed.length !== 1) revisionConflict()
        } else {
          await tx.insert(clarifyAnswers).values({
            roundId,
            questionId: answer.questionId,
            occurrence,
            ordinal,
            valueJson: JSON.stringify(answer),
            revision: 1,
            questionsRevision: round.questionsRevision,
            updatedAt: transition.now,
          })
        }
      }
      if (transition.freeze) {
        await tx.delete(clarifyAnswerDrafts).where(eq(clarifyAnswerDrafts.roundId, roundId))
        const values = Object.entries(projection.answerAttributions ?? {})
        // Freeze replaces the effective attribution map, as in epoch 1. Reopen never deletes it.
        await tx
          .delete(clarifyAnswerAttributions)
          .where(eq(clarifyAnswerAttributions.roundId, roundId))
        for (const [ordinal, [questionId, value]] of values.entries()) {
          await tx.insert(clarifyAnswerAttributions).values({
            roundId,
            questionId,
            occurrence: 0,
            ordinal,
            valueJson: JSON.stringify(value),
          })
        }
      }
      const changed = await tx
        .update(clarifyRounds)
        .set({
          answersRecorded: true,
          legacyAnswersJson: null,
          ...(transition.freeze
            ? {
                submittedByRole: transition.sealedByRole!,
                attributionsRecorded: true,
                draftsRecorded: false,
              }
            : {}),
          ...(transition.flipNow
            ? {
                status: 'answered' as const,
                directive: transition.directive,
                sealedQuestionSetKey: clarifyQuestionSetKey(questions),
                answeredAt: transition.now,
                ...(transition.sealedBy === undefined ? {} : { answeredBy: transition.sealedBy }),
              }
            : {}),
        })
        .where(
          and(
            eq(clarifyRounds.id, roundId),
            eq(clarifyRounds.status, round.status),
            eq(clarifyRounds.questionsRevision, round.questionsRevision),
          ),
        )
        .returning({ id: clarifyRounds.id })
      if (changed.length !== 1) revisionConflict()
    },
    async appendQuestions(tx, roundId, revision) {
      await lockClarifyRound(tx, roundId)
      const { clarifyRounds } = tablesOf(tx)
      const [round] = await tx.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId))
      if (!round || round.status !== 'awaiting_human')
        throw new ConflictError(
          'clarify-followup-closed',
          'This round no longer accepts follow-ups.',
        )
      const current = JSON.parse(round.questionsJson) as ClarifyQuestion[]
      if (
        clarifyQuestionSetKey(current) !== revision.previousKey ||
        revision.duplicateIds.length ||
        revision.error ||
        JSON.stringify(revision.questions.slice(0, current.length)) !== JSON.stringify(current)
      )
        revisionConflict()
      const changed = await tx
        .update(clarifyRounds)
        .set({
          questionsJson: JSON.stringify(revision.questions),
          questionsRevision: round.questionsRevision + 1,
        })
        .where(
          and(
            eq(clarifyRounds.id, roundId),
            eq(clarifyRounds.status, 'awaiting_human'),
            eq(clarifyRounds.questionsRevision, round.questionsRevision),
          ),
        )
        .returning({ id: clarifyRounds.id })
      if (changed.length !== 1) revisionConflict()
    },
    async transition(input, tx) {
      const apply = async (writer: PersistenceTx) => {
        await lockClarifyRound(writer, input.roundId)
        const { clarifyRounds, clarifyAnswers } = tablesOf(writer)
        const transition = clarifyRoundTransition(input.kind, input.now ?? Date.now())
        const { answers, ...metadata } = { answers: undefined, ...transition }
        const changed = await writer
          .update(clarifyRounds)
          .set({
            ...metadata,
            ...(answers === null
              ? { answersRecorded: false, legacyAnswersJson: null, sealedQuestionSetKey: null }
              : {}),
          })
          .where(
            and(
              eq(clarifyRounds.id, input.roundId),
              ...(input.taskId === undefined ? [] : [eq(clarifyRounds.taskId, input.taskId)]),
              ...(input.roundKind === undefined ? [] : [eq(clarifyRounds.kind, input.roundKind)]),
              ...(input.expectedStatus === undefined
                ? []
                : [eq(clarifyRounds.status, input.expectedStatus)]),
            ),
          )
          .returning({ id: clarifyRounds.id })
        if (changed.length && answers === null)
          await writer.delete(clarifyAnswers).where(eq(clarifyAnswers.roundId, input.roundId))
        return changed.length === 1
      }
      return tx ? apply(tx) : databaseSessionFor(db).transaction(apply)
    },
  }
}
