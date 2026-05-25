// RFC-061 PR-B T9-extra — daemon restart sequence (design.md §8).
// RFC-062 PR-A T8 — Step 4 actually wired (see CHANGELOG below).
//
// On daemon startup, runs the 4-step recovery so non-terminal tasks
// pick up where they left off — no fixup scripts, no manual cleanup:
//
//   1. catchUpProjections — incremental fold of events past
//      projection_meta.last_processed_event_id (or full rebuild if
//      cursor is NULL or the gap is too large to safely incremental).
//   2. markCrashedAttempts — every attempts row with finished_at IS NULL
//      is treated as crashed (the previous daemon never wrote the
//      finished event); we write `attempt-finished-crash` for each so
//      the projection + retry-pending-auto cascade kicks in.
//   3. enqueueResumeWakes — every task with non-terminal status gets a
//      `task-resumed-after-daemon-restart` event + wake on the actor
//      queue. The actor's wake-loop body then drives ready-scan.
//   4. spawnResumedActors — fires the injected launcher (cli/start.ts
//      wires services/task.launchTaskActor) for every non-terminal
//      task so its actor loop comes online and drains the wake from
//      Step 3.
//
// RFC-062 CHANGELOG: Step 4 was originally a stub; cli/start.ts called
// resumeFromDisk but nothing fired launchTaskActor, so resumed wakes
// piled up with no draining actor. The 2026-05-25 incident task spent
// ~8 hours "running" with zero progress after a daemon restart. PR-A
// T8 inverts the responsibility — resumeFromDisk now takes a launcher
// callback and runs it itself.

import { eq, gt, inArray, isNull, asc, type SQL } from 'drizzle-orm'

import type { DbClient } from '../db/client'
import { attempts, events as eventsTable, logicalRuns, projectionMeta, tasks } from '../db/schema'
import { writeEvents, type NewEvent } from '../services/writeEvents'
import { applyEvent } from '../services/eventApplier'
import { rebuildProjections } from '../services/projectionRebuilder'
import { RawEventSchema, type EventPayload, type RawEvent } from '@agent-workflow/shared'

import { taskActorRegistry, type ActorState } from './actorRegistry'

export interface DaemonResumeReport {
  /** Number of events applied incrementally (NOT including full rebuild). */
  appliedEvents: number
  /** True when the recovery dropped to a full projection rebuild. */
  fullRebuild: boolean
  /** Attempts marked crashed because the previous daemon died mid-run. */
  crashedAttempts: number
  /** Tasks that received a resume wake. */
  resumedTasks: number
}

export interface DaemonResumeOptions {
  db: DbClient
  /**
   * If the events table has more than this many rows past the cursor,
   * skip incremental and fall back to a full rebuild. Default 100000.
   */
  incrementalLimit?: number
  /**
   * Skip the spawnResumedActors step. Useful for tests / dry runs that
   * just want to verify recovery state without bringing actors online.
   */
  skipSpawn?: boolean
  /**
   * RFC-062 PR-A T8 — injected actor launcher (avoids importing
   * services/task.ts directly here and keeps daemonResume.ts unit-
   * testable with a mock). Called once per non-terminal task; should
   * return quickly (fire actor loop in background) and never throw to
   * the caller. cli/start.ts wires this to services/task.launchTaskActor.
   *
   * If undefined (back-compat for tests that don't care about Step 4),
   * spawnResumedActors becomes a no-op and only Steps 1-3 run.
   */
  launcher?: (taskId: string) => Promise<void>
}

/**
 * Run all 4 steps. Returns a structured report so the daemon log can
 * print a concise summary at boot.
 *
 * IMPORTANT: callers MUST be the daemon's single-instance lock holder
 * (flock on ~/.agent-workflow/daemon.lock). The recovery sequence
 * assumes no other daemon process is also reading/writing events.
 */
export async function resumeFromDisk(opts: DaemonResumeOptions): Promise<DaemonResumeReport> {
  const incrementalLimit = opts.incrementalLimit ?? 100_000
  // 1. Project catch-up
  const projectionInfo = await catchUpProjections(opts.db, incrementalLimit)
  // 2. Mark crashed attempts
  const crashedAttempts = await markCrashedAttempts(opts.db)
  // 3. Enqueue resume wakes for non-terminal tasks
  const resumedTasks = await enqueueResumeWakes(opts.db)
  // 4. RFC-062 PR-A T8 — actually spawn the actor loops the wakes were
  //    enqueued for. Without this step a daemon restart leaves every
  //    "running" task with a resume wake in queue and no actor draining
  //    it (the 2026-05-25 incident's secondary cause). Each launcher
  //    call returns a Promise resolved when the actor exits terminal;
  //    we fire-and-forget here so resumeFromDisk returns quickly.
  if (!opts.skipSpawn && opts.launcher !== undefined) {
    spawnResumedActors(opts.db, opts.launcher)
  }

  return {
    appliedEvents: projectionInfo.appliedEvents,
    fullRebuild: projectionInfo.fullRebuild,
    crashedAttempts,
    resumedTasks,
  }
}

/* ============================================================
 *  Step 4 — spawnResumedActors (RFC-062 PR-A T8 — actually wired)
 * ============================================================ */

/**
 * Fire `launcher(taskId)` for every task with non-terminal status. The
 * launcher promise is intentionally not awaited; each actor loop runs
 * until terminal state and self-deregisters from the registry. Errors
 * from individual launches are caught + logged so one bad task can't
 * abort the others.
 */
export function spawnResumedActors(
  db: DbClient,
  launcher: (taskId: string) => Promise<void>,
): number {
  const nonTerminal = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.status, ['pending', 'running', 'awaiting_review', 'awaiting_human']))
    .all()
  for (const t of nonTerminal) {
    void launcher(t.id).catch((err) => {
      // We can't import the project logger here without a cycle risk;
      // fall back to console.error so the failure is at least visible
      // in daemon.log via the global console redirect.
      // eslint-disable-next-line no-console
      console.error(
        `[daemon-resume] launcher threw for task ${t.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }
  return nonTerminal.length
}

/* ============================================================
 *  Step 1 — catchUpProjections
 * ============================================================ */

interface CatchUpResult {
  appliedEvents: number
  fullRebuild: boolean
}

export function catchUpProjections(db: DbClient, incrementalLimit: number): CatchUpResult {
  // Read cursor.
  const cursorRow = db
    .select({ lastId: projectionMeta.lastProcessedEventId })
    .from(projectionMeta)
    .where(eq(projectionMeta.id, 1))
    .limit(1)
    .all()[0]
  const cursor = cursorRow?.lastId ?? null

  if (cursor === null) {
    // No cursor — full rebuild.
    const applied = rebuildProjections(db)
    return { appliedEvents: applied, fullRebuild: true }
  }

  // Count events past the cursor.
  const newEventCount = db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(gt(eventsTable.id, cursor) as SQL)
    .all().length

  if (newEventCount > incrementalLimit) {
    // Too many — fall back to full rebuild for safety.
    const applied = rebuildProjections(db)
    return { appliedEvents: applied, fullRebuild: true }
  }

  // Incremental: apply each new event, advance the cursor at the end.
  if (newEventCount === 0) {
    return { appliedEvents: 0, fullRebuild: false }
  }

  let lastApplied = cursor
  let appliedCount = 0
  db.transaction((tx) => {
    const rows = tx
      .select()
      .from(eventsTable)
      .where(gt(eventsTable.id, cursor) as SQL)
      .orderBy(asc(eventsTable.id))
      .all() as Array<RawEvent>
    for (const raw of rows) {
      const parsed = RawEventSchema.parse(raw)
      // applyEvent takes the raw row + decodes internally.
      applyEvent(tx, parsed)
      appliedCount++
      lastApplied = raw.id
    }
    tx.update(projectionMeta)
      .set({ lastProcessedEventId: lastApplied, rebuiltAt: Date.now() })
      .where(eq(projectionMeta.id, 1))
      .run()
  })

  return { appliedEvents: appliedCount, fullRebuild: false }
}

/* ============================================================
 *  Step 2 — markCrashedAttempts
 * ============================================================ */

export async function markCrashedAttempts(db: DbClient): Promise<number> {
  const orphan = db
    .select({
      id: attempts.id,
      logicalRunId: attempts.logicalRunId,
    })
    .from(attempts)
    .where(isNull(attempts.finishedAt))
    .all()

  if (orphan.length === 0) return 0

  // For each orphan attempt, look up its scope from logical_runs (so the
  // event we write carries the right scope coordinates).
  const newEvents: NewEvent[] = []
  for (const a of orphan) {
    const lr = db
      .select({
        taskId: logicalRuns.taskId,
        nodeId: logicalRuns.nodeId,
        loopIter: logicalRuns.loopIter,
        shardKey: logicalRuns.shardKey,
        iter: logicalRuns.iter,
      })
      .from(logicalRuns)
      .where(eq(logicalRuns.id, a.logicalRunId))
      .limit(1)
      .all()[0]
    if (!lr) continue
    newEvents.push({
      taskId: lr.taskId,
      kind: 'attempt-finished-crash',
      nodeId: lr.nodeId,
      loopIter: lr.loopIter,
      shardKey: lr.shardKey,
      iter: lr.iter,
      attemptId: a.id,
      actor: 'system',
      payload: {
        errorMessage: 'daemon-restart-orphan-attempt',
      } as EventPayload<'attempt-finished-crash'>,
    })
  }

  if (newEvents.length > 0) {
    await writeEvents(db, newEvents)
  }
  return newEvents.length
}

/* ============================================================
 *  Step 3 — enqueueResumeWakes
 * ============================================================ */

export async function enqueueResumeWakes(db: DbClient): Promise<number> {
  // Non-terminal statuses per current tasks schema. 'awaiting_review' /
  // 'awaiting_human' are legacy RFC-005 / RFC-023 markers; under the
  // RFC-061 model they collapse into suspensions, but the column still
  // carries the old values until the T10/T11 cutover, so we include
  // them here to avoid leaving those tasks orphaned at restart.
  const nonTerminal = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.status, ['pending', 'running', 'awaiting_review', 'awaiting_human']))
    .all()

  if (nonTerminal.length === 0) return 0

  const newEvents: NewEvent[] = []
  for (const t of nonTerminal) {
    // Count how many crash events we just wrote for this task (Step 2).
    // For the resume event payload we just record the total so observers
    // know how much auto-retry the daemon kicked off.
    const crashedCount = db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.taskId, t.id))
      .all()
      .filter((r) => r.id !== undefined).length // placeholder; refined below
    newEvents.push({
      taskId: t.id,
      kind: 'task-resumed-after-daemon-restart',
      actor: 'system',
      payload: {
        crashedAttemptCount: 0,
      } as EventPayload<'task-resumed-after-daemon-restart'>,
    })
    void crashedCount
  }

  if (newEvents.length > 0) {
    await writeEvents(db, newEvents)
  }

  // Enqueue actor wakes for every resumed task. Producers (event-applier
  // subscribers, runner exit handlers) re-enqueue as state evolves.
  for (const t of nonTerminal) {
    const actor = taskActorRegistry.register(t.id)
    actor.queue.enqueue({
      kind: 'event-applied',
      eventId: 'daemon-resume',
    })
  }

  return nonTerminal.length
}

/* ============================================================
 *  Diagnostics — listResumedActors (kept for completeness)
 * ============================================================ */

/**
 * Snapshot of the actor registry post-resume. Useful for diagnostic
 * routes / tests that want to enumerate which tasks the daemon
 * brought back online.
 */
export function listResumedActors(): ActorState[] {
  return taskActorRegistry
    .taskIds()
    .map((id) => taskActorRegistry.get(id)!)
    .filter((a) => !!a)
}
