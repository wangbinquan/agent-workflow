import { asc } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationSourceRevisions } from '@/db/schema'
import { OBSERVATION_SOURCE_REVISION } from '@/platform/persistence/observationSourceRevisionSchema'
import type { CompleteCalculationSourceProof } from '../ports/completeCalculationFacts'

/** Only a complete same-snapshot vector qualifies reuse; missing registrations use full calculation. */
export async function completeCalculationSourceProof(
  db: ProviderNeutralDatabase,
  generationId: string,
): Promise<CompleteCalculationSourceProof | null> {
  const relations = await db
    .select()
    .from(observationSourceRevisions)
    .orderBy(asc(observationSourceRevisions.sourceId))
    .all()
  if (relations.length !== OBSERVATION_SOURCE_REVISION.sources.length) return null
  const expected = [...OBSERVATION_SOURCE_REVISION.sources].sort()
  if (relations.some((row, index) => row.sourceId !== expected[index] || !row.revision)) return null
  return { version: 1, generationId, relations }
}
