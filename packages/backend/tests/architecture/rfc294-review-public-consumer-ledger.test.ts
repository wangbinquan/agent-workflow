// RFC-294 review 2026-08-30 §C2 —— 公共面只降不升：零生产 consumer 的 public symbol 与
// 无 provider、无 consumer 的 required port 逐条入账。
//
// 为什么存在（design/RFC-294-backend-layered-target-architecture/review-2026-08-30.md §C2）：
// design §3.3 说「没有生产 consumer 的 symbol/field 不公开」，但 committed
// `architecture/public-surfaces.json` 的 public symbol 只把顶层、无 production/import/type consumer
// 的合同计入债务；递归嵌套 DTO 由 `publicTypeConsumerIds` 证明消费关系，不重复计入分母。
// `requiredPorts` 23 个里 20 个 declared-debt 零 provider，其中 8 个连 consumer 都是 0
// （development-automation 的 AgentActionExecutionPort 等）——纯死声明，跨了好几个 wave 无人看守。
//
// 这不是禁止「先落合同再切 consumer」（plan §2 五步的第 2 步本来就允许 additive contract）：
// 新增零 consumer 的 public symbol 必须同批入账并点名清偿波次，被消费后必须同批销账；
// 入账即留痕，RFC-317 T17 高水位再管只降不升。本文件只读 committed 账本，不扫源码。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

export interface PublicSurfaceLike {
  readonly id: string
  readonly file?: string
  readonly consumerEdgeIds?: readonly unknown[]
  readonly productionConsumers?: readonly unknown[]
  readonly publicTypeConsumerIds?: readonly unknown[]
}

export interface RequiredPortLike {
  readonly id: string
  readonly providerAdapters?: readonly unknown[]
  readonly consumerOwnerEntryIds?: readonly unknown[]
}

interface Debt {
  readonly id: string
  readonly removeAfterWave: string
}

interface DeadPortDebt extends Debt {
  readonly why: string
}

export function unconsumedPublicSymbols(entries: readonly PublicSurfaceLike[]): string[] {
  return entries
    .filter(
      (entry) =>
        (entry.consumerEdgeIds ?? []).length === 0 &&
        (entry.productionConsumers ?? []).length === 0 &&
        (entry.publicTypeConsumerIds ?? []).length === 0,
    )
    .map((entry) => entry.id)
    .sort()
}

export function deadRequiredPorts(ports: readonly RequiredPortLike[]): string[] {
  return ports
    .filter(
      (port) =>
        (port.providerAdapters ?? []).length === 0 &&
        (port.consumerOwnerEntryIds ?? []).length === 0,
    )
    .map((port) => port.id)
    .sort()
}

/**
 * 存量零 consumer public symbol（committed `public-surfaces.json`，review 2026-08-30 采样）。
 * 清偿波次按 context 归 plan.md §8 的 W4 子波；只降不升。
 */
export const UNCONSUMED_PUBLIC_SYMBOL_DEBT: readonly Debt[] = [
  { id: 'public:code-capability:queries:CodeAdoptionBuckets', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeAiAttemptProjection', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeMatrixRow', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeRepairAction', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeRoundProjection', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeRunCounts', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeStageProjection', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:CodeWorkItemProjection', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:StageGraph', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:StageGraphEdge', removeAfterWave: 'W4-E8' },
  { id: 'public:code-capability:queries:StageGraphNode', removeAfterWave: 'W4-E8' },
  { id: 'public:collaboration:commands:canonicalHumanGateJson', removeAfterWave: 'W4' },
  { id: 'public:collaboration:commands:canonicalHumanGateRequestHash', removeAfterWave: 'W4' },
  { id: 'public:collaboration:commands:deriveHumanGateCompatibilityKey', removeAfterWave: 'W4' },
  { id: 'public:collaboration:commands:encodeGateDecisionReceipt', removeAfterWave: 'W4' },
  { id: 'public:collaboration:commands:gateDecisionReceipt', removeAfterWave: 'W4' },
  { id: 'public:collaboration:commands:preparedHumanGateRef', removeAfterWave: 'W4' },
  { id: 'public:collaboration:events:COLLABORATION_COMMITTED_EVENT_REF', removeAfterWave: 'W4' },
  { id: 'public:collaboration:events:COLLABORATION_COMMITTED_SOURCE_REF', removeAfterWave: 'W4' },
  { id: 'public:collaboration:participants:HumanGateOpenParticipantResult', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:REVIEW_ANCHOR_CANDIDATE_LIMIT', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:REVIEW_ANCHOR_CONTEXT_CHARS', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:REVIEW_ANCHOR_DEFAULT_BUDGET_CHARS', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:REVIEW_ANCHOR_MESSAGE_CANDIDATE_LIMIT', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:REVIEW_ANCHOR_SUGGESTION_LIMIT', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:paragraphIdxAt', removeAfterWave: 'W4' },
  { id: 'public:collaboration:queries:sectionPathAt', removeAfterWave: 'W4' },
  { id: 'public:collaboration:types:QuestionDispatchActorSnapshot', removeAfterWave: 'W4' },
  { id: 'public:collaboration:types:ReviewAccessInputs', removeAfterWave: 'W4' },
  { id: 'public:collaboration:types:ReviewAnchorBlock', removeAfterWave: 'W4' },
  { id: 'public:collaboration:types:ReviewAnchorHeading', removeAfterWave: 'W4' },
  { id: 'public:development-automation:participants:DEVELOPMENT_PIPELINE_CLASSIFIER_DEFAULT_CATEGORIES_V2', removeAfterWave: 'W4-E8' },
  { id: 'public:development-automation:participants:DevelopmentDigitalEmployeeAgentTemplateV2', removeAfterWave: 'W4-E8' },
  { id: 'public:development-automation:types:encodeDevelopmentApprovalSubject', removeAfterWave: 'W4-E8' },
  { id: 'public:digital-employee:commands:DigitalEmployeeCommandPort', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:commands:EmployeeCaseCommandPort', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:events:EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:events:EMPLOYEE_INVOCATION_RESULT_EVENT_REF', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:events:EMPLOYEE_LIFECYCLE_SOURCE_REF', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:events:EmployeeCaseProjectionInvalidated', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:events:employeeCaseLifecycleObservation', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:events:employeeInvocationResultObservation', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:queries:DigitalEmployeeQueryPort', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:queries:EmployeeCaseQueryPort', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:EMPLOYEE_CASE_TERMINAL_KINDS', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:EmployeeCaseTerminalKind', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:EmployeeContextRef', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:LEGACY_MISSION_TERMINAL_KINDS', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:LegacyMissionTerminalKind', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:WORKSPACE_FAILURE_CLASSES', removeAfterWave: 'W4-E9' },
  { id: 'public:digital-employee:types:classifyTerminalKind', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:commands:EventObservationCommandPort', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:events:EventCenterProjectionInvalidated', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:participants:EventObserverControlParticipant', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:queries:EventCenterCatalogQueryPort', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:queries:EventCenterOperationsQueryPort', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:types:EventDeliveryStatusDocument', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:types:EventRecordAuditDocument', removeAfterWave: 'W4-E9' },
  { id: 'public:event-center:types:ObserverHealthDocument', removeAfterWave: 'W4-E9' },
  { id: 'public:execution-contract:types:ExecutionContractAgentCandidateReceipt', removeAfterWave: 'W4-E9' },
  { id: 'public:execution-contract:types:executionContractRefKey', removeAfterWave: 'W4-E9' },
  { id: 'public:execution-contract:types:executionContractRefSchema', removeAfterWave: 'W4-E9' },
  { id: 'public:identity-access:commands:CreateManagedUser', removeAfterWave: 'W4-E0' },
  { id: 'public:identity-access:commands:SyncOidcProfile', removeAfterWave: 'W4-E0' },
  { id: 'public:identity-access:commands:UpdateUserAccess', removeAfterWave: 'W4-E0' },
  { id: 'public:identity-access:events:IdentityAccessEventSink', removeAfterWave: 'W4-E0' },
  { id: 'public:identity-access:queries:GetUserAccess', removeAfterWave: 'W4-E0' },
  { id: 'public:identity-access:queries:requireUserAccess', removeAfterWave: 'W4-E0' },
  { id: 'public:identity-access:types:UserAccessErrorKind', removeAfterWave: 'W4-E0' },
  { id: 'public:integration:events:CODE_HOST_EVENT_SOURCE_REF', removeAfterWave: 'W4-B' },
  { id: 'public:integration:events:codeHostBusinessEventObservation', removeAfterWave: 'W4-B' },
  { id: 'public:integration:events:codeHostBusinessEventTypeRef', removeAfterWave: 'W4-B' },
  { id: 'public:integration:events:codeHostEventObservation', removeAfterWave: 'W4-B' },
  { id: 'public:integration:events:codeHostEventTypeRef', removeAfterWave: 'W4-B' },
  { id: 'public:source-control:commands:OwnRepositoryTransportCredentialCommands', removeAfterWave: 'W5' },
  { id: 'public:source-control:participants:RepositoryEndpointDiscoveryParticipant', removeAfterWave: 'W5' },
  { id: 'public:source-control:participants:RepositoryTransportCredentialSelectionParticipant', removeAfterWave: 'W5' },
  { id: 'public:source-control:participants:WorkspaceExcludeParticipant', removeAfterWave: 'W5' },
  { id: 'public:source-control:queries:OwnRepositoryTransportCredentialQueries', removeAfterWave: 'W5' },
  { id: 'public:source-control:types:RepositoryTransportCredentialErrorKind', removeAfterWave: 'W5' },
  { id: 'public:system-operations:commands:SystemOperationCommands', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:queries:SystemOperationQueries', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:activateLocalRestoreOptionsSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:backupResultViewSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:cancelStagedRestoreResultSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:localRestoreActivationSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:recoveryStatusViewSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:requestBackupInputSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:restorePlanOptionsSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:restorePlanViewSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:stageRestoreOptionsSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:system-operations:types:stageRestoreResultSchema', removeAfterWave: 'W4-E7' },
  { id: 'public:task-catalog:types:TaskCatalogListQuery', removeAfterWave: 'W4-E10' },
  { id: 'public:task-execution:commands:TaskDriveCoordinator', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:commands:taskDriveSubmission', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:events:TASK_LIFECYCLE_SOURCE_REF', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:events:TASK_STATUS_CHANGED_EVENT_REF', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:events:taskLifecycleObservation', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:types:SETTLES_WITHOUT_ROW_KINDS', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:types:TaskExecutionCommandResult', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:types:TaskReviewNodeDescriptor', removeAfterWave: 'W4-E1' },
  { id: 'public:task-execution:types:WrapperExecutionScopeSegment', removeAfterWave: 'W4-E1' },
]

/** provider=0 且 consumer=0 的 required SPI：死声明。 */
export const DEAD_REQUIRED_PORT_DEBT: readonly DeadPortDebt[] = [
  {
    id: 'required:development-automation:AgentActionExecutionPort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:DevelopmentCodeHostEffectsPort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:MergeRequestFactsPort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:PipelineEvidencePort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:ReconcilerPorts-legacy-aggregate',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:RepositoryUploadPlacementPort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:RequirementAcquisitionPort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
  {
    id: 'required:development-automation:RequirementInteractionPort',
    why: 'development-automation 声明的 required SPI 既无 provider adapter 也无 consumer；W4-E8 要么接入 use-case-specific provider，要么删除死声明。',
    removeAfterWave: 'W4-E8',
  },
]

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as Record<string, unknown>
}

const SURFACES = (readJson('architecture/public-surfaces.json').entries ??
  []) as readonly PublicSurfaceLike[]
const PORTS = (readJson('architecture/cross-context-imports.json').requiredPorts ??
  []) as readonly RequiredPortLike[]

function diff(observed: readonly string[], ledger: readonly string[]): {
  unlisted: string[]
  stale: string[]
} {
  return {
    unlisted: observed.filter((id) => !ledger.includes(id)),
    stale: ledger.filter((id) => !observed.includes(id)),
  }
}

describe('RFC-294 review §C2 —— 零 consumer public symbol 账本', () => {
  test('committed public surface 非空（读错文件时零预言力）', () => {
    expect(SURFACES.length).toBeGreaterThan(100)
    expect(PORTS.length).toBeGreaterThan(5)
  })

  test('零生产 consumer 的 public symbol 与账本逐条相等（新增 ⇒ 红；已被消费不销账 ⇒ 红）', () => {
    const { unlisted, stale } = diff(
      unconsumedPublicSymbols(SURFACES),
      UNCONSUMED_PUBLIC_SYMBOL_DEBT.map((entry) => entry.id),
    )
    expect(
      unlisted,
      '新增了没有生产 consumer 的 public symbol（design §3.3）：要么先切 consumer，要么入 ' +
        'UNCONSUMED_PUBLIC_SYMBOL_DEBT 并点名清偿波次',
    ).toEqual([])
    expect(stale, '这些 symbol 已有生产 consumer 或已删除：同批删掉账本条目').toEqual([])
  })

  test('provider=0 且 consumer=0 的 required port 与账本逐条相等', () => {
    const { unlisted, stale } = diff(
      deadRequiredPorts(PORTS),
      DEAD_REQUIRED_PORT_DEBT.map((entry) => entry.id),
    )
    expect(unlisted, '新增了既无 provider 也无 consumer 的 required SPI：先接 consumer/provider 再声明').toEqual([])
    expect(stale, '死声明已被接线或删除：同批删掉账本条目').toEqual([])
  })

  test('每条债务都点名 W 波次；死声明另附理由', () => {
    const badWave = [...UNCONSUMED_PUBLIC_SYMBOL_DEBT, ...DEAD_REQUIRED_PORT_DEBT]
      .filter((entry) => !/^W\d/.test(entry.removeAfterWave))
      .map((entry) => entry.id)
    const badWhy = DEAD_REQUIRED_PORT_DEBT.filter((entry) => entry.why.trim().length < 20).map(
      (entry) => entry.id,
    )
    expect(badWave).toEqual([])
    expect(badWhy).toEqual([])
  })
})

describe('RFC-294 review §C2 —— 负 fixture：判据自己咬得动', () => {
  test('零 consumer 的 symbol 会被报，有 consumer 的不报', () => {
    expect(
      unconsumedPublicSymbols([
        {
          id: 'public:probe:types:Unused',
          file: 'packages/backend/src/modules/probe/public/types.ts',
          consumerEdgeIds: [],
          productionConsumers: [],
        },
        {
          id: 'public:probe:types:Used',
          file: 'packages/backend/src/modules/probe/public/types.ts',
          consumerEdgeIds: ['import:probe'],
          productionConsumers: [],
        },
        {
          id: 'public:probe:types:Nested',
          file: 'packages/backend/src/modules/probe/public/types.ts',
          consumerEdgeIds: [],
          productionConsumers: [],
          publicTypeConsumerIds: ['public:probe:types:Envelope'],
        },
      ]),
    ).toEqual(['public:probe:types:Unused'])
  })

  test('无 provider 无 consumer 的 required port 会被报，任一侧有接线的不报', () => {
    expect(
      deadRequiredPorts([
        { id: 'required:probe:Dead', providerAdapters: [], consumerOwnerEntryIds: [] },
        {
          id: 'required:probe:Declared',
          providerAdapters: [],
          consumerOwnerEntryIds: ['owner:packages/backend/src/modules/probe/application/x.ts#$file'],
        },
      ]),
    ).toEqual(['required:probe:Dead'])
  })
})
