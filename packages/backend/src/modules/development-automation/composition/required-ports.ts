// RFC-310 consumer-owned required ports（design.md §1.5；本仓首个 required-ports 入口）。
//
// development-automation 对外部世界的全部依赖以本文件的 SPI 表达；实现由
// provider 模块的 `application/adapters/development-*-adapter.ts` 提供
// （type-only import，rfc294-architecture-preflight 放行的唯一形态），并在
// 装配点注入 composition.ts。普通 application/engine 不得 import 本文件
// （rfc310-architecture-lock 锁定）。
//
// DTO 纪律（rfc310-architecture-lock 做 token 级负扫描）：只允许 opaque ref、
// closed union、digest、revision、budget 与 capability 票据；禁止 credential、
// URL、header、DbClient、AbortSignal、runtime handle、session id、host 绝对
// 路径、raw body/log 与 open `Record<string, unknown>`。

import type {
  ActionRunRef,
  AgentExecutionRef,
  PipelineEvidenceBundleRef,
  RepositoryUploadPlanRef,
  RequirementBundleRef,
} from '@/modules/development-automation/domain/refs'

/** 一次性 staged sink 的 opaque 票据：adapter 只能写平台分配的暂存根，close 后失效。 */
export interface EvidenceSinkCapability {
  readonly sinkId: string
  readonly budget: {
    readonly maxFiles: number
    readonly maxFileBytes: number
    readonly maxTotalBytes: number
  }
}

export interface RequirementAcquireIntent {
  readonly adapterBindingRef: string
  readonly externalId: string
  readonly sink: EvidenceSinkCapability
  readonly idempotencyKey: string
}

export interface RequirementAcquisitionReceipt {
  readonly bundleRef: RequirementBundleRef
  readonly sourceRevision: string
  readonly manifestDigest: string
  readonly complete: boolean
}

export interface RequirementQuestionEffectIntent {
  readonly adapterBindingRef: string
  readonly questionSetRef: string
  readonly questionSetDigest: string
  readonly idempotencyKey: string
}

export interface RequirementQuestionEffectReceipt {
  readonly questionSetRef: string
  readonly correlationRef: string
}

export interface RequirementAnswerCollectIntent {
  readonly adapterBindingRef: string
  readonly questionSetRef: string
  readonly correlationRef: string
}

export interface RequirementAnswerCollectReceipt {
  readonly questionSetRef: string
  readonly answerRevision: string
  readonly answerDigest: string
  readonly complete: boolean
}

export interface RequirementAcquisitionPort {
  acquire(input: RequirementAcquireIntent): Promise<RequirementAcquisitionReceipt>
}

export interface RequirementInteractionPort {
  publishQuestions(
    input: RequirementQuestionEffectIntent,
  ): Promise<RequirementQuestionEffectReceipt>
  collectAnswers(input: RequirementAnswerCollectIntent): Promise<RequirementAnswerCollectReceipt>
}

export interface MergeRequestCollectIntent {
  readonly codeHostBindingRef: string
  readonly mergeRequestRef: string
}

export interface MergeRequestSnapshotReceipt {
  readonly snapshotRef: string
  readonly headSha: string
  readonly targetSha: string
  readonly snapshotDigest: string
}

export interface MergeRequestFactsPort {
  collect(input: MergeRequestCollectIntent): Promise<MergeRequestSnapshotReceipt>
}

export interface PipelineCollectIntent {
  readonly adapterBindingRef: string
  readonly mergeRequestRef: string
  readonly expectedHeadSha: string
  readonly expectedTargetSha: string
  readonly requiredGateKeys: readonly string[]
  readonly sink: EvidenceSinkCapability
}

export interface PipelineEvidenceReceipt {
  readonly bundleRef: PipelineEvidenceBundleRef
  readonly headSha: string
  readonly targetSha: string
  readonly completeness: 'complete' | 'partial'
  readonly manifestDigest: string
}

export interface PipelineTriggerIntent {
  readonly adapterBindingRef: string
  readonly expectedHeadSha: string
  readonly gateKeys: readonly string[]
  readonly idempotencyKey: string
}

export interface PipelineTriggerReceipt {
  readonly runRefs: readonly string[]
  readonly headSha: string
}

export interface PipelineRerunIntent {
  readonly adapterBindingRef: string
  readonly gateKey: string
  readonly runRef: string
  readonly expectedHeadSha: string
  readonly idempotencyKey: string
}

export interface PipelineRerunReceipt {
  readonly runRef: string
  readonly headSha: string
}

export interface PipelineEvidencePort {
  collect(input: PipelineCollectIntent): Promise<PipelineEvidenceReceipt>
  trigger(input: PipelineTriggerIntent): Promise<PipelineTriggerReceipt>
  rerun(input: PipelineRerunIntent): Promise<PipelineRerunReceipt>
}

/** closed effect union：类型层不存在 merge/approve/thread.resolve/custom（AC-15）。 */
export type DevelopmentCodeHostEffect =
  | { readonly kind: 'mr.ensure'; readonly intentRef: string }
  | { readonly kind: 'mr.comment.create'; readonly intentRef: string }
  | { readonly kind: 'mr.comment.update'; readonly intentRef: string }
  | { readonly kind: 'mr.feedback.reply'; readonly intentRef: string }
  | { readonly kind: 'mr.labels.reconcile'; readonly intentRef: string }

export interface DevelopmentCodeHostEffectReceipt {
  readonly effectKind: DevelopmentCodeHostEffect['kind']
  readonly providerCorrelationRef: string
  readonly resultDigest: string
}

export interface DevelopmentCodeHostEffectsPort {
  execute(input: DevelopmentCodeHostEffect): Promise<DevelopmentCodeHostEffectReceipt>
}

export interface AgentActionExecutionIntent {
  readonly actionRunRef: ActionRunRef
  readonly capabilityContractRef: string
  readonly actionTemplateRef: string
  readonly baselineRef: string
  readonly inputManifestRef: string
  readonly workspacePolicyRef: string
  readonly protocolRef: string
  readonly budget: { readonly wallTimeMs: number; readonly outputBytes: number }
}

export interface AgentActionLaunchReceipt {
  readonly executionRef: AgentExecutionRef
}

export interface AgentActionCancelIntent {
  readonly executionRef: AgentExecutionRef
  readonly reasonCode: string
}

export interface AgentActionCancelReceipt {
  readonly executionRef: AgentExecutionRef
  readonly settled: 'canceled' | 'already-terminal'
}

export interface AgentActionExecutionPort {
  launch(input: AgentActionExecutionIntent): Promise<AgentActionLaunchReceipt>
  cancel(input: AgentActionCancelIntent): Promise<AgentActionCancelReceipt>
}

export interface RepositoryUploadPlacementIntent {
  readonly uploadPlanRef: RepositoryUploadPlanRef
  readonly planDigest: string
  readonly baselineSnapshotRef: string
  readonly idempotencyKey: string
}

export interface RepositoryUploadPlacementReceipt {
  readonly uploadPlanRef: RepositoryUploadPlanRef
  readonly seedChangeRef: string | null
  readonly seedTreeDigest: string
}

export interface RepositoryUploadPlacementPort {
  place(input: RepositoryUploadPlacementIntent): Promise<RepositoryUploadPlacementReceipt>
}
