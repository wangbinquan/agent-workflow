import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { HumanGateArtifactStore } from '../application/ports/humanGateArtifactStore'
import { HumanGateOperationRecovery } from '../application/recoverHumanGateOperations'
import { DatabaseHumanGateOperationPersistence } from '../infrastructure/humanGateOperationPersistence'

/** Runs with the existing continuation owner. No second scheduler or local
 * artifact store is created; every journal mutation checks the current lease. */
export function composeCrewStationHumanGateRecovery(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly artifacts: HumanGateArtifactStore
  readonly now?: () => number
}) {
  const session = databaseSessionFor(input.db)
  const operations = new DatabaseHumanGateOperationPersistence({
    ...session,
    transaction: (body) => {
      const lease = input.fence.current()
      return session.transaction(async (tx) => {
        await input.fence.assertHeld(tx, lease)
        return body(tx)
      })
    },
  })
  return new HumanGateOperationRecovery({
    operations,
    artifacts: input.artifacts,
    now: input.now,
    preparedInspector: {
      async inspectPreparedOperation(operation) {
        const revision = await operations.latestGateRevision({
          gateKind: operation.gateKind,
          gateRef: operation.gateRef,
        })
        // Only a committed successor is proof that the original gate can no
        // longer consume this preparation. Time alone does not make it stale.
        return revision > operation.expectedGateRevision
          ? 'cleanup-stale'
          : 'retain-for-owner-retry'
      },
    },
  })
}
