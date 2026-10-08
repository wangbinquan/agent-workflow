import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import {
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
  type TaskExecutionContext,
} from '../application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
  type TaskHostAdmittedWork,
} from '../application/taskHostAdmission'
import type { TaskHostWriteBinding, TaskHostWriteSelection } from './hostExecutionWriteTransaction'

export interface TaskHostExecutionWriteSelection {
  readonly context: TaskExecutionContext
  readonly work: TaskHostAdmittedWork
  readonly selection: Extract<TaskHostWriteSelection, { kind: 'selected' }>
}

/** Capture the original Task work synchronously; the concrete adapter chooses its purpose. */
export function captureTaskHostExecutionWrite(
  binding: TaskHostWriteBinding,
  input: {
    readonly taskId?: string
    readonly executionContext?: TaskExecutionContextRef
  } = {},
): TaskHostExecutionWriteSelection {
  if (binding === undefined) throw new Error('task-host-write-selection-incomplete')
  const context =
    input.executionContext !== undefined
      ? runWithTaskExecutionContext(input.executionContext, () => currentTaskExecutionContext())
      : currentTaskExecutionContext(input.taskId)
  if (context === undefined) throw new Error('task-host-execution-context-required')
  const work = taskHostWorkForToken(context.token)
  if (work === undefined) throw new Error('task-host-admitted-work-required')
  return Object.freeze({
    context,
    work,
    selection: Object.freeze({ kind: 'selected', capture: taskHostWorkCapture(work), binding }),
  })
}
