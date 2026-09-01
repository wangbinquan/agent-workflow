import type { Agent } from '@agent-workflow/shared'

/** Provider-neutral rows needed to resolve one code-review agent slot. */
export interface ReviewerResolutionRead {
  loadRepositoryCapability(input: {
    readonly repositoryId: string
    readonly capability: string
  }): Promise<{ readonly templateId: string | null } | null>
  loadTemplate(templateId: string): Promise<{ readonly agentBySlotJson: string } | null>
  loadAgent(agentId: string): Promise<Agent | null>
}
