import type { TaskStatus } from '@agent-workflow/shared'
import type { TerminalWorkspacePruneDecision } from '@/platform/persistence/terminalWorkspacePrune'

/** Compatibility companion for the existing lifecycle admission path. */
export interface TaskLifecycleWriteExtra {
  finishedAt?: number | null
  errorSummary?: string | null
  errorMessage?: string | null
  failedNodeId?: string | null
  workflowSnapshot?: string
  workflowVersion?: number | null
  refClosureJson?: string | null
  workgroupConfigJson?: string | null
  sourceTerminationFence?: 'closed' | 'merged' | null
  sourceTerminationEffectRev?: number | null
}

export type TaskDefinitionLifecycleResult = readonly {
  readonly id: string
  readonly lifecycleEventRevision: number
}[]

export interface TaskDefinitionLifecycleInput {
  readonly taskId: string
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly extra?: TaskLifecycleWriteExtra
  readonly now: number
  readonly isRevival?: boolean
  readonly workspacePruneDecision: TerminalWorkspacePruneDecision
  readonly expectedLifecycleRevision?: number
  readonly expectedWorktreePath?: string
}

/** All operations participate in the caller's existing transaction. */
export interface TaskDefinitionWritePort {
  syncWorkflow(input: {
    readonly taskId: string
    readonly expectedStatus: TaskStatus
    readonly expectedLifecycleRevision: number
    readonly snapshot: string
    readonly sourceRevision: number
    readonly resourceClosure: string | null
    readonly occurredAt: number
  }): Promise<number | null>
  replaceWorkgroupRuntimeConfig(input: {
    readonly taskId: string
    readonly expectedRevision: string
    readonly nextConfig: string
  }): Promise<boolean>
  continueWorkgroupTask(input: {
    readonly taskId: string
    readonly expectedStatus: TaskStatus
    readonly expectedLifecycleRevision: number
    readonly snapshot?: string
  }): Promise<boolean>
  /** Preserves lifecycle CAS, including its legacy atomic definition companion. */
  transitionLifecycle(
    input: TaskDefinitionLifecycleInput,
  ): TaskDefinitionLifecycleResult | PromiseLike<TaskDefinitionLifecycleResult>
}
