// RFC-303 — the only cross-context task-control surface.
// It deliberately accepts a source binding, never caller-selected task ids.
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

export interface TaskSourceTerminationParticipant {
  apply(
    capability: SourceTerminationEffectCapability,
    input: TaskSourceTerminationEffectInput,
  ): Promise<readonly TaskSourceTerminationReceipt[]>
}
