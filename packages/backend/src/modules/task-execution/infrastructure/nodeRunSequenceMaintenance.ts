import { asc, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawRows } from '@/platform/persistence/queryHelpers'

const BATCH_SIZE = 500

/** Retain the allocator high-water row even after all corresponding runs disappear. */
export async function pruneNodeRunSequenceAllocations(db: PersistenceDb): Promise<number> {
  let total = 0
  for (;;) {
    const deleted = await databaseSessionFor(db).transaction(async (tx) => {
      const { nodeRunSeqAllocations } = tablesOf(tx)
      const candidates = sql`SELECT ${nodeRunSeqAllocations.seq} AS id FROM ${nodeRunSeqAllocations}
        WHERE ${nodeRunSeqAllocations.seq} < (SELECT MAX(${nodeRunSeqAllocations.seq}) FROM ${nodeRunSeqAllocations})
        ORDER BY ${asc(nodeRunSeqAllocations.seq)} LIMIT ${BATCH_SIZE}`
      const rows = await rawRows(
        tx,
        engineOf(tx).deleteByCandidates(
          nodeRunSeqAllocations,
          nodeRunSeqAllocations.seq,
          candidates,
        ),
      )
      return rows.length
    })
    total += deleted
    if (deleted < BATCH_SIZE) return total
  }
}
