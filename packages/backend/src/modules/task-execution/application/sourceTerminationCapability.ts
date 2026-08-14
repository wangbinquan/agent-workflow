// RFC-303 — unforgeable-in-process effect capability.
// Only bootstrap/composition imports `mint`; public routes receive neither the
// function nor an object shape that can pass the WeakMap identity check.
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
} from '@/modules/task-execution/public/participants'

const claims = new WeakMap<object, TaskSourceTerminationEffectInput>()

export function mintSourceTerminationEffectCapability(
  claim: TaskSourceTerminationEffectInput,
): SourceTerminationEffectCapability {
  const capability = Object.freeze({})
  claims.set(capability, Object.freeze({ ...claim }))
  return capability as SourceTerminationEffectCapability
}

export function sourceTerminationCapabilityMatches(
  capability: SourceTerminationEffectCapability,
  input: TaskSourceTerminationEffectInput,
): boolean {
  const claim = claims.get(capability as object)
  return (
    claim !== undefined &&
    claim.effectId === input.effectId &&
    claim.binding === input.binding &&
    claim.streamRevision === input.streamRevision &&
    claim.kind === input.kind &&
    claim.deliveryId === input.deliveryId
  )
}
