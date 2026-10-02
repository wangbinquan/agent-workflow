import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createObservationInvocationStore,
  readTaskSpanInvocations,
} from '../infrastructure/invocationPersistence'
import type {
  ObservationInvocationParticipant,
  ObservationUsageSource,
} from '../public/participants'
import { createUsageLedgerStore } from '../infrastructure/usageLedgerPersistence'
import { createUsageSourceProjection } from '../application/usageSourceProjection'
import { createSpanOwnerLookup } from '../application/spanBaselines'

/** Selected only by standalone bootstraps. Hosted execution supplies its own participant. */
export function composeLocalInvocationObservations(
  db: ProviderNeutralDatabase,
  source: ObservationUsageSource,
): ObservationInvocationParticipant {
  const store = createObservationInvocationStore(db)
  const participant: ObservationInvocationParticipant = {
    spanOwners: createSpanOwnerLookup({
      source,
      get: (id) => store.get(id),
      invocations: (taskId) => readTaskSpanInvocations(db, taskId),
    }),
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
