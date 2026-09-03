// RFC-353 T5（RFC-294 W4-E3）—— knowledge-evolution 对外的 fusion **participant** 合同。
//
// `FusionPersistence` 是 fusion 聚合自己的仓储面；`FusionEngineTaskOperations` 是 KE 向
// task-execution 要的启动面（TE 侧已有 exact adapter，本刀不动它）。
// `FusionOperations` 把三者装配成 application 的取用点。
//
// 注意 `FusionPersistence` 今天仍带着跨聚合写入（skill 版本、memory 成员关系），
// 那是 T6 要换成 resource-catalog / memory 各自 offered participant 的部分——
// 本刀只做归位，不改形状，避免「表已归位、跨聚合直写还在」与「形状改了但还在 legacy」
// 两种半截状态同时存在。

import type { FusionStatus, TaskStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

import type { MemoryCatalogOperations } from '../../memory/public/catalog'
import type {
  FusionBuiltinWorkflowSeed,
  FusionDecisionRecoveryReceipt,
  FusionPersistencePatch,
  FusionPersistenceRecord,
  FusionProvenanceRepairReceipt,
  FusionResourceSeed,
  FusionSkillAccess,
  FusionSkillIdentity,
} from './types'

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
  claimDecision(command: FusionDecisionClaimInput): Promise<boolean>
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

// ---------------------------------------------------------------------------
// RFC-353 T5 —— fusion 的**命令载荷**形状。
//
// 它们是入参 DTO（谁在改、从什么状态改到什么状态、这次提交带什么），不是 participant。
// 它们与 `FusionPersistence` 的方法签名绑定，所以住在 participants 面；`public/types` 不允许
// 出现 `Actor`（硬规则），而这里的 Actor 依赖是 RFC-294 已登记的存量债。
//
// `FusionDecisionClaimInput` 原名 `FusionDecisionClaimInput`：capability-forge 守卫按**名字后缀**
// 判敏感类型（`…Claim` 视为需要 brand + 唯一工厂 + 私有注册表的能力对象）。它其实只是入参 DTO，
// 所以改名而不是给它铸一个假的能力合同——守卫是在说这个名字承诺了它并不提供的东西。
// ---------------------------------------------------------------------------

export interface FusionDecisionClaimInput {
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
