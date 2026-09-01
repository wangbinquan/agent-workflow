import type {
  ExclusiveDaemonLockProof,
  OwnerSnapshot,
  OwnershipToken,
  OwnershipTuple,
  VerifiedStopProof,
  VerifiedTakeoverProof,
  WorkerIdentity,
} from '../../domain/ownership'

/** Provider-neutral, Promise-shaped ownership/CAS/lease boundary. Atomic
 * mutations are named; no database or generic transaction scope escapes. */
export interface TaskOwnershipPersistence {
  claimPendingIntent(input: {
    readonly intentId: string
    readonly identity: WorkerIdentity
    readonly now: number
    readonly leaseMs: number
  }): Promise<OwnershipToken>
  heartbeat(input: {
    readonly token: OwnershipToken
    readonly now: number
    readonly leaseMs: number
  }): Promise<OwnershipToken>
  revokeExact(input: {
    readonly owner: OwnershipTuple
    readonly expectedRevision: number
    readonly now: number
    readonly recoveryCode?: string
  }): Promise<OwnerSnapshot>
  revokeOldDaemon(input: {
    readonly owner: OwnershipTuple
    readonly expectedRevision: number
    readonly lockProof: ExclusiveDaemonLockProof
    readonly now: number
  }): Promise<OwnerSnapshot>
  markRecoveryRequired(input: {
    readonly token: OwnershipToken
    readonly expectedRevision: number
    readonly code: string
    readonly evidenceDigest?: string | null
    readonly now: number
  }): Promise<OwnerSnapshot>
  releaseAfterStop(input: {
    readonly token: OwnershipToken
    readonly intentId: string
    readonly proof: VerifiedStopProof
    readonly now: number
  }): Promise<OwnerSnapshot>
  releaseRecovered(input: {
    readonly owner: OwnershipTuple
    readonly expectedRevision: number
    readonly proof: VerifiedTakeoverProof
    readonly now: number
  }): Promise<OwnerSnapshot>
  read(taskId: string): Promise<OwnerSnapshot | null>
}
