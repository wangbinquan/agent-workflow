// RFC-370 — the daemon worker's entry into an admitted human-gate continuation.

import type { TaskDriveCoordinator } from './taskDriveTypes'

/**
 * Claims a pending gate continuation only once this process no longer drives
 * the task. A decision admitted while the task's driver is still attached
 * leaves that driver draining the work it already admitted; claiming before it
 * releases is an owner conflict on every worker cycle. The driver hands the
 * task over by releasing it, and the worker's next cycle claims.
 */
export function createGateContinuationDriver(input: {
  readonly isDriving: (taskId: string) => boolean
  readonly coordinator: Pick<TaskDriveCoordinator, 'submit'>
}): (continuation: Readonly<{ taskId: string; continuationRef: string }>) => Promise<void> {
  return async ({ taskId, continuationRef }) => {
    if (input.isDriving(taskId)) return
    await input.coordinator.submit({
      taskId,
      intentId: continuationRef,
      completionMode: 'background',
    })
  }
}
