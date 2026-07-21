// RFC-108 T3 (AR-11) — unified recovery audit + counters.
//
// A single primitive every SYSTEM-initiated recovery actor calls so that boot
// orphan-reap, shutdown survivor-flip, limit-cancel, snapshot-lost /
// live-child-survived escalation (and the deferred auto-resume / auto-repair /
// heartbeat-kill / quarantine) leave a durable, queryable trail instead of just
// a `log.warn`. lifecycle_repair_audit is the MANUAL (human-click) counterpart.

import { desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { recoveryEvents } from '@/db/schema'
import { createLogger } from '@/util/log'

const log = createLogger('recovery')

export type RecoveryEventKind =
  | 'boot-reap'
  | 'periodic-reap'
  | 'shutdown-flip'
  | 'limit-cancel'
  | 'snapshot-lost'
  | 'live-child-survived'
  | 'auto-resume'
  | 'auto-repair'
  | 'heartbeat-kill'
  | 'quarantine'
  // RFC-213 disaster-recovery. `restore` is written on the db reopened AFTER the
  // swap (the pre-swap db may be gone/corrupt); `pre-migration` after the fresh
  // db opens; `worktree-skip` when a task's worktree capture exceeds the cap.
  | 'restore'
  | 'pre-migration'
  | 'worktree-skip'

export interface RecordRecoveryEventArgs {
  taskId?: string | null
  nodeRunId?: string | null
  /** Defaults to 'system'. A user id when a human triggered it. */
  actor?: string
  kind: RecoveryEventKind
  reason?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** Override clock (tests). */
  now?: number
}

// In-process "since boot" counters (single-daemon seam — the persistent
// recovery_events table is the durable history; these are a cheap health gauge
// that resets on restart by design).
const counters = new Map<string, number>()

export function bumpRecoveryCounter(key: string, by = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + by)
}

export function recoveryCountersSnapshot(): Record<string, number> {
  return Object.fromEntries(counters)
}

/** Test helper — clear the in-process counters between cases. */
export function __resetRecoveryCountersForTest(): void {
  counters.clear()
}

/**
 * Record a system recovery action. AWAITED (not fire-and-forget — Codex design
 * gate P2) so the audit row lands before the caller proceeds, but best-effort:
 * it never throws, because a recovery action must not fail just because its
 * audit insert did. Also bumps the in-process counter for the kind.
 */
export async function recordRecoveryEvent(
  db: DbClient,
  args: RecordRecoveryEventArgs,
): Promise<void> {
  bumpRecoveryCounter(args.kind)
  try {
    await db.insert(recoveryEvents).values({
      id: ulid(),
      taskId: args.taskId ?? null,
      nodeRunId: args.nodeRunId ?? null,
      actor: args.actor ?? 'system',
      kind: args.kind,
      reason: args.reason ?? null,
      beforeJson: args.before !== undefined ? JSON.stringify(args.before) : null,
      afterJson: args.after !== undefined ? JSON.stringify(args.after) : null,
      createdAt: args.now ?? Date.now(),
    })
  } catch (err) {
    log.warn('recordRecoveryEvent failed (audit dropped)', {
      kind: args.kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Recent recovery events for a task, newest first (UI history). */
export async function listRecoveryEventsForTask(
  db: DbClient,
  taskId: string,
  limit = 50,
): Promise<Array<typeof recoveryEvents.$inferSelect>> {
  return db
    .select()
    .from(recoveryEvents)
    .where(eq(recoveryEvents.taskId, taskId))
    .orderBy(desc(recoveryEvents.createdAt))
    .limit(limit)
}
