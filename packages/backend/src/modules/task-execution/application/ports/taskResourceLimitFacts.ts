// RFC-395 II-b O3 — task-owned budgets, usage and limit-reason facts.
export interface ResourceLimitTask {
  readonly id: string
  readonly maxDurationMs: number | null
  readonly maxTotalTokens: number | null
  readonly runningMs: number
  readonly runningSince: number | null
}

export interface ResourceLimitCallHumanWait {
  readonly childTaskId: string | null
  readonly accumulatedMs: number
  readonly openSince: number | null
}

export interface ResourceLimitTaskClock {
  readonly runningMs: number
  readonly runningSince: number | null
}

/** Provider-owned reads/writes used by the resource-limit application policy. */
export interface TaskResourceLimitFacts {
  listRunningTasks(): Promise<ReadonlyArray<ResourceLimitTask>>
  callHumanWaits(taskId: string): Promise<ReadonlyArray<ResourceLimitCallHumanWait>>
  listTaskStatuses(taskIds: readonly string[]): Promise<ReadonlyArray<string>>
  sumTaskTokens(taskId: string): Promise<number>
  readTaskClock(taskId: string): Promise<ResourceLimitTaskClock | null>
  writeLimitReason(input: {
    readonly taskId: string
    readonly summary: string
    readonly message: string
  }): Promise<void>
}
