// RFC-061 G9 — events timeline projection-native read.
//
// Pages over the events table for one task. Cursor is the raw event id
// (a ULID — lexicographically ordered so afterId works as a strict
// "greater than" pivot). `kindFilter` restricts to one EventKind for
// targeted views (e.g. a "show only suspension lifecycle" toggle).
//
// Replaces the legacy `/api/tasks/:id/node-runs/:nodeRunId/events`
// per-nodeRun stream for the use case of "show me everything that has
// happened on this task". The per-nodeRun endpoint still exists (via
// taskRunsProjection) and synthesises a legacy shape for the existing
// frontend; this endpoint is the projection-native shape the future
// /tasks/:id/timeline view will consume.

import { and, asc, eq, gt } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { events as eventsTable, eventsArchive, tasks } from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import { decodeEvent, type Event, RawEventSchema } from '@agent-workflow/shared'

export interface ListTaskTimelineOpts {
  afterId: string | null
  limit: number
  kindFilter: string | null
}

export interface TimelineResponse {
  events: Event[]
  /** Cursor for the next page; null when no more events. */
  cursor: string | null
}

export async function listTaskTimeline(
  db: DbClient,
  taskId: string,
  opts: ListTaskTimelineOpts,
): Promise<TimelineResponse> {
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  const conds = [eq(eventsTable.taskId, taskId)]
  if (opts.afterId !== null) conds.push(gt(eventsTable.id, opts.afterId))
  if (opts.kindFilter !== null) conds.push(eq(eventsTable.kind, opts.kindFilter as never))

  const rows = await db
    .select()
    .from(eventsTable)
    .where(and(...conds))
    .orderBy(asc(eventsTable.id))
    .limit(opts.limit)

  // RFC-061 follow-up — if the live events table has nothing (or fewer
  // rows than the limit), backfill from events_archive so timelines for
  // old terminal tasks stay continuous after archival.
  if (rows.length < opts.limit) {
    const archConds = [eq(eventsArchive.taskId, taskId)]
    if (opts.afterId !== null) archConds.push(gt(eventsArchive.id, opts.afterId))
    if (opts.kindFilter !== null) archConds.push(eq(eventsArchive.kind, opts.kindFilter))
    const archRows = await db
      .select()
      .from(eventsArchive)
      .where(and(...archConds))
      .orderBy(asc(eventsArchive.id))
      .limit(opts.limit - rows.length)
    rows.push(
      ...archRows.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        ts: a.ts,
        kind: a.kind as (typeof eventsTable.$inferSelect)['kind'],
        nodeId: a.nodeId,
        loopIter: a.loopIter,
        shardKey: a.shardKey,
        iter: a.iter,
        attemptId: a.attemptId,
        parentEventId: a.parentEventId,
        actor: a.actor,
        resolutionId: a.resolutionId,
        payload: a.payload,
      })),
    )
  }

  const decoded: Event[] = rows.map((r) => decodeEvent(RawEventSchema.parse(r)))
  const cursor =
    decoded.length === opts.limit && decoded.length > 0
      ? (decoded[decoded.length - 1]?.id ?? null)
      : null
  return { events: decoded, cursor }
}
