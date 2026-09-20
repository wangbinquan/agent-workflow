import { isKnownRuntimeKind } from '@/services/runtime'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { RuntimeSelectionParticipantInTx } from '@/modules/runtime-management/public/participants'
import { composeRuntimeSelectionParticipantInTx } from '@/modules/runtime-management/composition/runtimeSelection'
import { DrizzleNodeRunRuntimePersistence } from '../infrastructure/nodeRunRuntimePersistence'

/** Task adapter consumes RM's offered participant on the exact live owner transaction. */
export function composeNodeRunRuntimePersistence(db: ProviderNeutralDatabase) {
  return new DrizzleNodeRunRuntimePersistence(
    db,
    isKnownRuntimeKind,
    (transaction, assertTaskScope) => {
      const binding = composeRuntimeSelectionParticipantInTx(transaction, assertTaskScope)
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
