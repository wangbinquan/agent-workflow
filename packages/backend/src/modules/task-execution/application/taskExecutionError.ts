import { DomainError } from '@/util/errors'

// RFC-480: the code vocabulary moved here from public/types — its only reader is this error (no other context names it).
/** Safe failure codes; durable owner identities never cross here. */
export type TaskExecutionCommandErrorCode =
  | 'task-continuation-conflict'
  | 'task-continuation-stale'
  | 'task-terminal-maintenance-conflict'
  | 'task-execution-owner-conflict'
  | 'task-execution-resource-conflict'
  | 'task-execution-stale-owner'
  | 'task-execution-recovery-required'
  | 'task-execution-outcome-unknown'
  | 'task-execution-shutting-down'

export class TaskExecutionError extends DomainError {
  constructor(
    code: TaskExecutionCommandErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, code === 'task-execution-shutting-down' ? 503 : 409, details)
    this.name = 'TaskExecutionError'
  }
}
