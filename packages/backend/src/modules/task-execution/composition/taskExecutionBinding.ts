import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createProcessTaskExecutionModule,
  createProviderTaskExecutionModule,
  type ClaimedTaskExecution,
  type TaskExecutionModule,
} from '../composition'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'

/** RFC-388: deployment lifetime and claim strategy are the runtime's only execution binding. */
export interface TaskExecutionBinding {
  readonly module: TaskExecutionModule
  readonly claim: (intentId: string) => Promise<ClaimedTaskExecution>
  /** Retains the process deployment's isolation cleanup receipt. */
  readonly legacyConnection?: PersistenceDb
}

/** RFC-530: the process deployment's module is built here, once per session binding (as the PostgreSQL one is). */
export function composeProcessTaskExecutionBinding(input: {
  readonly db: PersistenceDb
  readonly daemonGeneration: string
}): TaskExecutionBinding {
  const { db } = input
  const module = createProcessTaskExecutionModule(input.daemonGeneration)
  return Object.freeze({
    module,
    claim: (intentId: string) => module.claim({ db, intentId }),
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
