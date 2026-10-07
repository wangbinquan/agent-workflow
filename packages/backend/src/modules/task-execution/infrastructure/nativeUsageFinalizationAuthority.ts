import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeProcessFactSchema,
  type ObservationNativeBeforeSpawnAck,
  type ObservationNativeProcessFact,
} from '@agent-workflow/shared'
import type {
  NativeUsageFinalizationRef,
  NativeUsageOwnerBinding,
} from '../application/ports/nativeUsagePersistence'

interface Finalization {
  readonly binding: NativeUsageOwnerBinding
  before?: ObservationNativeBeforeSpawnAck
  spawned?: ObservationNativeProcessFact
  settled?: ObservationNativeProcessFact
  invalid: boolean
}
const originals = new WeakMap<NativeUsageFinalizationRef, Finalization>()

/** Only original prepare and kernel callbacks can activate this invocation's final evidence. */
export function createNativeUsageFinalizationAuthority(binding: NativeUsageOwnerBinding) {
  const reference: NativeUsageFinalizationRef = Object.freeze({})
  const original: Finalization = { binding, invalid: false }
  originals.set(reference, original)
  return {
    reference,
    prepared(input: ObservationNativeBeforeSpawnAck): void {
      const before = ObservationNativeBeforeSpawnAckSchema.parse(input)
      if (
        before.invocationId !== binding.invocationId ||
        before.epoch !== String(binding.executionContext.token.epoch) ||
        (original.before && !isDeepStrictEqual(original.before, before))
      ) {
        original.invalid = true
        return
      }
      original.before = Object.freeze(before)
    },
    observe(input: ObservationNativeProcessFact): void {
      const parsed = ObservationNativeProcessFactSchema.safeParse(input)
      if (!parsed.success) {
        original.invalid = true
        return
      }
      const fact = Object.freeze(parsed.data)
      if (fact.phase === 'spawned') {
        if (
          !original.before ||
          fact.launchNonce === null ||
          fact.spawnedAt === null ||
          fact.spawnedAt < original.before.preparedAt ||
          original.settled ||
          (original.spawned && !isDeepStrictEqual(original.spawned, fact))
        ) {
          original.invalid = true
          return
        }
        original.spawned = fact
        return
      }
      const spawned = original.spawned
      if (
        !original.before ||
        !spawned ||
        fact.pid !== spawned.pid ||
        fact.launchNonce !== spawned.launchNonce ||
        fact.spawnedAt !== spawned.spawnedAt ||
        fact.reapedAt === null ||
        fact.drainedAt === null ||
        fact.drainedAt < fact.reapedAt ||
        fact.outcome === 'unreaped' ||
        fact.drainTimedOut ||
        fact.pumpError ||
        (original.settled && !isDeepStrictEqual(original.settled, fact))
      ) {
        original.invalid = true
        return
      }
      original.settled = fact
    },
  }
}

/** A copied object or another invocation/context cannot borrow an original finalization. */
export function nativeUsageFinalizationReceipt(
  binding: NativeUsageOwnerBinding,
): ObservationNativeBeforeSpawnAck | undefined {
  if (!binding.finalization) return undefined
  const original = originals.get(binding.finalization)
  if (
    !original ||
    original.invalid ||
    !original.before ||
    !original.spawned ||
    !original.settled ||
    original.binding.taskId !== binding.taskId ||
    original.binding.nodeRunId !== binding.nodeRunId ||
    original.binding.invocationId !== binding.invocationId ||
    original.binding.executionContext !== binding.executionContext
  )
    return undefined
  return original.before
}
