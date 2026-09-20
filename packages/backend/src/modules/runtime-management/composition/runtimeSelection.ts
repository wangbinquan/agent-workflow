import type { ProviderNeutralDatabase } from '@/db/query'
import type { FrozenRuntimeRef } from '../public/participants'
import type { ResolvedRuntime } from '../domain/runtimeProfile'
import {
  createNodeRunRuntimeSelectionCapabilityInTx,
  createRuntimeSelectionParticipantInTx,
} from '../application/runtimeSelection'
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../infrastructure/runtimeRegistryEffects'
import { createRuntimeSelectionPersistence } from '../infrastructure/runtimeSelectionPersistence'

export function composeRuntimeSelectionParticipantInTx(
  transaction: ProviderNeutralDatabase,
  assertTaskScope: () => void,
) {
  const reader = createRuntimeSelectionPersistence(transaction)
  const registry = createRuntimeRegistryApplication(createRuntimeRegistryEffects())
  const snapshots = new Map<FrozenRuntimeRef, ResolvedRuntime>()
  const capability = createNodeRunRuntimeSelectionCapabilityInTx(assertTaskScope)
  const participant = createRuntimeSelectionParticipantInTx({
    capability,
    resolve: (agentRuntime, defaultRuntime) =>
      registry.resolveAgentRuntime(reader, agentRuntime, defaultRuntime),
    retain: (reference, snapshot) => {
      snapshots.set(reference, snapshot)
    },
  })
  return Object.freeze({
    capability,
    participant,
    readSnapshot(reference: FrozenRuntimeRef): ResolvedRuntime {
      assertTaskScope()
      const snapshot = snapshots.get(reference)
      if (snapshot === undefined) throw new Error('runtime-selection-reference-unavailable')
      return structuredClone(snapshot)
    },
  })
}
