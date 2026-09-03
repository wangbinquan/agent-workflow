// RFC-352 T9 —— `resource-acl:bypass` 判定经 public 暴露。
// 由来：memory 的两个 provider 此前从**不同地方**取同一个谓词——SQLite 侧走 legacy
// `@/services/resourceAcl`、PostgreSQL 侧直接深入 `resource-catalog/domain/resourceAccess`
// （跨 context 内部 import，RFC-317 R2 入账）。同一判据两个来源正是本 RFC 反复撞到的漂移形状，
// 因此由 owner（resource-catalog）在 public 面给出唯一出口。
export { hasResourceAclBypass } from '../domain/resourceAccess'

import { asBundleResourceType } from '@agent-workflow/shared'
import type {
  Agent,
  BundleResourceType,
  BundleOp,
  CopyWorkflowRequest,
  CopyWorkgroupRequest,
  CreateAgent,
  CreateMcp,
  CreatePlugin,
  CreateWorkgroup,
  DeleteMcp,
  DeletePlugin,
  IntentOp,
  IntentResourceType,
  Mcp,
  McpProbeErrorCodeT,
  McpOperationResource,
  Plugin,
  PluginOperationRequest,
  PluginOperationResource,
  PluginUpdateCheck,
  PluginUpgradeResult,
  GrantResourceType,
  ResourceAccess,
  ResourceVisibility,
  RenameAgentRequest,
  RenameMcpRequest,
  RenamePluginRequest,
  RenameWorkgroup,
  SaveWorkflowReceipt,
  SaveWorkgroupReceipt,
  Skill,
  SkillContent,
  SkillVersion,
  SkillVersionContent,
  SkillVersionDiff,
  SkillZipDecisionMap,
  UpdateMcpRequest,
  UpdatePluginRequest,
  UpdateWorkgroup,
  ParseSkillZipResponse,
  CommitSkillZipResponse,
  WorkflowCandidateHash,
  WorkflowDetail,
  WorkflowDefinition,
  WorkflowValidationContextHash,
  WorkflowValidationIssue,
  Workgroup,
  WorkgroupDetail,
} from '@agent-workflow/shared'

/** Closed public kind rosters alias the shared wire contracts directly. */
export type CatalogSelectorKind = IntentResourceType
export type PackageResourceKind = BundleResourceType

/** Named public narrowing point; persistence-specific kind helpers stay internal. */
export const asPackageResourceKind = asBundleResourceType

/** Closed identity-only references owned by the Resource Catalog public surface. */
export interface ResourceRef<K extends GrantResourceType = GrantResourceType> {
  readonly kind: K
  readonly id: string
}

export type PackageResourceRef<K extends PackageResourceKind = PackageResourceKind> = ResourceRef<K>
export type CatalogResourceRef<K extends CatalogSelectorKind = CatalogSelectorKind> = ResourceRef<K>

interface ResourceSummaryRevisionByKind {
  readonly agent: {
    readonly kind: 'agent'
    readonly updatedAt: number
    readonly aclRevision: number
  }
  readonly skill: { readonly kind: 'skill'; readonly token: string }
  readonly mcp: { readonly kind: 'mcp'; readonly configHash: string }
  readonly plugin: { readonly kind: 'plugin'; readonly configHash: string }
  readonly workflow: { readonly kind: 'workflow'; readonly version: number }
  readonly workgroup: { readonly kind: 'workgroup'; readonly version: number }
}

/** Equality-only catalog projection; aggregate commands retain their exact fences. */
export type ResourceSummaryRevision<K extends CatalogSelectorKind = CatalogSelectorKind> =
  ResourceSummaryRevisionByKind[K]

declare const resourceCatalogCursorBrand: unique symbol

export type ResourceCatalogCursor = string & {
  readonly [resourceCatalogCursorBrand]: 'resource-catalog-cursor'
}

interface ResourceSummaryOf<K extends CatalogSelectorKind> {
  readonly ref: CatalogResourceRef<K>
  readonly kind: K
  readonly name: string
  readonly description: string | null
  readonly revision: ResourceSummaryRevision<K>
  readonly visibilityHint: 'public' | 'private'
}

/** Closed classic-six selection row; no persistence or provider type escapes. */
export type ResourceSummary =
  | ResourceSummaryOf<'agent'>
  | ResourceSummaryOf<'skill'>
  | ResourceSummaryOf<'mcp'>
  | ResourceSummaryOf<'plugin'>
  | ResourceSummaryOf<'workflow'>
  | ResourceSummaryOf<'workgroup'>

export interface ResourceSummaryQuery {
  readonly kinds?: readonly CatalogSelectorKind[]
  readonly search?: string
  readonly cursor?: ResourceCatalogCursor
  readonly limit: number
}

export interface ResourceSummaryPage {
  readonly items: readonly ResourceSummary[]
  readonly nextCursor: ResourceCatalogCursor | null
}

interface JsonBodySubmission {
  readonly kind: 'json-body'
  readonly body: string
}

/** Public operation DTOs. Transport parsing and persistence rows stay behind adapters. */
export interface GetResourceAclCatalogInput {
  readonly id: string
}

export interface UpdateResourceAclCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export type CreateAgentCatalogInput = CreateAgent

export interface UpdateAgentCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteAgentCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface RenameAgentCatalogInput {
  readonly id: string
  readonly rename: RenameAgentRequest
}

export interface DeleteAgentCatalogReceipt {
  readonly deleted: Agent
}

export interface CreateSkillCatalogInput {
  readonly submission: JsonBodySubmission
}

export interface SaveSkillCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteSkillCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteSkillCatalogReceipt {
  readonly deleted: Skill
}

export interface CreateWorkflowCatalogInput {
  readonly submission: JsonBodySubmission
}

export interface CopyWorkflowCatalogInput {
  readonly id: string
  readonly copy: CopyWorkflowRequest
}

export interface UpdateWorkflowCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteWorkflowCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export type UpdateWorkflowCatalogReceipt = SaveWorkflowReceipt

export interface DeleteWorkflowCatalogReceipt {
  readonly deleted: Readonly<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'public' | 'private'
    readonly builtin: boolean
  }>
  readonly clientMutationId: string
  readonly deletedVersion: number
}

export type CreateMcpCatalogInput = CreateMcp

export interface UpdateMcpCatalogInput {
  readonly id: string
  readonly update: UpdateMcpRequest
}

export interface DeleteMcpCatalogInput {
  readonly id: string
  readonly deletion: DeleteMcp
}

export interface RenameMcpCatalogInput {
  readonly id: string
  readonly rename: RenameMcpRequest
}

export interface DeleteMcpCatalogReceipt {
  readonly deleted: McpOperationResource
}

export type CreatePluginCatalogInput = CreatePlugin

export interface UpdatePluginCatalogInput {
  readonly id: string
  readonly update: UpdatePluginRequest
}

export interface DeletePluginCatalogInput {
  readonly id: string
  readonly deletion: DeletePlugin
}

export interface RenamePluginCatalogInput {
  readonly id: string
  readonly rename: RenamePluginRequest
}

export interface CheckPluginUpdateCatalogInput {
  readonly id: string
  readonly operation: PluginOperationRequest
}

export interface UpgradePluginCatalogInput {
  readonly id: string
  readonly operation: PluginOperationRequest
}

export interface DeletePluginCatalogReceipt {
  readonly deleted: PluginOperationResource
}

export type CheckPluginUpdateCatalogReceipt = PluginUpdateCheck
export type UpgradePluginCatalogReceipt = PluginUpgradeResult

export type CreateWorkgroupCatalogInput = CreateWorkgroup

export interface CopyWorkgroupCatalogInput {
  readonly id: string
  readonly copy: CopyWorkgroupRequest
}

export interface UpdateWorkgroupCatalogInput {
  readonly id: string
  readonly update: UpdateWorkgroup
}

export interface DeleteWorkgroupCatalogInput {
  readonly id: string
  readonly deletion: JsonBodySubmission
}

export interface RenameWorkgroupCatalogInput {
  readonly id: string
  readonly rename: RenameWorkgroup
}

export type UpdateWorkgroupCatalogReceipt = SaveWorkgroupReceipt

export interface DeleteWorkgroupCatalogReceipt {
  readonly id: string
  readonly deletedVersion: number
  readonly clientMutationId: string
  readonly deleted: WorkgroupDetail
}

/** T5-A aggregate contract. SQLite rows and raw transport values stay private. */
export type AgentCatalogResource = Agent

export interface GetAgentCatalogInput {
  readonly id: string
}

export interface AgentReferenceLabelsInput {
  readonly agents: readonly AgentCatalogResource[]
  readonly visibleAgentIds: readonly string[]
}

interface AgentReferenceLabel {
  readonly id: string
  readonly name: string
}

export interface AgentReferenceLabels {
  readonly skills: readonly AgentReferenceLabel[]
  readonly mcps: readonly AgentReferenceLabel[]
  readonly plugins: readonly AgentReferenceLabel[]
}

export interface ResolveAgentDependencyClosureInput {
  readonly root: AgentCatalogResource
  readonly onMissing: 'fail' | 'skip'
}

export type AgentDependencyClosureResult =
  | { readonly ok: true; readonly agents: readonly AgentCatalogResource[] }
  | { readonly ok: false; readonly cyclePath: readonly string[] }

export interface ResolveAgentDependencyIdsInput {
  readonly ids: readonly string[]
}

export interface ResolvedAgentDependencyIds {
  readonly ids: readonly string[]
  readonly missing: readonly {
    readonly type: 'agent'
    readonly name: string
  }[]
}

export interface ValidateAgentDependenciesInput {
  readonly selfId: string
  readonly dependsOn: readonly string[]
}

type AgentResourceRefKind = 'skill' | 'mcp' | 'plugin' | 'agent'
/** Exact wire code shared by every disabled-plugin integrity emitter. */
export const PLUGIN_DISABLED_ERROR_CODE = 'plugin-disabled' as const
type AgentResourceIssueCode =
  | 'agent-dependency-not-found'
  | 'agent-dependency-cycle'
  | 'skill-not-found'
  | 'skill-unavailable'
  | 'mcp-not-found'
  | 'plugin-not-found'
  | typeof PLUGIN_DISABLED_ERROR_CODE
type AgentResourceDisplayState = 'available' | 'hidden' | 'missing' | 'unavailable'

interface AgentResourceDisplayRef {
  readonly kind: AgentResourceRefKind
  readonly refId: string
  readonly name: string | null
  readonly state: AgentResourceDisplayState
}

interface AgentResourceDisplayIssue {
  readonly code: AgentResourceIssueCode
  readonly refKind: AgentResourceRefKind
  readonly state: AgentResourceDisplayState
  readonly refId: string | null
  readonly refName: string | null
  readonly ownerAgentId: string | null
  readonly ownerAgentName: string | null
  readonly direct: boolean
}

export interface AgentResourceStatus {
  readonly ok: boolean
  readonly references: readonly AgentResourceDisplayRef[]
  readonly issues: readonly AgentResourceDisplayIssue[]
}

export interface GetAgentResourceStatusInput {
  readonly root: AgentCatalogResource
}

/** Closed multi-root integrity projection used by Workgroup authoring. */
export interface GetAgentResourceClosureStatusInput {
  readonly rootAgentIds: readonly string[]
}

interface AgentResourceClosureIssue {
  readonly code: AgentResourceIssueCode
  readonly rootAgentId: string
  readonly refKind: AgentResourceRefKind
  readonly direct: boolean
}

export interface AgentResourceClosureStatus {
  readonly ok: boolean
  readonly issues: readonly AgentResourceClosureIssue[]
}

/** Closed provider persistence projection for one MCP probe. */
export interface McpProbeRecord {
  readonly id: string
  readonly mcpId: string
  readonly mcpName: string
  readonly status: 'ok' | 'error'
  readonly latencyMs: number
  readonly handshakeMs: number | null
  readonly serverInfoJson: string | null
  readonly protocolVersion: string | null
  readonly capabilitiesJson: string | null
  readonly toolsJson: string | null
  readonly resourcesJson: string | null
  readonly resourceTemplatesJson: string | null
  readonly promptsJson: string | null
  readonly errorCode: McpProbeErrorCodeT | null
  readonly errorMessage: string | null
  readonly errorDetailJson: string | null
  readonly startedAt: number
  readonly finishedAt: number
  readonly updatedAt: number
}

/** Closed write projection captured before crossing the probe-store port. */
export interface McpProbeWrite {
  readonly status: 'ok' | 'error'
  readonly latencyMs: number
  readonly handshakeMs: number | null
  readonly serverInfoJson: string | null
  readonly protocolVersion: string | null
  readonly capabilitiesJson: string | null
  readonly toolsJson: string | null
  readonly resourcesJson: string | null
  readonly resourceTemplatesJson: string | null
  readonly promptsJson: string | null
  readonly errorCode: McpProbeErrorCodeT | null
  readonly errorMessage: string | null
  readonly errorDetailJson: string | null
  readonly startedAt: number
  readonly finishedAt: number
}

export type McpRuntimeProtocol = 'opencode' | 'claude-code'

export interface McpRuntimeTestLeaseToken {
  readonly protocol: McpRuntimeProtocol
  readonly runtimeSessionId: string
  readonly testSessionId: string
  readonly turnId: string
  readonly leaseNonceDigest: string
}

export interface McpRuntimeTestLeaseInput extends McpRuntimeTestLeaseToken {
  readonly leasedAt?: number
}

/** T5-S aggregate contract. Filesystem roots and persistence rows stay private. */
export type SkillCatalogResource = Skill
export type SkillCatalogContent = SkillContent
export type SkillCatalogVersion = SkillVersion
export type SkillCatalogVersionContent = SkillVersionContent
export type SkillCatalogVersionDiff = SkillVersionDiff

interface SkillJsonSubmission {
  readonly kind: 'json-body'
  readonly body: string
}

export interface GetSkillCatalogInput {
  readonly id: string
}

export interface GetSkillContentCatalogInput {
  readonly id: string
}

export interface ListSkillFilesCatalogInput {
  readonly id: string
}

export interface ReadSkillFileCatalogInput {
  readonly id: string
  readonly path: string
}

export interface WriteSkillFileCatalogInput {
  readonly id: string
  readonly path: string
  readonly submission: SkillJsonSubmission
}

export interface WriteSkillFileCatalogReceipt {
  readonly ok: true
  readonly path: string
  readonly token: string | null
}

export interface DeleteSkillFileCatalogInput {
  readonly id: string
  readonly path: string
  readonly expectedToken?: string
  readonly submission: SkillJsonSubmission
}

export interface DeleteSkillFileCatalogReceipt {
  readonly deleted: Readonly<{
    readonly skillId: string
    readonly name: string
    readonly path: string
  }>
  readonly token: string | null
}

export interface ListSkillVersionsCatalogInput {
  readonly id: string
}

export interface DiffSkillVersionsCatalogInput {
  readonly id: string
  readonly from: string
  readonly to: string
}

export interface GetSkillVersionContentCatalogInput {
  readonly id: string
  readonly version: string
}

export interface RestoreSkillVersionCatalogInput {
  readonly id: string
  readonly version: string
  readonly submission: SkillJsonSubmission
}

export interface RestoreSkillVersionCatalogReceipt {
  readonly version: SkillCatalogVersion
  readonly unfusedMemoryIds: readonly string[]
  readonly token: string | null
}

/** Closed transport envelope; archive bytes never expose a runtime buffer type. */
export interface SkillZipArchiveSubmission {
  readonly encoding: 'base64'
  readonly content: string
}

export interface ParseSkillZipCatalogInput {
  readonly archive: SkillZipArchiveSubmission
}

export interface CommitSkillZipCatalogInput {
  readonly archive: SkillZipArchiveSubmission
  readonly decisions: SkillZipDecisionMap
}

export type ParseSkillZipCatalogReceipt = ParseSkillZipResponse
export type CommitSkillZipCatalogReceipt = CommitSkillZipResponse

/** T5-WF aggregate contract. Persistence rows and raw submissions stay private. */
export type WorkflowCatalogDetail = WorkflowDetail

export interface GetWorkflowCatalogInput {
  readonly id: string
}

/** Closed input for the provider-owned workflow validation inventory. */
export interface ValidateStoredWorkflowCatalogInput {
  readonly workflow: WorkflowCatalogDetail
}

/** Closed draft validation input; transport parsing stays outside the module. */
export interface ValidateWorkflowDraftCatalogInput {
  readonly workflow: WorkflowCatalogDetail
  readonly definition: WorkflowDefinition
  readonly claimedCandidateHash: WorkflowCandidateHash
}

export interface WorkflowCatalogValidationResult {
  readonly validationContextHash: WorkflowValidationContextHash
  readonly ok: boolean
  readonly issues: readonly WorkflowValidationIssue[]
}

export interface WorkflowCatalogDraftValidationResult extends WorkflowCatalogValidationResult {
  readonly candidateHash: WorkflowCandidateHash
}

/** T5-M aggregate contract. Persistence rows and transport contexts stay private. */
export type McpCatalogResource = McpOperationResource

export interface GetMcpCatalogInput {
  readonly id: string
}

/** Purpose-specific identity used by the generic ACL transport adapter. */
export interface McpAclIdentity {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
  readonly updatedAt: number
}

/** T5-P aggregate contract. Installer artifacts and SQLite rows stay private. */
export type PluginCatalogResource = PluginOperationResource

export interface GetPluginCatalogInput {
  readonly id: string
}

/** T5-WG aggregate contract. Roster persistence and SQLite rows stay private. */
export type WorkgroupCatalogDetail = WorkgroupDetail

export interface GetWorkgroupCatalogInput {
  readonly id: string
}

export type TaskExecutionAgentSnapshot = Pick<
  Agent,
  | 'id'
  | 'name'
  | 'description'
  | 'outputs'
  | 'outputKinds'
  | 'branchPorts'
  | 'inputs'
  | 'outputWrapperPortNames'
  | 'role'
  | 'syncOutputsOnIterate'
  | 'runtime'
  | 'permission'
  | 'skills'
  | 'dependsOn'
  | 'mcp'
  | 'plugins'
  | 'frontmatterExtra'
  | 'bodyMd'
  | 'schemaVersion'
  | 'createdAt'
  | 'updatedAt'
>

type TaskExecutionMcpSnapshotOf<T extends Mcp> = Pick<
  T,
  | 'id'
  | 'name'
  | 'description'
  | 'type'
  | 'config'
  | 'enabled'
  | 'schemaVersion'
  | 'createdAt'
  | 'updatedAt'
>

export type TaskExecutionMcpSnapshot =
  | TaskExecutionMcpSnapshotOf<Extract<Mcp, { type: 'local' }>>
  | TaskExecutionMcpSnapshotOf<Extract<Mcp, { type: 'remote' }>>

export interface TaskExecutionPluginSnapshot {
  readonly id: string
  readonly name: string
  readonly options: Plugin['options']
  readonly enabled: boolean
  /** Runtime-ready locator; the storage/cache path remains infrastructure-private. */
  readonly runtimeSpecifier: string
  readonly resolvedVersion: string | null
}

type TaskExecutionSkillSnapshot =
  | {
      readonly kind: 'managed'
      readonly skillId: string
      readonly name: string
      readonly contentVersion: number
    }
  | { readonly kind: 'project'; readonly name: string }

export interface TaskExecutionWorkflowSnapshot {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly definition: WorkflowDefinition
}

export type TaskExecutionWorkgroupSnapshot = Pick<
  Workgroup,
  | 'id'
  | 'name'
  | 'description'
  | 'instructions'
  | 'mode'
  | 'outputContract'
  | 'leaderMemberId'
  | 'switches'
  | 'maxRounds'
  | 'completionGate'
  | 'clarifyBudget'
  | 'fanOut'
  | 'members'
  | 'version'
>

export type TaskExecutionResourceRequest =
  | { readonly kind: 'workflow-launch'; readonly workflowId: string }
  | { readonly kind: 'agent-injection'; readonly agentId: string }
  | {
      readonly kind: 'call-workflow'
      readonly sourceWorkflowId: string
      readonly nodeId: string
      readonly name: string
      readonly idHint?: string
    }
  | {
      readonly kind: 'call-workgroup'
      readonly sourceWorkflowId: string
      readonly nodeId: string
      readonly name: string
      readonly idHint?: string
    }

export type FrozenTaskExecutionResourceSnapshot =
  | {
      readonly kind: 'workflow-launch'
      readonly workflow: TaskExecutionWorkflowSnapshot
    }
  | {
      readonly kind: 'agent-injection'
      readonly root: TaskExecutionAgentSnapshot
      readonly dependents: readonly TaskExecutionAgentSnapshot[]
      readonly skills: readonly TaskExecutionSkillSnapshot[]
      readonly mcps: readonly TaskExecutionMcpSnapshot[]
      readonly plugins: readonly TaskExecutionPluginSnapshot[]
    }
  | {
      readonly kind: 'call-workflow'
      readonly sourceWorkflowId: string
      readonly nodeId: string
      readonly workflow: TaskExecutionWorkflowSnapshot
    }
  | {
      readonly kind: 'call-workgroup'
      readonly sourceWorkflowId: string
      readonly nodeId: string
      readonly workgroup: TaskExecutionWorkgroupSnapshot
    }

type IntentPayloadFor<K extends CatalogSelectorKind> = Extract<
  IntentOp,
  { resourceType: K }
>['payload']

type IntentCreateResourcePlan<K extends CatalogSelectorKind> = {
  readonly kind: K
  readonly operationId: string
  readonly action: 'create'
  readonly resourceId: string
  readonly fromCopy: boolean
  readonly copiedFromResourceId?: string
  readonly payload: Readonly<IntentPayloadFor<K>>
}

type IntentUpdateResourcePlan<K extends CatalogSelectorKind> = {
  readonly kind: K
  readonly operationId: string
  readonly action: 'update'
  readonly resourceId: string
  readonly expectedRevision: ResourceSummaryRevision<K>
  readonly payload: Readonly<IntentPayloadFor<K>>
}

type VersionedIntentResourceChangesetPlanOf<K extends CatalogSelectorKind> =
  K extends CatalogSelectorKind ? IntentCreateResourcePlan<K> | IntentUpdateResourcePlan<K> : never

export type VersionedIntentResourceChangesetPlan =
  VersionedIntentResourceChangesetPlanOf<CatalogSelectorKind>

interface IntentResourceChangesetReceiptOf<K extends CatalogSelectorKind> {
  readonly kind: K
  readonly operationId: string
  readonly resourceId: string
  readonly action: 'create' | 'update'
  readonly revision: ResourceSummaryRevision<K>
}

type DistributedIntentResourceChangesetReceipt<K extends CatalogSelectorKind> =
  K extends CatalogSelectorKind ? IntentResourceChangesetReceiptOf<K> : never

export type IntentResourceChangesetReceipt =
  DistributedIntentResourceChangesetReceipt<CatalogSelectorKind>

export type IntegrationTriggerResourceRequest =
  | { readonly kind: 'scheduled-workflow'; readonly workflowId: string }
  | { readonly kind: 'scheduled-agent'; readonly agentId: string }
  | { readonly kind: 'scheduled-workgroup'; readonly workgroupId: string }
  | { readonly kind: 'webhook-workflow'; readonly workflowId: string }
  | {
      readonly kind: 'webhook-digital-employee'
      readonly employeeDefinitionId: string
    }

export interface DigitalEmployeeTriggerSnapshot {
  readonly employeeDefinitionId: string
  readonly currentRevision: number
  readonly typeId: string
  readonly typeRevision: number
  readonly intake: Readonly<{
    readonly acceptedKinds: readonly ('body' | 'files' | 'body-and-files' | 'external-id')[]
    readonly targetFields: readonly Readonly<{ fieldRef: string; required: boolean }>[]
  }>
}

export type FrozenIntegrationTriggerResourceSnapshot =
  | {
      readonly kind: 'scheduled-workflow'
      readonly workflow: TaskExecutionWorkflowSnapshot
    }
  | { readonly kind: 'scheduled-agent'; readonly agent: TaskExecutionAgentSnapshot }
  | {
      readonly kind: 'scheduled-workgroup'
      readonly workgroup: TaskExecutionWorkgroupSnapshot
    }
  | { readonly kind: 'webhook-workflow'; readonly workflow: TaskExecutionWorkflowSnapshot }
  | {
      readonly kind: 'webhook-digital-employee'
      readonly employee: DigitalEmployeeTriggerSnapshot
    }

export type ResourceMemoryScopeRef =
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'workflow'; readonly id: string }

export type ResourceScopeAccess = ResourceAccess

export type AgentPackageMutation = Extract<BundleOp, { kind: 'agent-create' | 'agent-update' }>
export type SkillPackageMutation = Extract<BundleOp, { kind: 'skill-create' | 'skill-update' }>
export type McpPackageMutation = Extract<BundleOp, { kind: 'mcp-create' | 'mcp-update' }>
export type PluginPackageMutation = Extract<BundleOp, { kind: 'plugin-create' | 'plugin-update' }>
export type WorkflowPackageMutation = Extract<
  BundleOp,
  { kind: 'workflow-create' | 'workflow-update' }
>
export type WorkgroupPackageMutation = Extract<
  BundleOp,
  { kind: 'workgroup-create' | 'workgroup-update' }
>
export type CapabilityTemplatePackageMutation = Extract<
  BundleOp,
  {
    kind:
      | 'capability-framework-create'
      | 'capability-framework-update'
      | 'capability-binding-create'
      | 'capability-binding-update'
      | 'capability-template-create'
      | 'capability-template-update'
  }
>

declare const preparedPackageMutationBrand: unique symbol

export interface PreparedAgentPackageMutation {
  readonly [preparedPackageMutationBrand]: 'agent'
  readonly mutation: AgentPackageMutation
}
export interface PreparedSkillPackageMutation {
  readonly [preparedPackageMutationBrand]: 'skill'
  readonly mutation: SkillPackageMutation
}
export interface PreparedMcpPackageMutation {
  readonly [preparedPackageMutationBrand]: 'mcp'
  readonly mutation: McpPackageMutation
}
export interface PreparedPluginPackageMutation {
  readonly [preparedPackageMutationBrand]: 'plugin'
  readonly mutation: PluginPackageMutation
}
export interface PreparedWorkflowPackageMutation {
  readonly [preparedPackageMutationBrand]: 'workflow'
  readonly mutation: WorkflowPackageMutation
}
export interface PreparedWorkgroupPackageMutation {
  readonly [preparedPackageMutationBrand]: 'workgroup'
  readonly mutation: WorkgroupPackageMutation
}
export interface PreparedCapabilityTemplatePackageMutation {
  readonly [preparedPackageMutationBrand]: 'capability_template'
  readonly mutation: CapabilityTemplatePackageMutation
}

export interface ResourcePackageMutationReceipt<
  K extends PackageResourceKind = PackageResourceKind,
> {
  readonly resourceType: K
  readonly operationId: string
  readonly resourceId: string
  readonly action: 'create' | 'update'
  readonly name: string
}

export interface ResourcePackageApplyScenarioPlan {
  readonly scenarioId: 'resource-package'
  readonly idempotencyKey: Readonly<{ scope: 'package'; key: string }>
  readonly serializationKey: string
  readonly operations: readonly BundleOp[]
}

/**
 * T6 package transport contract. Multipart files, ZIP bytes, filesystem paths
 * and secret values are staged by the composition adapter and never cross the
 * public operation surface.
 */
export interface StagedResourcePackageSubmission {
  readonly kind: 'staged-resource-package'
  readonly handle: string
}

export interface InspectResourcePackage {
  readonly submission: StagedResourcePackageSubmission
}

export interface ApplyResourcePackage {
  readonly submission: StagedResourcePackageSubmission
  readonly idempotencyKey: string
}

/**
 * Closed transport envelopes for the task-scoped Workgroup room.  The room
 * projection intentionally remains serialized here: it contains historical
 * template metadata whose JSON vocabulary is wider than the public Resource
 * Catalog contract, while the HTTP adapter must preserve the existing wire
 * byte-for-byte without exposing an open object or a persistence row.
 */
export interface WorkgroupTaskJsonSubmission {
  readonly kind: 'json-body'
  readonly body: string
}

export interface WorkgroupTaskJsonDocument {
  readonly kind: 'json-document'
  readonly body: string
}

export interface WorkgroupTaskRef {
  readonly taskId: string
}

export interface WorkgroupTaskAssignmentRef extends WorkgroupTaskRef {
  readonly assignmentId: string
}

export interface WorkgroupTaskSubmission extends WorkgroupTaskRef {
  readonly submission: WorkgroupTaskJsonSubmission
}

export interface WorkgroupTaskAssignmentSubmission extends WorkgroupTaskAssignmentRef {
  readonly submission: WorkgroupTaskJsonSubmission
}

export interface WorkgroupTaskMessageReceipt {
  readonly messageId: string
  readonly assignmentIds: readonly string[]
}

export interface WorkgroupTaskDeliveryReceipt {
  readonly messageId: string
}

export interface WorkgroupTaskDecisionReceipt {
  readonly decision: 'approve' | 'reject'
  readonly exhausted?: true
}

export interface WorkgroupTaskWorkflowReceipt {
  readonly id: string
  readonly name: string
}

export interface WorkgroupTaskConfigReceipt {
  readonly changes: readonly string[]
}

export interface ExportResourcePackage {
  readonly submission: StagedResourcePackageSubmission
}

export type PreparedPackageMutation =
  | PreparedAgentPackageMutation
  | PreparedSkillPackageMutation
  | PreparedMcpPackageMutation
  | PreparedPluginPackageMutation
  | PreparedWorkflowPackageMutation
  | PreparedWorkgroupPackageMutation
  | PreparedCapabilityTemplatePackageMutation
