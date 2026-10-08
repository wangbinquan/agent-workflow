import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskRuntimeSessionLeaseExecutionOperations } from '../application/ports/taskRuntimeSessionLeaseExecutionOperations'
import { createRuntimeSessionLeaseOperations } from '../infrastructure/runtimeSessionLeaseOperations'
import { createSelectedTaskRuntimeSessionLeaseOperations } from '../infrastructure/taskRuntimeSessionLeaseOperations'
import type { TaskHostWriteBinding } from '../infrastructure/hostExecutionWriteTransaction'

/** Explicit Task-only selection; the original complete native factory remains unchanged. */
export function createTaskRuntimeSessionLeaseExecutionOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly hostWrites: TaskHostWriteBinding
}): TaskRuntimeSessionLeaseExecutionOperations {
  return createSelectedTaskRuntimeSessionLeaseOperations({
    db: input.db,
    operations: createRuntimeSessionLeaseOperations(input.db),
    hostWrites: input.hostWrites,
  })
}
