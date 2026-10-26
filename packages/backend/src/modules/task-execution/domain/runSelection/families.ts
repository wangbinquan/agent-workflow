import { runSlotsEqual, type RunSlot } from './slots'

export type RunFamily =
  | { readonly kind: 'node'; readonly nodeId: string }
  | Extract<RunSlot, { kind: 'synthetic' }>
  | {
      readonly kind: 'workgroup'
      readonly taskId: string
      readonly nodeId: string
      readonly shardKey: string | null
    }

/** Within one task, a reader can translate this union into canonical-slot predicates. */
export function runSlotInFamily(
  slot: RunSlot,
  family: RunFamily,
  options: { readonly legacyEmptyShard?: boolean } = {},
): boolean {
  if (family.kind === 'synthetic') return runSlotsEqual(slot, family)
  if (family.kind === 'node') return slot.kind !== 'synthetic' && slot.nodeId === family.nodeId
  const sameShard = (shardKey: string | null) =>
    options.legacyEmptyShard === true
      ? (shardKey ?? '') === (family.shardKey ?? '')
      : shardKey === family.shardKey
  if (slot.kind === 'workgroup-host')
    return slot.nodeId === family.nodeId && sameShard(slot.shardKey)
  // design/RFC-395-database-target-schema-rebuild/plan.md:447: #70 includes gates in history.
  return (
    slot.kind === 'synthetic' &&
    slot.syntheticKind === 'wg-gate' &&
    slot.owner.kind === 'task' &&
    slot.owner.id === family.taskId &&
    slot.discriminator === family.nodeId &&
    sameShard(null)
  )
}
