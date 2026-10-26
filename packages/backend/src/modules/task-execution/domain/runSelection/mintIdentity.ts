import type { NodeRunSyntheticKind } from '../nodeRunRole'
import { encodeCanonicalRunSlot } from './slotKey'
import type { RunSlot } from './slots'

export type NodeRunMintSlotFacts =
  | {
      readonly role: 'node-attempt'
      readonly syntheticKind: null
      readonly slot: Extract<RunSlot, { kind: 'node' | 'shard' | 'aggregator' }>
    }
  | {
      readonly role: 'container'
      readonly syntheticKind: null
      readonly slot: Extract<RunSlot, { kind: 'container' }>
    }
  | {
      readonly role: 'synthetic'
      readonly syntheticKind: 'workgroup-host'
      readonly slot: Extract<RunSlot, { kind: 'workgroup-host' }>
    }
  | {
      readonly role: 'synthetic'
      readonly syntheticKind: Exclude<NodeRunSyntheticKind, 'workgroup-host'>
      readonly slot: Extract<RunSlot, { kind: 'synthetic' }>
    }

/** Writer-owned facts only. No parent, node-name, cause, status or mutable round heuristic. */
export function nodeRunSlotKeyForMint(facts: NodeRunMintSlotFacts): string {
  const { role, syntheticKind, slot } = facts
  const valid =
    (role === 'node-attempt' &&
      syntheticKind === null &&
      (slot.kind === 'node' || slot.kind === 'shard' || slot.kind === 'aggregator')) ||
    (role === 'container' && syntheticKind === null && slot.kind === 'container') ||
    (role === 'synthetic' &&
      ((slot.kind === 'workgroup-host' && syntheticKind === 'workgroup-host') ||
        (slot.kind === 'synthetic' && syntheticKind === slot.syntheticKind)))
  if (!valid) throw new Error('node-run-role-slot-mismatch')
  return encodeCanonicalRunSlot(slot)
}
