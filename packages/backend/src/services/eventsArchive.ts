// RFC-061 follow-up — events archival on the projection model.
//
// For every task whose status is terminal (done/failed/canceled/
// interrupted) AND whose finished_at is older than the archive cutoff
// (default 30 days), copy its rows from `events` into `events_archive`
// and then DELETE from `events`. The archive mirrors the column shape
// of `events` and adds `archived_at`; it has no kind CHECK or
// append-only trigger so future operator-side corrections + replays
// remain possible.
//
// services/timeline.ts falls back to the archive when the live events
// table has nothing for a task — operator-visible timelines for old
// terminal tasks stay continuous.
//
// The DELETE here is the ONLY legitimate `db.delete(events)` call site
// outside the projectionRebuilder; rfc061-grep-guards.test.ts
// allowlist treats it as such.

import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { events as eventsTable, eventsArchive, tasks } from '@/db/schema'
import { createLogger } from '@/util/log'

const log = createLogger('events-archive')

const DAY_MS = 86_400_000
const DEFAULT_CUTOFF_MS = 30 * DAY_MS
const HOUR_MS = 60 * 60 * 1000
const TERMINAL_STATUSES = ['done', 'failed', 'canceled', 'interrupted'] as const

export interface ArchiveRunResult {
  /** Number of tasks whose events moved to events_archive. */
  archivedTasks: number
  /** Total events rows moved this pass. */
  archivedRows: number
}

export interface ArchiveRunOptions {
  /** Override now for tests. */
  now?: () => number
  /** ms-old after finished_at before a terminal task's events archive. */
  cutoffMs?: number
  /** Hard cap on tasks processed per pass (back-pressure). */
  maxTasksPerPass?: number
}

/**
 * Archive one pass: find terminal tasks older than cutoff, move their
 * events to events_archive, then DELETE from events. Returns counters
 * for tests + the hourly logger.
 */
export async function archiveEvents(
  db: DbClient,
  opts: ArchiveRunOptions = {},
): Promise<ArchiveRunResult> {
  const now = (opts.now ?? Date.now)()
  const cutoffMs = opts.cutoffMs ?? DEFAULT_CUTOFF_MS
  const maxTasks = opts.maxTasksPerPass ?? 50
  const cutoffTs = now - cutoffMs

  const candidates = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...TERMINAL_STATUSES]),
        isNotNull(tasks.finishedAt),
        lt(tasks.finishedAt, cutoffTs),
      ),
    )
    .limit(maxTasks)

  if (candidates.length === 0) {
    return { archivedTasks: 0, archivedRows: 0 }
  }

  let archivedRows = 0
  for (const { id } of candidates) {
    archivedRows += await archiveOneTask(db, id, now)
  }
  if (archivedRows > 0) {
    log.info('archived events', {
      tasks: candidates.length,
      rows: archivedRows,
      cutoffTs,
    })
  }
  return { archivedTasks: candidates.length, archivedRows }
}

async function archiveOneTask(db: DbClient, taskId: string, now: number): Promise<number> {
  const rows = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.taskId, taskId))
    .orderBy(asc(eventsTable.ts), asc(eventsTable.id))
  if (rows.length === 0) return 0

  // batch insert into archive (composite PK on id stops duplicates).
  await db
    .insert(eventsArchive)
    .values(
      rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        ts: r.ts,
        kind: r.kind,
        nodeId: r.nodeId,
        loopIter: r.loopIter,
        shardKey: r.shardKey,
        iter: r.iter,
        attemptId: r.attemptId,
        parentEventId: r.parentEventId,
        actor: r.actor,
        resolutionId: r.resolutionId,
        payload: r.payload,
        archivedAt: now,
      })),
    )
    .onConflictDoNothing()

  // Delete from live events — legitimate INV-1 exception (kind=archive).
  await db.delete(eventsTable).where(eq(eventsTable.taskId, taskId))
  return rows.length
}

/**
 * Hourly tick wrapper used by cli/start.ts.
 */
export function startEventsArchiver(
  db: DbClient,
  intervalMs: number = HOUR_MS,
): { stop: () => void } {
  let running = false
  const safeRun = (): void => {
    if (running) return
    running = true
    void archiveEvents(db)
      .catch((err: unknown) => {
        // log-only: archive failures can't trigger their own alert (S?
        // unhealthy-archiver would be circular). Backups + operator
        // monitoring cover the hard-failure mode.
        log.error('archiveEvents failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }
  const handle = setInterval(safeRun, intervalMs)
  return { stop: () => clearInterval(handle) }
}

/**
 * Legacy read helper preserved as no-op for now. The on-disk JSONL
 * files from pre-RFC-061 days are not migrated.
 */
export async function readArchivedEvents(
  _logsDir: string,
  _taskId: string,
  _nodeRunId: string,
  _since: number,
  _limit: number,
): Promise<Array<{ id: number; ts: number; kind: string; payload: string }>> {
  return []
}
