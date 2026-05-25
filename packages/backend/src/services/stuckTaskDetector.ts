// RFC-061 follow-up — stuck-task detector rebuilt on the projection.
//
// Two rules survive the cutover, both keyed off the events table:
//
//   S5 "scheduler-stalled" — tasks.status='running' AND
//                            now - max(events.ts) > stuckThresholdMs.
//                            The actor or runner stopped emitting; either
//                            the scheduler hung or every running attempt
//                            died silently. RFC-062's core rule.
//
//   S6 "suspension-stale"  — tasks.status='running' AND there is at least
//                            one open suspension older than
//                            stuckThresholdMs whose awaitsActor starts
//                            with 'user:'. A user-driven clarify / review
//                            that has been waiting too long; UI surfaces
//                            it so operators can chase the asker.
//
// Findings land in lifecycle_alerts (rule='S5'|'S6'). reconcileLifecycle-
// Alerts owns the upsert + 24h grace promotion + WS broadcast.
//
// The legacy S1..S4 rules (awaiting_review / awaiting_human task statuses
// without backing doc_versions / clarify_sessions, pending > 5min) are
// retired — task.status under the actor never carries the 'awaiting_*'
// values, and S5 covers the "no progress" symptom S3 watched for.

import { and, eq, gt, inArray, isNull, max as sqlMax } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { events as eventsTable, logicalRuns, suspensions, tasks } from '@/db/schema'
import { createLogger } from '@/util/log'

import {
  reconcileLifecycleAlerts,
  type LifecycleAlertFinding,
  type LifecycleAlertRow,
} from './lifecycleInvariants'

const log = createLogger('lifecycle.stuck')

const MIN_MS = 60_000

export const DEFAULT_STUCK_THRESHOLD_MS = 30 * MIN_MS
export const DEFAULT_PENDING_THRESHOLD_MS = 5 * MIN_MS

const OWNED_RULES = ['S5', 'S6'] as const

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
  args: RunStuckTaskDetectorArgs,
): Promise<RunStuckTaskDetectorResult> {
  const now = (args.now ?? Date.now)()
  const stuckMs = args.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS

  const running = await args.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        eq(tasks.status, 'running'),
        ...(args.taskIdFilter !== undefined && args.taskIdFilter.length > 0
          ? [inArray(tasks.id, args.taskIdFilter as string[])]
          : []),
      ),
    )

  if (running.length === 0) {
    return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
  }

  const findings: LifecycleAlertFinding[] = []
  const taskIds = running.map((r) => r.id)

  // S5: per task, max(events.ts). No row → use a sentinel so age = 0
  // (just-started task, never stuck).
  const tsRows = await args.db
    .select({ taskId: eventsTable.taskId, maxTs: sqlMax(eventsTable.ts) })
    .from(eventsTable)
    .where(inArray(eventsTable.taskId, taskIds))
    .groupBy(eventsTable.taskId)
  const maxTsByTask = new Map<string, number>()
  for (const r of tsRows) {
    if (r.maxTs !== null) maxTsByTask.set(r.taskId, r.maxTs)
  }
  for (const t of running) {
    const last = maxTsByTask.get(t.id)
    if (last === undefined) continue
    const age = now - last
    if (age > stuckMs) {
      findings.push({
        taskId: t.id,
        rule: 'S5',
        detail: { lastEventTs: last, ageMs: age, thresholdMs: stuckMs },
      })
    }
  }

  // S6: per task, oldest open user-awaited suspension.
  const suspRows = await args.db
    .select({
      lrTaskId: logicalRuns.taskId,
      createdAt: suspensions.createdAt,
      awaitsActor: suspensions.awaitsActor,
      suspensionId: suspensions.id,
    })
    .from(suspensions)
    .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
    .where(
      and(
        inArray(logicalRuns.taskId, taskIds),
        isNull(suspensions.resolvedAt),
        gt(suspensions.createdAt, 0),
      ),
    )
  const oldestByTask = new Map<
    string,
    { createdAt: number; suspensionId: string; awaitsActor: string }
  >()
  for (const r of suspRows) {
    if (!r.awaitsActor.startsWith('user:')) continue
    const prev = oldestByTask.get(r.lrTaskId)
    if (prev === undefined || r.createdAt < prev.createdAt) {
      oldestByTask.set(r.lrTaskId, {
        createdAt: r.createdAt,
        suspensionId: r.suspensionId,
        awaitsActor: r.awaitsActor,
      })
    }
  }
  for (const [taskId, info] of oldestByTask.entries()) {
    const age = now - info.createdAt
    if (age > stuckMs) {
      findings.push({
        taskId,
        rule: 'S6',
        detail: {
          suspensionId: info.suspensionId,
          awaitsActor: info.awaitsActor,
          createdAt: info.createdAt,
          ageMs: age,
          thresholdMs: stuckMs,
        },
      })
    }
  }

  const reconciled = await reconcileLifecycleAlerts({
    db: args.db,
    taskIds,
    findings,
    now,
    ownedRules: OWNED_RULES,
    ...(args.onAlert !== undefined ? { onAlert: args.onAlert } : {}),
  })
  log.info('scan complete', {
    scanned: running.length,
    findings: findings.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
  })
  return { scanned: running.length, ...reconciled }
}

export function startStuckTaskDetectorLoop(opts: {
  db: DbClient
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  intervalMs?: number
}): { stop: () => void } {
  const interval = opts.intervalMs ?? 5 * MIN_MS
  let running = false
  const safeRun = (): void => {
    if (running) return
    running = true
    void runStuckTaskDetector({
      db: opts.db,
      ...(opts.onAlert !== undefined ? { onAlert: opts.onAlert } : {}),
    })
      .catch((err: unknown) => {
        log.error('scan failed', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = false
      })
  }
  const handle = setInterval(safeRun, interval)
  return { stop: () => clearInterval(handle) }
}
