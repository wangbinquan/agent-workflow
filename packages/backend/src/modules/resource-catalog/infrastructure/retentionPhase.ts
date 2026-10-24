// RFC-395 II-b O3 — the owner retains its existing same-statement candidate DELETE.
import { sql, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'

function mcpRuntimeCandidates(db: PersistenceDb, cutoff: number | null, batchSize: number): SQL {
  const { mcpRuntimeTestEvents, mcpRuntimeTestSessions } = tablesOf(db)
  return sql`
    SELECT ${mcpRuntimeTestEvents.id} AS id
    FROM ${mcpRuntimeTestEvents}
    WHERE ${mcpRuntimeTestEvents.ts} < ${cutoff}
      AND EXISTS (
        SELECT 1 FROM ${mcpRuntimeTestSessions}
        WHERE ${mcpRuntimeTestSessions.id} = ${mcpRuntimeTestEvents.testSessionId}
          AND ${mcpRuntimeTestSessions.status} = 'ended'
      )
    ORDER BY ${mcpRuntimeTestEvents.id}
    LIMIT ${batchSize}
  `
}

export function createMcpRuntimeTestEventRetentionPhase(db: PersistenceDb): RetentionSweepPhase {
  return {
    name: 'mcp-runtime-test-events',
    counter: 'mcpRuntimeTestEvents',
    async deleteBatch(cutoff, batchSize) {
      const { mcpRuntimeTestEvents } = tablesOf(db)
      const deleted = await rawRows(
        db,
        databaseSessionFor(db).engine.deleteByCandidates(
          mcpRuntimeTestEvents,
          mcpRuntimeTestEvents.id,
          mcpRuntimeCandidates(db, cutoff, batchSize),
        ),
      )
      return deleted.length
    },
  }
}
