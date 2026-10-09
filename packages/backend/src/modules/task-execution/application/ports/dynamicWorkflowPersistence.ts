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
export interface DynamicWorkflowStateWriter {
  saveState(taskId: string, state: DwState, now?: number): Promise<void>
}

export interface DynamicWorkflowWritePurposes {
  readonly preparation: DynamicWorkflowStateWriter
  readonly issuedResults: DynamicWorkflowStateWriter
}

export interface DynamicWorkflowPersistence extends DynamicWorkflowStateWriter {
  readonly writeMode?: 'host-selected'
  readonly writePurposes?: DynamicWorkflowWritePurposes
  loadTask(taskId: string): Promise<DynamicWorkflowTaskSnapshot | null>
  loadAgent(agentId: string): Promise<Agent | null>
  hasAwaitingConfirmationRun(taskId: string, cause: string): Promise<boolean>
  countNodeRuns(taskId: string, nodeId: string): Promise<number>
}
