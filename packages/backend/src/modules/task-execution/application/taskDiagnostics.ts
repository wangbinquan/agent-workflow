// RFC-452 — the tasks route's diagnostics use cases over the recovery port, moved from the route handlers: the recovery
// audit trail together with the auto-recovery quarantine state, and the on-demand diagnose pass.

import type { TaskDiagnoseResponse, TaskRecoveryEventsResponse } from '@agent-workflow/shared'
import { runLifecycleInvariants } from './lifecycleAlerts/lifecycleInvariants'
import { listOpenLifecycleAlertsForTask } from './lifecycleAlerts/openLifecycleAlerts'
import type { TaskLifecycleAlertNotices } from './ports/taskDiagnostics'
import type { TaskRecoveryOperations } from './ports/taskRecoveryOperations'
import { isAutoRecoverySuspended } from './recovery/autoRecoveryBreaker'
import { listRecoveryEventsForTask } from './recovery/recoveryEvents'

/** RFC-108 T3 / T11: the task's system recovery audit trail, newest first, and whether auto-recovery is quarantined. */
export async function readTaskRecoveryHistory(
  operations: TaskRecoveryOperations,
  taskId: string,
): Promise<TaskRecoveryEventsResponse> {
  const [events, suspended] = await Promise.all([
    listRecoveryEventsForTask(operations, taskId),
    isAutoRecoverySuspended(operations, taskId),
  ])
  return { events: [...events], suspended }
}

/**
 * RFC-053 P-3: an on-demand invariant scan of one task. It reads live state (not the cached lifecycle_alerts table),
 * so the report reflects the current rows without waiting for the next hourly tick.
 *
 * RFC-057: the stuck-task detector (S1..S4) has a 30-minute freshness gate and runs on its own 5-minute cadence, so
 * the live scan alone misses its open rows — the banner would say "open alerts" while the panel said "no findings".
 * They are merged in from the table after the scan's own rows.
 */
export async function diagnoseTask(
  operations: TaskRecoveryOperations,
  taskId: string,
  notices: TaskLifecycleAlertNotices,
): Promise<TaskDiagnoseResponse> {
  const result = await runLifecycleInvariants({
    operations,
    scope: { taskId },
    onAlert: (row, transition) => notices.alert(row, transition),
    onResolved: (resolvedTaskId) => notices.resolved(resolvedTaskId),
  })
  const invariantIds = new Set(result.openAlerts.map((a) => a.id))
  const allOpen = await listOpenLifecycleAlertsForTask(operations, taskId)
  const extra = allOpen
    .filter((a) => !invariantIds.has(a.id))
    .map((a) => ({
      id: a.id,
      taskId: a.taskId,
      rule: a.rule,
      severity: a.severity,
      detail: a.detail,
      detectedAt: a.detectedAt,
      resolvedAt: null,
    }))
  return { ...result, openAlerts: [...result.openAlerts, ...extra] }
}
