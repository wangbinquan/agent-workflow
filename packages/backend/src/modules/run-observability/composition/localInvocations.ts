import type { ProviderNeutralDatabase } from '@/db/query'
import { createObservationInvocationStore } from '../infrastructure/invocationPersistence'
import type {
  ObservationInvocationParticipant,
  ObservationUsageSource,
} from '../public/participants'
import { createUsageLedgerStore } from '../infrastructure/usageLedgerPersistence'
import { createUsageSourceProjection } from '../application/usageSourceProjection'

/** Selected only by standalone bootstraps. Hosted execution supplies its own participant. */
export function composeLocalInvocationObservations(
  db: ProviderNeutralDatabase,
  source: ObservationUsageSource,
): ObservationInvocationParticipant {
  const store = createObservationInvocationStore(db)
  const participant: ObservationInvocationParticipant = {
    reconcile: createUsageSourceProjection({
      source,
      store: createUsageLedgerStore(db),
      invocations: store,
    }),
    accept: ({ runtime, ...input }) =>
      store.accept({ ...input, authority: { kind: 'local', runtime } }),
  }
  return Object.freeze(participant)
}
