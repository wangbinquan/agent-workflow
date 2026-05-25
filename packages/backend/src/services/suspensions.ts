// RFC-061 follow-up — read + resolve helpers for the suspensions projection.
//
// Powers the rebuild of clarify / review UX without going through the
// legacy services/clarify or services/review modules (deleted). The
// frontend rebuild calls:
//   GET /api/tasks/:id/suspensions          → list open suspensions
//   GET /api/suspensions/:id                → fetch one
//   POST /api/suspensions/:id/resolve       → submit a resolution payload
//                                              (delegated to SignalKindHandler)

import { and, asc, eq, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { logicalRuns, suspensions } from '@/db/schema'
import { writeEvents } from '@/services/writeEvents'
import { loadTaskEvents } from '@/scheduler-v2/taskActor'
import { SIGNAL_KIND_HANDLERS } from '@/handlers/signalKind'
import { NotFoundError, ValidationError } from '@/util/errors'
import type { Scope, SignalKind, Event } from '@agent-workflow/shared'

export interface SuspensionRow {
  id: string
  taskId: string
  nodeRunId: string
  scope: Scope
  signalKind: SignalKind
  awaitsActor: string
  /** Parsed JSON body the SignalKind handler emitted at onSuspend time. */
  body: unknown
  createdAt: number
  resolvedAt: number | null
  resolvedByEventId: string | null
}

/**
 * List suspensions for a task. `openOnly` (default true) filters out
 * resolved/terminated rows.
 */
export async function listTaskSuspensions(
  db: DbClient,
  taskId: string,
  opts: { openOnly?: boolean } = {},
): Promise<SuspensionRow[]> {
  const openOnly = opts.openOnly !== false
  const rows = await db
    .select({
      id: suspensions.id,
      logicalRunId: suspensions.logicalRunId,
      signalKind: suspensions.signalKind,
      awaitsActor: suspensions.awaitsActor,
      payload: suspensions.payload,
      createdAt: suspensions.createdAt,
      resolvedAt: suspensions.resolvedAt,
      resolvedByEventId: suspensions.resolvedByEventId,
      lrTaskId: logicalRuns.taskId,
      lrNodeId: logicalRuns.nodeId,
      lrLoopIter: logicalRuns.loopIter,
      lrShardKey: logicalRuns.shardKey,
      lrIter: logicalRuns.iter,
    })
    .from(suspensions)
    .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
    .where(
      openOnly
        ? and(eq(logicalRuns.taskId, taskId), isNull(suspensions.resolvedAt))
        : eq(logicalRuns.taskId, taskId),
    )
    .orderBy(asc(suspensions.createdAt), asc(suspensions.id))
  return rows.map(rowToSuspension)
}

/**
 * List suspensions across every task. Powers the global inbox view.
 * Always filters to `openOnly` (no use case for the all-tasks list of
 * historic rows yet). Optional signalKind filter narrows to clarify-
 * only or review-only inboxes.
 */
export async function listAllOpenSuspensions(
  db: DbClient,
  opts: { signalKind?: SignalKind; limit?: number } = {},
): Promise<SuspensionRow[]> {
  const conds = [isNull(suspensions.resolvedAt)]
  if (opts.signalKind !== undefined) {
    conds.push(eq(suspensions.signalKind, opts.signalKind))
  }
  const limit = Math.min(opts.limit ?? 200, 500)
  const rows = await db
    .select({
      id: suspensions.id,
      logicalRunId: suspensions.logicalRunId,
      signalKind: suspensions.signalKind,
      awaitsActor: suspensions.awaitsActor,
      payload: suspensions.payload,
      createdAt: suspensions.createdAt,
      resolvedAt: suspensions.resolvedAt,
      resolvedByEventId: suspensions.resolvedByEventId,
      lrTaskId: logicalRuns.taskId,
      lrNodeId: logicalRuns.nodeId,
      lrLoopIter: logicalRuns.loopIter,
      lrShardKey: logicalRuns.shardKey,
      lrIter: logicalRuns.iter,
    })
    .from(suspensions)
    .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
    .where(and(...conds))
    .orderBy(asc(suspensions.createdAt), asc(suspensions.id))
    .limit(limit)
  return rows.map(rowToSuspension)
}

function rowToSuspension(r: {
  id: string
  logicalRunId: string
  signalKind: string
  awaitsActor: string
  payload: string
  createdAt: number
  resolvedAt: number | null
  resolvedByEventId: string | null
  lrTaskId: string
  lrNodeId: string
  lrLoopIter: number
  lrShardKey: string
  lrIter: number
}): SuspensionRow {
  return {
    id: r.id,
    taskId: r.lrTaskId,
    nodeRunId: r.logicalRunId,
    scope: {
      nodeId: r.lrNodeId,
      loopIter: r.lrLoopIter,
      shardKey: r.lrShardKey,
      iter: r.lrIter,
    },
    signalKind: r.signalKind as SignalKind,
    awaitsActor: r.awaitsActor,
    body: safeJsonParse(r.payload),
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    resolvedByEventId: r.resolvedByEventId,
  }
}

export async function getSuspensionById(
  db: DbClient,
  suspensionId: string,
): Promise<SuspensionRow> {
  const rows = await db
    .select({
      id: suspensions.id,
      logicalRunId: suspensions.logicalRunId,
      signalKind: suspensions.signalKind,
      awaitsActor: suspensions.awaitsActor,
      payload: suspensions.payload,
      createdAt: suspensions.createdAt,
      resolvedAt: suspensions.resolvedAt,
      resolvedByEventId: suspensions.resolvedByEventId,
      lrTaskId: logicalRuns.taskId,
      lrNodeId: logicalRuns.nodeId,
      lrLoopIter: logicalRuns.loopIter,
      lrShardKey: logicalRuns.shardKey,
      lrIter: logicalRuns.iter,
    })
    .from(suspensions)
    .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
    .where(eq(suspensions.id, suspensionId))
    .limit(1)
  const r = rows[0]
  if (r === undefined) {
    throw new NotFoundError('suspension-not-found', `suspension '${suspensionId}' not found`)
  }
  return rowToSuspension(r)
}

/**
 * Submit a resolution payload for an open suspension. Validates via the
 * matching SignalKindHandler, then calls its applyResolution to produce
 * the events that close + cascade. The events are written through
 * writeEvents so the projection stays in lockstep.
 *
 * Throws:
 *   - NotFoundError       suspension id does not exist
 *   - ValidationError     resolution payload fails handler validation
 *                         or the suspension is already resolved
 */
export async function resolveSuspension(
  db: DbClient,
  suspensionId: string,
  resolutionPayload: unknown,
): Promise<{ writtenEventIds: string[]; signalKind: SignalKind }> {
  const susp = await getSuspensionById(db, suspensionId)
  if (susp.resolvedAt !== null) {
    throw new ValidationError(
      'suspension-already-resolved',
      `suspension '${suspensionId}' was resolved at ts=${susp.resolvedAt}`,
    )
  }
  const handler = SIGNAL_KIND_HANDLERS[susp.signalKind]
  const valid = handler.validateResolution(resolutionPayload)
  if (!valid.valid) {
    throw new ValidationError(
      'suspension-resolution-invalid',
      valid.reason ?? 'resolution payload failed handler validation',
    )
  }
  const events = await loadTaskEvents(db, susp.taskId)
  const newEvents = (await handler.applyResolution(
    {
      scope: susp.scope,
      suspensionId,
      events,
    },
    resolutionPayload,
  )) as ReadonlyArray<Event>
  if (newEvents.length === 0) {
    return { writtenEventIds: [], signalKind: susp.signalKind }
  }
  const written = await writeEvents(
    db,
    newEvents.map((e) => ({
      taskId: e.taskId,
      kind: e.kind,
      payload: e.payload,
      actor: e.actor,
      nodeId: e.nodeId ?? null,
      loopIter: e.loopIter ?? null,
      shardKey: e.shardKey ?? null,
      iter: e.iter ?? null,
      attemptId: e.attemptId ?? null,
      parentEventId: e.parentEventId ?? null,
      resolutionId: e.resolutionId ?? null,
    })),
  )
  return {
    writtenEventIds: written.map((e) => e.id),
    signalKind: susp.signalKind,
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
