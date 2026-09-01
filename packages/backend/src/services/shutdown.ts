// P-4-06: SIGTERM/SIGINT graceful shutdown.
//
// On signal:
//   1. The HTTP/WS server is asked to stop (callers do this before invoking
//      gracefulShutdown).
//   2. Every in-flight task's AbortController is signaled. The runner SIGTERMs
//      its opencode child; the scheduler marks the row canceled.
//   3. We poll up to `budgetMs` (default 30s) for all running tasks to
//      transition out of 'running'.
//   4. Any survivor past the budget is flipped to 'interrupted' so the
//      next startup's orphan reaper (P-4-07) doesn't have to do it.

import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import type {
  TaskExecutionShutdownController,
  TaskExecutionShutdownOperations,
} from '@/modules/task-execution/application/ports/taskExecutionShutdownOperations'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { recordRecoveryEvent } from '@/services/recovery'
import { createLogger } from '@/util/log'

const log = createLogger('shutdown')

export interface GracefulShutdownDependencies {
  readonly controller: TaskExecutionShutdownController
  readonly operations: TaskExecutionShutdownOperations
  readonly recovery: TaskRecoveryOperations
}

export async function gracefulShutdown(
  dependencies: GracefulShutdownDependencies,
  budgetMs: number = 30_000,
): Promise<void> {
  // RFC-202 T4: tag the abort so the scheduler writes interrupted +
  // daemon-restart (resumable / boot-auto-resumable) instead of
  // 'canceled by user' — a daemon restart is not a user decision.
  await dependencies.controller.shutdownActive(DAEMON_SHUTDOWN_ABORT_REASON, budgetMs)

  // Budget elapsed; flip any survivors to 'interrupted'.
  const survivors = await dependencies.operations.listRunningTaskIds()
  if (survivors.length === 0) return
  log.warn('graceful budget exceeded; marking survivors interrupted', {
    count: survivors.length,
  })
  for (const taskId of survivors) {
    // RFC-097: CAS from running; a task that settled inside the budget window
    // keeps its real terminal status.
    const now = Date.now()
    const won = await dependencies.operations.interruptSurvivor({
      taskId,
      now,
      errorMessage: 'task did not exit within graceful shutdown budget',
    })
    // RFC-108 T3 (AR-11): durable audit of the shutdown survivor flip.
    if (won) {
      await dependencies.operations.markRecoveryRequired({
        taskId,
        now,
        recoveryCode: 'daemon-shutdown-survivor',
      })
      await recordRecoveryEvent(dependencies.recovery, {
        taskId,
        kind: 'shutdown-flip',
        reason: 'daemon-shutdown',
        before: { status: 'running' },
        after: { status: 'interrupted' },
        now,
      })
    }
  }
}
