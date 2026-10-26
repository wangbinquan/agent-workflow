import {
  readClarifyHistory,
  mergeClarifyHistory,
  type ClarifyHistoryRound,
} from './clarifyHistoryProjection'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { binaryTextOrder } from '@/platform/persistence/binaryTextOrder'
import type { ClarifyAnswerQueries } from '../application/ports/clarifyAnswerQueries'
import { decodeLegacyClarifyAnswerColumns } from './clarifyAnswerCodec'

export function createClarifyAnswerQueries(db: PersistenceDb): ClarifyAnswerQueries {
  return {
    async listSelfQuestions(ids) {
      if (ids.length === 0) return []
      const { clarifyRounds } = tablesOf(db)
      const live = await db
        .select({
          id: clarifyRounds.id,
          taskId: clarifyRounds.taskId,
          questionsJson: clarifyRounds.questionsJson,
        })
        .from(clarifyRounds)
        .where(and(eq(clarifyRounds.kind, 'self'), inArray(clarifyRounds.id, [...ids])))
        .orderBy(asc(binaryTextOrder(db, clarifyRounds.id)))
      const history = (await readClarifyHistory(db, { roundIds: ids }))
        .filter((row) => row.kind === 'self' && ids.includes(row.id))
        .map(({ id, taskId, questionsJson }) => ({ id, taskId, questionsJson }))
      return mergeClarifyHistory(live, history).sort((a, b) =>
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      )
    },
    async listSelfSources(ids) {
      if (ids.length === 0) return []
      const { clarifyRounds } = tablesOf(db)
      const rows = await db
        .select({
          id: clarifyRounds.id,
          taskId: clarifyRounds.taskId,
          intermediaryNodeId: clarifyRounds.intermediaryNodeId,
          askingNodeRunId: clarifyRounds.askingNodeRunId,
          questionsJson: clarifyRounds.questionsJson,
          answersRecorded: clarifyRounds.answersRecorded,
          draftsRecorded: clarifyRounds.draftsRecorded,
          attributionsRecorded: clarifyRounds.attributionsRecorded,
          legacyAnswersJson: clarifyRounds.legacyAnswersJson,
        })
        .from(clarifyRounds)
        .where(and(eq(clarifyRounds.kind, 'self'), inArray(clarifyRounds.id, [...ids])))
        .orderBy(asc(binaryTextOrder(db, clarifyRounds.id)))
      const history = (await readClarifyHistory(db, { roundIds: ids })).filter(
        (row) => row.kind === 'self' && ids.includes(row.id),
      )
      return Promise.all(
        mergeClarifyHistory<
          RecordedAnswers &
            Pick<
              TargetClarifyRound,
              'taskId' | 'intermediaryNodeId' | 'askingNodeRunId' | 'questionsJson'
            >
        >(rows, history)
          .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))
          .map(async (round) => ({
            id: round.id,
            taskId: round.taskId,
            intermediaryNodeId: round.intermediaryNodeId,
            askingNodeRunId: round.askingNodeRunId,
            questionsJson: round.questionsJson,
            answers: (await readClarifyAnswerProjection(db, round)).content,
          })),
      )
    },
  }
}

export type TargetClarifyRound = PersistenceTables['clarifyRounds']['$inferSelect']
type RecordedAnswers = Pick<
  TargetClarifyRound,
  'id' | 'answersRecorded' | 'draftsRecorded' | 'attributionsRecorded' | 'legacyAnswersJson'
> &
  Pick<ClarifyHistoryRound, 'legacyProjection'>
type AnswerRow = {
  readonly questionId: string
  readonly occurrence: number
  readonly ordinal: number
  readonly valueJson: string
}

/** Preserve ordered occurrences and the old response semantics, including raw legacy text. */
export function projectClarifyAnswerRows(
  round: RecordedAnswers,
  answers: readonly AnswerRow[],
  drafts: readonly AnswerRow[],
  attributions: readonly AnswerRow[],
) {
  const ordered = (rows: readonly AnswerRow[]) => [...rows].sort((a, b) => a.ordinal - b.ordinal)
  const mapJson = (rows: readonly AnswerRow[]) =>
    `{${ordered(rows)
      .map((row) => `${JSON.stringify(row.questionId)}:${row.valueJson}`)
      .join(',')}}`
  return decodeLegacyClarifyAnswerColumns({
    answersJson:
      round.legacyAnswersJson ??
      (round.answersRecorded
        ? `[${ordered(answers)
            .map((row) => row.valueJson)
            .join(',')}]`
        : null),
    draftAnswersJson: round.draftsRecorded ? mapJson(drafts) : null,
    answerAttributionsJson: round.attributionsRecorded ? mapJson(attributions) : null,
  })
}

export async function readClarifyAnswerProjection(
  reader: PersistenceDb | PersistenceTx,
  round: RecordedAnswers,
) {
  if (round.legacyProjection !== undefined) return round.legacyProjection
  const { clarifyAnswers, clarifyAnswerDrafts, clarifyAnswerAttributions } = tablesOf(reader)
  const answers = round.answersRecorded
    ? await reader
        .select()
        .from(clarifyAnswers)
        .where(eq(clarifyAnswers.roundId, round.id))
        .orderBy(asc(clarifyAnswers.ordinal))
    : []
  const drafts = round.draftsRecorded
    ? await reader
        .select()
        .from(clarifyAnswerDrafts)
        .where(eq(clarifyAnswerDrafts.roundId, round.id))
        .orderBy(asc(clarifyAnswerDrafts.ordinal))
    : []
  const attributions = round.attributionsRecorded
    ? await reader
        .select()
        .from(clarifyAnswerAttributions)
        .where(eq(clarifyAnswerAttributions.roundId, round.id))
        .orderBy(asc(clarifyAnswerAttributions.ordinal))
    : []
  return projectClarifyAnswerRows(round, answers, drafts, attributions)
}
