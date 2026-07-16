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

import { eq } from 'drizzle-orm'
import { DAEMON_RESTART_ERROR_SUMMARY, DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { abortAllActiveTasks } from '@/services/task'
import { recordRecoveryEvent } from '@/services/recovery'
import { createLogger } from '@/util/log'
import { trySetTaskStatus } from '@/services/lifecycle'

const log = createLogger('shutdown')

export async function gracefulShutdown(db: DbClient, budgetMs: number = 30_000): Promise<void> {
  // RFC-202 T4: tag the abort so the scheduler writes interrupted +
  // daemon-restart (resumable / boot-auto-resumable) instead of
  // 'canceled by user' — a daemon restart is not a user decision.
  abortAllActiveTasks(DAEMON_SHUTDOWN_ABORT_REASON)

  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const stillRunning = await db.select().from(tasks).where(eq(tasks.status, 'running'))
    if (stillRunning.length === 0) return
    await Bun.sleep(100)
  }

  // Budget elapsed; flip any survivors to 'interrupted'.
  const survivors = await db.select().from(tasks).where(eq(tasks.status, 'running'))
  if (survivors.length === 0) return
  log.warn('graceful budget exceeded; marking survivors interrupted', {
    count: survivors.length,
  })
  for (const t of survivors) {
    // RFC-097: CAS from running; a task that settled inside the budget window
    // keeps its real terminal status.
    const won = await trySetTaskStatus({
      db,
      taskId: t.id,
      to: 'interrupted',
      allowedFrom: ['running'],
      extra: {
        finishedAt: Date.now(),
        // RFC-202 T4: stamp the summary autoResume actually matches —
        // 'daemon-shutdown' was never picked up by boot auto-resume
        // (autoResume.ts matches DAEMON_RESTART_ERROR_SUMMARY exactly).
        // The recovery_events row below keeps 'daemon-shutdown' as the
        // audit-side provenance.
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        errorMessage: 'task did not exit within graceful shutdown budget',
      },
      reason: 'graceful-shutdown',
    })
    // RFC-108 T3 (AR-11): durable audit of the shutdown survivor flip.
    if (won) {
      await recordRecoveryEvent(db, {
        taskId: t.id,
        kind: 'shutdown-flip',
        reason: 'daemon-shutdown',
        before: { status: 'running' },
        after: { status: 'interrupted' },
      })
    }
  }
}
