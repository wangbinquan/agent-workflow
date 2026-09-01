import type { TaskExecutionContextRef } from './taskExecutionTopology'

export interface SchedulerDoneNodeRun {
  readonly id: string
  readonly parentNodeRunId: string | null
  readonly status: string
}

/** Named scheduler-finalization reads/writes. Git inspection remains outside;
 * the adapter owns only the atomic task projection and done-run lookup. */
export interface SchedulerCompletionPersistence {
  recordReadonlyDirty(input: {
    readonly taskId: string
    readonly repoIndex: number
    readonly changedCount: number
    readonly execution?: TaskExecutionContextRef
    readonly now: number
  }): Promise<void>

  listDoneNodeRuns(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly iteration: number
  }): Promise<readonly SchedulerDoneNodeRun[]>
}
