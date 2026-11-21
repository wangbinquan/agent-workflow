import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
// RFC-395 II-b package O3: the legacy enforcer tests receive production facts/audit/cancellation ports.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeResourceLimitOperations } from '@/bootstrap/resourceLimits'
import { enforceLimits as enforceLimitsWithPorts } from '@/modules/task-execution/application/resourceLimitEnforcement'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
import { composeTaskCancellation } from './taskCancellation'

export function enforceLimits(db: PersistenceDb, now?: number) {
  return enforceLimitsWithPorts(
    composeResourceLimitOperations({
      db,
      cancelTask: (taskId, reason) =>
        composeTaskCancellation(
          db,
          epoch2RuntimeTestPorts(db).historyRestrictions,
          composeHumanGateOpenParticipantFactory(),
          createFileWorkspacePresenceQueries(),
        ).cancel(taskId, {
          kind: 'resource-reaped',
          ...reason,
        }),
    }),
    now,
  )
}
