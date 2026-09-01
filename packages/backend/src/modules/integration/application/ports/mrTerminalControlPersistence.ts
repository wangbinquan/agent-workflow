import type { ProtectedMrLaunchGuardInput } from '../../public/mrTerminalControl'

export type MrLaunchGuardStatus =
  | 'reserved'
  | 'launching'
  | 'revoking-terminal'
  | 'task-committed'
  | 'launch-settled'
  | 'aborted-terminal'
  | 'failed'

export interface MrLaunchGuardReservation {
  readonly guardId: string
  readonly ownerKey: string
  readonly createdAt: number
}

export interface MrLaunchGuardPersistencePort {
  reserve(input: ProtectedMrLaunchGuardInput & MrLaunchGuardReservation): Promise<void>
  markLaunching(guardId: string, now: number): Promise<void>
  assertCanCommit(input: {
    readonly guardId: string
    readonly launchRevision: number
  }): Promise<boolean>
  markTaskCommitted(guardId: string, taskId: string, now: number): Promise<void>
  markLaunchSettled(guardId: string, taskId: string, now: number): Promise<void>
  markFailed(guardId: string, errorCode: string, now: number): Promise<void>
  listRevokingGuardIds(): Promise<readonly string[]>
  reconcileStaleOnBoot(now: number): Promise<void>
  hasLaunchBarrier(binding: string, revision: number): Promise<boolean>
}

/**
 * Process-local ownership is a runtime mechanism, not application policy.
 * Composition supplies the implementation so this application layer never
 * imports a concrete SQLite/PostgreSQL/in-memory adapter.
 */
export interface MrLaunchSupervisorPort {
  register(guardId: string, controller: AbortController): boolean
  abort(guardId: string): boolean
  release(guardId: string, controller: AbortController): boolean
  abortAll(): void
}

export type MrControlEffectStatus =
  | 'pending'
  | 'waiting-launches'
  | 'retryable'
  | 'leased'
  | 'succeeded'

export interface MrControlEffectClaim {
  readonly id: string
  readonly binding: string
  readonly endpointId: string
  readonly streamKey: string
  readonly revision: number
  readonly kind: 'fence-closed' | 'fence-merged' | 'clear-closed'
  readonly deliveryId: string
  readonly attemptCount: number
}

export interface MrControlTargetReceipt {
  readonly taskId: string
  readonly priorStatus: string | null
  readonly fenceOutcome: string
  readonly cancelOutcome: string
  readonly releaseOutcome: string
  readonly errorCode: string | null
}

export interface MrTerminalEffectPersistencePort {
  claimNextDue(input: {
    readonly workerId: string
    readonly now: number
    readonly leaseMs: number
  }): Promise<MrControlEffectClaim | null>
  recordReceipts(
    effectId: string,
    receipts: readonly MrControlTargetReceipt[],
    now: number,
  ): Promise<void>
  listReleaseOutcomes(effectId: string): Promise<readonly string[]>
  finishAttempt(input: {
    readonly effectId: string
    readonly workerId: string
    readonly status: MrControlEffectStatus
    readonly nextAttemptAt: number
    readonly lastError: string | null
    readonly now: number
  }): Promise<void>
}
