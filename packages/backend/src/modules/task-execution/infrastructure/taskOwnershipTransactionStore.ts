import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type {
  ExclusiveDaemonLockProof,
  OwnedTaskTx,
  OwnerSnapshot,
  OwnershipToken,
  OwnershipTuple,
  VerifiedStopProof,
  VerifiedTakeoverProof,
  WorkerIdentity,
} from '../domain/ownership'

export interface TaskOwnershipStore {
  claimPendingIntent(input: {
    db: DbClient
    intentId: string
    identity: WorkerIdentity
    now: number
    leaseMs: number
  }): OwnershipToken
  heartbeat(input: {
    db: DbClient
    token: OwnershipToken
    now: number
    leaseMs: number
  }): OwnershipToken
  withOwnedTaskTx<T>(input: {
    db: DbClient
    token: OwnershipToken
    now: number
    run: (tx: DbTxSync, owned: OwnedTaskTx) => T
  }): T
  revokeExact(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    now: number
    recoveryCode?: string
  }): OwnerSnapshot
  revokeOldDaemon(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    lockProof: ExclusiveDaemonLockProof
    now: number
  }): OwnerSnapshot
  markRecoveryRequired(input: {
    db: DbClient
    token: OwnershipToken
    expectedRevision: number
    code: string
    evidenceDigest?: string | null
    now: number
  }): OwnerSnapshot
  releaseAfterStop(input: {
    db: DbClient
    token: OwnershipToken
    intentId: string
    proof: VerifiedStopProof
    now: number
  }): OwnerSnapshot
  releaseRecovered(input: {
    db: DbClient
    owner: OwnershipTuple
    expectedRevision: number
    proof: VerifiedTakeoverProof
    now: number
  }): OwnerSnapshot
  read(db: DbClient, taskId: string): OwnerSnapshot | null
}
