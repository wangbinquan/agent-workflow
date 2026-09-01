import type { CanonicalHumanGateRequest } from '../../domain/canonicalGateRequest'
import type {
  HumanGateArtifactState,
  HumanGateOperationSnapshot,
} from '../../domain/humanGateOperation'

export const DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS = 30_000

export interface BeginHumanGateOperationInput {
  readonly operationId: string
  readonly request: CanonicalHumanGateRequest
  readonly idempotencyKey: string
  readonly now: number
  readonly artifacts?: readonly HumanGateArtifactDeclaration[]
  /** Clarify/manual preparations have no filesystem phase and can be made
   * prepared in the same atomic operation as their idempotency admission. */
  readonly preparedManifestJson?: string
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
  begin(input: BeginHumanGateOperationInput): Promise<BegunHumanGateOperation>
  findByIdempotency(input: {
    readonly taskId: string
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly operationKind: CanonicalHumanGateRequest['operationKind']
    readonly idempotencyKey: string
  }): Promise<HumanGateOperationSnapshot | null>
  latestGateRevision(input: {
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly gateRef: string
  }): Promise<number>
  get(operationId: string): Promise<HumanGateOperationSnapshot | null>
  listArtifacts(operationId: string): Promise<readonly HumanGateArtifactSnapshot[]>
  claimRecoveryBatch(input: {
    readonly now: number
    readonly leaseMs: number
    readonly limit: number
  }): Promise<readonly HumanGateOperationSnapshot[]>
  renewRecoveryClaim(input: {
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
    readonly leaseMs: number
  }): Promise<HumanGateOperationSnapshot>
  markPrepared(input: {
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly manifestJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  commit(input: {
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly receiptJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  complete(input: {
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  markCleanupPending(input: {
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  completeCleanup(input: {
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly failureJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  transitionArtifact(input: {
    readonly operationId: string
    readonly artifactKey: string
    readonly from: HumanGateArtifactState
    readonly to: HumanGateArtifactState
    readonly receiptJson?: string | null
    readonly expectedClaimEpoch?: number
    readonly now: number
  }): Promise<void>
}
