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
//   any non-terminal ──▶ canceled

import type { WorkgroupAssignmentStatus } from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { workgroupAssignments, workgroupMemberCursors } from '@/db/schema'

export const WORKGROUP_ASSIGNMENT_TRANSITIONS: Record<
  WorkgroupAssignmentStatus,
  readonly WorkgroupAssignmentStatus[]
> = {
  open: ['dispatched', 'canceled'],
  dispatched: ['running', 'delivered', 'failed', 'canceled'],
  running: ['done', 'failed', 'awaiting_human', 'canceled'],
  awaiting_human: ['running', 'failed', 'canceled'],
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
  const res = await db
    .update(workgroupAssignments)
    .set({ ...set, status: to, updatedAt: Date.now() })
    .where(and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.status, from)))
  return (res as unknown as { changes?: number }).changes !== 0
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
