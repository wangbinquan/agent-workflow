import type { ProviderNeutralDatabase } from '@/db/query'
import { createObservationUsageSource } from '../infrastructure/observationUsageSource'

/** Bootstrap selects this source only for standalone execution. */
export function composeObservationUsageSource(db: ProviderNeutralDatabase) {
  return createObservationUsageSource(db)
}
