/** Durable half of daemon shutdown. Process-local driver admission is owned by
 * the bootstrap controller; this port owns only provider state. */
export interface TaskExecutionShutdownOperations {
  listRunningTaskIds(): Promise<readonly string[]>
  interruptSurvivor(input: {
    readonly taskId: string
    readonly now: number
    readonly errorMessage: string
  }): Promise<boolean>
  markRecoveryRequired(input: {
    readonly taskId: string
    readonly now: number
    readonly recoveryCode: string
  }): Promise<void>
}

/** Process-local half of daemon shutdown. It closes claim admission, requests
 * exact active handles to stop and returns only handles still alive after the
 * bounded wait. */
export interface TaskExecutionShutdownController {
  shutdownActive(reason: string, budgetMs: number): Promise<readonly string[]>
}
