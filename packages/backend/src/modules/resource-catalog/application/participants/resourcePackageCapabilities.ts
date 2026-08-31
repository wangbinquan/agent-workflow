import type {
  AgentPackageMutationParticipantInTx,
  CapabilityTemplatePackageMutationParticipantInTx,
  McpPackageMutationParticipantInTx,
  PluginPackageMutationParticipantInTx,
  ResourcePackageApplyScenarioTx,
  ResourcePackageApplyTx,
  ResourcePackageAuditInTx,
  ResourcePackageEventsInTx,
  SkillPackageMutationParticipantInTx,
  WorkflowPackageMutationParticipantInTx,
  WorkgroupPackageMutationParticipantInTx,
} from '../../public/participants'
import type {
  AgentPackageMutation,
  CapabilityTemplatePackageMutation,
  McpPackageMutation,
  PluginPackageMutation,
  PreparedAgentPackageMutation,
  PreparedCapabilityTemplatePackageMutation,
  PreparedMcpPackageMutation,
  PreparedPluginPackageMutation,
  PreparedSkillPackageMutation,
  PreparedWorkflowPackageMutation,
  PreparedWorkgroupPackageMutation,
  SkillPackageMutation,
  WorkflowPackageMutation,
  WorkgroupPackageMutation,
} from '../../public/types'

const trustedResourcePackageCapabilities = new WeakSet<object>()

function prepared<T extends object>(value: T): T {
  const capability = Object.freeze(value)
  trustedResourcePackageCapabilities.add(capability)
  return capability
}

export function createPreparedAgentPackageMutation(
  mutation: AgentPackageMutation,
): PreparedAgentPackageMutation {
  return prepared({ mutation }) as unknown as PreparedAgentPackageMutation
}

export function createPreparedSkillPackageMutation(
  mutation: SkillPackageMutation,
): PreparedSkillPackageMutation {
  return prepared({ mutation }) as unknown as PreparedSkillPackageMutation
}

export function createPreparedMcpPackageMutation(
  mutation: McpPackageMutation,
): PreparedMcpPackageMutation {
  return prepared({ mutation }) as unknown as PreparedMcpPackageMutation
}

export function createPreparedPluginPackageMutation(
  mutation: PluginPackageMutation,
): PreparedPluginPackageMutation {
  return prepared({ mutation }) as unknown as PreparedPluginPackageMutation
}

export function createPreparedWorkflowPackageMutation(
  mutation: WorkflowPackageMutation,
): PreparedWorkflowPackageMutation {
  return prepared({ mutation }) as unknown as PreparedWorkflowPackageMutation
}

export function createPreparedWorkgroupPackageMutation(
  mutation: WorkgroupPackageMutation,
): PreparedWorkgroupPackageMutation {
  return prepared({ mutation }) as unknown as PreparedWorkgroupPackageMutation
}

export function createPreparedCapabilityTemplatePackageMutation(
  mutation: CapabilityTemplatePackageMutation,
): PreparedCapabilityTemplatePackageMutation {
  return prepared({ mutation }) as unknown as PreparedCapabilityTemplatePackageMutation
}

export function assertTrustedResourcePackageCapability(capability: object): void {
  if (!trustedResourcePackageCapabilities.has(capability)) {
    throw new Error('untrusted-resource-package-capability')
  }
}

export function createAgentPackageMutationParticipantInTx(
  commit: AgentPackageMutationParticipantInTx['commit'],
): AgentPackageMutationParticipantInTx {
  const participant = Object.freeze({ commit }) as unknown as AgentPackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createSkillPackageMutationParticipantInTx(
  commit: SkillPackageMutationParticipantInTx['commit'],
): SkillPackageMutationParticipantInTx {
  const participant = Object.freeze({ commit }) as unknown as SkillPackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createMcpPackageMutationParticipantInTx(
  commit: McpPackageMutationParticipantInTx['commit'],
): McpPackageMutationParticipantInTx {
  const participant = Object.freeze({ commit }) as unknown as McpPackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createPluginPackageMutationParticipantInTx(
  commit: PluginPackageMutationParticipantInTx['commit'],
): PluginPackageMutationParticipantInTx {
  const participant = Object.freeze({ commit }) as unknown as PluginPackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createWorkflowPackageMutationParticipantInTx(
  commit: WorkflowPackageMutationParticipantInTx['commit'],
): WorkflowPackageMutationParticipantInTx {
  const participant = Object.freeze({ commit }) as unknown as WorkflowPackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createWorkgroupPackageMutationParticipantInTx(
  commit: WorkgroupPackageMutationParticipantInTx['commit'],
): WorkgroupPackageMutationParticipantInTx {
  const participant = Object.freeze({
    commit,
  }) as unknown as WorkgroupPackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createCapabilityTemplatePackageMutationParticipantInTx(
  commit: CapabilityTemplatePackageMutationParticipantInTx['commit'],
): CapabilityTemplatePackageMutationParticipantInTx {
  const participant = Object.freeze({
    commit,
  }) as unknown as CapabilityTemplatePackageMutationParticipantInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createResourcePackageEventsInTx(
  resourceApplied: ResourcePackageEventsInTx['resourceApplied'],
): ResourcePackageEventsInTx {
  const participant = Object.freeze({ resourceApplied }) as unknown as ResourcePackageEventsInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createResourcePackageAuditInTx(
  recordResourceApplied: ResourcePackageAuditInTx['recordResourceApplied'],
): ResourcePackageAuditInTx {
  const participant = Object.freeze({
    recordResourceApplied,
  }) as unknown as ResourcePackageAuditInTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export function createResourcePackageApplyScenarioTx(
  currentAuthority: ResourcePackageApplyScenarioTx['currentAuthority'],
): ResourcePackageApplyScenarioTx {
  const participant = Object.freeze({
    currentAuthority,
  }) as unknown as ResourcePackageApplyScenarioTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}

export interface ResourcePackageApplyTxInput {
  readonly currentAuthority: () => ResourcePackageApplyTx['currentAuthority']
  readonly agents: ResourcePackageApplyTx['agents']
  readonly skills: ResourcePackageApplyTx['skills']
  readonly mcps: ResourcePackageApplyTx['mcps']
  readonly plugins: ResourcePackageApplyTx['plugins']
  readonly workflows: ResourcePackageApplyTx['workflows']
  readonly workgroups: ResourcePackageApplyTx['workgroups']
  readonly capabilityTemplates: ResourcePackageApplyTx['capabilityTemplates']
  readonly events: ResourcePackageApplyTx['events']
  readonly audit: ResourcePackageApplyTx['audit']
}

export function createResourcePackageApplyTx(
  input: ResourcePackageApplyTxInput,
): ResourcePackageApplyTx {
  const participant = Object.freeze({
    get currentAuthority() {
      return input.currentAuthority()
    },
    agents: input.agents,
    skills: input.skills,
    mcps: input.mcps,
    plugins: input.plugins,
    workflows: input.workflows,
    workgroups: input.workgroups,
    capabilityTemplates: input.capabilityTemplates,
    events: input.events,
    audit: input.audit,
  }) as unknown as ResourcePackageApplyTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}
