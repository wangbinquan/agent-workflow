import { and, asc, eq, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { binaryTextOrder } from '@/platform/persistence/binaryTextOrder'
import type { ClarifyAnswerQueries } from '../application/ports/clarifyAnswerQueries'
import { decodeLegacyClarifyAnswerColumns } from './clarifyAnswerCodec'

export function createClarifyAnswerQueries(db: PersistenceDb): ClarifyAnswerQueries {
  return {
    async listSelfQuestions(ids) {
      if (ids.length === 0) return []
      const { clarifyRounds } = tablesOf(db)
      return db
        .select({
          id: clarifyRounds.id,
          taskId: clarifyRounds.taskId,
          questionsJson: clarifyRounds.questionsJson,
        })
        .from(clarifyRounds)
        .where(and(eq(clarifyRounds.kind, 'self'), inArray(clarifyRounds.id, [...ids])))
        .orderBy(asc(binaryTextOrder(db, clarifyRounds.id)))
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
          answersJson: clarifyRounds.answersJson,
        })
        .from(clarifyRounds)
        .where(and(eq(clarifyRounds.kind, 'self'), inArray(clarifyRounds.id, [...ids])))
        .orderBy(asc(binaryTextOrder(db, clarifyRounds.id)))
      return rows.map(({ answersJson, ...round }) => ({
        ...round,
        answers: decodeLegacyClarifyAnswerColumns({ answersJson }).content,
      }))
    },
  }
}
