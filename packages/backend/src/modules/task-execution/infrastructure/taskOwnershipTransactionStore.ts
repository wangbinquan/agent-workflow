import type { DbClient } from '@/db/client'
import type { OwnerSnapshot, OwnershipToken, OwnershipTuple } from '../domain/ownership'

export interface TaskOwnershipStore {
  heartbeat(input: {
    db: DbClient
    token: OwnershipToken
    now: number
    leaseMs: number
  }): OwnershipToken
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
