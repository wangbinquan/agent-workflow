// RFC-589 — the agent / workgroup launch operations the two launch bindings call, and the upload shapes the agent launch
// passes. They left `public/commands` when the launch endpoints moved into this module's inbound layer: no other module
// consumes them.
import type { AuthenticatedAuthoritySnapshot } from '@/modules/identity-access/public/participants'
import type { StartAgentTask, StartWorkgroupTask, Task } from '@agent-workflow/shared'

export interface TaskRouteUploadLimits {
  readonly perFile: number
  readonly perRequest: number
  readonly perCount: number
}

export interface TaskRouteMultipartFilePart {
  readonly inputKey: string
  readonly filename: string
  readonly declaredMime: string
  readonly blob: Blob
}

/** TaskExecution-owned launch boundary consumed by the Agent route. */
export interface AgentRouteTaskLaunchOperations {
  uploadLimits(): TaskRouteUploadLimits | Promise<TaskRouteUploadLimits>
  assertReplayVisible(actor: AuthenticatedAuthoritySnapshot, sourceTaskId: string): Promise<void>
  launch(
    actor: AuthenticatedAuthoritySnapshot,
    input: Readonly<{
      agentId: string
      payload: StartAgentTask
      uploads?: Readonly<{
        parts: readonly TaskRouteMultipartFilePart[]
        limits: TaskRouteUploadLimits
      }>
    }>,
  ): Promise<Task>
}

/** TaskExecution-owned launch boundary consumed by the Workgroup route. */
export interface WorkgroupRouteTaskLaunchOperations {
  assertReplayVisible(actor: AuthenticatedAuthoritySnapshot, sourceTaskId: string): Promise<void>
  launch(
    actor: AuthenticatedAuthoritySnapshot,
    input: Readonly<{ workgroupId: string; payload: StartWorkgroupTask }>,
  ): Promise<Task>
}
