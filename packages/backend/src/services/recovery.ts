// RFC-108 T3 (AR-11) — unified recovery audit + counters.
//
// A single primitive every SYSTEM-initiated recovery actor calls so that boot
// orphan-reap, shutdown survivor-flip, limit-cancel, snapshot-lost /
// live-child-survived escalation (and the deferred auto-resume / auto-repair /
// heartbeat-kill / quarantine) leave a durable, queryable trail instead of just
// a `log.warn`. lifecycle_repair_audit is the MANUAL (human-click) counterpart.

import { ulid } from 'ulid'

import type {
  TaskRecoveryEventKind,
  TaskRecoveryEventRecord,
  TaskRecoveryOperations,
} from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { createLogger } from '@/util/log'

const log = createLogger('recovery')

export type RecoveryEventKind = TaskRecoveryEventKind

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
  operations: TaskRecoveryOperations,
  args: RecordRecoveryEventArgs,
): Promise<void> {
  bumpRecoveryCounter(args.kind)
  try {
    await operations.recordEvent({
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
  operations: TaskRecoveryOperations,
  taskId: string,
  limit = 50,
): Promise<readonly TaskRecoveryEventRecord[]> {
  return operations.listEventsForTask(taskId, limit)
}
