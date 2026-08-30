import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import type {
  AgentPackageMutation,
  CapabilityTemplatePackageMutation,
  FrozenIntegrationTriggerResourceSnapshot,
  FrozenTaskExecutionResourceSnapshot,
  IntegrationTriggerResourceRequest,
  IntentResourceChangesetReceipt,
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

/** Opaque current authority minted by identity-access; never an Actor-shaped bag. */
export type ResourceCurrentAuthorityInTx = RequestAuthority

export interface TaskExecutionResourceSnapshotInTx {
  loadAuthorized(
    authority: ResourceCurrentAuthorityInTx,
    requests: readonly TaskExecutionResourceRequest[],
  ): readonly FrozenTaskExecutionResourceSnapshot[]
}

export interface IntentApplyResourceParticipantInTx {
  authorizeAndCommit(
    authority: ResourceCurrentAuthorityInTx,
    plan: VersionedIntentResourceChangesetPlan,
  ): IntentResourceChangesetReceipt
}

export interface IntegrationTriggerResourceSnapshotInTx {
  loadAuthorized(
    authority: ResourceCurrentAuthorityInTx,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): readonly FrozenIntegrationTriggerResourceSnapshot[]
}

export interface ResourceScopeAuthorizationInTx {
  accessOf(
    authority: ResourceCurrentAuthorityInTx,
    scope: ResourceMemoryScopeRef,
  ): ResourceScopeAccess
}

/** General ACL verdict participant; consumers cannot request a resource body. */
export interface ResourceAuthorizationInTx {
  accessOf(authority: ResourceCurrentAuthorityInTx, target: ResourceAclTarget): ResourceScopeAccess
  assertView(authority: ResourceCurrentAuthorityInTx, target: ResourceAclTarget): void
  assertEdit(authority: ResourceCurrentAuthorityInTx, target: ResourceAclTarget): void
  assertGovern(authority: ResourceCurrentAuthorityInTx, target: ResourceAclTarget): void
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
  commit(prepared: PreparedAgentPackageMutation): ResourcePackageMutationReceipt<'agent'>
}
export interface SkillPackageMutationParticipantInTx {
  commit(prepared: PreparedSkillPackageMutation): ResourcePackageMutationReceipt<'skill'>
}
export interface McpPackageMutationParticipantInTx {
  commit(prepared: PreparedMcpPackageMutation): ResourcePackageMutationReceipt<'mcp'>
}
export interface PluginPackageMutationParticipantInTx {
  commit(prepared: PreparedPluginPackageMutation): ResourcePackageMutationReceipt<'plugin'>
}
export interface WorkflowPackageMutationParticipantInTx {
  commit(prepared: PreparedWorkflowPackageMutation): ResourcePackageMutationReceipt<'workflow'>
}
export interface WorkgroupPackageMutationParticipantInTx {
  commit(prepared: PreparedWorkgroupPackageMutation): ResourcePackageMutationReceipt<'workgroup'>
}
export interface CapabilityTemplatePackageMutationParticipantInTx {
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
  resourceApplied(receipt: ResourcePackageMutationReceipt): void
}

export interface ResourcePackageAuditInTx {
  recordResourceApplied(receipt: ResourcePackageMutationReceipt): void
}

export interface ResourcePackageApplyScenarioTx {
  readonly currentAuthority: ResourceCurrentAuthorityInTx
}

export interface ResourcePackageApplyTx extends ResourcePackageApplyScenarioTx {
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
