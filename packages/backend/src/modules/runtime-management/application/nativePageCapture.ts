import {
  ObservationNativeBeforeSpawnAckSchema,
  type ObservationNativeBeforeSpawnAck,
  type ObservationNativePassAck,
} from '@agent-workflow/shared'
import type { NativeUsageCapture, NativeUsageCaptureIdentity } from './ports/nativeUsageCapture'
import type { AsyncNativeUsagePassReader } from './ports/nativeUsageOwner'
import type { NativeUsagePassIdentity } from './ports/nativeUsagePass'
import { persistNativeUsagePass } from './persistNativeUsagePass'

/** One frozen reader packet at a time. Neither baseline nor final has a population limit. */
export function createNativePageCapture(
  input: NativeUsageCaptureIdentity & {
    readonly nativeSource: string
    readonly durableOwner: NonNullable<NativeUsageCaptureIdentity['durableOwner']>
    readonly generation: () => Promise<string | null>
    readonly open: (identity: NativeUsagePassIdentity) => Promise<AsyncNativeUsagePassReader>
    readonly passId: () => string
    readonly now: () => number
  },
): NativeUsageCapture {
  let before: ObservationNativeBeforeSpawnAck | undefined
  let begin: Promise<void> | undefined
  let final: Promise<void> | undefined
  let baselineReady = false
  const roots = input.durableOwner.rootCollection
  const read = async (
    phase: 'baseline' | 'final',
    rootSessionId: string,
    finalOwner?: ReturnType<typeof input.durableOwner.passOwner>,
  ) => {
    if (!before) throw new Error('Original native before-spawn receipt is unavailable')
    const sourceGeneration = await input.generation()
    if (
      sourceGeneration === null ||
      (before.sourceGeneration !== null && sourceGeneration !== before.sourceGeneration)
    )
      throw new Error('Original native store generation changed')
    const identity: NativeUsagePassIdentity = {
      passId: input.passId(),
      invocationId: input.invocationId,
      nativeSource: before.nativeSource,
      sourceGeneration,
      rootSessionId,
      lineage: before.lineage,
      epoch: before.epoch,
      phase,
    }
    const receipt = before
    const persist = async (owner: ReturnType<typeof input.durableOwner.passOwner>) => {
      const reader = await input.open(identity)
      return persistNativeUsagePass(reader, owner)
    }
    if (finalOwner) return persist(finalOwner)
    if (phase === 'final' && input.durableOwner.withFinalOwner)
      return input.durableOwner.withFinalOwner(receipt, persist)
    return persist(input.durableOwner.passOwner(receipt))
  }
  return {
    contract: roots ? 'opencode-child-root-pages-v3' : 'opencode-child-pages-v2',
    nativeSource: input.nativeSource,
    // Once before is durable the native pages are the sole owner of step numbers.
    // Failed before capture leaves already observed stdout numbers available.
    includesRecord: (recordId) => !baselineReady || !recordId.startsWith('opencode:step:'),
    begin() {},
    finish: () => [],
    beginDurable() {
      return (begin ??= (async () => {
        const sourceGeneration = await input.generation()
        if (sourceGeneration === null && input.resumeSessionId)
          throw new Error('Original native resume store is unavailable')
        const original = await input.durableOwner.prepare({
          nativeSource: input.nativeSource,
          sourceGeneration,
          ...(sourceGeneration === null ? { sourceAbsentAt: input.now() } : {}),
          resumeRootSessionId: input.resumeSessionId ?? null,
        })
        before = ObservationNativeBeforeSpawnAckSchema.parse(original)
        if (
          before.invocationId !== input.invocationId ||
          before.nativeSource !== input.nativeSource ||
          before.sourceGeneration !== sourceGeneration ||
          before.rootSessionId !== (input.resumeSessionId ?? null)
        )
          throw new Error('Original native before-spawn owner changed its accepted invocation')
        if (input.resumeSessionId) await read('baseline', input.resumeSessionId)
        baselineReady = true
      })())
    },
    finishDurable(rootSessionId) {
      return (final ??= (async () => {
        if (!before) throw new Error('Original native before-spawn receipt is unavailable')
        try {
          if (roots) {
            await roots.freeze()
            const traverse = async (owner: ReturnType<typeof input.durableOwner.passOwner>) => {
              let after: string | null = null,
                firstFailure: unknown
              let lastAck: ObservationNativePassAck | undefined
              let examined = 0n
              for (;;) {
                const packet = await roots.page(after)
                if (packet.length === 0) break
                for (const root of packet) {
                  try {
                    lastAck = await read('final', root, owner)
                  } catch (error) {
                    firstFailure ??= error
                  }
                  examined++
                }
                const next = packet.at(-1)!
                if (next === after)
                  throw new Error('Original native root source did not advance to EOF')
                after = next
              }
              if (examined === 0n) throw new Error('Original native root collection is unavailable')
              if (firstFailure !== undefined) throw firstFailure
              if (!lastAck)
                throw new Error('Original native root collection has no successful pass ACK')
              // This callback value is an actual pass ACK, never a root-set completion proof.
              return lastAck
            }
            if (input.durableOwner.withFinalOwner)
              await input.durableOwner.withFinalOwner(before, traverse)
            else await traverse(input.durableOwner.passOwner(before))
            return
          }
          if (rootSessionId === null) throw new Error('Original native root is unavailable')
          if (before.mode === 'resume' && rootSessionId !== before.rootSessionId)
            throw new Error('Original native resume root changed')
          await read('final', rootSessionId)
        } finally {
          // Missing pages retain the actual partial proof and every committed number.
          await input.durableOwner.seal(input.now())
        }
      })())
    },
    async recordProcess(fact) {
      if (before) await input.durableOwner.recordProcess(fact)
    },
    async sealDurable() {
      if (before) await input.durableOwner.seal(input.now())
    },
  }
}
