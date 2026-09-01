import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type {
  ApplicationEvidence,
  RetryAuthority,
  TaskExecutionAttemptState,
  TaskExecutionEffectKind,
} from '../domain/executionEffect'
import type {
  ExclusiveDaemonLockProof,
  OwnerSnapshot,
  OwnershipToken,
  OwnershipTuple,
  VerifiedOutcomeUnknownClosure,
  VerifiedStopProof,
} from '../domain/ownership'

export interface PrepareEffectAttemptInput {
  readonly db: DbClient
  readonly token: OwnershipToken
  readonly intentId: string
  readonly operationKey: string
  readonly executionLineageId: string
  readonly operationFamilyKey: string
  readonly operationGeneration: number
  readonly kind: TaskExecutionEffectKind
  readonly requestHash: string
  readonly slotPathJson: string
  readonly slotPathDigest: string
  readonly candidateId: string
  readonly recoveryClass: string
  readonly recoveryDescriptorJson?: string | null
  readonly classifierVersion: string
  readonly transportPolicyVersion: string
  readonly retryAuthority: RetryAuthority
  readonly resourceKeys: readonly string[]
  readonly now?: number
}

export interface PreparedEffectAttempt {
  readonly effectId: string
  readonly attemptId: string
  readonly attemptNo: number
  readonly resourceKeys: readonly string[]
}

export interface LinkedWorkspaceRollbackEffect {
  readonly effectId: string
  readonly idempotent: boolean
}

export interface RecoveredManagedProcessResolution {
  readonly resolvedEffectIds: readonly string[]
  readonly unresolvedEffectIds: readonly string[]
}

export interface RecoveredCodeHostMutationInput {
  readonly effectId: string
  readonly attemptId: string
  readonly outcome: 'applied' | 'definitely-not-applied'
  readonly receiptJson: string
  readonly nodeRunId: string | null
  readonly responseStatus: number
  readonly responseBody: string
}

export interface RecoveredCodeHostMutationResolution {
  readonly appliedEffectIds: readonly string[]
  readonly retryAuthorizedEffectIds: readonly string[]
}

export interface CodeHostAttemptPlan {
  readonly operationGeneration: number
  readonly retryAuthority: RetryAuthority
}

export interface SettleEffectAttemptInput {
  readonly db: DbClient
  readonly token: OwnershipToken
  readonly effectId: string
  readonly attemptId: string
  readonly state: Extract<
    TaskExecutionAttemptState,
    | 'succeeded'
    | 'failed-not-applied'
    | 'retry-authorized'
    | 'recovery-required'
    | 'outcome-unknown'
  >
  readonly applicationEvidence: ApplicationEvidence
  readonly retryAuthority: RetryAuthority
  readonly receiptJson?: string | null
  readonly failureCode?: string | null
  readonly now?: number
  /**
   * Business projection that must become durable with the attempt settlement.
   * The callback runs only after every effect/attempt/fence/lineage check has
   * passed, inside the same owned transaction.
   */
  readonly onSettledTx?: (tx: DbTxSync) => void
}

export interface TaskExecutionEffectStore {
  /**
   * Admission-time link used only by an RFC-333 gate-continuation transaction.
   * It creates the logical effect before a worker exists; the exact owner epoch
   * still prepares the first attempt and acquires resource fences pre-drive.
   */
  linkWorkspaceRollbackTx(input: {
    readonly tx: DbTxSync
    readonly taskId: string
    readonly intentId: string
    readonly operationKey: string
    readonly executionLineageId: string
    readonly operationFamilyKey: string
    readonly operationGeneration: number
    readonly requestHash: string
    readonly slotPathJson: string
    readonly slotPathDigest: string
    readonly now: number
  }): LinkedWorkspaceRollbackEffect
  /** Reuse an explicitly authorized open generation; otherwise mint N+1. */
  planCodeHostAttempt(input: {
    readonly db: DbClient
    readonly executionLineageId: string
    readonly operationFamilyKey: string
  }): CodeHostAttemptPlan
  prepareAndAcquire(input: PrepareEffectAttemptInput): PreparedEffectAttempt
  settle(input: SettleEffectAttemptInput): void
  /**
   * Resolve only RFC-328 pre-activated managed-process attempts after the
   * successor daemon's orphan-process barrier has completed.  A durable spawn
   * receipt means the launch happened; its absence means the gated launcher
   * could not activate the target.  Every other shape remains unresolved.
   */
  resolveQuiescedManagedProcesses(
    input: {
      readonly db: DbClient
      readonly quiescenceEvidenceDigest: string
      readonly now?: number
    } & (
      | {
          readonly authority: 'successor-daemon'
          readonly owner: OwnershipTuple
          readonly expectedRevision: number
          readonly lockProof: ExclusiveDaemonLockProof
        }
      | {
          readonly authority: 'exact-stop'
          readonly token: OwnershipToken
          readonly expectedRevision: number
          readonly proof: VerifiedStopProof
        }
    ),
  ): RecoveredManagedProcessResolution
  /** Resolve deterministic code-host probes under the successor daemon lock. */
  resolveQuiescedCodeHostMutations(input: {
    readonly db: DbClient
    readonly owner: OwnershipTuple
    readonly expectedRevision: number
    readonly lockProof: ExclusiveDaemonLockProof
    readonly quiescenceEvidenceDigest: string
    readonly resolutions: readonly RecoveredCodeHostMutationInput[]
    readonly onAppliedTx?: (tx: DbTxSync, resolution: RecoveredCodeHostMutationInput) => void
    readonly now?: number
  }): RecoveredCodeHostMutationResolution
  closeOutcomeUnknownAndRelease(input: {
    readonly db: DbClient
    readonly token: OwnershipToken
    readonly intentId: string
    readonly proof: VerifiedOutcomeUnknownClosure
    readonly now?: number
  }): OwnerSnapshot
  closeRecoveredOutcomeUnknownAndRelease(input: {
    readonly db: DbClient
    readonly owner: OwnershipTuple
    readonly expectedRevision: number
    readonly lockProof: ExclusiveDaemonLockProof
    readonly proof: VerifiedOutcomeUnknownClosure
    readonly now?: number
  }): OwnerSnapshot
}
