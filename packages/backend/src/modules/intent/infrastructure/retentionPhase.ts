// RFC-395 II-b O3 — the owner retains its existing same-statement candidate DELETE.
import { sql, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'

function intentCandidates(db: PersistenceDb, cutoff: number | null, batchSize: number): SQL {
  const { intentTurnEvents, intentTurns, intentSessions } = tablesOf(db)
  return sql`
    SELECT ${intentTurnEvents.id} AS id
    FROM ${intentTurnEvents}
    WHERE ${intentTurnEvents.ts} < ${cutoff}
      AND EXISTS (
        SELECT 1
        FROM ${intentTurns}
        JOIN ${intentSessions} ON ${intentSessions.id} = ${intentTurns.sessionId}
        WHERE ${intentTurns.id} = ${intentTurnEvents.turnId}
          AND ${intentSessions.status} = 'archived'
      )
    ORDER BY ${intentTurnEvents.id}
    LIMIT ${batchSize}
  `
}

export function createIntentTurnEventRetentionPhase(db: PersistenceDb): RetentionSweepPhase {
  return {
    name: 'intent-turn-events',
    counter: 'intentTurnEvents',
    async deleteBatch(cutoff, batchSize) {
      const { intentTurnEvents } = tablesOf(db)
      const deleted = await rawRows(
        db,
        databaseSessionFor(db).engine.deleteByCandidates(
          intentTurnEvents,
          intentTurnEvents.id,
          intentCandidates(db, cutoff, batchSize),
        ),
      )
      return deleted.length
    },
  }
}
