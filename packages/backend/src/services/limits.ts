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

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { events as eventsTable, tasks } from '@/db/schema'
import { cancelTask } from '@/services/task'
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
    // limit-specific reason so the UI surfaces it.
    await db
      .update(tasks)
      .set({ errorSummary: reason.summary, errorMessage: reason.message })
      .where(eq(tasks.id, t.id))
    canceled.push(t.id)
    log.warn('limit exceeded', { taskId: t.id, summary: reason.summary })
  }

  return { scanned: running.length, canceled }
}

async function checkOne(
  db: DbClient,
  t: typeof tasks.$inferSelect,
  now: number,
): Promise<{ summary: string; message: string } | null> {
  if (typeof t.maxDurationMs === 'number' && t.maxDurationMs > 0) {
    const elapsed = now - t.startedAt
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

/**
 * Sum every attempt-token-usage event's `total` field for one task.
 * RFC-061 follow-up restored token-limit enforcement: the projection
 * events table is authoritative now that node_runs.tok_total is gone.
 *
 * Events whose payload doesn't parse or whose .total is missing
 * contribute 0 (a malformed event must NEVER credit a task with
 * negative or NaN tokens).
 */
async function sumTaskTokens(db: DbClient, taskId: string): Promise<number> {
  const rows = await db
    .select({ payload: eventsTable.payload })
    .from(eventsTable)
    .where(and(eq(eventsTable.taskId, taskId), eq(eventsTable.kind, 'attempt-token-usage')))
  let total = 0
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { total?: unknown }
      if (typeof p.total === 'number' && Number.isFinite(p.total) && p.total >= 0) {
        total += p.total
      }
    } catch {
      // skip malformed
    }
  }
  return total
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
