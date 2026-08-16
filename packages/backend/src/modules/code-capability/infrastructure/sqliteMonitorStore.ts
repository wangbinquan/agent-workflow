// RFC-304 T36 — the rows a wake-up creates: work item, round, observation.
//
// PR-1a built the work item and round TABLES and the lifecycle that moves them;
// nothing has ever written the first row of either. The wake path launched a
// `code-round` task with a hardcoded `roundSeq: 1` and no work item at all, so
// "round 2 of this merge request" was not a thing the database could represent.
// This file is that join.
//
// ## Identity, and why the insert races rather than checks
//
// A work item is identified by (endpoint, project, capability, anchorKind,
// anchorId) — the unique index the schema already declares. Two events on the
// same merge request arriving together is the NORMAL case (a push produces
// `mr_updated` and a pipeline event within the same second), so "select, and
// insert if absent" would lose that race regularly and violate the index. The
// insert is therefore unconditional with `onConflictDoNothing`, followed by a
// read: the loser of the race gets the winner's row, which is the correct
// answer rather than an error.

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeWorkItems, codeWorkObservations, codeWorkRounds } from '@/db/schema'

/** The five columns that identify a work item. */
export interface WorkItemIdentity {
  codeHostEndpointId: string
  stableProjectId: string
  capability: string
  anchorKind: 'mr' | 'issue' | 'pipeline'
  anchorId: string
}

export interface EnsureWorkItemArgs extends WorkItemIdentity {
  db: DbClient
  /** Display snapshot (title, URL, author) — refreshed, never identity. */
  anchorMeta?: Record<string, unknown>
  /** Who this work is on behalf of; only set at creation. */
  initiatorUserId?: string | null
  now?: number
}

export interface EnsuredWorkItem {
  id: string
  /** False when another writer created it first, or it already existed. */
  created: boolean
  status: string
  epoch: number
}

/**
 * Find or create the work item for this anchor.
 *
 * Never returns a NEW item for an anchor that already has one, including under
 * concurrent wake-ups — that is what the unique index is for, and this function
 * is written to lose the race gracefully rather than to avoid it.
 */
export async function ensureWorkItem(args: EnsureWorkItemArgs): Promise<EnsuredWorkItem> {
  const now = args.now ?? Date.now()
  const id = ulid()

  const inserted = await args.db
    .insert(codeWorkItems)
    .values({
      id,
      codeHostEndpointId: args.codeHostEndpointId,
      stableProjectId: args.stableProjectId,
      capability: args.capability,
      anchorKind: args.anchorKind,
      anchorId: args.anchorId,
      status: 'idle',
      ...(args.anchorMeta === undefined ? {} : { anchorMeta: JSON.stringify(args.anchorMeta) }),
      ...(args.initiatorUserId === undefined || args.initiatorUserId === null
        ? {}
        : { initiatorUserId: args.initiatorUserId }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: codeWorkItems.id })

  const [row] = await args.db
    .select({
      id: codeWorkItems.id,
      status: codeWorkItems.status,
      epoch: codeWorkItems.epoch,
    })
    .from(codeWorkItems)
    .where(
      and(
        eq(codeWorkItems.codeHostEndpointId, args.codeHostEndpointId),
        eq(codeWorkItems.stableProjectId, args.stableProjectId),
        eq(codeWorkItems.capability, args.capability),
        eq(codeWorkItems.anchorKind, args.anchorKind),
        eq(codeWorkItems.anchorId, args.anchorId),
      ),
    )
    .limit(1)

  if (row === undefined) {
    // The insert was swallowed by a conflict AND the row is not there — only
    // possible if someone deleted it between the two statements. Reporting it
    // beats returning a fabricated id that no later write will match.
    throw new Error(
      `work item for ${args.capability} on ${args.anchorKind}/${args.anchorId} vanished during creation`,
    )
  }

  // Refresh the display snapshot on every wake: a merge request's title and
  // author change, and a stale title in the activity view is the kind of wrong
  // that makes people distrust the rest of the row.
  if (args.anchorMeta !== undefined && inserted.length === 0) {
    await args.db
      .update(codeWorkItems)
      .set({ anchorMeta: JSON.stringify(args.anchorMeta), updatedAt: now })
      .where(eq(codeWorkItems.id, row.id))
  }

  return { id: row.id, created: inserted.length > 0, status: row.status, epoch: row.epoch }
}

export interface OpenRoundArgs {
  db: DbClient
  workItemId: string
  epoch: number
  /** What this round will do; stored so the round stays replayable. */
  workPackage?: unknown
  baselineSha?: string | null
  stageContractVer?: number
  templateSnapshot?: unknown
  now?: number
}

export interface OpenedRound {
  roundId: string
  roundSeq: number
}

/**
 * Allocate the next round of a work item.
 *
 * `roundSeq` comes from `MAX(round_seq) + 1` computed INSIDE the insert, so two
 * concurrent openers cannot both read 2 and then both write 2. The unique index
 * on (work_item_id, round_seq) is the backstop: the loser's insert throws
 * rather than silently overwriting the winner's round.
 */
export async function openRound(args: OpenRoundArgs): Promise<OpenedRound> {
  const now = args.now ?? Date.now()
  const roundId = ulid()

  const [inserted] = await args.db
    .insert(codeWorkRounds)
    .values({
      id: roundId,
      workItemId: args.workItemId,
      roundSeq: sql`(SELECT COALESCE(MAX(round_seq), 0) + 1 FROM code_work_rounds WHERE work_item_id = ${args.workItemId})`,
      epoch: args.epoch,
      ...(args.baselineSha === undefined || args.baselineSha === null
        ? {}
        : { baselineSha: args.baselineSha }),
      ...(args.workPackage === undefined ? {} : { workPackage: JSON.stringify(args.workPackage) }),
      ...(args.templateSnapshot === undefined
        ? {}
        : { templateSnapshot: JSON.stringify(args.templateSnapshot) }),
      ...(args.stageContractVer === undefined ? {} : { stageContractVer: args.stageContractVer }),
      startedAt: now,
    })
    .returning({ id: codeWorkRounds.id, roundSeq: codeWorkRounds.roundSeq })

  if (inserted === undefined) throw new Error('failed to open a round')
  return { roundId: inserted.id, roundSeq: inserted.roundSeq }
}

/**
 * Write a round's terminal outcome.
 *
 * The counterpart to `openRound`, and it was missing: rounds were inserted and
 * only ever updated to attach a task id, so every round stayed `running`
 * forever — including the ones whose thirteen stages had all finished and whose
 * review was already on the merge request.
 *
 * Nothing errored, which is why it survived. What it cost was every reader:
 * `deriveRoundStatus` had no terminal state to derive, the state view showed
 * perpetual spinners, `codeMetricsQuery` — which already branches on
 * `published` / `failed` / `awaiting` — counted every round as in-flight, and
 * the data-lifetime GC found nothing old enough to collect. The whole
 * vocabulary existed on the reading side, waiting for a writer.
 *
 * Idempotent by the `endedAt IS NULL` guard: a retried finalisation must not
 * move the end time, and the FIRST terminal answer is the true one.
 */
export async function closeRound(
  db: DbClient,
  roundId: string,
  outcome: 'published' | 'awaiting' | 'failed' | 'canceled' | 'superseded',
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(codeWorkRounds)
    .set({ outcome, endedAt: now })
    .where(and(eq(codeWorkRounds.id, roundId), isNull(codeWorkRounds.endedAt)))
}

/** Point the work item at the round now in flight. */
export async function attachRoundTask(
  db: DbClient,
  roundId: string,
  taskId: string,
): Promise<void> {
  await db.update(codeWorkRounds).set({ taskId }).where(eq(codeWorkRounds.id, roundId))
}

export type ObservationKind = 'noop' | 'dispatched' | 'conflict' | 'blocked'

export interface RecordObservationArgs {
  db: DbClient
  workItemId: string
  kind: ObservationKind
  /** The department's own words where there are any; never paraphrased. */
  reason: string
  observedRevision?: string | null
  causationId?: string | null
  /** The ingress event this answers. Claiming it is what makes T10e durable. */
  eventId?: string | null
  now?: number
}

export type RecordObservationResult =
  | { recorded: true; id: string }
  /** Another capability already claimed this event (T10e). */
  | { recorded: false; reason: 'event-already-claimed' }

/**
 * Write down what this wake-up concluded.
 *
 * Returns `event-already-claimed` rather than throwing when the unique index on
 * `event_id` rejects the row: that is not an error, it is the T10e rule working
 * — the same note must not both trigger a review and wake the monitor into a
 * second, independent reaction.
 */
export async function recordObservation(
  args: RecordObservationArgs,
): Promise<RecordObservationResult> {
  const now = args.now ?? Date.now()
  const id = ulid()
  const inserted = await args.db
    .insert(codeWorkObservations)
    .values({
      id,
      workItemId: args.workItemId,
      kind: args.kind,
      reason: args.reason,
      ...(args.observedRevision === undefined || args.observedRevision === null
        ? {}
        : { observedRevision: args.observedRevision }),
      ...(args.causationId === undefined || args.causationId === null
        ? {}
        : { causationId: args.causationId }),
      ...(args.eventId === undefined || args.eventId === null ? {} : { eventId: args.eventId }),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: codeWorkObservations.id })

  if (inserted.length === 0) return { recorded: false, reason: 'event-already-claimed' }
  return { recorded: true, id }
}

export interface ObservationRow {
  id: string
  kind: string
  reason: string
  observedRevision: string | null
  createdAt: number
}

/** The most recent conclusions, newest first — the activity view's source. */
export async function readObservations(
  db: DbClient,
  workItemId: string,
  limit = 20,
): Promise<ObservationRow[]> {
  const rows = await db
    .select({
      id: codeWorkObservations.id,
      kind: codeWorkObservations.kind,
      reason: codeWorkObservations.reason,
      observedRevision: codeWorkObservations.observedRevision,
      createdAt: codeWorkObservations.createdAt,
    })
    .from(codeWorkObservations)
    .where(eq(codeWorkObservations.workItemId, workItemId))
    .orderBy(desc(codeWorkObservations.createdAt), desc(codeWorkObservations.id))
    .limit(limit)
  return rows
}

/**
 * Has this revision already been reported as conflicted?
 *
 * A conflicted merge request keeps producing events — comments, pipeline runs,
 * other people's pushes — for as long as it sits there. Reporting on each would
 * be the noise storm §11.1 warns about, and a muted bot loses the reports that
 * matter. One report per REVISION: the author pushing again is new information
 * and earns a new report; everything else does not.
 */
export async function hasReportedConflict(
  db: DbClient,
  workItemId: string,
  revision: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: codeWorkObservations.id })
    .from(codeWorkObservations)
    .where(
      and(
        eq(codeWorkObservations.workItemId, workItemId),
        eq(codeWorkObservations.kind, 'conflict'),
        eq(codeWorkObservations.observedRevision, revision),
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Close a work item for good (T40).
 *
 * Unconditional on the current status, unlike every other transition here: a
 * merged or closed merge request is an external fact, and an item stuck in
 * `running` because a round died must not stay open forever because of it.
 */
export async function closeWorkItem(
  db: DbClient,
  workItemId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(codeWorkItems)
    .set({ status: 'closed', closedAt: now, updatedAt: now, currentRoundId: null })
    .where(eq(codeWorkItems.id, workItemId))
}

/** Is this work item finished, so that later events must not open rounds? */
export async function isWorkItemClosed(db: DbClient, workItemId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: codeWorkItems.status })
    .from(codeWorkItems)
    .where(eq(codeWorkItems.id, workItemId))
    .limit(1)
  return row?.status === 'closed'
}
