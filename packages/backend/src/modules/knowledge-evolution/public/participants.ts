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
import type { SkillTreeVersionOperations } from '../../resource-catalog/public/participants'
import type {
  FusionBuiltinWorkflowSeed,
  FusionDecisionRecoveryReceipt,
  FusionEngineTaskResult,
  FusionPersistencePatch,
  FusionPersistenceRecord,
  FusionProvenanceRepairReceipt,
  FusionResourceSeed,
  FusionSkillAccess,
  FusionSkillIdentity,
  FusionTreeFile,
  FusionWorkspaceSeed,
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
  readonly baseCommit: string | null
}

/**
 * RFC-370 §10 V20：KE 只交出种子树（技能字节），工作区由 task-execution 经 source-control 准备——
 * 本地是 `fusions/<id>/iter<n>/work` 的 Git 仓，托管是引擎任务自己卷里的工作副本。
 */
export interface FusionEngineTaskLaunch {
  readonly taskId: string
  readonly fusionId: string
  readonly iteration: number
  readonly seed: FusionWorkspaceSeed
  readonly workflowId: string
  readonly name: string
  readonly inputs: Readonly<Record<string, string>>
  readonly collaboratorUserIds?: readonly string[]
  readonly ownerUserId: string
  readonly initiator: 'manual' | 'api'
  readonly platformInputPaths: readonly string[]
  readonly completionMode?: 'background' | 'await-settle'
}

export interface FusionEngineTaskOperations {
  launch(command: FusionEngineTaskLaunch): Promise<void>
  load(taskId: string): Promise<FusionEngineTaskRecord | null>
  /** The settled task's proposal; `null` when the task no longer exists. */
  collect(taskId: string): Promise<FusionEngineTaskResult | null>
  /** Gives the task's workspace back once its proposal is no longer needed there. */
  release(taskId: string): Promise<void>
  cancel(taskId: string): Promise<void>
}

export interface FusionOperations {
  readonly persistence: FusionPersistence
  readonly memories: MemoryCatalogOperations
  readonly tasks: FusionEngineTaskOperations
  /** Seeds (strict version trees) and proposal candidates of the selected skill storage. */
  readonly skillTrees: SkillTreeVersionOperations
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
  /** The proposed skill tree that becomes the next version. */
  readonly proposal: readonly FusionTreeFile[]
  readonly incorporatedMemoryIds: readonly string[]
  readonly summary: string
  readonly now: number
}

// ---------------------------------------------------------------------------
// RFC-353 T7（RFC-294 W4-E3）—— 技能回滚的成员关系协调，KE offered。
//
// resource-catalog 铸新版本、memory 退回记忆，而「回滚时该退回哪些、必须与版本推进
// 同事务」这条规则归 knowledge-evolution。RC 只认识下面这个窄端口（给事务、还 id），
// 既不认识 memory，也不必知道 `aboveVersion` 是怎么算出来的——从而拆掉
// `resource-catalog → memory/infrastructure` 那条跨 context 内部 import（RFC-317 R2）。
//
// 装配在 bootstrap：RFC-294 的目标边表里只有 `knowledge-evolution → resource-catalog`，
// 反向边不存在，所以 RC 不能 import KE；由 `cli/start.ts` / `server.ts` /
// `cli/postgresqlDaemonApplication.ts` 把 KE 铸好的协调器交给 RC 的 composition。
// ---------------------------------------------------------------------------

export type { SkillRestoreMembershipRequest } from '../application/skillRestoreMembership'
export { createAsyncSkillRestoreMembership } from '../application/skillRestoreMembership'
