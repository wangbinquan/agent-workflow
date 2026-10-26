import type { RunSlot } from './ports/runSelection'
import { randomBytes } from 'node:crypto'
import type { NodeRunMintSlotFacts } from '../domain/runSelection/mintIdentity'
import { nodeRunSlotKeyForMint } from '../domain/runSelection/mintIdentity'
import type { TaskExecutionGenerationCause } from './ports/taskExecutionGenerations'

/** The writer names the slot and whether this command starts a task execution generation. */
export type NodeRunMintGeneration =
  | { readonly kind: 'current' }
  | {
      readonly kind: 'operation'
      readonly cause: TaskExecutionGenerationCause
      readonly operationRef: string
    }
  | { readonly kind: 'existing'; readonly generationSeq: number }

export function nodeRunMintIdentity<T extends NodeRunMintSlotFacts>(
  facts: T,
  executionGeneration: NodeRunMintGeneration,
) {
  nodeRunSlotKeyForMint(facts)
  return { ...facts, envelopeNonce: randomBytes(8).toString('hex'), executionGeneration }
}

/** Persisted/caller-authored canonical slots determine the role without legacy heuristics. */
export function nodeRunMintIdentityForSlot(
  slot: RunSlot,
  executionGeneration: NodeRunMintGeneration,
  envelopeNonce = randomBytes(8).toString('hex'),
) {
  const role =
    slot.kind === 'container'
      ? ('container' as const)
      : slot.kind === 'synthetic' || slot.kind === 'workgroup-host'
        ? ('synthetic' as const)
        : ('node-attempt' as const)
  const syntheticKind =
    slot.kind === 'synthetic'
      ? slot.syntheticKind
      : slot.kind === 'workgroup-host'
        ? ('workgroup-host' as const)
        : null
  return { role, syntheticKind, slot, executionGeneration, envelopeNonce }
}
