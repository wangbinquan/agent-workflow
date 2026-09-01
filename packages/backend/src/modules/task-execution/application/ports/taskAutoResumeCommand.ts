import type { TaskRecoveryBreakerConfig } from './taskRecoveryOperations'

export interface RepositoryPreparationRetryCommand {
  retry(taskId: string): Promise<void>
}

export interface TaskAutoResumeResult {
  readonly resumed: readonly string[]
  readonly skipped: readonly string[]
}

/** Closed boot recovery command; repository preparation retry is required. */
export interface TaskAutoResumeCommand {
  run(input: { readonly breaker: TaskRecoveryBreakerConfig }): Promise<TaskAutoResumeResult>
}
