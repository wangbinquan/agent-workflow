import type {
  Fusion,
  FusionStatus,
  ResourceAccess,
  TaskStatus,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { MemoryCatalogOperations } from './catalog'

export interface FusionPersistenceRecord {
  readonly id: string
  readonly skillId: string
  readonly skillName: string
  readonly baseSkillVersion: number
  readonly preconditionToken: string | null
  readonly memoryIdsJson: string
  readonly intent: string
  readonly status: FusionStatus
  readonly iteration: number
  readonly currentTaskId: string | null
  readonly proposedWorktreePath: string | null
  readonly proposedDiff: string | null
  readonly incorporatedMemoryIdsJson: string | null
  readonly skippedJson: string | null
  readonly changelog: string | null
  readonly appliedSkillVersion: number | null
  readonly ownerUserId: string
  readonly createdAt: number
  readonly decidedByUserId: string | null
  readonly decidedAt: number | null
  readonly decisionReason: string | null
  readonly error: string | null
}

export type FusionPersistencePatch = Partial<
  Pick<
    FusionPersistenceRecord,
    | 'iteration'
    | 'currentTaskId'
    | 'proposedWorktreePath'
    | 'proposedDiff'
    | 'incorporatedMemoryIdsJson'
    | 'skippedJson'
    | 'changelog'
    | 'appliedSkillVersion'
    | 'decidedByUserId'
    | 'decidedAt'
    | 'decisionReason'
    | 'error'
  >
>

export interface FusionSkillIdentity {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly contentVersion: number
  readonly metaRevision: number
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
}

export interface FusionSkillAccess {
  readonly skill: FusionSkillIdentity
  readonly access: ResourceAccess
  readonly preconditionToken: string
}

export interface FusionBuiltinAgentSeed {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly outputs: readonly string[]
  readonly syncOutputsOnIterate: boolean
  readonly bodyMd: string
}

export interface FusionBuiltinWorkflowSeed {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly definition: WorkflowDefinition
  readonly mergerAgentId: string
}

export interface FusionResourceSeed {
  readonly ownerUserId: string
  readonly agent: FusionBuiltinAgentSeed
  readonly workflow: FusionBuiltinWorkflowSeed
}

export interface FusionProvenanceRepairReceipt {
  readonly repairedFusions: number
  readonly quarantinedFusions: number
  readonly terminalizedFusions: number
  readonly repairedMemories: number
  readonly quarantinedMemories: number
}

export interface FusionDecisionRecoveryReceipt {
  readonly rolledForward: number
  readonly rolledBack: number
  readonly rejectFailed: number
}

export interface FusionDecisionClaim {
  readonly id: string
  readonly actor: Actor
  readonly from: FusionStatus
  readonly to: FusionStatus
  readonly patch?: FusionPersistencePatch
}

export interface FusionStatusCas {
  readonly id: string
  readonly from: readonly FusionStatus[]
  readonly to: FusionStatus
  readonly expectedCurrentTaskId?: string | null
  readonly patch?: FusionPersistencePatch
}

export interface FusionApplyCommand {
  readonly fusionId: string
  readonly actor: Actor
  readonly appHome: string
  readonly proposedWorktreePath: string
  readonly incorporatedMemoryIds: readonly string[]
  readonly summary: string
  readonly now: number
}

export interface FusionPersistence {
  seedResources(seed: FusionResourceSeed): Promise<void>
  loadBuiltinWorkflowId(seed: FusionBuiltinWorkflowSeed, ownerUserId: string): Promise<string>

  loadSkillAccess(actor: Actor, skillId: string): Promise<FusionSkillAccess | null>
  loadSkillIdentity(skillId: string): Promise<FusionSkillIdentity | null>

  create(record: FusionPersistenceRecord): Promise<void>
  load(id: string): Promise<FusionPersistenceRecord | null>
  listSummaries(filter?: {
    readonly skillId?: string
    readonly status?: FusionStatus
  }): Promise<readonly FusionPersistenceRecord[]>
  listIdsByStatus(status: FusionStatus): Promise<readonly string[]>
  listAwaitingApprovalOwners(): Promise<readonly { id: string; ownerUserId: string }[]>

  casStatus(command: FusionStatusCas): Promise<boolean>
  claimDecision(command: FusionDecisionClaim): Promise<boolean>
  claimCancellation(input: {
    readonly id: string
    readonly actor: Actor
    readonly now: number
  }): Promise<{ readonly ok: false } | { readonly ok: true; readonly taskId: string | null }>
  apply(command: FusionApplyCommand): Promise<{ readonly versionIndex: number }>

  repairProvenance(): Promise<FusionProvenanceRepairReceipt>
  recoverDecisions(now?: number): Promise<FusionDecisionRecoveryReceipt>
}

export interface FusionEngineTaskRecord {
  readonly status: TaskStatus
  readonly errorSummary: string | null
  readonly worktreePath: string
}

export interface FusionEngineTaskLaunch {
  readonly taskId: string
  readonly workflowId: string
  readonly name: string
  readonly inputs: Readonly<Record<string, string>>
  readonly collaboratorUserIds?: readonly string[]
  readonly ownerUserId: string
  readonly initiator: 'manual' | 'api'
  readonly worktreePath: string
  readonly baseCommit: string
  readonly platformInputPaths: readonly string[]
  readonly binaryOverride?: readonly string[]
  readonly configPath?: string
  readonly awaitScheduler?: boolean
  readonly defaultPerNodeTimeoutMs?: number
  readonly defaultNodeRetries?: number
  readonly sessionRestartBudget?: number
  readonly defaultRuntime?: string
}

export interface FusionEngineTaskOperations {
  launch(command: FusionEngineTaskLaunch): Promise<void>
  load(taskId: string): Promise<FusionEngineTaskRecord | null>
  cancel(taskId: string): Promise<void>
}

export interface FusionOperations {
  readonly persistence: FusionPersistence
  readonly memories: MemoryCatalogOperations
  readonly tasks: FusionEngineTaskOperations
}

export type FusionView = Fusion
