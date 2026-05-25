// RFC-061 PR-A T3 — single-writer entry to the events table.
//
// ALL writes to the events table flow through writeEvents(). Grep guard
// (PR-D) enforces this by rejecting any `db.insert(events)` reference
// outside this file. writeEvents() also drives the event-applier in
// the same transaction so the projections never lag behind the event log.
//
// **Sync transaction body.** drizzle's bun-sqlite transaction wrapper is
// itself synchronous — it calls the callback once and COMMITs as soon as
// the callback returns. An async callback returns a Promise immediately,
// the wrapper sees no throw, COMMITs, then any post-yield microtask runs
// AFTER the transaction is already committed. So the tx body uses sync
// drizzle queries (.run() / .all() / .get()) and the applier is sync. The
// outer writeEvents function returns a Promise only for API consistency
// (callers may want to log id/ts asynchronously after the sync commit).

import { monotonicFactory } from 'ulid'

import { type DbClient } from '../db/client'
import { events, projectionMeta } from '../db/schema'
import {
  decodeEvent,
  type Event,
  type EventKind,
  type EventPayload,
  type RawEvent,
  encodeEventPayload,
} from '@agent-workflow/shared'

import { applyEvent } from './eventApplier'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

// Monotonic ULID factory — ULIDs from the same millisecond increment a
// counter rather than re-randomize. This guarantees that ordering events
// by id alone reproduces insertion order, which is essential for the
// projection rebuilder. Tests that batch many events into Date.now() ==
// equal-ms windows otherwise see rebuild apply events out of order.
const ulid = monotonicFactory()

/**
 * What callers supply to writeEvents. id + ts are auto-minted when omitted;
 * scope fields default to null (the caller is responsible for setting them
 * for non-task-level events).
 */
export interface NewEvent<K extends EventKind = EventKind> {
  taskId: string
  kind: K
  payload: EventPayload<K>
  nodeId?: string | null
  loopIter?: number | null
  shardKey?: string | null
  iter?: number | null
  attemptId?: string | null
  parentEventId?: string | null
  actor: string
  resolutionId?: string | null
  /** Defaults to Date.now(); pass explicit ts only in tests / replay. */
  ts?: number
  /** Defaults to a fresh ULID; pass explicit id only in tests / replay. */
  id?: string
}

function toRawEvent<K extends EventKind>(input: NewEvent<K>, ts: number): RawEvent {
  return {
    id: input.id ?? ulid(),
    taskId: input.taskId,
    ts: input.ts ?? ts,
    kind: input.kind,
    nodeId: input.nodeId ?? null,
    loopIter: input.loopIter ?? null,
    shardKey: input.shardKey ?? null,
    iter: input.iter ?? null,
    attemptId: input.attemptId ?? null,
    parentEventId: input.parentEventId ?? null,
    actor: input.actor,
    resolutionId: input.resolutionId ?? null,
    payload: encodeEventPayload(input.kind, input.payload),
  }
}

/**
 * Insert a batch of events. Each event is validated by its EventKind's
 * payload Zod schema (via encodeEventPayload), then inserted into `events`,
 * then applied to the projections in batch order. Finally the
 * projection_meta cursor is advanced to the last event's id.
 *
 * Returns the decoded events (with typed payloads), so callers that need
 * the assigned id / ts can use them downstream.
 *
 * Transactional semantics: the whole batch (events INSERT + projection
 * updates + cursor advance) is wrapped in a single sync transaction. Any
 * applier failure rolls back ALL events in the batch — the events table
 * never contains a row whose projection update silently failed.
 */
export async function writeEvents<K extends EventKind>(
  db: DbClient,
  newEvents: ReadonlyArray<NewEvent<K>>,
): Promise<ReadonlyArray<Event>> {
  if (newEvents.length === 0) return []

  // ts within a batch advances by 1ms per event so the (ts, id) index
  // also reflects insertion order, not just id alone.
  const baseNow = Date.now()
  const rawEvents: RawEvent[] = newEvents.map((e, i) => toRawEvent(e, baseNow + i))

  // SYNC transaction — see file header for why we can't use async here.
  db.transaction((tx) => {
    // 1. Validate (encodeEventPayload throws on schema failure) — already
    //    done by toRawEvent above. Insert all events in one batch.
    tx.insert(events)
      .values(
        rawEvents.map((r) => ({
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
        })),
      )
      .run()

    // 2. Apply each in order; an applier exception rolls the tx back.
    for (const r of rawEvents) {
      applyEvent(tx, r)
    }

    // 3. Advance the projection cursor to the last event's id.
    const lastId = rawEvents[rawEvents.length - 1]!.id
    const cursorTs = rawEvents[rawEvents.length - 1]!.ts
    tx.insert(projectionMeta)
      .values({ id: 1, lastProcessedEventId: lastId, rebuiltAt: cursorTs })
      .onConflictDoUpdate({
        target: projectionMeta.id,
        set: { lastProcessedEventId: lastId, rebuiltAt: cursorTs },
      })
      .run()
  })

  // RFC-061 follow-up — after commit, fan out one task.event.appended
  // frame per event so WS subscribers see the live timeline. The
  // broadcaster is fire-and-forget; a slow consumer can never delay
  // event writes (the writeEvents call already returned to its caller
  // synchronously after commit).
  for (const r of rawEvents) {
    try {
      taskBroadcaster.broadcast(TASK_CHANNEL(r.taskId), {
        type: 'task.event.appended',
        eventId: r.id,
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
      })
    } catch {
      // Broadcaster failures must not corrupt the events table; they
      // already committed. Drop the frame silently; clients can recover
      // via REST polling on /api/tasks/:id/timeline.
    }
  }

  return rawEvents.map(decodeEvent)
}

/**
 * Convenience for a single event. Identical to writeEvents([one])[0].
 */
export async function writeEvent<K extends EventKind>(
  db: DbClient,
  newEvent: NewEvent<K>,
): Promise<Event> {
  const [written] = await writeEvents(db, [newEvent])
  return written!
}
