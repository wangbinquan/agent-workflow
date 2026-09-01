import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export interface AgentLaunchValidationIssue {
  readonly severity?: string
  readonly message: string
  readonly [key: string]: unknown
}

/** Provider-selected visible Agent projection bound to the current authority model. */
export interface AgentLaunchVisibleAgentQuery {
  get(actor: Actor, agentId: string): Promise<Agent | null>
}

/** Provider-selected full Resource Catalog validation context. */
export interface AgentLaunchWorkflowValidation {
  validate(definition: WorkflowDefinition): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}

/** Provider-selected Resource Catalog seam used by single-agent task launch. */
export interface AgentLaunchResourceOperations {
  loadVisibleAgent(actor: Actor, agentId: string): Promise<Agent | null>
  ensureHostWorkflow(): Promise<void>
  validateHostWorkflow(definition: WorkflowDefinition): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}
