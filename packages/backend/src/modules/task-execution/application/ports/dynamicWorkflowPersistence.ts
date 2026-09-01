import type { Agent, DwState } from '@agent-workflow/shared'

/** Closed durable snapshot needed by the dynamic-workflow generation pass. */
export interface DynamicWorkflowTaskSnapshot {
  readonly workgroupConfigJson: string | null
  readonly triggerContextJson: string | null
  readonly dwStateJson: string | null
}

/**
 * Provider-neutral persistence for the dynamic-workflow transport adapter.
 * Provider clients and Drizzle rows remain inside infrastructure.
 */
export interface DynamicWorkflowPersistence {
  loadTask(taskId: string): Promise<DynamicWorkflowTaskSnapshot | null>
  loadAgent(agentId: string): Promise<Agent | null>
  hasAwaitingConfirmationRun(taskId: string, cause: string): Promise<boolean>
  countNodeRuns(taskId: string, nodeId: string): Promise<number>
  saveState(taskId: string, state: DwState, now?: number): Promise<void>
}
