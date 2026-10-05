import type { ProviderNeutralDatabase } from '@/db/query'
import { createObservationUsageSource } from '../infrastructure/observationUsageSource'
import type { ObservationNativeHistorySource } from '@/modules/run-observability/public/participants'

/** Bootstrap selects this source only for standalone execution. */
export function composeObservationUsageSource(
  db: ProviderNeutralDatabase,
  historyPrepare?: ObservationNativeHistorySource['prepare'],
) {
  return createObservationUsageSource(db, historyPrepare)
}
