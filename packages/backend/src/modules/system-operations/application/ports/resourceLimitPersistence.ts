export interface ResourceLimitTask {
  readonly id: string
  readonly maxDurationMs: number | null
  readonly maxTotalTokens: number | null
  readonly runningMs: number
  readonly runningSince: number | null
}

export interface ResourceLimitCallRow {
  readonly childTaskId: string | null
  readonly wrapperProgressJson: string | null
}

export interface ResourceLimitTaskClock {
  readonly runningMs: number
  readonly runningSince: number | null
}

export interface ResourceLimitCancellationAudit {
  readonly taskId: string
  readonly reason: string
  readonly now: number
}

/** Provider-owned reads/writes used by the resource-limit application policy. */
export interface ResourceLimitPersistence {
  listRunningTasks(): Promise<ReadonlyArray<ResourceLimitTask>>
  listCallRows(taskId: string): Promise<ReadonlyArray<ResourceLimitCallRow>>
  listTaskStatuses(taskIds: readonly string[]): Promise<ReadonlyArray<string>>
  sumTaskTokens(taskId: string): Promise<number>
  readTaskClock(taskId: string): Promise<ResourceLimitTaskClock | null>
  writeLimitReason(input: {
    readonly taskId: string
    readonly summary: string
    readonly message: string
  }): Promise<void>
  recordLimitCancellation(input: ResourceLimitCancellationAudit): Promise<void>
}

/**
 * Cancellation is supplied by Task Execution composition. System Operations
 * deliberately does not reach into a task runtime or fabricate a fallback.
 */
export interface ResourceLimitOperations {
  readonly persistence: ResourceLimitPersistence
  readonly cancelTask: (taskId: string) => Promise<void>
}

/** Aggregate expressions are not column-decoded by every provider driver. */
export function decodeResourceLimitTokenTotal(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : 0
  if (typeof value === 'bigint') {
    const decoded = Number(value)
    return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const decoded = Number(value)
    return Number.isFinite(decoded) ? decoded : 0
  }
  return 0
}
