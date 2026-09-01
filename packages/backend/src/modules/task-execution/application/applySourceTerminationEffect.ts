// RFC-349 — provider-neutral source-termination application contract.

import type { TaskStatus } from '@agent-workflow/shared'

declare const sourceTerminationCapabilityBrand: unique symbol

export type SourceTerminationEffectCapability = Readonly<{
  [sourceTerminationCapabilityBrand]: true
}>

export type TaskSourceTerminationEffectInput = Readonly<{
  effectId: string
  binding: string
  streamRevision: number
  kind: 'fence-closed' | 'fence-merged' | 'clear-closed'
  deliveryId: string
}>

export type TaskSourceTerminationReceipt = Readonly<{
  taskId: string
  priorStatus: TaskStatus
  fenceOutcome: 'fenced-closed' | 'fenced-merged' | 'cleared-closed' | 'unchanged'
  cancelOutcome: 'canceled' | 'already-terminal' | 'not-applicable'
  releaseOutcome: 'pending' | 'no-active-owner' | 'released' | 'unreaped' | 'not-required'
  errorCode: string | null
}>

/** Named atom owns task fence/status, node cancellation, intent
 * terminalization, owner release and committed events per target. */
export interface TaskSourceTerminationParticipant {
  apply(
    capability: SourceTerminationEffectCapability,
    input: TaskSourceTerminationEffectInput,
  ): Promise<readonly TaskSourceTerminationReceipt[]>
}

export async function applySourceTerminationEffect(
  participant: TaskSourceTerminationParticipant,
  capability: SourceTerminationEffectCapability,
  input: TaskSourceTerminationEffectInput,
): Promise<readonly TaskSourceTerminationReceipt[]> {
  return await participant.apply(capability, input)
}
