import type {
  Agent,
  BundleOp,
  IntentOp,
  Mcp,
  McpOperationResource,
  Plugin,
  PluginOperationResource,
  ResourceAccess,
  ResourceVisibility,
  Skill,
  SkillContent,
  SkillVersion,
  SkillVersionContent,
  SkillVersionDiff,
  WorkflowDetail,
  WorkflowDefinition,
  Workgroup,
  WorkgroupDetail,
} from '@agent-workflow/shared'
import type { CatalogSelectorKind, PackageResourceKind } from '../domain/resourceKinds'
import type { ResourceSummaryRevision } from '../domain/resourceRevision'

export {
  asPackageResourceKind,
  type CatalogSelectorKind,
  type PackageResourceKind,
} from '../domain/resourceKinds'
export { type PackageResourceRef, type ResourceRef } from '../domain/resourceRef'
export { type ResourceSummaryRevision } from '../domain/resourceRevision'

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

/** T5-WF aggregate contract. Persistence rows and raw submissions stay private. */
export type WorkflowCatalogDetail = WorkflowDetail

export interface GetWorkflowCatalogInput {
  readonly id: string
}

export interface WorkflowAclIdentity {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly builtin: boolean
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
