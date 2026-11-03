import type { StartAgentTask, StartTask, StartWorkgroupTask } from '@agent-workflow/shared'
import type { SourceTerminationSnapshot } from '@/modules/task-execution/public/types'

export interface EventWorkStartOrigin {
  readonly eventSubscriptionId: string
  readonly eventDeliveryId: string
}

export type WorkStartTarget =
  | { readonly kind: 'workflow'; readonly refId: string; readonly payload: StartTask }
  | {
      readonly kind: 'agent'
      readonly refId: string
      readonly payload: StartAgentTask & { readonly agentId: string }
    }
  | {
      readonly kind: 'workgroup'
      readonly refId: string
      readonly payload: StartWorkgroupTask & { readonly workgroupId: string }
    }
  | {
      readonly kind: 'digital-employee'
      readonly refId: string
      readonly intake: {
        readonly kind: 'body' | 'external-id'
        readonly target: Readonly<Record<string, string>>
        readonly body: string | null
        readonly externalId: string | null
        readonly uploads: readonly []
      }
    }

export type WorkStartReceipt =
  | { readonly kind: 'orchestration'; readonly taskId: string }
  | { readonly kind: 'digital-employee'; readonly caseId: string }

export interface DigitalEmployeeWorkStartPort {
  launch(input: {
    readonly employeeId: string
    readonly intake: Extract<WorkStartTarget, { readonly kind: 'digital-employee' }>['intake'] & {
      readonly idempotencyKey: string
    }
    readonly actorUserId: string | null
    readonly origin: EventWorkStartOrigin
  }): Promise<{ readonly caseId: string }>
}

export type { PipelineEvidenceExecution } from '../infrastructure/local/legacyPipelineAdapter'
export type { SelectedPipelineEvidenceExecution } from '../application/developmentPipelineAdapter'
export type {
  RequirementAdapterBinding,
  PipelineAdapterBinding,
  ApprovalAdapterBinding,
} from '../application/ports/developmentPurposeBinding'
export type {
  AdapterConfigurationReference,
  AdapterProgramReference,
  AdapterProgramFactory,
  AdapterProcessObservation,
  RequirementAdapterEffects,
  PipelineAdapterEffects,
  ApprovalAdapterEffects,
} from '../application/ports/developmentAdapterEffects'

// RFC-303 — exact integration-owned launch/control surface used by the transitional webhook dispatcher and
// bootstrap; it exposes no task selector. RFC-434: folded in from the former non-exact `public/mrTerminalControl`.
export type ProtectedMrLaunchGuardInput = Readonly<{
  endpointId: string
  streamKey: string
  binding: string
  launchRevision: number
  deliveryId: string
  fireId: string
  triggerId: string
  triggerName: string
}>

export interface ProtectedMrLaunchGuard {
  readonly id: string
  readonly signal: AbortSignal
  readonly snapshot: SourceTerminationSnapshot
  /**
   * Process-local final guard used by the legacy task INSERT callback.  The
   * provider-neutral durable check is `verifyCanCommit`; bootstrap must run it
   * immediately before handing control to the task owner.
   */
  assertCanCommit(): void
  verifyCanCommit(): Promise<void>
  taskCommitted(taskId: string): Promise<void>
  launchSettled(taskId: string): Promise<void>
  failed(errorCode: string): Promise<void>
  release(): void
}

export interface MrTerminalControl {
  reserveLaunch(input: ProtectedMrLaunchGuardInput): Promise<ProtectedMrLaunchGuard>
  /** Wake is idempotent; effectId only narrows the first scan. */
  wake(effectId?: string | null): void
  /** Boot barrier: reconcile stale guards and drain every currently due effect. */
  reconcileOnBoot(): Promise<void>
  /** Stop accepting wakeups, abort launch owners, and wait for the active effect attempt. */
  stop(): Promise<void>
  /**
   * Re-arm after a provider pause. Only the RFC-349 rollback path calls this:
   * the frozen source session resumes its own writers when a cutover fails.
   */
  resume(): void
}
