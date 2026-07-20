// P-4-04: resource-limit enforcement.
//
// The daemon runs `enforceLimits` on a 1Hz tick. It scans every task in
// `status='running'` and:
//   1. cancels the task with error `task-time-limit-exceeded` when
//      `now - started_at > max_duration_ms`
//   2. cancels the task with error `task-token-limit-exceeded` when
//      `sum(node_runs.tok_total) > max_total_tokens`
//
// Cancellation is best-effort: we call `cancelTask` which signals the
// scheduler's AbortController if one exists. If the daemon was restarted
// orphan logic (P-4-07) has already flipped the row to `interrupted`, this
// tick is a no-op for that task.

import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'
import { cancelTask } from '@/services/task'
import { recordRecoveryEvent } from '@/services/recovery'
import { createLogger, type Logger } from '@/util/log'

const log: Logger = createLogger('limits')

export interface EnforceLimitsResult {
  scanned: number
  /** Task ids that were canceled by this tick. */
  canceled: string[]
}

export async function enforceLimits(
  db: DbClient,
  now: number = Date.now(),
): Promise<EnforceLimitsResult> {
  const running = await db.select().from(tasks).where(eq(tasks.status, 'running'))
  const canceled: string[] = []

  for (const t of running) {
    const reason = await checkOne(db, t, now)
    if (reason === null) continue

    try {
      await cancelTask(db, t.id)
    } catch {
      // Already terminal between read and cancel; ignore.
    }
    // cancelTask sets a generic 'canceled by user' summary; overwrite with the
    // limit-specific reason so the UI surfaces it. RFC-097 (audit S-14): only
    // on rows where the cancel actually landed — a task that reached
    // done/failed between the scan and the cancel keeps its real terminal
    // message instead of being painted over with limit copy.
    await db
      .update(tasks)
      .set({ errorSummary: reason.summary, errorMessage: reason.message })
      .where(and(eq(tasks.id, t.id), eq(tasks.status, 'canceled')))
    canceled.push(t.id)
    log.warn('limit exceeded', { taskId: t.id, summary: reason.summary })
    // RFC-108 T3 (AR-11): durable audit of the resource-limit cancel.
    await recordRecoveryEvent(db, {
      taskId: t.id,
      kind: 'limit-cancel',
      reason: reason.summary,
      before: { status: 'running' },
      after: { status: 'canceled' },
      now,
    })
  }

  return { scanned: running.length, canceled }
}

async function checkOne(
  db: DbClient,
  t: typeof tasks.$inferSelect,
  now: number,
): Promise<{ summary: string; message: string } | null> {
  if (typeof t.maxDurationMs === 'number' && t.maxDurationMs > 0) {
    // RFC-207 §3.8 — the accumulated running time, NOT wall clock since creation:
    // a task that sat parked on a question for a week has not been "running" for a
    // week, and killing it the moment a human finally answers is the opposite of
    // what a duration limit is for.
    const elapsed = t.runningMs + (t.runningSince === null ? 0 : now - t.runningSince)
    if (elapsed > t.maxDurationMs) {
      return {
        summary: 'task-time-limit-exceeded',
        message: `task ran ${elapsed}ms, exceeding configured limit ${t.maxDurationMs}ms`,
      }
    }
  }
  if (typeof t.maxTotalTokens === 'number' && t.maxTotalTokens > 0) {
    const total = await sumTaskTokens(db, t.id)
    if (total > t.maxTotalTokens) {
      return {
        summary: 'task-token-limit-exceeded',
        message: `task consumed ${total} tokens, exceeding configured limit ${t.maxTotalTokens}`,
      }
    }
  }
  return null
}

async function sumTaskTokens(db: DbClient, taskId: string): Promise<number> {
  // Only count parent runs (fan-out children's tok_total is already mirrored
  // up into the parent by runFanOutNode aggregation in P-4-05).
  const rows = await db
    .select({ total: sql<number | null>`sum(${nodeRuns.tokTotal})` })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId)))
  const v = rows[0]?.total
  return typeof v === 'number' ? v : 0
}

/**
 * Convenience: start a 1Hz interval running enforceLimits against the given
 * db, returning a stopper. The daemon wires this in main.ts; tests call
 * enforceLimits directly.
 */
export function startLimitsTicker(db: DbClient, intervalMs: number = 1000): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    enforceLimits(db)
      .catch((err: unknown) => {
        log.error('enforceLimits failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return { stop: () => clearInterval(handle) }
}
