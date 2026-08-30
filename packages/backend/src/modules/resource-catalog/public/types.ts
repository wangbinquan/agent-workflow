import type {
  Agent,
  BundleOp,
  CreateMcp,
  DeleteMcp,
  IntentOp,
  Mcp,
  McpOperationResource,
  Plugin,
  RenameMcpRequest,
  ResourceAccess,
  ResourceAcl,
  ResourceVisibility,
  UpdateMcpRequest,
  UpdateResourceAclBody,
  WorkflowDefinition,
  Workgroup,
} from '@agent-workflow/shared'
import type { CatalogSelectorKind, PackageResourceKind } from '../domain/resourceKinds'
import type { AclResourceRef, CatalogResourceRef } from '../domain/resourceRef'
import type { ResourceSummaryRevision } from '../domain/resourceRevision'

export {
  ACL_CATALOG_KINDS,
  CATALOG_SELECTOR_KINDS,
  GRANT_TARGET_KINDS,
  PACKAGE_RESOURCE_KINDS,
  asAclCatalogKind,
  asCatalogSelectorKind,
  asPackageResourceKind,
  type AclCatalogKind,
  type CatalogSelectorKind,
  type GrantTargetKind,
  type PackageResourceKind,
} from '../domain/resourceKinds'
export {
  resourceRef,
  type AclResourceRef,
  type CatalogResourceRef,
  type GrantTargetRef,
  type PackageResourceRef,
  type ResourceRef,
} from '../domain/resourceRef'
export {
  resourceSummaryRevisionEquals,
  type ResourceSummaryRevision,
  type ResourceSummaryRevisionByKind,
} from '../domain/resourceRevision'

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

export type ResourceSummary<K extends CatalogSelectorKind = CatalogSelectorKind> =
  K extends CatalogSelectorKind ? ResourceSummaryOf<K> : never

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

/** Stable application target; no SQLite row or column handle crosses public. */
export interface ResourceAclTarget {
  readonly ref: AclResourceRef
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
}

export interface GetResourceAclRequest {
  readonly target: ResourceAclTarget
}

export interface UpdateResourceAclRequest {
  readonly target: ResourceAclTarget
  readonly update: UpdateResourceAclBody
}

export type ResourceAclDocument = ResourceAcl

/** T5-M aggregate contract. Persistence rows and transport contexts stay private. */
export type McpCatalogResource = McpOperationResource
export type CreateMcpCatalogInput = CreateMcp

export interface GetMcpCatalogInput {
  readonly id: string
}

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
  readonly deleted: McpCatalogResource
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

export type TaskExecutionAgentSnapshot = Pick<
  Agent,
  | 'id'
  | 'name'
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
>

type TaskExecutionMcpSnapshotOf<T extends Mcp> = Pick<
  T,
  'id' | 'name' | 'type' | 'config' | 'enabled'
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

export type TaskExecutionSkillSnapshot =
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
