// P-4-04: resource-limit enforcement.
//
// The daemon runs `enforceLimits` on a 1Hz tick. It scans every task in
// `status='running'` and:
//   1. cancels the task with error `task-time-limit-exceeded` when
//      `now - started_at > max_duration_ms`
//   2. cancels the task with error `task-token-limit-exceeded` when
//      `sum(node_runs.tok_total) > max_total_tokens`
//
// Cancellation is best-effort: we call `cancelTask` which signals the
// scheduler's AbortController if one exists. If the daemon was restarted
// orphan logic (P-4-07) has already flipped the row to `interrupted`, this
// tick is a no-op for that task.

import {
  type ResourceLimitOperations,
  type ResourceLimitPersistence,
} from '@/modules/system-operations/public/operations'
import { composeLegacySqliteResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import { createLogger, type Logger } from '@/util/log'

const log: Logger = createLogger('limits')

export interface EnforceLimitsResult {
  scanned: number
  /** Task ids that were canceled by this tick. */
  canceled: string[]
}

type LegacySqliteResourceLimitSource = Parameters<
  typeof composeLegacySqliteResourceLimitOperations
>[0]
type ResourceLimitSource = LegacySqliteResourceLimitSource | ResourceLimitOperations

function isResourceLimitOperations(source: ResourceLimitSource): source is ResourceLimitOperations {
  return (
    typeof source === 'object' &&
    source !== null &&
    'persistence' in source &&
    'cancelTask' in source &&
    typeof source.cancelTask === 'function'
  )
}

function operationsFor(source: ResourceLimitSource): ResourceLimitOperations {
  return isResourceLimitOperations(source)
    ? source
    : composeLegacySqliteResourceLimitOperations(source)
}

export async function enforceLimits(
  source: ResourceLimitSource,
  now: number = Date.now(),
): Promise<EnforceLimitsResult> {
  const operations = operationsFor(source)
  // RFC-311 (audit L1-9): this runs at 1Hz — checkOne consumes exactly five
  // scalar columns, but the former select() decoded every running task's
  // workflow_snapshot / inputs / ref_closure_json JSON once per second,
  // forever. (The token SUM below stays per-tick: it only fires for tasks
  // with a configured cap and walks idx_node_runs_task; deferring it would
  // delay the cancel, which is a behavior change this pass must not make.)
  const running = await operations.persistence.listRunningTasks()
  const canceled: string[] = []

  for (const t of running) {
    const reason = await checkOne(operations.persistence, t, now)
    if (reason === null) continue

    try {
      await operations.cancelTask(t.id)
    } catch {
      // Already terminal between read and cancel; ignore.
    }
    // cancelTask sets a generic 'canceled by user' summary; overwrite with the
    // limit-specific reason so the UI surfaces it. RFC-097 (audit S-14): only
    // on rows where the cancel actually landed — a task that reached
    // done/failed between the scan and the cancel keeps its real terminal
    // message instead of being painted over with limit copy.
    await operations.persistence.writeLimitReason({
      taskId: t.id,
      summary: reason.summary,
      message: reason.message,
    })
    canceled.push(t.id)
    log.warn('limit exceeded', { taskId: t.id, summary: reason.summary })
    // RFC-108 T3 (AR-11): durable audit of the resource-limit cancel.
    await operations.persistence.recordLimitCancellation({
      taskId: t.id,
      reason: reason.summary,
      now,
    })
  }

  return { scanned: running.length, canceled }
}

async function checkOne(
  persistence: ResourceLimitPersistence,
  t: Awaited<ReturnType<ResourceLimitPersistence['listRunningTasks']>>[number],
  now: number,
): Promise<{ summary: string; message: string } | null> {
  if (typeof t.maxDurationMs === 'number' && t.maxDurationMs > 0) {
    // RFC-207 §3.8 — the accumulated running time, NOT wall clock since creation:
    // a task that sat parked on a question for a week has not been "running" for a
    // week, and killing it the moment a human finally answers is the opposite of
    // what a duration limit is for.
    const elapsed = t.runningMs + (t.runningSince === null ? 0 : now - t.runningSince)
    if (elapsed > t.maxDurationMs) {
      // RFC-243 §4.5 — a parent waiting on a child execution stays 'running'
      // (D6, no status bubbling), so its clock keeps accruing while the child
      // sits on a HUMAN gate. That wait is RFC-207-parked time in spirit:
      //   ① deduct the call rows' accounted human-wait (durable ledger the
      //     call handler keeps in wrapper_progress_json, incl. the live
      //     segment), and
      //   ② while any child is CURRENTLY awaiting_*, defer the kill this tick
      //     (covers the poll-granularity gap of the ledger) — alert only.
      // Both are no-ops for tasks without call rows (single cheap query only
      // on the over-limit path).
      const wait = await callRowHumanWait(persistence, t.id, now)
      const effective = elapsed - wait.waitMs
      if (effective > t.maxDurationMs) {
        if (wait.childAwaiting) {
          log.warn(
            'duration limit exceeded but a child execution awaits human input — kill deferred (RFC-243 §4.5)',
            {
              taskId: t.id,
              elapsed,
              deductedMs: wait.waitMs,
            },
          )
        } else {
          return {
            summary: 'task-time-limit-exceeded',
            message: `task ran ${effective}ms (human-wait deducted), exceeding configured limit ${t.maxDurationMs}ms`,
          }
        }
      }
    }
  }
  if (typeof t.maxTotalTokens === 'number' && t.maxTotalTokens > 0) {
    const total = await persistence.sumTaskTokens(t.id)
    if (total > t.maxTotalTokens) {
      return {
        summary: 'task-token-limit-exceeded',
        message: `task consumed ${total} tokens, exceeding configured limit ${t.maxTotalTokens}`,
      }
    }
  }
  return null
}

/** RFC-243 §4.5 — the call rows' human-wait ledger + live awaiting probe. */
async function callRowHumanWait(
  persistence: ResourceLimitPersistence,
  taskId: string,
  now: number,
): Promise<{ waitMs: number; childAwaiting: boolean }> {
  const callRows = await persistence.listCallRows(taskId)
  if (callRows.length === 0) return { waitMs: 0, childAwaiting: false }
  let waitMs = 0
  const childIds = new Set<string>()
  for (const r of callRows) {
    if (r.childTaskId !== null) childIds.add(r.childTaskId)
    waitMs += parseCallHumanWait(r.wrapperProgressJson, now)
  }
  const statuses = await persistence.listTaskStatuses([...childIds])
  const childAwaiting = statuses.some(
    (status) => status === 'awaiting_review' || status === 'awaiting_human',
  )
  return { waitMs, childAwaiting }
}

/** Parse `{callHumanWaitMs, callHumanWaitSince}` from a call row's progress JSON. */
export function parseCallHumanWait(json: string | null, now: number): number {
  if (json === null || json === '') return 0
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return 0
    const o = parsed as { callHumanWaitMs?: unknown; callHumanWaitSince?: unknown }
    const base =
      typeof o.callHumanWaitMs === 'number' && o.callHumanWaitMs >= 0 ? o.callHumanWaitMs : 0
    const since =
      typeof o.callHumanWaitSince === 'number' && o.callHumanWaitSince > 0
        ? Math.max(0, now - o.callHumanWaitSince)
        : 0
    return base + since
  } catch {
    return 0
  }
}

/**
 * Terminal TaskExecution usage projection consumed by Digital Employee.
 * It intentionally reuses the same accumulated-running and durable human-wait
 * accounting as the live limit enforcer instead of deriving wall-clock time.
 */
export async function readTaskResourceUsage(
  source: ResourceLimitSource,
  taskId: string,
  now: number = Date.now(),
): Promise<{ readonly effectiveRunningMs: number; readonly totalTokens: number } | null> {
  const persistence = operationsFor(source).persistence
  const task = await persistence.readTaskClock(taskId)
  if (task === null) return null
  const elapsed =
    task.runningMs + (task.runningSince === null ? 0 : Math.max(0, now - task.runningSince))
  const wait = await callRowHumanWait(persistence, taskId, now)
  return {
    effectiveRunningMs: Math.max(0, elapsed - wait.waitMs),
    totalTokens: await persistence.sumTaskTokens(taskId),
  }
}

/**
 * Convenience: start a 1Hz interval running enforceLimits against the given
 * db, returning a stopper. The daemon wires this in main.ts; tests call
 * enforceLimits directly.
 */
