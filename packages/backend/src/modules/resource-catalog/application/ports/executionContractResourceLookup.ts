import type { WorkflowDefinition } from '@agent-workflow/shared'
export interface ExecutionContractAgentResource {
  readonly name: string
  readonly outputs: readonly string[]
  readonly updatedAt: number
  readonly frontmatterExtra: Readonly<Record<string, unknown>>
}

export interface ExecutionContractWorkflowResource {
  readonly name: string
  readonly version: number
  readonly definition: WorkflowDefinition
}

export interface ExecutionContractResourceLookup {
  loadAgent(id: string): Promise<ExecutionContractAgentResource | null>
  loadWorkflow(id: string): Promise<ExecutionContractWorkflowResource | null>
}
