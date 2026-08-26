import type { TaskExecutionCommandErrorCode } from '../public/types'
import { DomainError } from '@/util/errors'

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
