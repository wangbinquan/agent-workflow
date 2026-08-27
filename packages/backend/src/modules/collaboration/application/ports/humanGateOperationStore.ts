import type { DbTxSync } from '@/db/txSync'
import type { CanonicalHumanGateRequest } from '../../domain/canonicalGateRequest'
import type {
  HumanGateArtifactState,
  HumanGateOperationSnapshot,
} from '../../domain/humanGateOperation'

export const DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS = 30_000

export interface BeginHumanGateOperationInput {
  readonly tx: DbTxSync
  readonly operationId: string
  readonly request: CanonicalHumanGateRequest
  readonly idempotencyKey: string
  readonly now: number
}

export type BegunHumanGateOperation = Readonly<{
  operation: HumanGateOperationSnapshot
  replayed: boolean
}>

export interface HumanGateArtifactDeclaration {
  readonly artifactKey: string
  readonly stagedPath: string
  readonly finalPath: string
  readonly sha256: string
  readonly byteSize: number
}

export interface HumanGateArtifactSnapshot extends HumanGateArtifactDeclaration {
  readonly operationId: string
  readonly artifactKind: 'review-doc'
  readonly state: HumanGateArtifactState
  readonly receiptJson: string | null
  readonly updatedAt: number
}

export interface HumanGateOperationStore {
  beginTx(input: BeginHumanGateOperationInput): BegunHumanGateOperation
  findByIdempotencyTx(input: {
    readonly tx: DbTxSync
    readonly taskId: string
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly operationKind: CanonicalHumanGateRequest['operationKind']
    readonly idempotencyKey: string
  }): HumanGateOperationSnapshot | null
  latestGateRevisionTx(input: {
    readonly tx: DbTxSync
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly gateRef: string
  }): number
  getTx(tx: DbTxSync, operationId: string): HumanGateOperationSnapshot | null
  listArtifactsTx(tx: DbTxSync, operationId: string): readonly HumanGateArtifactSnapshot[]
  claimRecoveryBatchTx(input: {
    readonly tx: DbTxSync
    readonly now: number
    readonly leaseMs: number
    readonly limit: number
  }): readonly HumanGateOperationSnapshot[]
  renewRecoveryClaimTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
    readonly leaseMs: number
  }): HumanGateOperationSnapshot
  markPreparedTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly manifestJson: string
    readonly now: number
  }): HumanGateOperationSnapshot
  commitTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly receiptJson: string
    readonly now: number
  }): HumanGateOperationSnapshot
  completeTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): HumanGateOperationSnapshot
  markCleanupPendingTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): HumanGateOperationSnapshot
  deleteCleanupArtifactsTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
  }): void
  completeCleanupTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly failureJson: string
    readonly now: number
  }): HumanGateOperationSnapshot
  declareArtifactsTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly artifacts: readonly HumanGateArtifactDeclaration[]
    readonly now: number
  }): void
  transitionArtifactTx(input: {
    readonly tx: DbTxSync
    readonly operationId: string
    readonly artifactKey: string
    readonly from: HumanGateArtifactState
    readonly to: HumanGateArtifactState
    readonly receiptJson?: string | null
    readonly expectedClaimEpoch?: number
    readonly now: number
  }): void
}
