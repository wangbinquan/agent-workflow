// RFC-452 — assembles the task diagnostics surface the tasks route reaches: the recovery reads and the diagnose pass go
// to the recovery operations, and the three node-run reads keep their read models, prompt / archived-event reads and the
// deployment's inventory content. Every dependency is a required parameter (RFC-359 W1-T1: "not composed" is not
// representable), so this file only binds.

import { listOpenLifecycleAlertsForTask } from '../application/lifecycleAlerts/openLifecycleAlerts'
import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { TaskDiagnostics } from '../application/ports/taskDiagnostics'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { TaskRuntimeInventoryContent } from '../application/ports/taskRuntimeInventoryContent'
import { clearAutoRecoverySuspension } from '../application/recovery/autoRecoveryBreaker'
import { diagnoseTask, readTaskRecoveryHistory } from '../application/taskDiagnostics'
import { getRuntimeInventory } from '../infrastructure/runtimeInventoryRead'
import { getSessionTree } from '../infrastructure/sessionTreeRead'
import { getStartupVerification } from '../infrastructure/startupVerificationRead'
import type { TaskArchivedEventsReader, TaskExecutionReadModels } from '../public/types'

export function composeTaskDiagnostics(input: {
  readonly recovery: TaskRecoveryOperations
  readonly readModels: TaskExecutionReadModels
  readonly nodeRunPrompts: NodeRunPromptOperations
  /** Absent: the session read falls back to the local event archive files (as the route's call did). */
  readonly archivedEvents?: TaskArchivedEventsReader | undefined
  readonly runtimeInventoryContent: TaskRuntimeInventoryContent
}): TaskDiagnostics {
  const { recovery, readModels } = input
  const diagnostics: TaskDiagnostics = {
    openAlerts: (taskId) => listOpenLifecycleAlertsForTask(recovery, taskId),
    recoveryHistory: (taskId) => readTaskRecoveryHistory(recovery, taskId),
    clearRecoverySuspension: (taskId) => clearAutoRecoverySuspension(recovery, taskId),
    diagnose: (taskId, notices) => diagnoseTask(recovery, taskId, notices),
    sessionTree: (taskId, nodeRunId) =>
      getSessionTree(
        readModels.sessions,
        taskId,
        nodeRunId,
        {},
        input.nodeRunPrompts,
        input.archivedEvents,
      ),
    runtimeInventory: (taskId, nodeRunId) =>
      getRuntimeInventory(
        readModels.runtimeInventory,
        taskId,
        nodeRunId,
        input.runtimeInventoryContent,
      ),
    startupVerification: (taskId, nodeRunId) =>
      getStartupVerification(readModels.startupVerification, taskId, nodeRunId),
  }
  return Object.freeze(diagnostics)
}
