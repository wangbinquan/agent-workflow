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

import {
  fireSchedule,
  type BuildScheduleLaunch,
  type Row,
  type ScheduleAuthorityRuntime,
  type ScheduledTaskOperations,
} from '@/services/scheduledTasks'
import { createLogger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('scheduled-tasks')

export const SCHEDULE_TICK_MS = 30_000 // preset minute granularity is plenty; lighter than 1Hz
export const SCHEDULE_FIRE_CONCURRENCY = 4 // actual parallel launches
export const SCHEDULE_MAX_IN_FLIGHT = 32 // R2-a: dispatched-but-not-done cap = backlog bound
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10

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
export async function pollAndClaim(
  operations: ScheduledTaskOperations,
  now: number,
  limit: number,
): Promise<readonly Row[]> {
  return await operations.persistence.pollAndClaim({
    now,
    limit,
    decide(row) {
      try {
        return {
          kind: 'claim',
          nextRunAt: computeNextRunAt(
            ScheduleSpecSchema.parse(JSON.parse(row.scheduleSpec)),
            now,
            row.nextRunAt ?? now,
          ),
        }
      } catch (err) {
        return { kind: 'disable', error: `schedule-spec-invalid: ${msgOf(err)}` }
      }
    },
  })
}

/** Success: reset the streak (unconditional) + write display fields under the firedAt guard. */
async function recordSuccess(
  operations: ScheduledTaskOperations,
  id: string,
  taskId: string,
  firedAt: number,
): Promise<void> {
  await operations.persistence.recordSuccess({
    id,
    taskId,
    firedAt,
    recordedAt: Date.now(),
  })
}

/**
 * Failure: atomic `consecutive_failures + 1` and auto-disable in ONE statement
 * (SET reads OLD values, so `+1 >= max` matches the new count). `WHERE enabled=1
 * RETURNING enabled` makes the auto-disable fire exactly once — only the fire that
 * crosses the threshold sees enabled=1 → 0. Display fields are firedAt-guarded.
 */
async function recordFailure(
  operations: ScheduledTaskOperations,
  id: string,
  message: string,
  firedAt: number,
  maxFailures: number,
  onAutoDisable?: (id: string) => void,
): Promise<void> {
  const result = await operations.persistence.recordFailure({
    id,
    message,
    firedAt,
    maxFailures,
    recordedAt: Date.now(),
  })
  if (result.autoDisabled) onAutoDisable?.(id)
}

async function fireClaimed(
  operations: ScheduledTaskOperations,
  row: Row,
  buildLaunch: BuildScheduleLaunch,
  identityAccess: ScheduleAuthorityRuntime,
  maxFailures: number,
  onAutoDisable?: (id: string) => void,
  defaultRuntime?: string | null,
): Promise<void> {
  const firedAt = row.nextRunAt ?? Date.now() // the claimed slot (pre-advance)
  try {
    const { taskId } = await fireSchedule(
      operations,
      row,
      buildLaunch,
      Date.now(),
      identityAccess,
      { kind: 'automatic', occurrenceAt: firedAt },
      defaultRuntime,
    )
    await recordSuccess(operations, row.id, taskId, firedAt)
    scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
      type: 'scheduled.fired',
      id: row.id,
      ownerUserId: row.ownerUserId,
    })
  } catch (err) {
    await recordFailure(operations, row.id, msgOf(err), firedAt, maxFailures, onAutoDisable)
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
  operations: ScheduledTaskOperations,
  opts: {
    buildLaunch: BuildScheduleLaunch
    identityAccess: ScheduleAuthorityRuntime
    now?: number
    maxFailures?: number
    limit?: number
    onAutoDisable?: (id: string) => void
    defaultRuntime?: string | null
  },
): Promise<readonly Row[]> {
  const claimed = await pollAndClaim(
    operations,
    opts.now ?? Date.now(),
    opts.limit ?? SCHEDULE_MAX_IN_FLIGHT,
  )
  for (const row of claimed) {
    await fireClaimed(
      operations,
      row,
      opts.buildLaunch,
      opts.identityAccess,
      opts.maxFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      opts.onAutoDisable,
      opts.defaultRuntime,
    )
  }
  return claimed
}

/** Start the background ticker. Returns `{ stop }`. */
export function startScheduledTaskLoop(opts: {
  operations: ScheduledTaskOperations
  loadConfig: () => Config
  buildLaunch: BuildScheduleLaunch
  identityAccess: ScheduleAuthorityRuntime
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
      capacity === 0
        ? Promise.resolve([] as readonly Row[])
        : pollAndClaim(opts.operations, Date.now(), capacity)
    poll
      .then((claimed) => {
        for (const row of claimed) {
          inFlight++
          void sem
            .run(() =>
              fireClaimed(
                opts.operations,
                row,
                opts.buildLaunch,
                opts.identityAccess,
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
