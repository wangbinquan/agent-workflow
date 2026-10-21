import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createProviderTaskExecutionModule,
  taskExecutionModule,
  type ClaimedTaskExecution,
  type TaskExecutionModule,
} from '../composition'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'

/** RFC-388: deployment lifetime and claim strategy are the runtime's only execution binding. */
export interface TaskExecutionBinding {
  readonly module: TaskExecutionModule
  readonly claim: (intentId: string) => Promise<ClaimedTaskExecution>
  /** Retains the process deployment's isolation cleanup receipt. */
  readonly legacyConnection?: ProviderNeutralDatabase
}

export function composeProcessTaskExecutionBinding(
  db: ProviderNeutralDatabase,
): TaskExecutionBinding {
  return Object.freeze({
    module: taskExecutionModule,
    claim: (intentId: string) => taskExecutionModule.claim({ db, intentId }),
    legacyConnection: db,
  })
}

export function composeSessionTaskExecutionBinding(input: {
  readonly daemonGeneration: string
  readonly persistence: TaskExecutionPersistence
}): TaskExecutionBinding {
  const module = createProviderTaskExecutionModule(input)
  return Object.freeze({
    module,
    claim: (intentId: string) => module.claimPersisted({ intentId }),
  })
}
