// RFC-395 II-b O3 — bind Task facts and the System Operations audit to the legacy policy.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ResourceLimitOperations } from '@/services/limits'
import { createTaskResourceLimitFacts } from '@/modules/task-execution/composition'
import { createResourceLimitAudit } from '@/modules/system-operations/composition'

export function composeResourceLimitOperations(input: {
  readonly db: PersistenceDb
  readonly cancelTask: ResourceLimitOperations['cancelTask']
}): ResourceLimitOperations {
  return Object.freeze({
    persistence: {
      ...createTaskResourceLimitFacts(input.db),
      ...createResourceLimitAudit(input.db),
    },
    cancelTask: input.cancelTask,
  })
}
