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

/** RFC-308 task-owned, path-free workspace commit capability for code tasks. */
export type TaskWorkspaceCommitPreviewResult =
  | {
      readonly ok: true
      readonly diff: string
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | { readonly ok: false; readonly error: string }

export type TaskWorkspaceCommitPublishResult =
  | { readonly ok: true; readonly policyDigest: string }
  | {
      readonly ok: false
      readonly reason: 'excluded-history'
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

export type TaskWorkspaceCommitFreezeResult =
  | {
      readonly ok: true
      readonly commitSha: string
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason: 'no-changes'
      readonly policyDigest: string
      readonly excludedPaths: readonly string[]
    }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

export interface TaskWorkspaceCommitParticipant {
  preview(): Promise<TaskWorkspaceCommitPreviewResult>
  freeze(input: {
    message: string
    keepRef: string
    authorName?: string
    authorEmail?: string
  }): Promise<TaskWorkspaceCommitFreezeResult>
  publish(input: {
    mode: 'cas' | 'new'
    baseSha: string
    tipSha: string
    remote: string
    branch: string
  }): Promise<TaskWorkspaceCommitPublishResult>
  release(input: { ref: string }): Promise<{ ok: true } | { ok: false; error: string }>
}

export type DigitalEmployeeExecutionResult =
  | { readonly kind: 'pending'; readonly executionRef: string }
  | { readonly kind: 'completed'; readonly executionRef: string; readonly outputJson: string }
  | {
      readonly kind: 'failed'
      readonly executionRef: string
      readonly errorCode: string
      readonly errorDetail: string
    }

/** Exact TaskEngine lane used by the Digital Employee OS. */
export interface DigitalEmployeeExecutionParticipant {
  launch(planJson: string, attemptJson: string): Promise<{ readonly executionRef: string }>
  inspect(executionRef: string): Promise<DigitalEmployeeExecutionResult>
  cancel(executionRef: string): Promise<void>
}
