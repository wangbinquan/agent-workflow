// RFC-552 (RFC-294 S9): the fusion persistence port and the records, patches, seeds and receipts it carries. They sat on
// `public/`, reachable only through the maintenance functions' signatures; no other module reads them.
import type { FusionTreeFile } from '../../public/types'
import type { AuthenticatedAuthoritySnapshot } from '@/modules/identity-access/public/participants'
import type { FusionStatus, ResourceAccess } from '@agent-workflow/shared'
import type { FusionBuiltinWorkflowSeed } from '../../domain/fusionWorkflowSeed'
import type { FusionPersistenceRecord } from '../../domain/fusionRow'

export interface FusionPersistence {
  seedResources(seed: FusionResourceSeed): Promise<void>
  loadBuiltinWorkflowId(seed: FusionBuiltinWorkflowSeed, ownerUserId: string): Promise<string>

  loadSkillAccess(
    actor: AuthenticatedAuthoritySnapshot,
    skillId: string,
  ): Promise<FusionSkillAccess | null>
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
  claimDecision(command: FusionDecisionClaimInput): Promise<boolean>
  claimCancellation(input: {
    readonly id: string
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly now: number
  }): Promise<{ readonly ok: false } | { readonly ok: true; readonly taskId: string | null }>
  apply(command: FusionApplyCommand): Promise<{ readonly versionIndex: number }>

  repairProvenance(): Promise<FusionProvenanceRepairReceipt>
  recoverDecisions(now?: number): Promise<FusionDecisionRecoveryReceipt>
}

// ---------------------------------------------------------------------------
// RFC-353 T5 —— fusion 的**命令载荷**形状。
//
// 它们是入参 DTO（谁在改、从什么状态改到什么状态、这次提交带什么），不是 participant。
// 它们与 `FusionPersistence` 的方法签名绑定，所以保留在 participants 面；
// RFC-400：调用方身份直接使用 Identity Access 的 AuthenticatedAuthoritySnapshot。
//
// `FusionDecisionClaimInput` 原名 `FusionDecisionClaimInput`：capability-forge 守卫按**名字后缀**
// 判敏感类型（`…Claim` 视为需要 brand + 唯一工厂 + 私有注册表的能力对象）。它其实只是入参 DTO，
// 所以改名而不是给它铸一个假的能力合同——守卫是在说这个名字承诺了它并不提供的东西。
// ---------------------------------------------------------------------------

export interface FusionDecisionClaimInput {
  readonly id: string
  readonly actor: AuthenticatedAuthoritySnapshot
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
  readonly actor: AuthenticatedAuthoritySnapshot
  /** The proposed skill tree that becomes the next version. */
  readonly proposal: readonly FusionTreeFile[]
  readonly incorporatedMemoryIds: readonly string[]
  readonly summary: string
  readonly now: number
  /** 提案所在的候选树；提交后由 RC 场景的尾部清理。 */
  readonly candidateId?: string
}

export interface FusionSkillAccess {
  readonly skill: FusionSkillIdentity
  readonly access: ResourceAccess
  readonly preconditionToken: string
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

export interface FusionBuiltinAgentSeed {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly outputs: readonly string[]
  readonly syncOutputsOnIterate: boolean
  readonly bodyMd: string
}
