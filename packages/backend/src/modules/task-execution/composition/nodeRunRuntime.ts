import { isKnownRuntimeKind } from '@/services/runtime'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { RuntimeSelectionParticipantInTx } from '@/modules/runtime-management/public/participants'
import type {
  FrozenRuntimeRef,
  NodeRunRuntimeSelectionCapabilityInTx,
} from '@/modules/runtime-management/public/participants'
import type { ResolvedRuntimeProfile } from '@/modules/runtime-management/public/types'

/** Composition-only binding; bootstrap supplies RM's factory, the Task adapter consumes its offered participant. */
export interface RuntimeSelectionBinding {
  readonly capability: NodeRunRuntimeSelectionCapabilityInTx
  readonly participant: RuntimeSelectionParticipantInTx
  readSnapshot(reference: FrozenRuntimeRef): ResolvedRuntimeProfile
}
export type BindRuntimeSelection = (
  transaction: ProviderNeutralDatabase,
  assertTaskScope: () => void,
) => RuntimeSelectionBinding
import { DrizzleNodeRunRuntimePersistence } from '../infrastructure/nodeRunRuntimePersistence'

/** Task adapter consumes RM's offered participant on the exact live owner transaction. */
export function composeNodeRunRuntimePersistence(
  db: ProviderNeutralDatabase,
  bindSelection: BindRuntimeSelection,
) {
  return new DrizzleNodeRunRuntimePersistence(
    db,
    isKnownRuntimeKind,
    (transaction, assertTaskScope) => {
      const binding = bindSelection(transaction, assertTaskScope)
      const selection: RuntimeSelectionParticipantInTx = binding.participant
      return async (agentRuntime, defaultRuntime) => {
        const ref = await selection.freeze(binding.capability, { agentRuntime, defaultRuntime })
        const runtime = binding.readSnapshot(ref)
        return {
          protocol: runtime.protocol,
          binary: runtime.binaryPath,
          params: {
            model: runtime.model,
            variant: runtime.variant,
            temperature: runtime.temperature,
            steps: runtime.steps,
            maxSteps: runtime.maxSteps,
            isSandbox: runtime.isSandbox,
            extraArgs: runtime.extraArgs ?? null,
          },
          configDir: runtime.configDir,
        }
      }
    },
  )
}
