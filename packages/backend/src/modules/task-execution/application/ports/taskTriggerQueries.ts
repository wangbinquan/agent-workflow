import type { TaskStatus } from '@agent-workflow/shared'

export interface TaskTerminalWorkspace {
  readonly id: string
  readonly ownerUserId: string | null
  readonly status: TaskStatus
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  readonly workspacePruningAt: number | null
  readonly workspacePrunedAt: number | null
}

export interface TaskTriggerQueries {
  frozenContext(taskId: string): Promise<string | null | undefined>
  workspaceAttribution(taskId: string): Promise<{
    webhookTriggerId: string | null
    eventSubscriptionId: string | null
  } | null>
  findByOrigin(input: {
    readonly fireId: string
    readonly eventDeliveryId?: string
  }): Promise<string | null>
  status(taskId: string): Promise<{ id: string; status: TaskStatus } | null>
  terminalWorkspaces(taskIds: readonly string[]): Promise<TaskTerminalWorkspace[]>
}
