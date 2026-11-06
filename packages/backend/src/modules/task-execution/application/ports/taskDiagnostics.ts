// RFC-452 — the task diagnostics surface behind `/api/tasks/:id/{alerts,recovery-events,clear-recovery-suspension,
// diagnose}` and the node-run session / inventory / startup-verification reads. Composition binds the recovery
// operations, the read models, the prompt and archived-event reads and the deployment's inventory content; routes
// depend only on this contract.

import type {
  RuntimeInventoryResponse,
  SessionViewResponse,
  StartupVerificationResponse,
  TaskDiagnoseResponse,
  TaskLifecycleAlert,
  TaskRecoveryEventsResponse,
} from '@agent-workflow/shared'
import type { TaskRouteLifecycleAlertNotice } from '../../public/types'

/** Where a diagnose pass reports alert changes (the route broadcasts them on the tasks-list channel). */
export interface TaskLifecycleAlertNotices {
  /** A new open alert, or an existing one promoted from warning to error. */
  alert(notice: TaskRouteLifecycleAlertNotice, transition: 'new' | 'promoted'): void
  /** The task's open alert set shrank during the pass. */
  resolved(taskId: string): void
}

export interface TaskDiagnostics {
  /** Open lifecycle alerts for one task, oldest first (the stuck-task banner's source). */
  openAlerts(taskId: string): Promise<TaskLifecycleAlert[]>
  /** The task's system recovery audit trail, newest first, and whether auto-recovery is quarantined. */
  recoveryHistory(taskId: string): Promise<TaskRecoveryEventsResponse>
  /** Clears an auto-recovery quarantine so the auto loops may retry the task. */
  clearRecoverySuspension(taskId: string): Promise<void>
  /** A live invariant scan of one task, merged with the open stuck-rule rows that scan does not produce. */
  diagnose(taskId: string, notices: TaskLifecycleAlertNotices): Promise<TaskDiagnoseResponse>
  sessionTree(taskId: string, nodeRunId: string): Promise<SessionViewResponse>
  runtimeInventory(taskId: string, nodeRunId: string): Promise<RuntimeInventoryResponse>
  startupVerification(taskId: string, nodeRunId: string): Promise<StartupVerificationResponse>
}
