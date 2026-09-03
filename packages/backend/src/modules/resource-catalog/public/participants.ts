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
  skillVersionCommitParticipantInTxBrand,
} from '../domain/participantBrands'
import type {
  AgentPackageMutation,
  CapabilityTemplatePackageMutation,
  CatalogSelectorKind,
  FrozenIntegrationTriggerResourceSnapshot,
  FrozenTaskExecutionResourceSnapshot,
  IntegrationTriggerResourceRequest,
  GetAgentResourceClosureStatusInput,
  IntentResourceChangesetReceipt,
  McpAclIdentity,
  McpProbeRecord,
  McpProbeWrite,
  McpPackageMutation,
  McpRuntimeTestLeaseInput,
  McpRuntimeTestLeaseToken,
  PluginPackageMutation,
  PreparedAgentPackageMutation,
  PreparedCapabilityTemplatePackageMutation,
  PreparedMcpPackageMutation,
  PreparedPluginPackageMutation,
  PreparedSkillPackageMutation,
  PreparedWorkflowPackageMutation,
  PreparedWorkgroupPackageMutation,
  ResourceMemoryScopeRef,
  ResourcePackageApplyScenarioPlan,
  ResourcePackageMutationReceipt,
  ResourceScopeAccess,
  SkillPackageMutation,
  ParseSkillZipCatalogInput,
  ParseSkillZipCatalogReceipt,
  CommitSkillZipCatalogInput,
  CommitSkillZipCatalogReceipt,
  TaskExecutionResourceRequest,
  VersionedIntentResourceChangesetPlan,
  WorkflowPackageMutation,
  WorkgroupPackageMutation,
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
declare const intentApplyResourceParticipantInTxBrand: unique symbol
declare const integrationTriggerResourceSnapshotInTxBrand: unique symbol
declare const resourceScopeAuthorizationInTxBrand: unique symbol
declare const agentPackageMutationParticipantInTxBrand: unique symbol
declare const skillPackageMutationParticipantInTxBrand: unique symbol
declare const mcpPackageMutationParticipantInTxBrand: unique symbol
declare const pluginPackageMutationParticipantInTxBrand: unique symbol
declare const workflowPackageMutationParticipantInTxBrand: unique symbol
declare const workgroupPackageMutationParticipantInTxBrand: unique symbol
declare const capabilityTemplatePackageMutationParticipantInTxBrand: unique symbol
declare const resourcePackageEventsInTxBrand: unique symbol
declare const resourcePackageAuditInTxBrand: unique symbol
declare const resourcePackageApplyScenarioTxBrand: unique symbol
declare const resourcePackageApplyTxBrand: unique symbol
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

export class McpRuntimeTestLeaseError extends Error {
  readonly code = 'mcp-test-session-conflict' as const

  constructor(readonly reason: string) {
    super('mcp-test-session-conflict')
    this.name = 'McpRuntimeTestLeaseError'
  }
}

/** Provider-neutral single-writer lease participant for one MCP playground. */
export interface McpRuntimeTestLeaseOperations {
  claimNew(input: McpRuntimeTestLeaseInput): Promise<McpRuntimeTestLeaseToken>
  preclaim(input: McpRuntimeTestLeaseInput): Promise<McpRuntimeTestLeaseToken>
  rotate(
    token: McpRuntimeTestLeaseToken,
    nextRuntimeSessionId: string,
  ): Promise<McpRuntimeTestLeaseToken>
  release(token: McpRuntimeTestLeaseToken): Promise<boolean>
  repairAfterReap(testSessionId: string, turnId: string, childReaped: true): Promise<boolean>
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
  ): readonly FrozenTaskExecutionResourceSnapshot[]
}

export interface IntentApplyResourceParticipantInTx {
  readonly [intentApplyResourceParticipantInTxBrand]: 'intent-apply-resource-participant'
  authorizeAndCommit(
    authority: ResourceRequestContext,
    plan: VersionedIntentResourceChangesetPlan,
  ): IntentResourceChangesetReceipt
}

export interface IntegrationTriggerResourceSnapshotInTx {
  readonly [integrationTriggerResourceSnapshotInTxBrand]: 'integration-trigger-resource-snapshot'
  loadAuthorized(
    authority: ResourceRequestContext,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): readonly FrozenIntegrationTriggerResourceSnapshot[]
}

export interface ResourceScopeAuthorizationInTx {
  readonly [resourceScopeAuthorizationInTxBrand]: 'resource-scope-authorization'
  accessOf(authority: ResourceRequestContext, scope: ResourceMemoryScopeRef): ResourceScopeAccess
}

export interface AgentPackageMutationParticipant {
  prepare(mutation: AgentPackageMutation): Promise<PreparedAgentPackageMutation>
}
export interface SkillPackageMutationParticipant {
  prepare(mutation: SkillPackageMutation): Promise<PreparedSkillPackageMutation>
}
export interface McpPackageMutationParticipant {
  prepare(mutation: McpPackageMutation): Promise<PreparedMcpPackageMutation>
}
export interface PluginPackageMutationParticipant {
  prepare(mutation: PluginPackageMutation): Promise<PreparedPluginPackageMutation>
}
export interface WorkflowPackageMutationParticipant {
  prepare(mutation: WorkflowPackageMutation): Promise<PreparedWorkflowPackageMutation>
}
export interface WorkgroupPackageMutationParticipant {
  prepare(mutation: WorkgroupPackageMutation): Promise<PreparedWorkgroupPackageMutation>
}
export interface CapabilityTemplatePackageMutationParticipant {
  prepare(
    mutation: CapabilityTemplatePackageMutation,
  ): Promise<PreparedCapabilityTemplatePackageMutation>
}

export interface AgentPackageMutationParticipantInTx {
  readonly [agentPackageMutationParticipantInTxBrand]: 'agent-package-mutation'
  commit(prepared: PreparedAgentPackageMutation): ResourcePackageMutationReceipt<'agent'>
}
export interface SkillPackageMutationParticipantInTx {
  readonly [skillPackageMutationParticipantInTxBrand]: 'skill-package-mutation'
  commit(prepared: PreparedSkillPackageMutation): ResourcePackageMutationReceipt<'skill'>
}
export interface McpPackageMutationParticipantInTx {
  readonly [mcpPackageMutationParticipantInTxBrand]: 'mcp-package-mutation'
  commit(prepared: PreparedMcpPackageMutation): ResourcePackageMutationReceipt<'mcp'>
}
export interface PluginPackageMutationParticipantInTx {
  readonly [pluginPackageMutationParticipantInTxBrand]: 'plugin-package-mutation'
  commit(prepared: PreparedPluginPackageMutation): ResourcePackageMutationReceipt<'plugin'>
}
export interface WorkflowPackageMutationParticipantInTx {
  readonly [workflowPackageMutationParticipantInTxBrand]: 'workflow-package-mutation'
  commit(prepared: PreparedWorkflowPackageMutation): ResourcePackageMutationReceipt<'workflow'>
}
export interface WorkgroupPackageMutationParticipantInTx {
  readonly [workgroupPackageMutationParticipantInTxBrand]: 'workgroup-package-mutation'
  commit(prepared: PreparedWorkgroupPackageMutation): ResourcePackageMutationReceipt<'workgroup'>
}
export interface CapabilityTemplatePackageMutationParticipantInTx {
  readonly [capabilityTemplatePackageMutationParticipantInTxBrand]: 'capability-template-package-mutation'
  commit(
    prepared: PreparedCapabilityTemplatePackageMutation,
  ): ResourcePackageMutationReceipt<'capability_template'>
}

export interface ResourcePackageMutationParticipants {
  readonly agents: AgentPackageMutationParticipant
  readonly skills: SkillPackageMutationParticipant
  readonly mcps: McpPackageMutationParticipant
  readonly plugins: PluginPackageMutationParticipant
  readonly workflows: WorkflowPackageMutationParticipant
  readonly workgroups: WorkgroupPackageMutationParticipant
  readonly capabilityTemplates: CapabilityTemplatePackageMutationParticipant
}

export interface ResourcePackageEventsInTx {
  readonly [resourcePackageEventsInTxBrand]: 'resource-package-events'
  resourceApplied(receipt: ResourcePackageMutationReceipt): void
}

export interface ResourcePackageAuditInTx {
  readonly [resourcePackageAuditInTxBrand]: 'resource-package-audit'
  recordResourceApplied(receipt: ResourcePackageMutationReceipt): void
}

export interface ResourcePackageApplyScenarioTx {
  readonly [resourcePackageApplyScenarioTxBrand]: 'resource-package-apply-scenario'
  readonly currentAuthority: ResourceRequestContext
}

export interface ResourcePackageApplyTx extends ResourcePackageApplyScenarioTx {
  readonly [resourcePackageApplyTxBrand]: 'resource-package-apply'
  readonly agents: AgentPackageMutationParticipantInTx
  readonly skills: SkillPackageMutationParticipantInTx
  readonly mcps: McpPackageMutationParticipantInTx
  readonly plugins: PluginPackageMutationParticipantInTx
  readonly workflows: WorkflowPackageMutationParticipantInTx
  readonly workgroups: WorkgroupPackageMutationParticipantInTx
  readonly capabilityTemplates: CapabilityTemplatePackageMutationParticipantInTx
  readonly events: ResourcePackageEventsInTx
  readonly audit: ResourcePackageAuditInTx
}

/** Additive W4-C contract consumed by the current BundleApply adapter first. */
export interface ResourcePackageApplyScenarioProvider {
  readonly scenario: ResourcePackageApplyScenarioPlan
  readonly participants: ResourcePackageMutationParticipants
}

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

export interface SkillVersionCommitParticipantInTx {
  readonly [skillVersionCommitParticipantInTxBrand]: 'skill-version-commit'
  /** 返回刚写下的版本号（等于 `request.versionIndex`）。 */
  commit(
    request: SkillVersionCommitRequest,
    hooks?: SkillVersionCommitHooks<Promise<void> | void>,
  ): Promise<number>
}

export { createSkillVersionCommitParticipantInTx } from '../application/skillVersionCommit'
export { sqliteSkillVersionCommitSync } from '../infrastructure/sqliteSkillVersionCommitParticipant'
export { composePostgresqlSkillVersionCommitParticipantFactory } from '../infrastructure/postgresqlSkillVersionCommitParticipant'
