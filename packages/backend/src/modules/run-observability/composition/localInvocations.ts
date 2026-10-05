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
import { createUsageIngestion } from '../application/usageIngestion'

/** Selected only by standalone bootstraps. Hosted execution supplies its own participant. */
export function composeLocalInvocationObservations(
  db: ProviderNeutralDatabase,
  source: ObservationUsageSource,
): ObservationInvocationParticipant {
  const store = createObservationInvocationStore(db)
  const ledger = createUsageLedgerStore(db)
  const ingestion = createUsageIngestion(ledger, source.nativeScopes, source.nativeHistory)
  const participant: ObservationInvocationParticipant = {
    spanOwners: createSpanOwnerLookup({
      source,
      get: (id) => store.get(id),
      invocations: (taskId) => readTaskSpanInvocations(db, taskId),
    }),
    reconcile: createUsageSourceProjection({
      source,
      store: ledger,
      invocations: store,
    }),
    accept: ({ runtime, ...input }) =>
      store.accept({ ...input, authority: { kind: 'local', runtime } }),
    ...(source.nativeHistory
      ? {
          reconcileNativeHistory: async (invocationId: string) => {
            const accepted = await store.get(invocationId)
            if (!accepted || accepted.authority.kind !== 'local')
              throw new Error('Original native history invocation is not locally accepted')
            const capture = (await ledger.captures([invocationId]))[0]
            if (!capture) return undefined
            if (
              capture.taskId !== accepted.taskId ||
              capture.sourceId !== 'local-node:' + accepted.nodeRunId
            )
              throw new Error('Original native history capture changed its accepted owner')
            if (capture.capture.contract !== 'opencode-child-pages-v2')
              throw new Error('Original invocation did not select native page history')
            const progress = await ingestion.repairCapture(capture)
            return progress || undefined
          },
        }
      : {}),
  }
  return Object.freeze(participant)
}
