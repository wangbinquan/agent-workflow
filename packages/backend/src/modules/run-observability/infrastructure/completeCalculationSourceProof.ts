import { asc, eq, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationSourceRevisions } from '@/db/schema'
import { observationProjectionChanges } from '@/db/observationProjection'
import { OBSERVATION_SOURCE_REVISION } from '@/platform/persistence/observationSourceRevisionSchema'
import type { CompleteCalculationSourceProof } from '../ports/completeCalculationFacts'

/** Only a complete same-snapshot vector qualifies reuse; missing registrations use full calculation. */
export async function completeCalculationSourceProof(
  db: ProviderNeutralDatabase,
  generationId: string,
): Promise<CompleteCalculationSourceProof | null> {
  const pending = db
    .select({
      source: observationProjectionChanges.source,
      changes: sql<string>`CAST(count(*) AS TEXT)`.as('changes'),
    })
    .from(observationProjectionChanges)
    .where(eq(observationProjectionChanges.completed, false))
    .groupBy(observationProjectionChanges.source)
    .as('pending_source_changes')
  // One statement sees one MVCC snapshot. Counts change on every committed
  // append, including a writer whose ID/order predates an already seen writer.
  const rows = await db
    .select({
      sourceId: observationSourceRevisions.sourceId,
      revision: observationSourceRevisions.revision,
      pending: sql<string>`coalesce(${pending.changes}, '0')`,
    })
    .from(observationSourceRevisions)
    .leftJoin(pending, eq(observationSourceRevisions.sourceId, pending.source))
    .orderBy(asc(observationSourceRevisions.sourceId))
    .all()
  const relations = rows.map((row) => ({
    sourceId: row.sourceId,
    revision: JSON.stringify([row.revision, row.pending]),
  }))
  if (relations.length !== OBSERVATION_SOURCE_REVISION.sources.length) return null
  const expected = [...OBSERVATION_SOURCE_REVISION.sources].sort()
  if (
    rows.some(
      (row, index) =>
        row.sourceId !== expected[index] || !row.revision || !/^(0|[1-9][0-9]*)$/.test(row.pending),
    )
  )
    return null
  return { version: 1, generationId, relations }
}
