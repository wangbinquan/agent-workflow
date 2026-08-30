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

const trustedResourcePackageCapabilities = new WeakSet<object>()

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
  readonly currentAuthority: ResourcePackageApplyTx['currentAuthority']
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
  const participant = Object.freeze({ ...input }) as unknown as ResourcePackageApplyTx
  trustedResourcePackageCapabilities.add(participant)
  return participant
}
