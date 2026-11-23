// RFC-550 (RFC-294 S9): the merge-request terminal control this module composes and drives, with its protected launch
// guard. They sat on `public/participants` without any other module consuming them.
import type { TaskLaunchGuard } from '@/modules/task-execution/public/types'

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

/**
 * RFC-486: the members task-execution's launch uses are declared by task-execution (`TaskLaunchGuard`); this guard adds
 * its reservation id. `assertCanCommit` is the process-local final check; the provider-neutral durable check is
 * `verifyCanCommit`, which bootstrap must run immediately before handing control to the task owner.
 */
export interface ProtectedMrLaunchGuard extends TaskLaunchGuard {
  readonly id: string
}
