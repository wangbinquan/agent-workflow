import type { NodeRunStatus } from '@agent-workflow/shared'

export interface NodeStatusEvents {
  broadcastNodeStatus(
    taskId: string,
    nodeRunId: string,
    nodeId: string,
    status: NodeRunStatus,
  ): void
}
export interface ExecutionDiagnostics {
  describeIsoFailure(code: string, error: unknown): string
}
