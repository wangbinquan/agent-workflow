import type { TaskOperationsListItem } from '@agent-workflow/shared'
import { formatDurationMs, type DurationToken } from './duration'

export type TaskOperationsDuration =
  | { kind: 'dash' }
  | { kind: 'queued' | 'running' | 'accumulated'; dur: DurationToken }

/** RFC-244: RFC-207 execution clock, excluding time parked for human input. */
export function taskOperationsDuration(
  task: Pick<TaskOperationsListItem, 'status' | 'startedAt' | 'executionClock'>,
  now: number,
): TaskOperationsDuration {
  if (task.status === 'pending') {
    return { kind: 'queued', dur: formatDurationMs(now - task.startedAt) }
  }

  let effective = task.executionClock.runningMs
  if (task.status === 'running' && task.executionClock.runningSince !== null) {
    effective += Math.max(0, now - task.executionClock.runningSince)
  }
  if (task.status === 'running') {
    return { kind: 'running', dur: formatDurationMs(effective) }
  }
  if (effective > 0) {
    return { kind: 'accumulated', dur: formatDurationMs(effective) }
  }
  return { kind: 'dash' }
}
