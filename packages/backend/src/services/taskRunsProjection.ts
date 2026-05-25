// RFC-061 PR-B (cleanup) — projection-based read shims for the
// /api/tasks/:id/node-runs* family.
//
// After PR-B the actor writes ONLY to events/logical_runs/attempts/
// node_outputs/suspensions. The legacy nodeRuns / nodeRunOutputs /
// nodeRunEvents tables receive no actor writes, so the legacy
// `getTaskNodeRuns` family in services/task.ts returned empty data for
// every task driven by the actor. This module synthesises the legacy
// `NodeRun` / `NodeRunOutput` / `NodeRunEvent` shapes from the new
// projection so the existing frontend canvas (tasks.detail) keeps
// working without a full DTO rewrite (deferred to Phase 6).
//
// Compromises documented inline:
//   - retryIndex synthesised from attempt_seq (legacy retryIndex was
//     identical semantically — number of failed sibling attempts).
//   - reviewIteration / clarifyIteration / crossClarifyIteration are
//     all collapsed into `iter` per RFC-061 G2, so we surface 0 for
//     each (kept on the schema to preserve the wire contract). Frontend
//     code that conditionally renders chips from these counters will
//     simply not render them — acceptable UX shedding until Phase 6.
//   - parentNodeRunId: fanout shard linkage is recoverable from
//     scope (shardKey != '') but the legacy frontend grouping logic
//     joined on parentNodeRunId. We surface null for now; SubProcessList
//     groups by nodeId+shardKey instead.
//   - promptText / tokInput / tokOutput / token-cache fields / injected
//     memories / port validation failures: not yet captured in
//     projection events. Surfaced as null. (Token usage IS captured by
//     the runner per `RunOpencodeAttemptResult.tokenUsage` but not yet
//     emitted as an event — separate cleanup PR.)
//
// The shim intentionally has no fallback to legacy tables; if the
// projection is empty, the response is empty.
//
// `getNodeRunEvents` / `getNodeRunStdout` return what little is
// captured in the new events table (attempt-subagent-* + attempt
// lifecycle events). The legacy fine-grained main-agent stream
// (tool_use / text / reasoning) is not yet captured — the events
// drawer will be sparser until that's wired (Phase 6).

import { asc, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  attempts,
  events as eventsTable,
  logicalRuns,
  nodeOutputs,
  suspensions,
  tasks,
} from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import type {
  NodeRun,
  NodeRunEvent,
  NodeRunEventsResponse,
  NodeRunOutput,
  NodeRunStatus,
  TaskNodeRuns,
} from '@agent-workflow/shared'

/**
 * Map projection `logical_runs.status` (closed enum) + open-suspension
 * `signal_kind` to the legacy `NodeRunStatus` (broader enum). Done /
 * failed / canceled / running / pending pass through unchanged; the
 * 'suspended' state fans into 'awaiting_review' / 'awaiting_human'
 * depending on which SignalKind the open suspension carries.
 *
 * If we ever see `suspended` with no matching open suspension row, fall
 * back to 'pending' (the actor is between bumps; the next wake will
 * progress it).
 */
function mapStatus(
  lrStatus: typeof logicalRuns.$inferSelect.status,
  openSignal: typeof suspensions.$inferSelect.signalKind | null,
): NodeRunStatus {
  switch (lrStatus) {
    case 'pending':
    case 'running':
    case 'done':
    case 'failed':
    case 'canceled':
      return lrStatus
    case 'suspended': {
      if (openSignal === 'review') return 'awaiting_review'
      if (openSignal === 'self-clarify' || openSignal === 'cross-clarify') return 'awaiting_human'
      return 'pending'
    }
  }
}

const TERMINAL_LEGACY_STATUSES: ReadonlySet<NodeRunStatus> = new Set([
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
])

/**
 * Synthesise the legacy TaskNodeRuns response (runs + outputs) from the
 * RFC-061 projection. See module header for the field mapping rules and
 * compromises.
 */
export async function getTaskNodeRunsFromProjection(
  db: DbClient,
  taskId: string,
): Promise<TaskNodeRuns> {
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const lrs = await db
    .select()
    .from(logicalRuns)
    .where(eq(logicalRuns.taskId, taskId))
    .orderBy(asc(logicalRuns.createdAt), asc(logicalRuns.id))

  if (lrs.length === 0) return { runs: [], outputs: [] }

  const lrIds = lrs.map((lr) => lr.id)

  const allAttempts = await db
    .select()
    .from(attempts)
    .where(inArray(attempts.logicalRunId, lrIds))
    .orderBy(asc(attempts.logicalRunId), asc(attempts.attemptSeq))
  const latestAttemptByLr = new Map<string, (typeof allAttempts)[number]>()
  const attemptCountByLr = new Map<string, number>()
  for (const a of allAttempts) {
    const cur = latestAttemptByLr.get(a.logicalRunId)
    if (cur === undefined || a.attemptSeq > cur.attemptSeq) {
      latestAttemptByLr.set(a.logicalRunId, a)
    }
    attemptCountByLr.set(a.logicalRunId, (attemptCountByLr.get(a.logicalRunId) ?? 0) + 1)
  }

  const allSusps = await db
    .select()
    .from(suspensions)
    .where(inArray(suspensions.logicalRunId, lrIds))
  const openSuspByLr = new Map<string, (typeof allSusps)[number]>()
  for (const s of allSusps) {
    if (s.resolvedAt === null) openSuspByLr.set(s.logicalRunId, s)
  }

  const lrByScope = new Map<string, string>()
  for (const lr of lrs) {
    lrByScope.set(`${lr.nodeId}|${lr.loopIter}|${lr.shardKey}|${lr.iter}`, lr.id)
  }

  const outRows = await db.select().from(nodeOutputs).where(eq(nodeOutputs.taskId, taskId))
  const outputs: NodeRunOutput[] = []
  for (const o of outRows) {
    const nodeRunId = lrByScope.get(`${o.nodeId}|${o.loopIter}|${o.shardKey}|${o.iter}`)
    if (nodeRunId === undefined) continue
    outputs.push({ nodeRunId, port: o.portName, value: o.content })
  }

  const runs: NodeRun[] = lrs.map((lr) => {
    const att = latestAttemptByLr.get(lr.id)
    const susp = openSuspByLr.get(lr.id)
    const attCount = attemptCountByLr.get(lr.id) ?? 0
    const status = mapStatus(lr.status, susp?.signalKind ?? null)
    const isTerminal = TERMINAL_LEGACY_STATUSES.has(status)
    return {
      id: lr.id,
      taskId: lr.taskId,
      nodeId: lr.nodeId,
      parentNodeRunId: null,
      iteration: lr.iter,
      shardKey: lr.shardKey === '' ? null : lr.shardKey,
      retryIndex: Math.max(0, attCount - 1),
      reviewIteration: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      status,
      startedAt: lr.createdAt,
      finishedAt: isTerminal ? lr.updatedAt : null,
      pid: att?.pid ?? null,
      exitCode: att?.exitCode ?? null,
      errorMessage: att?.errorMessage ?? null,
      promptText: null,
      tokInput: null,
      tokOutput: null,
      tokTotal: null,
      tokCacheCreate: null,
      tokCacheRead: null,
      opencodeSessionId: att?.opencodeSessionId ?? null,
      injectedMemories: null,
      portValidationFailures: null,
    }
  })

  return { runs, outputs }
}

/**
 * Verify a legacy `nodeRunId` refers to a logical_run belonging to this
 * task. Throws NotFoundError otherwise. Used by the per-run REST routes.
 */
async function assertLogicalRunBelongsToTask(
  db: DbClient,
  taskId: string,
  logicalRunId: string,
): Promise<typeof logicalRuns.$inferSelect> {
  const rows = await db.select().from(logicalRuns).where(eq(logicalRuns.id, logicalRunId)).limit(1)
  const lr = rows[0]
  if (lr === undefined || lr.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${logicalRunId}' not found under task '${taskId}'`,
    )
  }
  return lr
}

/**
 * Map an RFC-061 event into the legacy NodeRunEvent kind enum. RFC-061
 * doesn't capture the full opencode stdout stream — only subagent
 * observations and attempt lifecycle markers — so the synthesised
 * stream is much sparser than the legacy one. The owning node-detail
 * drawer should eventually use a projection-native shape (/tasks/:id/
 * timeline, deferred Phase 6).
 *
 * Returns null for events we don't surface to the legacy drawer
 * (anything not attempt-scoped, or task-level lifecycle events).
 */
function mapEventToLegacyKind(eventKind: string): NodeRunEvent['kind'] | null {
  switch (eventKind) {
    case 'attempt-subagent-tool-use':
      return 'tool_use'
    case 'attempt-subagent-output':
      return 'text'
    case 'attempt-started':
      return 'step_start'
    case 'attempt-finished-success':
    case 'attempt-finished-envelope-fail':
    case 'attempt-finished-crash':
    case 'attempt-finished-timeout':
    case 'attempt-canceled':
      return 'step_finish'
    default:
      return null
  }
}

/**
 * Page attempt-scoped events for a logical_run. `since` is a hash-stable
 * numeric cursor over the integer suffix the synthesiser assigns (id
 * derived from the event ULID byte order — see `synthEventId` below);
 * for forward compatibility callers should treat it as opaque.
 *
 * In legacy `nodeRunEvents.id` was an autoincrement integer; we
 * synthesise integer ids from the event row sequence so the existing
 * `?since=N` semantics keep working. The cursor is unique per task per
 * logical_run; concurrent appends to different logical_runs may share
 * the same numeric value but always belong to different rows by
 * (nodeRunId, id) key — exactly the legacy invariant.
 */
export async function getNodeRunEventsFromProjection(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<NodeRunEventsResponse> {
  const lr = await assertLogicalRunBelongsToTask(db, taskId, nodeRunId)
  const limit = Math.min(opts.limit ?? 500, 1000)
  const since = opts.since ?? 0

  const lrAttempts = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.logicalRunId, lr.id))
  const attemptIds = lrAttempts.map((a) => a.id)
  if (attemptIds.length === 0) return { events: [], cursor: null }

  const rows = await db
    .select()
    .from(eventsTable)
    .where(inArray(eventsTable.attemptId, attemptIds))
    .orderBy(asc(eventsTable.ts), asc(eventsTable.id))
  const synthEvents: NodeRunEvent[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    const kind = mapEventToLegacyKind(r.kind)
    if (kind === null) continue
    const synthId = i + 1
    if (synthId <= since) continue
    let payload: unknown
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = r.payload
    }
    synthEvents.push({
      id: synthId,
      nodeRunId,
      ts: r.ts,
      kind,
      payload,
    })
    if (synthEvents.length >= limit) break
  }

  const cursor = synthEvents.length > 0 ? (synthEvents[synthEvents.length - 1]?.id ?? null) : null
  return { events: synthEvents, cursor }
}

/**
 * Synthesised stdout: concatenate every projection event's payload in
 * order. Stderr was a legacy stream-channel distinction; nothing in the
 * RFC-061 events table carries 'stderr' so this is effectively a no-op
 * filter. Returns '' for logical_runs with no attempts.
 */
export async function getNodeRunStdoutFromProjection(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
): Promise<string> {
  const lr = await assertLogicalRunBelongsToTask(db, taskId, nodeRunId)
  const lrAttempts = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.logicalRunId, lr.id))
  const attemptIds = lrAttempts.map((a) => a.id)
  if (attemptIds.length === 0) return ''

  const rows = await db
    .select({ payload: eventsTable.payload, kind: eventsTable.kind })
    .from(eventsTable)
    .where(inArray(eventsTable.attemptId, attemptIds))
    .orderBy(asc(eventsTable.ts), asc(eventsTable.id))
  return rows.map((r) => r.payload).join('\n')
}
