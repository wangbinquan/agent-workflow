// RFC-053 P-6 — helper: read open lifecycle_alerts for a single task.
//
// Used by `GET /api/tasks/:id/alerts` (banner data source) and by the
// future frontend invalidation path on `lifecycle.alert` WS events.
// Returns rows ordered by detected_at ascending so the UI can group
// "oldest first" without re-sorting.

import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { InvariantSeverity, LifecycleAlertRule } from '@/services/lifecycleInvariants'

export interface OpenLifecycleAlert {
  id: string
  taskId: string
  rule: LifecycleAlertRule
  severity: InvariantSeverity
  detail: Record<string, unknown>
  detectedAt: number
}

export async function listOpenLifecycleAlertsForTask(
  operations: TaskRecoveryOperations,
  taskId: string,
): Promise<OpenLifecycleAlert[]> {
  const rows = await operations.listOpenLifecycleAlerts(taskId)
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    rule: r.rule as LifecycleAlertRule,
    severity: r.severity as InvariantSeverity,
    detail: safeParseDetail(r.detail),
    detectedAt: r.detectedAt,
  }))
}

/**
 * RFC-108 T19: all open lifecycle alerts across every task (the auto-repair loop
 * scans globally, not per-task). Oldest first.
 */
export async function listAllOpenLifecycleAlerts(
  operations: TaskRecoveryOperations,
): Promise<OpenLifecycleAlert[]> {
  const rows = await operations.listOpenLifecycleAlerts()
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    rule: r.rule as LifecycleAlertRule,
    severity: r.severity as InvariantSeverity,
    detail: safeParseDetail(r.detail),
    detectedAt: r.detectedAt,
  }))
}

function safeParseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { raw }
  } catch {
    return { raw }
  }
}
