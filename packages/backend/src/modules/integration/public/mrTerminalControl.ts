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
  /** Second durable gate. Safe to call both before materialization and in the task INSERT tx. */
  assertCanCommit(): void
  taskCommitted(taskId: string): void
  launchSettled(taskId: string): void
  failed(errorCode: string): void
  release(): void
}

export interface MrTerminalControl {
  reserveLaunch(input: ProtectedMrLaunchGuardInput): ProtectedMrLaunchGuard
  /** Wake is idempotent; effectId only narrows the first scan. */
  wake(effectId?: string | null): void
  /** Boot barrier: reconcile stale guards and drain every currently due effect. */
  reconcileOnBoot(): Promise<void>
  stop(): void
}
