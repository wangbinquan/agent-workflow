import { decodeRunSlot, encodeRunSlot, type RunSlot } from './slots'

export const RUN_SLOT_KEY_VERSION = 'rs1' as const

/** Keep the II-a rs1 bytes; later codecs must use a different version tag. */
export function encodeCanonicalRunSlot(slot: RunSlot): string {
  const iteration =
    slot.kind === 'node' || slot.kind === 'container'
      ? slot.frame.iteration
      : slot.kind === 'shard' || slot.kind === 'aggregator'
        ? slot.iteration
        : undefined
  if (
    iteration !== undefined &&
    (!Number.isSafeInteger(iteration) || iteration < 0 || Object.is(iteration, -0))
  )
    throw new Error('invalid-run-slot-iteration')
  const encoded = encodeRunSlot(slot)
  // Validation also rejects undefined shard/owner facts rather than encoding them as NULL.
  const decoded = decodeRunSlot(encoded)
  if (
    ((slot.kind === 'shard' || slot.kind === 'workgroup-host') &&
      slot.shardKey !== (decoded as typeof slot).shardKey) ||
    ((slot.kind === 'node' || slot.kind === 'container') &&
      slot.frame.containerRunId !== (decoded as typeof slot).frame.containerRunId)
  )
    throw new Error('invalid-run-slot')
  return encoded
}

export function decodeCanonicalRunSlot(encoded: string): RunSlot {
  return decodeRunSlot(encoded)
}

// runInputShard.ts uses shard-v1:none / shard-v1:key:<JSON string> for a standalone
// scalar column. rs1 already has typed JSON positions: null and "" stay distinct
// without nesting that scalar encoding or changing the existing rs1 bytes.
