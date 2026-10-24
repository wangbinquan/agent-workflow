// RFC-395 II-b package O3: the legacy enforcer tests receive production facts/audit/cancellation ports.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeResourceLimitOperations } from '@/bootstrap/resourceLimits'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
import { enforceLimits as enforceLimitsWithPorts } from '@/services/limits'

export function enforceLimits(db: PersistenceDb, now?: number) {
  return enforceLimitsWithPorts(
    composeResourceLimitOperations({
      db,
      cancelTask: (taskId, reason) =>
        composeTaskCancellation(db).cancel(taskId, { kind: 'resource-reaped', ...reason }),
    }),
    now,
  )
}
