import type { TaskResourceLimitFacts } from './ports/taskResourceLimitFacts'
import { callHumanWaitMs } from '../domain/resourceLimitUsage'

/** RFC-243 §4.5 — the call rows' human-wait ledger + live awaiting probe. */
export async function callRowHumanWait(
  persistence: TaskResourceLimitFacts,
  taskId: string,
  now: number,
): Promise<{ waitMs: number; childAwaiting: boolean }> {
  const callRows = await persistence.callHumanWaits(taskId)
  if (callRows.length === 0) return { waitMs: 0, childAwaiting: false }
  let waitMs = 0
  const childIds = new Set<string>()
  for (const r of callRows) {
    if (r.childTaskId !== null) childIds.add(r.childTaskId)
    waitMs += callHumanWaitMs(r, now)
  }
  const statuses = await persistence.listTaskStatuses([...childIds])
  const childAwaiting = statuses.some(
    (status) => status === 'awaiting_review' || status === 'awaiting_human',
  )
  return { waitMs, childAwaiting }
}

/**
 * Terminal TaskExecution usage projection consumed by Digital Employee.
 * It intentionally reuses the same accumulated-running and durable human-wait
 * accounting as the live limit enforcer instead of deriving wall-clock time.
 */
export async function readTaskResourceUsage(
  persistence: TaskResourceLimitFacts,
  taskId: string,
  now: number = Date.now(),
): Promise<{ readonly effectiveRunningMs: number; readonly totalTokens: number } | null> {
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
