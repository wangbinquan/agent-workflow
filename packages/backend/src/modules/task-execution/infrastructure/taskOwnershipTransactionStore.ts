import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type {
  OwnedTaskTx,
  OwnerSnapshot,
  OwnershipToken,
  OwnershipTuple,
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
  markRecoveryRequired(input: {
    db: DbClient
    token: OwnershipToken
    expectedRevision: number
    code: string
    evidenceDigest?: string | null
    now: number
  }): OwnerSnapshot
  read(db: DbClient, taskId: string): OwnerSnapshot | null
}
