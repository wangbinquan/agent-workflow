// RFC-303 — exact integration-owned launch/control surface used by the
// transitional webhook dispatcher and bootstrap.  It exposes no task selector.
import type { SourceTerminationSnapshot } from '@/modules/task-execution/public/types'

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
