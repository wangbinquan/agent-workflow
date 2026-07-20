// RFC-164 PR-2 — workgroup assignment status machine (design §1.4).
//
// Pure transition table + assert helper, mirroring services/lifecycle.ts
// style (single source of truth; illegal transitions throw instead of
// silently writing). The DB CAS wrapper lands together with migration B in
// this PR (casAssignmentStatus) — engine code (PR-3) must go through it, not
// through raw UPDATEs.
//
//   open ──claim──▶ dispatched ──▶ running ──▶ done | failed
//                        │             │──▶ awaiting_human ──▶ running
//                        └─(human)──▶ delivered ──▶ done
//   failed ──▶ open        (fc re-open, bounded by defaultNodeRetries — §4.3)
//   awaiting_human ──▶ dispatched | open   (RFC-181 A2 autonomous-toggle requeue:
//       lw re-dispatches to the same member; fc recycles the card to the pool)
//   any non-terminal ──▶ canceled

import type { WorkgroupAssignmentStatus } from '@agent-workflow/shared'
import { workgroupHasHumanMember } from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  clarifySessions,
  nodeRuns,
  tasks,
  workgroupAssignments,
  workgroupMemberCursors,
} from '@/db/schema'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'

export const WORKGROUP_ASSIGNMENT_TRANSITIONS: Record<
  WorkgroupAssignmentStatus,
  readonly WorkgroupAssignmentStatus[]
> = {
  open: ['dispatched', 'canceled'],
  dispatched: ['running', 'delivered', 'failed', 'canceled'],
  running: ['done', 'failed', 'awaiting_human', 'canceled'],
  // 'dispatched'/'open': RFC-181 A2 — flipping autonomous ON dismisses an
  // in-flight clarify park and requeues the card (lw → same member; fc → pool).
  awaiting_human: ['running', 'failed', 'canceled', 'dispatched', 'open'],
  delivered: ['done', 'canceled'],
  done: [],
  // fc re-open path (design §4.3); lw retries mint NEW assignments instead.
  failed: ['open'],
  canceled: [],
}

export const WORKGROUP_ASSIGNMENT_TERMINAL: ReadonlySet<WorkgroupAssignmentStatus> = new Set([
  'done',
  'canceled',
])

export class IllegalWorkgroupAssignmentTransition extends Error {
  constructor(
    public readonly from: WorkgroupAssignmentStatus,
    public readonly to: WorkgroupAssignmentStatus,
  ) {
    super(`illegal workgroup assignment transition ${from} → ${to}`)
    this.name = 'IllegalWorkgroupAssignmentTransition'
  }
}

export function canTransitionAssignment(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): boolean {
  return WORKGROUP_ASSIGNMENT_TRANSITIONS[from].includes(to)
}

export function assertAssignmentTransition(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): void {
  if (!canTransitionAssignment(from, to)) {
    throw new IllegalWorkgroupAssignmentTransition(from, to)
  }
}

/**
 * Compare-and-set an assignment's status: the UPDATE only lands when the row
 * is still in `from` (concurrent engine/HTTP writers race safely — the loser
 * gets `false` and re-reads). Illegal (from → to) pairs throw regardless.
 * Optional `set` piggybacks column writes (nodeRunId, assignee, result link)
 * onto the same guarded UPDATE.
 */
export async function casAssignmentStatus(
  db: DbClient,
  assignmentId: string,
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
  set: Partial<typeof workgroupAssignments.$inferInsert> = {},
): Promise<boolean> {
  assertAssignmentTransition(from, to)
  const rows = await db
    .update(workgroupAssignments)
    .set({ ...set, status: to, updatedAt: Date.now() })
    .where(and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.status, from)))
    .returning({ taskId: workgroupAssignments.taskId })
  const landed = rows.length > 0
  if (landed && rows[0] !== undefined) {
    // Single broadcast point for every assignment status flip (engine, room
    // routes, PR-5 delivery/confirm all ride it) — room cards update live.
    taskBroadcaster.broadcast(TASK_CHANNEL(rows[0].taskId), {
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId,
      status: to,
    })
  }
  return landed
}

/**
 * Transactional companion of casAssignmentStatus. The caller owns the outer
 * dbTxSync transaction and broadcasts only after commit. This is required for
 * operations such as human delivery and roster edits where the assignment
 * transition and its companion message/config rows form one business fact.
 */
export function casAssignmentStatusTx(
  tx: DbTxSync,
  assignmentId: string,
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
  set: Partial<typeof workgroupAssignments.$inferInsert> = {},
): boolean {
  assertAssignmentTransition(from, to)
  const updated = tx
    .update(workgroupAssignments)
    .set({ ...set, status: to, updatedAt: Date.now() })
    .where(and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.status, from)))
    .returning({ id: workgroupAssignments.id })
    .all()
  return updated.length > 0
}

/**
 * Advance a member's consumption cursor to `messageId` — monotonic (a stale
 * writer can never move it backwards), UPSERT on first touch. Engine calls
 * this in the same transaction that mints the member's run (design §1.6).
 */
export async function advanceMemberCursor(
  db: DbClient,
  taskId: string,
  memberId: string,
  messageId: string,
): Promise<void> {
  await db
    .insert(workgroupMemberCursors)
    .values({ taskId, memberId, lastConsumedMessageId: messageId, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [workgroupMemberCursors.taskId, workgroupMemberCursors.memberId],
      set: {
        lastConsumedMessageId: sql`max(${workgroupMemberCursors.lastConsumedMessageId}, excluded.last_consumed_message_id)`,
        updatedAt: Date.now(),
      },
    })
}

/**
 * RFC-181 C — envelope-time suppression oracle: read the task's CURRENT
 * frozen-config `autonomous` (per-task PATCH can flip it mid-run, RFC-181 A).
 * The workgroup hook consults this right before opening a clarify session so
 * a run dispatched with ask-back allowed cannot park the task after the
 * launcher toggled autonomous ON (design-gate P1-①).
 */
/**
 * RFC-207 — is ask-back suppressed for this task, i.e. does its FROZEN roster
 * hold no human member? Read live from `tasks.workgroup_config_json` (the copy
 * the engine and the mid-run config PATCH share), so removing the last human
 * takes effect on the very next check rather than the next launch.
 *
 * Missing / unparseable config ⇒ NOT suppressed. An unreadable snapshot is an
 * anomaly, and letting a question through so a human can look is the safe
 * failure — the same direction the RFC-180 predecessor took.
 */
export async function isTaskClarifySuppressed(db: DbClient, taskId: string): Promise<boolean> {
  const row = (
    await db
      .select({ cfg: tasks.workgroupConfigJson })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (row === undefined || row.cfg === null) return false
  try {
    const parsed = JSON.parse(row.cfg) as { members?: unknown }
    if (!Array.isArray(parsed.members)) return false
    return !workgroupHasHumanMember(
      parsed.members.filter(
        (m): m is { memberType: 'agent' | 'human' } =>
          typeof m === 'object' && m !== null && 'memberType' in m,
      ),
    )
  } catch {
    return false
  }
}

export interface AutonomousDismissalResult {
  dismissedSessions: number
  canceledParkRuns: Array<{ nodeRunId: string; nodeId: string }>
  requeuedAssignments: Array<{ id: string; to: WorkgroupAssignmentStatus }>
}

/**
 * RFC-181 A2 — flipping `autonomous` false→true dismisses every in-flight
 * clarify park of the task so the engine can actually move on (without this,
 * the toggle is a no-op for a task that is ALREADY ping-ponging questions —
 * the very scenario the switch exists for).
 *
 * ONE dbTxSync transaction (mirrors clarifySeal's atomic pattern): sessions
 * are re-read INSIDE the transaction and all writes commit together, so a
 * concurrent answer submission serializes against the dismissal — the loser's
 * CAS misses and the stale answer is rejected by the session-status guard on
 * the answer route. Broadcasts fire after commit (never inside).
 *
 * Per open session: session row → canceled; its park-carrier clarify run
 * (`clarifyNodeRunId`, status awaiting_human) → canceled; when the source
 * shard is an assignment (worker park), the card requeues via the A2 edges
 * (lw awaiting_human→dispatched same member / fc →open recycled to the pool).
 * Leader / message-turn sessions (shard null / `msg:*`) have no card to
 * requeue — the resumed engine's autonomous idle-nudge re-wakes the leader.
 */
export async function dismissOpenClarifyParksForAutonomous(
  db: DbClient,
  taskId: string,
  mode?: string,
): Promise<AutonomousDismissalResult> {
  const result: AutonomousDismissalResult = {
    dismissedSessions: 0,
    canceledParkRuns: [],
    requeuedAssignments: [],
  }
  // Callers that hold the parsed config pass mode; the workgroup hook's
  // post-create compensation path (impl-gate P1-③) omits it — resolve from
  // the task's frozen config (requeue target only matters for worker parks,
  // which cannot exist in that window, so a fallback default is safe).
  const resolvedMode =
    mode ??
    (await (async () => {
      const row = (
        await db
          .select({ cfg: tasks.workgroupConfigJson })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]
      if (row === undefined || row.cfg === null) return 'leader_worker'
      try {
        const parsed = JSON.parse(row.cfg) as { mode?: unknown }
        return typeof parsed.mode === 'string' ? parsed.mode : 'leader_worker'
      } catch {
        return 'leader_worker'
      }
    })())
  dbTxSync(db, (tx) => {
    const open = tx
      .select()
      .from(clarifySessions)
      .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
      .all()
    for (const s of open) {
      tx.update(clarifySessions)
        .set({ status: 'canceled' })
        .where(and(eq(clarifySessions.id, s.id), eq(clarifySessions.status, 'awaiting_human')))
        .run()
      result.dismissedSessions++
      // Park-carrier clarify run → canceled in the SAME transaction (the
      // asking host run already closed as done/failed — RFC-181 design §2.1a).
      // rfc053-allow-direct-status-write -- RFC-181 A2 atomic dismissal (guarded
      // awaiting_human-only UPDATE inside dbTxSync; async lifecycle helpers
      // cannot join a sync transaction).
      const parked = tx
        .update(nodeRuns)
        .set({
          status: 'canceled',
          finishedAt: Date.now(),
          errorMessage: 'wg-clarify-disabled',
        })
        .where(and(eq(nodeRuns.id, s.clarifyNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
        .returning({ id: nodeRuns.id })
        .all()
      if (parked.length > 0) {
        result.canceledParkRuns.push({ nodeRunId: s.clarifyNodeRunId, nodeId: s.clarifyNodeId })
      }
      // Impl-gate P1-② — the AUTHORITATIVE clarify round row (RFC-058 dual
      // write): /api/clarify, drafts and sealRoundQuestions all read
      // clarify_rounds, so canceling only the legacy session row would leave
      // the question answerable — a stale answer could still seal the round
      // and mint a continuation. Same tx, same awaiting_human-only guard.
      tx.update(clarifyRounds)
        .set({ status: 'canceled' })
        .where(
          and(
            eq(clarifyRounds.taskId, taskId),
            eq(clarifyRounds.intermediaryNodeRunId, s.clarifyNodeRunId),
            eq(clarifyRounds.status, 'awaiting_human'),
          ),
        )
        .run()
      const shard = s.sourceShardKey
      if (shard !== null && !shard.startsWith('msg:')) {
        const to: WorkgroupAssignmentStatus = resolvedMode === 'free_collab' ? 'open' : 'dispatched'
        assertAssignmentTransition('awaiting_human', to)
        const requeued = tx
          .update(workgroupAssignments)
          .set({
            status: to,
            nodeRunId: null,
            ...(resolvedMode === 'free_collab' ? { assigneeMemberId: null } : {}),
            updatedAt: Date.now(),
          })
          .where(
            and(
              eq(workgroupAssignments.id, shard),
              eq(workgroupAssignments.taskId, taskId),
              eq(workgroupAssignments.status, 'awaiting_human'),
            ),
          )
          .returning({ id: workgroupAssignments.id })
          .all()
        if (requeued.length > 0) result.requeuedAssignments.push({ id: shard, to })
      }
    }
  })
  for (const r of result.canceledParkRuns) {
    taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
      id: -1,
      type: 'node.status',
      nodeRunId: r.nodeRunId,
      nodeId: r.nodeId,
      status: 'canceled',
    })
  }
  for (const a of result.requeuedAssignments) {
    taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId: a.id,
      status: a.to,
    })
  }
  return result
}
