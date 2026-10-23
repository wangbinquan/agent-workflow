export interface ReferencingResource {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface AgentMcpReferenceLookup {
  find(mcpId: string): Promise<readonly ReferencingResource[]>
}
export interface AgentPluginReferenceLookup {
  find(pluginId: string): Promise<readonly ReferencingResource[]>
}
export interface AgentSkillReferenceLookup {
  find(skillId: string): Promise<readonly ReferencingResource[]>
}
export interface AgentDependencyReferenceLookup {
  find(agentId: string): Promise<readonly ReferencingResource[]>
}
export interface WorkflowAgentReferenceLookup {
  find(agentId: string): Promise<readonly ReferencingResource[]>
}
export interface WorkflowCallReferenceLookup {
  find(input: {
    readonly id: string
    readonly name: string
  }): Promise<readonly { readonly id: string }[]>
}
