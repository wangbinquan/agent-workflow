import { ulid } from 'ulid'
import type {
  FrozenRuntimeRef,
  NodeRunRuntimeSelectionCapabilityInTx,
  RuntimeSelectionParticipantInTx,
} from '../public/participants'
import type { ResolvedRuntime } from '../domain/runtimeProfile'

// Task supplies the live owner/NodeRun transaction check. RM never reads Task's
// tables or ownership token; the private registry retains exactly that binding.
const selectionScopes = new WeakMap<object, () => void>()
const participants = new WeakSet<object>()

export function createNodeRunRuntimeSelectionCapabilityInTx(
  assertTaskScope: () => void,
): NodeRunRuntimeSelectionCapabilityInTx {
  const capability = Object.freeze({}) as NodeRunRuntimeSelectionCapabilityInTx
  selectionScopes.set(capability, assertTaskScope)
  return capability
}

export function createRuntimeSelectionParticipantInTx(deps: {
  readonly capability: NodeRunRuntimeSelectionCapabilityInTx
  resolve(
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<ResolvedRuntime>
  retain(reference: FrozenRuntimeRef, snapshot: ResolvedRuntime): void
}): RuntimeSelectionParticipantInTx {
  const assertScope = (capability: NodeRunRuntimeSelectionCapabilityInTx) => {
    const check = selectionScopes.get(capability)
    if (capability !== deps.capability || check === undefined)
      throw new Error('runtime-selection-capability-not-bound')
    check()
  }
  const participant = Object.freeze({
    async freeze(
      capability: NodeRunRuntimeSelectionCapabilityInTx,
      input: Parameters<RuntimeSelectionParticipantInTx['freeze']>[1],
    ) {
      if (!participants.has(this)) throw new Error('runtime-selection-participant-not-bound')
      assertScope(capability)
      const snapshot = await deps.resolve(input.agentRuntime, input.defaultRuntime)
      assertScope(capability)
      const reference = ulid() as FrozenRuntimeRef
      deps.retain(reference, structuredClone(snapshot))
      return reference
    },
  }) as RuntimeSelectionParticipantInTx
  participants.add(participant)
  return participant
}
