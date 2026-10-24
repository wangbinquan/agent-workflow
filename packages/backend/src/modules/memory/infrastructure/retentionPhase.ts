// RFC-395 II-b O3 — the owner retains its existing same-statement candidate DELETE.
import { sql, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'

function distillCandidates(db: PersistenceDb, cutoff: number | null, batchSize: number): SQL {
  const { memoryDistillEvents, memoryDistillJobs } = tablesOf(db)
  return sql`
    SELECT ${memoryDistillEvents.id} AS id
    FROM ${memoryDistillEvents}
    WHERE ${memoryDistillEvents.ts} < ${cutoff}
      AND EXISTS (
        SELECT 1 FROM ${memoryDistillJobs}
        WHERE ${memoryDistillJobs.id} = ${memoryDistillEvents.distillJobId}
          AND ${memoryDistillJobs.status} IN ('done', 'failed', 'canceled')
      )
    ORDER BY ${memoryDistillEvents.id}
    LIMIT ${batchSize}
  `
}

export function createDistillEventRetentionPhase(db: PersistenceDb): RetentionSweepPhase {
  return {
    name: 'distill-events',
    counter: 'distillEvents',
    async deleteBatch(cutoff, batchSize) {
      const { memoryDistillEvents } = tablesOf(db)
      const deleted = await rawRows(
        db,
        databaseSessionFor(db).engine.deleteByCandidates(
          memoryDistillEvents,
          memoryDistillEvents.id,
          distillCandidates(db, cutoff, batchSize),
        ),
      )
      return deleted.length
    },
  }
}
