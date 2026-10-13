import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocationPriceRecords } from '@/db/observationAnalysis'
import type { ObservationPriceCorrectionStore } from '../ports/priceCorrections'
import type { ObservationInvocationPricePolicy } from '@agent-workflow/shared'
export function createObservationPriceCorrectionStore(
  db: ProviderNeutralDatabase,
): ObservationPriceCorrectionStore {
  return {
    async get(id, identity) {
      if (!identity) return undefined
      const row = await db
        .select()
        .from(observationInvocationPriceRecords)
        .where(
          and(
            eq(observationInvocationPriceRecords.invocationId, id),
            eq(observationInvocationPriceRecords.sourceId, identity.sourceId),
            eq(observationInvocationPriceRecords.recordId, identity.recordId),
          ),
        )
        .get()
      return row ? (JSON.parse(row.document) as ObservationInvocationPricePolicy) : undefined
    },
  }
}
