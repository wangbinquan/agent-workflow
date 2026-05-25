// RFC-061 follow-up — stuck-task detector retired.
//
// The legacy RFC-053 P-6 detector watched 4 rules (S1/S2/S3/S4) that
// joined tasks.status against the deprecated doc_versions /
// clarify_sessions / node_runs / node_run_events tables to flag tasks
// parked too long without evidence. Under the actor model:
//
//   * S1 "awaiting_review > 30 min without pending doc_version":
//     tasks.status === 'awaiting_review' isn't written by the actor;
//     review suspends a logical_run instead. A native S1 successor
//     should query the suspensions projection.
//   * S2 same story for clarify suspensions.
//   * S3 "running > 30 min without active node_run": replace with a
//     query over (logical_runs.status='running' + max(events.ts)).
//   * S4 "pending > 5 min": no nodeRuns dependency; could survive a
//     simple rewrite but we stub it for consistency until the full
//     suite ports.
//
// The full rewrite is queued behind RFC-062 (scheduler-stall-defense),
// which adds a stronger S5 "scheduler-stalled" rule on top of the
// projection events table. Until then this module is a no-op stub so
// the cli/start.ts ticker fires harmlessly.

import type { DbClient } from '@/db/client'

import type { LifecycleAlertRow } from './lifecycleInvariants'

const MIN_MS = 60_000

export const DEFAULT_STUCK_THRESHOLD_MS = 30 * MIN_MS
export const DEFAULT_PENDING_THRESHOLD_MS = 5 * MIN_MS

export interface RunStuckTaskDetectorArgs {
  db: DbClient
  now?: () => number
  stuckThresholdMs?: number
  pendingThresholdMs?: number
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  taskIdFilter?: readonly string[]
}

export interface RunStuckTaskDetectorResult {
  scanned: number
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: LifecycleAlertRow[]
}

export async function runStuckTaskDetector(
  _args: RunStuckTaskDetectorArgs,
): Promise<RunStuckTaskDetectorResult> {
  return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
}

export function startStuckTaskDetectorLoop(_opts: {
  db: DbClient
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  intervalMs?: number
}): { stop: () => void } {
  return { stop: () => {} }
}
