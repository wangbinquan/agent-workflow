import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { RecoveredManagedProcessResolution } from '../application/ports/taskExecutionEffectStore'
import type {
  ApplicationEvidence,
  RetryAuthority,
  TaskExecutionAttemptState,
  TaskExecutionEffectKind,
} from '../domain/executionEffect'
import type {
  OwnerSnapshot,
  OwnershipToken,
  VerifiedOutcomeUnknownClosure,
} from '../domain/ownership'

// RFC-359 T7b：判定结果类型归端口所有；这里只为同步 store 的既有 import 路径再导出。
export type { RecoveredManagedProcessResolution }

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
  // RFC-359 W8：静默清算的同步副本已退役。`resolveQuiescedManagedProcesses` /
  // `closeRecoveredOutcomeUnknownAndRelease` 只剩 `effectQuiescence.ts` 那一份中立实现
  // （两个 provider 共用，经 `TaskExecutionEffectPersistence` 端口暴露）；同步 store 上的
  // 那两份自 W1-T7b 起就没有任何调用方，随本波一并删除。
  closeOutcomeUnknownAndRelease(input: {
    readonly db: DbClient
    readonly token: OwnershipToken
    readonly intentId: string
    readonly proof: VerifiedOutcomeUnknownClosure
    readonly now?: number
  }): OwnerSnapshot
}
