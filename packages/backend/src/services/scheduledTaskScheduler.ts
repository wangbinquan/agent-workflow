// RFC-159 — scheduled-task background loop.
//
// Poll due rows → CAS-advance next_run_at (per-slot single-flight, at-most-once) →
// fire on a bounded-concurrency pool with a backpressure cap → record the outcome
// with atomic SQL. `running` guards only the fast poll+claim; fires run async so a
// slow/hung launch never stalls the poll cadence. See design.md §4 (R2-a bounded
// backlog, R2-c/R3-2 atomic counter + firedAt-guarded display, R4-1 no last_run_at
// write in the claim).
import type { Config } from '@agent-workflow/shared'
import { computeNextRunAt, ScheduleSpecSchema } from '@agent-workflow/shared'
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { scheduledTasks } from '@/db/schema'
import { fireSchedule, type BuildScheduleLaunch } from '@/services/scheduledTasks'
import { createLogger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('scheduled-tasks')

export const SCHEDULE_TICK_MS = 30_000 // preset minute granularity is plenty; lighter than 1Hz
export const SCHEDULE_FIRE_CONCURRENCY = 4 // actual parallel launches
export const SCHEDULE_MAX_IN_FLIGHT = 32 // R2-a: dispatched-but-not-done cap = backlog bound
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10

type Row = typeof scheduledTasks.$inferSelect

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * SELECT ≤`limit` due rows and CAS-advance each `next_run_at` to the next slot
 * strictly after `now` (the claim). A row whose `next_run_at` changed under us
 * (another tick raced) is dropped. Returns the rows we claimed (carrying their
 * pre-advance `next_run_at` = the fired slot). NEVER writes `last_run_at` here
 * (R4-1 — that would self-block the firedAt-guarded display writes).
 */
export async function pollAndClaim(db: DbClient, now: number, limit: number): Promise<Row[]> {
  if (limit <= 0) return []
  const due = await db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.enabled, true),
        isNotNull(scheduledTasks.nextRunAt),
        lte(scheduledTasks.nextRunAt, now),
      ),
    )
    .orderBy(asc(scheduledTasks.nextRunAt))
    .limit(limit)

  const claimed: Row[] = []
  for (const row of due) {
    if (row.nextRunAt === null) continue
    let next: number
    try {
      next = computeNextRunAt(
        ScheduleSpecSchema.parse(JSON.parse(row.scheduleSpec)),
        now,
        row.nextRunAt,
      )
    } catch (err) {
      // Corrupt / uncomputable spec — disable so we don't hot-loop on it.
      await db
        .update(scheduledTasks)
        .set({
          enabled: false,
          lastStatus: 'failed',
          lastError: `schedule-spec-invalid: ${msgOf(err)}`,
          updatedAt: now,
        })
        .where(eq(scheduledTasks.id, row.id))
      continue
    }
    const res = await db
      .update(scheduledTasks)
      .set({ nextRunAt: next, updatedAt: now })
      .where(
        and(
          eq(scheduledTasks.id, row.id),
          eq(scheduledTasks.nextRunAt, row.nextRunAt),
          eq(scheduledTasks.enabled, true),
        ),
      )
      .returning({ id: scheduledTasks.id })
    if (res.length > 0) claimed.push(row)
  }
  return claimed
}

/** Success: reset the streak (unconditional) + write display fields under the firedAt guard. */
async function recordSuccess(
  db: DbClient,
  id: string,
  taskId: string,
  firedAt: number,
): Promise<void> {
  const now = Date.now()
  await db
    .update(scheduledTasks)
    .set({ consecutiveFailures: 0, updatedAt: now })
    .where(eq(scheduledTasks.id, id))
  await db
    .update(scheduledTasks)
    .set({
      lastStatus: 'launched',
      lastError: null,
      lastTaskId: taskId,
      lastRunAt: firedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledTasks.id, id),
        sql`(${scheduledTasks.lastRunAt} IS NULL OR ${scheduledTasks.lastRunAt} <= ${firedAt})`,
      ),
    )
}

/**
 * Failure: atomic `consecutive_failures + 1` and auto-disable in ONE statement
 * (SET reads OLD values, so `+1 >= max` matches the new count). `WHERE enabled=1
 * RETURNING enabled` makes the auto-disable fire exactly once — only the fire that
 * crosses the threshold sees enabled=1 → 0. Display fields are firedAt-guarded.
 */
async function recordFailure(
  db: DbClient,
  id: string,
  message: string,
  firedAt: number,
  maxFailures: number,
  onAutoDisable?: (id: string) => void,
): Promise<void> {
  const now = Date.now()
  const res = await db
    .update(scheduledTasks)
    .set({
      consecutiveFailures: sql`${scheduledTasks.consecutiveFailures} + 1`,
      enabled: sql`CASE WHEN ${scheduledTasks.consecutiveFailures} + 1 >= ${maxFailures} THEN 0 ELSE ${scheduledTasks.enabled} END`,
      updatedAt: now,
    })
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.enabled, true)))
    .returning({ enabled: scheduledTasks.enabled })
  if (res.length > 0 && res[0]!.enabled === false) onAutoDisable?.(id)
  await db
    .update(scheduledTasks)
    .set({ lastStatus: 'failed', lastError: message, lastRunAt: firedAt, updatedAt: now })
    .where(
      and(
        eq(scheduledTasks.id, id),
        sql`(${scheduledTasks.lastRunAt} IS NULL OR ${scheduledTasks.lastRunAt} <= ${firedAt})`,
      ),
    )
}

async function fireClaimed(
  db: DbClient,
  row: Row,
  buildLaunch: BuildScheduleLaunch,
  maxFailures: number,
  onAutoDisable?: (id: string) => void,
  defaultRuntime?: string | null,
): Promise<void> {
  const firedAt = row.nextRunAt ?? Date.now() // the claimed slot (pre-advance)
  try {
    const { taskId } = await fireSchedule(db, row, buildLaunch, Date.now(), defaultRuntime)
    await recordSuccess(db, row.id, taskId, firedAt)
    scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
      type: 'scheduled.fired',
      id: row.id,
      ownerUserId: row.ownerUserId,
    })
  } catch (err) {
    await recordFailure(db, row.id, msgOf(err), firedAt, maxFailures, onAutoDisable)
    // A failure changed last_status (and possibly auto-disabled) — refresh the UI.
    scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
      type: 'scheduled.updated',
      id: row.id,
      ownerUserId: row.ownerUserId,
    })
  }
}

/** Deterministic single pass (poll+claim+fire, awaiting every fire). Used by tests + run-now. */
export async function runDueSchedulesOnce(
  db: DbClient,
  opts: {
    buildLaunch: BuildScheduleLaunch
    now?: number
    maxFailures?: number
    limit?: number
    onAutoDisable?: (id: string) => void
    defaultRuntime?: string | null
  },
): Promise<Row[]> {
  const claimed = await pollAndClaim(
    db,
    opts.now ?? Date.now(),
    opts.limit ?? SCHEDULE_MAX_IN_FLIGHT,
  )
  for (const row of claimed) {
    await fireClaimed(
      db,
      row,
      opts.buildLaunch,
      opts.maxFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      opts.onAutoDisable,
      opts.defaultRuntime,
    )
  }
  return claimed
}

/** Start the background ticker. Returns `{ stop }`. */
export function startScheduledTaskLoop(opts: {
  db: DbClient
  loadConfig: () => Config
  buildLaunch: BuildScheduleLaunch
  intervalMs?: number
  onAutoDisable?: (id: string) => void
}): { stop: () => void } {
  const sem = new Semaphore(SCHEDULE_FIRE_CONCURRENCY)
  let running = false
  let inFlight = 0
  const handle = setInterval(() => {
    if (running) return
    const cfg = opts.loadConfig()
    if (cfg.scheduledTasksEnabled === false) return // live master switch, read per tick
    running = true
    const capacity = Math.max(0, SCHEDULE_MAX_IN_FLIGHT - inFlight)
    const maxFailures = cfg.scheduledTasksMaxFailures
    const poll =
      capacity === 0 ? Promise.resolve([] as Row[]) : pollAndClaim(opts.db, Date.now(), capacity)
    poll
      .then((claimed) => {
        for (const row of claimed) {
          inFlight++
          void sem
            .run(() =>
              fireClaimed(
                opts.db,
                row,
                opts.buildLaunch,
                maxFailures,
                opts.onAutoDisable,
                cfg.defaultRuntime,
              ),
            )
            .finally(() => {
              inFlight--
            })
        }
      })
      .catch((err) => log.error('scheduled-task tick failed', { error: msgOf(err) }))
      .finally(() => {
        running = false
      })
  }, opts.intervalMs ?? SCHEDULE_TICK_MS)
  ;(handle as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(handle) }
}
