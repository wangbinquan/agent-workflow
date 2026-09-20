import type {
  ResourceVisibility,
  SkillVersionSource,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import type {
  DirectAuthenticatedAuthority,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type {
  demoResourceCatalogSeedParticipantBrand,
  agentLaunchResourceIntegrityParticipantBrand,
  intentContextResourceAuthorizationSessionBrand,
  skillCatalogBootParticipantBrand,
} from '../domain/participantBrands'
import type {
  CatalogSelectorKind,
  FrozenTaskExecutionResourceSnapshot,
  GetAgentResourceClosureStatusInput,
  McpAclIdentity,
  McpProbeRecord,
  McpProbeWrite,
  ParseSkillZipCatalogInput,
  ParseSkillZipCatalogReceipt,
  CommitSkillZipCatalogInput,
  CommitSkillZipCatalogReceipt,
  TaskExecutionResourceRequest,
} from './types'

/** Opaque request context minted by identity-access; never an Actor-shaped bag. */
export type ResourceRequestContext = RequestAuthority
/** Branded current-user authority consumed by exact Agent aggregate operations. */
export type AgentOperationContext = DirectAuthenticatedAuthority
/** Branded current-user authority consumed by the exact MCP aggregate operations. */
export type McpOperationContext = DirectAuthenticatedAuthority
/** Branded current-user authority consumed by exact Plugin aggregate operations. */
export type PluginOperationContext = DirectAuthenticatedAuthority
/** Branded current-user authority consumed by exact Skill aggregate operations. */
export type SkillOperationContext = DirectAuthenticatedAuthority
/** Branded current-user authority consumed by exact Workflow aggregate operations. */
export type WorkflowOperationContext = DirectAuthenticatedAuthority
/** Branded current-user authority consumed by exact Workgroup aggregate operations. */
export type WorkgroupOperationContext = DirectAuthenticatedAuthority

/** Provider-owned Agent closure preflight used by the TaskExecution launch arm. */
export interface AgentLaunchResourceIntegrityParticipant {
  readonly [agentLaunchResourceIntegrityParticipantBrand]: 'agent-launch-resource-integrity-participant'
  assertUsable(input: GetAgentResourceClosureStatusInput): Promise<void>
}

export interface SkillIdentityMigrationReceipt {
  readonly recoveredOperations: number
  readonly removedHusks: number
  readonly migratedSkills: number
  readonly verifiedSkills: number
  readonly verifiedVersions: number
}

export interface SkillLegacyVersionBackfillReceipt {
  readonly backfilled: number
  readonly husksRemoved: number
}

export interface SkillSnapshotReverifyReceipt {
  readonly verified: number
  readonly quarantined: number
}

/**
 * Provider-owned Skill Catalog boot capability.
 *
 * Database clients, transactions and filesystem roots are fixed by composition;
 * bootstrap can only advance the four reviewed boot stages and receive closed
 * count receipts.
 */
export interface SkillCatalogBootParticipant {
  readonly [skillCatalogBootParticipantBrand]: 'skill-catalog-boot-participant'
  runIdentityMigrationBarrier(): Promise<SkillIdentityMigrationReceipt>
  activateAvailabilityGate(): void
  reconcileLiveFiles(): Promise<void>
  backfillLegacyVersions(): Promise<SkillLegacyVersionBackfillReceipt>
  reverifySnapshots(): Promise<SkillSnapshotReverifyReceipt>
}

export interface DemoResourceCatalogSeedMarkerContext {
  readonly kind: 'initial-demo-offer'
  readonly ownerUserId: string
  readonly offeredAt: number
}

export interface DemoResourceCatalogAgentSample {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly outputs: readonly string[]
  readonly syncOutputsOnIterate: boolean
  readonly readonly: boolean
  readonly bodyMd: string
}

interface DemoResourceCatalogWorkflowSample {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly definition: WorkflowDefinition
}

export interface DemoResourceCatalogSeedInput {
  readonly marker: DemoResourceCatalogSeedMarkerContext
  readonly agent: DemoResourceCatalogAgentSample
  readonly workflows: readonly DemoResourceCatalogWorkflowSample[]
}

interface DemoResourceCatalogOccupiedIdWarning {
  readonly resourceType: 'agent' | 'workflow'
  readonly resourceId: string
  readonly expectedName: string
  readonly occupiedBy: string
}

export interface DemoResourceCatalogSeedReceipt {
  readonly createdAgent: boolean
  readonly createdWorkflowIds: readonly string[]
  readonly occupiedIdWarnings: readonly DemoResourceCatalogOccupiedIdWarning[]
}

export interface DemoResourceCatalogSeedParticipant {
  readonly [demoResourceCatalogSeedParticipantBrand]: 'demo-resource-catalog-seed-participant'
  seed(input: DemoResourceCatalogSeedInput): Promise<DemoResourceCatalogSeedReceipt>
}

declare const taskExecutionResourceSnapshotInTxBrand: unique symbol
declare const mcpAclIdentityParticipantBrand: unique symbol
export interface IntentContextResourceReference {
  readonly resourceType: CatalogSelectorKind
  readonly resourceId: string
  readonly expectedName?: string
}

export interface IntentContextResourceIdentity {
  readonly resourceType: CatalogSelectorKind
  readonly resourceId: string
  readonly name: string
}

/**
 * One provider-transaction-bound Intent context authorization capability.
 *
 * The caller supplies only an opaque current-request authority and a closed
 * classic-six reference. Persistence rows, provider clients and the admitted
 * actor stay behind the composition-owned session factory.
 */
export interface IntentContextResourceAuthorizationSession {
  readonly [intentContextResourceAuthorizationSessionBrand]: 'intent-context-resource-authorization-session'
  loadVisible(
    authority: ResourceRequestContext,
    reference: IntentContextResourceReference,
  ): Promise<IntentContextResourceIdentity | null>
}

export interface McpAclIdentityParticipant {
  readonly [mcpAclIdentityParticipantBrand]: 'mcp-acl-identity-participant'
  load(id: string): Promise<McpAclIdentity | null>
  nextUpdatedAt(id: string): Promise<number>
}

/** Provider-neutral persistence participant for MCP probe measurements. */
export interface McpProbeStore {
  list(): Promise<readonly McpProbeRecord[]>
  getByMcpId(mcpId: string): Promise<McpProbeRecord | null>
  upsert(mcpId: string, measurement: McpProbeWrite): Promise<McpProbeRecord>
}

/** Provider-bound whole-tree ZIP import; route owns only multipart decoding. */
export interface SkillZipImportParticipant {
  parse(
    authority: SkillOperationContext,
    input: ParseSkillZipCatalogInput,
  ): Promise<ParseSkillZipCatalogReceipt>
  commit(
    authority: SkillOperationContext,
    input: CommitSkillZipCatalogInput,
  ): Promise<CommitSkillZipCatalogReceipt>
}

export interface TaskExecutionResourceSnapshotInTx {
  readonly [taskExecutionResourceSnapshotInTxBrand]: 'task-execution-resource-snapshot'
  loadAuthorized(
    authority: ResourceRequestContext,
    requests: readonly TaskExecutionResourceRequest[],
  ): Promise<readonly FrozenTaskExecutionResourceSnapshot[]>
}

// RFC-359 —— `IntentApplyResourceParticipantInTx` 与它的工厂随两台 apply 引擎合一一起退役。
// 它是 legacy 会话的**提交期句柄**（`participantInTransaction(tx)`）；现行会话交出的是
// `IntentApplyResourceTransactionAttempt`（`{participant, commitSucceeded}`），
// 因为提交后还有一条尾巴要在外层事务提交之后才放行。唯一的消费者随 legacy 参与者一起删了。

// memory 的资源 scope（agent / workflow）访问判定参与者**不在这里**：那是 memory 自己声明的端口
// （`modules/memory/application/ports/resourceScopeAccess.ts`），resource-catalog 只在装配根上交出一份
// 结构兼容的实现（`composition/resourceScopeAuthorization.ts`）。public 面不引 Actor，也不点名事务句柄。

// RFC-359（apply 引擎合一，plan §5dy）—— 资源包的**整族参与者合同**随**通用 bundle 引擎**
// 退役，公共面上不再留它们：
//
//   · 七条 `*PackageMutationParticipantInTx`（`commit(prepared)`）—— 那是同步事务链的形状
//     「引擎开事务 → 把七个 tx-bound 参与者交给它 → 逐个 commit」；
//   · 七条 `*PackageMutationParticipant`（`prepare(mutation)`）与它们的花名册
//     `ResourcePackageMutationParticipants`；
//   · `ResourcePackageEventsInTx` / `ResourcePackageAuditInTx` / `ResourcePackageApplyScenarioTx`。
//
// 统一 apply 引擎不跨这些合同：编排层自己持有事务，逐臂调用**模块内部**的
// `PostgresqlResourcePackagePreparationParticipants` /
// `PostgresqlResourcePackageTransactionParticipants`（七条臂的闭集判据钉在
// `rfc345-resource-catalog-contracts` 上，名字换了、闭集逐字不变）。
// 公共面不留没人跨的合同。

// RFC-359（apply 引擎合一，plan §5dy）—— `ResourcePackageApplyTx` 与
// `ResourcePackageApplyScenarioProvider` 两条公共合同随**通用 bundle 引擎**退役：
// 它们描述的是那条同步事务链「把七条臂 + events + audit 打包交给引擎」的形状，
// 统一 apply 引擎不走这个形状（编排层持有事务、逐臂调用）。公共面不留没人跨的合同。
// ---------------------------------------------------------------------------
// RFC-353 T6（RFC-294 W4-E3）—— resource-catalog offered 的**技能版本提交**面。
//
// `skills` / `skill_versions` 两张表归 resource-catalog 单写。此前 knowledge-evolution 的
// 融合 `apply()` 是跨 context 直写它们（两个 provider 各抄一份，复合前置条件还比对方少四项）。
// 现在改由这个 tx-bound participant 代写：调用方开好事务交进来，版本行与调用方自己的
// 状态推进、与 memory 的成员关系标记落在同一个事务里。
//
// 唯一 owner 工厂是 `application/skillVersionCommit.ts` 的
// `createSkillVersionCommitParticipantInTx`。
// ---------------------------------------------------------------------------

/** 调用方在授权那一刻看到的技能形状；漂了就以 409 退回让它重新加载。 */
export interface SkillVersionCommitFence {
  readonly expectedSkillId?: string
  readonly expectedVersion?: number
  readonly expectedMetaRevision?: number
  readonly expectedOwnerUserId?: string | null
  readonly expectedAclRevision?: number
  readonly expectedVisibility?: ResourceVisibility
  /**
   * 栅栏拦下时给用户看的话。默认是 RC 通用的那句；融合 approve 传自己的
   * （「fusion target skill changed」），这样判据收成一份而**用户可见的文案逐字不变**。
   */
  readonly staleMessage?: string
}

export interface SkillVersionCommitRequest extends SkillVersionCommitFence {
  readonly skillId: string
  readonly versionIndex: number
  readonly contentHash: string
  readonly source: SkillVersionSource
  readonly summary: string | null
  readonly fusionId: string | null
  readonly restoredFromVersion: number | null
  readonly authorUserId: string | null
  readonly now: number
}

/**
 * 调用方折进同一事务的两段自有写入 / 检查。
 *
 * `before` 在版本行落下**之前**跑，这决定错误优先级：融合 approve 的既有语义是先答
 * 「不在 applying / 无权」，再答「技能已被别人推进」。放到写入之后会让 409 抢在前面，
 * 那是用户可见的行为漂移。`after` 拿得到刚写下的版本号（融合在这里把记忆标记为已融合）。
 */
export interface SkillVersionCommitHooks<R> {
  readonly before?: () => R
  readonly after?: (versionIndex: number) => R
}

declare const skillVersionCommitParticipantInTxBrand: unique symbol

export interface SkillVersionCommitParticipantInTx {
  readonly [skillVersionCommitParticipantInTxBrand]: 'skill-version-commit'
  /** 返回刚写下的版本号（等于 `request.versionIndex`）。 */
  commit(
    request: SkillVersionCommitRequest,
    hooks?: SkillVersionCommitHooks<Promise<void> | void>,
  ): Promise<number>
}

/** The caller supplies the runtime names it changed; Resource Catalog owns only test sessions. */
declare const runtimeProfileTestInvalidationBrand: unique symbol
export interface RuntimeProfileTestInvalidationInTx<Transaction> {
  readonly [runtimeProfileTestInvalidationBrand]: 'runtime-profile-test-invalidation'
  invalidate(
    transaction: Transaction,
    input: {
      readonly runtimeNames: readonly string[]
      readonly reason: 'runtime-profile-changed' | 'runtime-disabled' | 'runtime-deleted'
      readonly now: number
    },
  ): Promise<void>
}

/** RFC-364: post-commit invalidation reconciliation, shared with the one diagnostics lifecycle. */
export interface McpRuntimeTestReconciliationParticipant {
  reconcileDurableIntents(): Promise<void>
}
