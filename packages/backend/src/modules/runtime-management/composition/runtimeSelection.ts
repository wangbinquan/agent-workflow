import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createNodeRunRuntimeSelectionCapabilityInTx,
  createRuntimeSelectionParticipantInTx,
  createRuntimeSelectionSnapshotsInTx,
} from '../application/runtimeSelection'
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../infrastructure/runtimeRegistryEffects'
import { createRuntimeSelectionPersistence } from '../infrastructure/runtimeSelectionPersistence'

export function composeRuntimeSelectionParticipantInTx(
  transaction: PersistenceDb,
  assertTaskScope: () => void,
) {
  const reader = createRuntimeSelectionPersistence(transaction)
  const registry = createRuntimeRegistryApplication(createRuntimeRegistryEffects())
  const snapshots = createRuntimeSelectionSnapshotsInTx(assertTaskScope)
  const capability = createNodeRunRuntimeSelectionCapabilityInTx(assertTaskScope)
  const participant = createRuntimeSelectionParticipantInTx({
    capability,
    resolve: (agentRuntime, defaultRuntime) =>
      registry.resolveAgentRuntime(reader, agentRuntime, defaultRuntime),
    retain: snapshots.retain,
  })
  return Object.freeze({
    capability,
    participant,
    readSnapshot: snapshots.readSnapshot,
  })
}
