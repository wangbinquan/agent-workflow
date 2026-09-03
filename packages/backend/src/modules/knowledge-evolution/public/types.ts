// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 对外的 fusion **类型**合同。
//
// 这些形状此前住在 `modules/memory/public/fusion.ts`，那是 RFC-294 明令的反向：
// design §638 把 fusion aggregate 判给 knowledge-evolution，memory 的禁止清单第一条就写着
// 「fusion engine」。端口住在被消费的那一侧，等于让 memory 替 KE 保管它的聚合契约。
//
// 拆成 `types.ts` / `participants.ts` 两个 **exact** 入口（RFC-317 T24 只允许
// commands/queries/participants/events/operations/types 六个文件名）——原来那个 `fusion.ts`
// 是 memory 的 NON_EXACT_PUBLIC 例外，本刀顺带把那条例外还掉。

import type { FusionStatus, ResourceAccess, WorkflowDefinition } from '@agent-workflow/shared'

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
