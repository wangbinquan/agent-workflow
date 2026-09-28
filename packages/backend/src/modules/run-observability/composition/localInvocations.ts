import type { ProviderNeutralDatabase } from '@/db/query'
import { createObservationInvocationStore } from '../infrastructure/invocationPersistence'
import type { ObservationInvocationParticipant } from '../public/participants'

/** Selected only by standalone bootstraps. Hosted execution supplies its own participant. */
export function composeLocalInvocationObservations(
  db: ProviderNeutralDatabase,
): ObservationInvocationParticipant {
  const store = createObservationInvocationStore(db)
  const participant: ObservationInvocationParticipant = {
    accept: ({ runtime, ...input }) =>
      store.accept({ ...input, authority: { kind: 'local', runtime } }),
  }
  return Object.freeze(participant)
}
