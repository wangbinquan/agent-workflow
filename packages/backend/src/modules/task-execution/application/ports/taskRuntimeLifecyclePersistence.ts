import type { TaskStatus } from '@agent-workflow/shared'

import type { TaskExecutionContextRef } from './taskExecutionTopology'

export interface TaskRuntimeLifecycleMutation {
  readonly finishedAt?: number | null
  readonly errorSummary?: string | null
  readonly errorMessage?: string | null
  readonly failedNodeId?: string | null
}

/** Scheduler-owned task lifecycle CAS. The adapter owns provider fencing,
 * running-time accounting, workspace-prune admission and committed events. */
export interface TaskRuntimeLifecyclePersistence {
  trySet(input: {
    readonly taskId: string
    readonly to: TaskStatus
    readonly allowedFrom: readonly TaskStatus[]
    readonly allowTerminal?: boolean
    readonly extra?: TaskRuntimeLifecycleMutation
    readonly executionContext?: TaskExecutionContextRef
    readonly now: number
    readonly reason: string
  }): Promise<boolean>
}
