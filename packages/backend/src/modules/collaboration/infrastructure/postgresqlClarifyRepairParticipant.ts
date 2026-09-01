import { and, desc, eq, inArray } from 'drizzle-orm'

import { clarifyRounds } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ClarifyRepairParticipant } from '../application/ports/clarifyRepairParticipant'

export function createPostgresqlClarifyRepairParticipant(
  db: PostgresqlDatabaseClient,
): ClarifyRepairParticipant {
  return Object.freeze({
    async hasOpenForNodeRun(input: Parameters<ClarifyRepairParticipant['hasOpenForNodeRun']>[0]) {
      const row = (
        await db
          .select({ id: clarifyRounds.id })
          .from(clarifyRounds)
          .where(
            and(
              eq(clarifyRounds.taskId, input.taskId),
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.intermediaryNodeRunId, input.nodeRunId),
              eq(clarifyRounds.status, 'awaiting_human'),
            ),
          )
          .limit(1)
      )[0]
      return row !== undefined
    },
    async latestClosedForNodeRun(
      input: Parameters<ClarifyRepairParticipant['latestClosedForNodeRun']>[0],
    ) {
      const row = (
        await db
          .select({ roundId: clarifyRounds.id, status: clarifyRounds.status })
          .from(clarifyRounds)
          .where(
            and(
              eq(clarifyRounds.taskId, input.taskId),
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.intermediaryNodeRunId, input.nodeRunId),
              inArray(clarifyRounds.status, ['answered', 'canceled', 'abandoned']),
            ),
          )
          .orderBy(desc(clarifyRounds.createdAt), desc(clarifyRounds.id))
          .limit(1)
      )[0]
      if (row === undefined || row.status === 'awaiting_human') return null
      return { roundId: row.roundId, status: row.status }
    },
    async reopen(input: Parameters<ClarifyRepairParticipant['reopen']>[0]) {
      return await db.transaction(async (transaction) => {
        const changed = await transaction
          .update(clarifyRounds)
          .set({ status: 'awaiting_human', answersJson: null, answeredAt: null })
          .where(
            and(
              eq(clarifyRounds.id, input.roundId),
              eq(clarifyRounds.taskId, input.taskId),
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.status, input.expectedStatus),
            ),
          )
          .returning({ id: clarifyRounds.id })
        return changed.length === 1
      })
    },
  })
}
