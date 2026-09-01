import type {
  ApplicationEvidence,
  RetryAuthority,
  TaskExecutionAttemptState,
  TaskExecutionEffectKind,
} from '../../domain/executionEffect'
import type { OwnershipToken } from '../../domain/ownership'

export interface TaskEffectLineageSnapshot {
  readonly executionLineageId: string
  readonly continuationSlotKey: string
  readonly slotPathJson: string
  readonly workflowVersion: number | null
  readonly nodeId: string | null
  readonly iteration: number | null
  readonly retryIndex: number | null
  readonly shardKey: string | null
}

export interface TaskEffectAttemptIdentity {
  readonly effectId: string
  readonly attemptId: string
  readonly attemptNo: number
  readonly resourceKeys: readonly string[]
}

export interface TaskEffectAttemptPreparation {
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

export interface TaskEffectAttemptSettlement {
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
}

export interface CodeHostNodeSettlementProjection {
  readonly nodeRunId: string
  readonly status: 'done' | 'failed'
  readonly reason: string
  readonly finishedAt: number
  readonly errorMessage?: string
  readonly failureCode?: string
  readonly outputs?: readonly Readonly<{ portName: string; content: string }>[]
}

/** Closed projection written together with a successful workspace-prepare
 * effect. Infrastructure owns the provider transaction; callers cannot pass a
 * database callback through this contract. */
export interface WorkspacePreparationRepositoryProjection {
  readonly taskId: string
  readonly repoIndex: number
  readonly repoPath: string
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly baseBranch: string
  readonly branch: string
  readonly workingBranch: string | null
  readonly baseCommit: string | null
  readonly worktreePath: string
  readonly worktreeDirName: string
  readonly mountPath: string
  readonly subdir: string
  readonly readonly: boolean
  readonly readonlyDirtyCount: null
  readonly workspaceProfileVersion: number | null
  readonly workspaceProfileDigest: string | null
  readonly hasSubmodules: boolean
  readonly submoduleInitOk: boolean
  readonly submoduleInitError: string | null
  readonly schemaVersion: number
}

export interface WorkspacePreparationSettlementProjection {
  readonly taskId: string
  readonly prepNodeRunId: string
  readonly finishedAt: number
  readonly task: Readonly<{
    worktreePath: string
    branch: string
    baseCommit: string | null
    repoPath: string
    repoUrl: string | null
    cachedRepoId: string | null
    baseBranch: string
    repoCount: number
  }>
  readonly repositories: readonly WorkspacePreparationRepositoryProjection[]
  readonly nodePaths: readonly string[]
}

/** Provider-neutral effect journal and resource-fence boundary. Business
 * projections that must share settlement atomicity are exposed as separate
 * named ports by their owning use case, never as a transaction callback. */
export interface TaskExecutionEffectPersistence {
  readLineage(input: {
    readonly taskId: string
    readonly intentId: string
    readonly nodeRunId?: string
  }): Promise<TaskEffectLineageSnapshot | null>
  planCodeHostAttempt(input: {
    readonly executionLineageId: string
    readonly operationFamilyKey: string
  }): Promise<{ readonly operationGeneration: number; readonly retryAuthority: RetryAuthority }>
  nextOperationGeneration(input: {
    readonly executionLineageId: string
    readonly operationFamilyKey: string
  }): Promise<number>
  prepareAndAcquire(input: TaskEffectAttemptPreparation): Promise<TaskEffectAttemptIdentity>
  settle(input: TaskEffectAttemptSettlement): Promise<void>
  settleCodeHostNode(input: {
    readonly settlement: TaskEffectAttemptSettlement
    readonly projection: CodeHostNodeSettlementProjection
  }): Promise<void>
  settleWorkspacePreparation(input: {
    readonly settlement: TaskEffectAttemptSettlement
    readonly projection: WorkspacePreparationSettlementProjection
  }): Promise<void>
  recordProcessSpawn(input: {
    readonly token: OwnershipToken
    readonly effectId: string
    readonly attemptId: string
    readonly nodeRunId: string
    readonly pid: number
    readonly spawnBinaryPath: string
    readonly launchNonce: string
    readonly runtimeParamsJson?: string
    readonly now?: number
  }): Promise<void>
}

/** @deprecated source-compatibility name; the shape is Promise/provider-neutral. */
export type TaskExecutionEffectStore = TaskExecutionEffectPersistence
