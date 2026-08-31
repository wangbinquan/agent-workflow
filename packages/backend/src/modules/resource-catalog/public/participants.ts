import type {
  DirectAuthenticatedAuthority,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type {
  AgentPackageMutation,
  AgentAclIdentity,
  CapabilityTemplatePackageMutation,
  FrozenIntegrationTriggerResourceSnapshot,
  FrozenTaskExecutionResourceSnapshot,
  IntegrationTriggerResourceRequest,
  IntentResourceChangesetReceipt,
  McpAclIdentity,
  McpPackageMutation,
  PluginPackageMutation,
  PluginAclIdentity,
  WorkgroupAclIdentity,
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
  SkillAclIdentity,
  SkillPackageMutation,
  TaskExecutionResourceRequest,
  VersionedIntentResourceChangesetPlan,
  WorkflowAclIdentity,
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
declare const agentAclIdentityParticipantBrand: unique symbol
declare const pluginAclIdentityParticipantBrand: unique symbol
declare const skillAclIdentityParticipantBrand: unique symbol
declare const workflowAclIdentityParticipantBrand: unique symbol
declare const workgroupAclIdentityParticipantBrand: unique symbol

export interface McpAclIdentityParticipant {
  readonly [mcpAclIdentityParticipantBrand]: 'mcp-acl-identity-participant'
  load(id: string): Promise<McpAclIdentity | null>
  nextUpdatedAt(id: string): Promise<number>
}

export interface AgentAclIdentityParticipant {
  readonly [agentAclIdentityParticipantBrand]: 'agent-acl-identity-participant'
  load(id: string): Promise<AgentAclIdentity | null>
  nextUpdatedAt(id: string): Promise<number>
}

export interface PluginAclIdentityParticipant {
  readonly [pluginAclIdentityParticipantBrand]: 'plugin-acl-identity-participant'
  load(id: string): Promise<PluginAclIdentity | null>
  nextUpdatedAt(id: string): Promise<number>
}

export interface SkillAclIdentityParticipant {
  readonly [skillAclIdentityParticipantBrand]: 'skill-acl-identity-participant'
  load(id: string): Promise<SkillAclIdentity | null>
  nextUpdatedAt(id: string): Promise<number>
}

export interface WorkflowAclIdentityParticipant {
  readonly [workflowAclIdentityParticipantBrand]: 'workflow-acl-identity-participant'
  load(id: string): Promise<WorkflowAclIdentity | null>
}

export interface WorkgroupAclIdentityParticipant {
  readonly [workgroupAclIdentityParticipantBrand]: 'workgroup-acl-identity-participant'
  load(id: string): Promise<WorkgroupAclIdentity | null>
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
