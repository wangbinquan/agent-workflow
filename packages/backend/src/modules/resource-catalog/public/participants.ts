import type {
  DirectAuthenticatedAuthority,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type {
  AgentPackageMutation,
  CapabilityTemplatePackageMutation,
  FrozenIntegrationTriggerResourceSnapshot,
  FrozenTaskExecutionResourceSnapshot,
  IntegrationTriggerResourceRequest,
  IntentResourceChangesetReceipt,
  McpAclIdentity,
  McpPackageMutation,
  PluginPackageMutation,
  PreparedAgentPackageMutation,
  PreparedCapabilityTemplatePackageMutation,
  PreparedMcpPackageMutation,
  PreparedPluginPackageMutation,
  PreparedSkillPackageMutation,
  PreparedWorkflowPackageMutation,
  PreparedWorkgroupPackageMutation,
  ResourceMemoryScopeRef,
  ResourceAclTarget,
  ResourcePackageApplyScenarioPlan,
  ResourcePackageMutationReceipt,
  ResourceScopeAccess,
  SkillPackageMutation,
  TaskExecutionResourceRequest,
  VersionedIntentResourceChangesetPlan,
  WorkflowPackageMutation,
  WorkgroupPackageMutation,
} from './types'

/** Opaque request context minted by identity-access; never an Actor-shaped bag. */
export type ResourceRequestContext = RequestAuthority
/** Branded current-user authority consumed by the exact MCP aggregate operations. */
export type McpOperationContext = DirectAuthenticatedAuthority

declare const taskExecutionResourceSnapshotInTxBrand: unique symbol
declare const intentApplyResourceParticipantInTxBrand: unique symbol
declare const integrationTriggerResourceSnapshotInTxBrand: unique symbol
declare const resourceScopeAuthorizationInTxBrand: unique symbol
declare const resourceAuthorizationInTxBrand: unique symbol
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

export interface McpAclIdentityParticipant {
  readonly [mcpAclIdentityParticipantBrand]: 'mcp-acl-identity-participant'
  load(id: string): Promise<McpAclIdentity | null>
  nextUpdatedAt(id: string): Promise<number>
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

/** General ACL verdict participant; consumers cannot request a resource body. */
export interface ResourceAuthorizationInTx {
  readonly [resourceAuthorizationInTxBrand]: 'resource-authorization'
  accessOf(authority: ResourceRequestContext, target: ResourceAclTarget): ResourceScopeAccess
  assertView(authority: ResourceRequestContext, target: ResourceAclTarget): void
  assertEdit(authority: ResourceRequestContext, target: ResourceAclTarget): void
  assertGovern(authority: ResourceRequestContext, target: ResourceAclTarget): void
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
