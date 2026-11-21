// RFC-530 — the tests' execution module. Production builds one per session binding (`composeProcessTaskExecutionBinding`
// in task-execution's composition); tests that drive tasks without a composed daemon share this one and reset it per
// file, as they did with the process-level instance the composition root used to build at import time.
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createProcessTaskExecutionModule,
  type TaskExecutionModule,
} from '@/modules/task-execution/composition'
import type { TaskExecutionBinding } from '@/modules/task-execution/composition/taskExecutionBinding'

/** The tests' shared module (what tests used to import as `taskExecutionModule`). */
export const testTaskExecutionModule: TaskExecutionModule = createProcessTaskExecutionModule(
  `test-${ulid()}`,
)

/** A separate module with its own claim gate and registry (default: a fresh test generation). */
export function createTaskExecutionTestModule(
  daemonGeneration: string = `test-${ulid()}`,
): TaskExecutionModule {
  return createProcessTaskExecutionModule(daemonGeneration)
}

/**
 * The SQLite execution binding over the tests' shared module: helpers that compose a runtime directly drive and observe
 * the same module, as they did when the binding used the process-level instance. (Production's binding builds its own
 * module per session; tests composing the real daemon read the module from the composed runtime.)
 */
export function testProcessTaskExecutionBinding(db: PersistenceDb): TaskExecutionBinding {
  return Object.freeze({
    module: testTaskExecutionModule,
    claim: (intentId: string) => testTaskExecutionModule.claim({ db, intentId }),
    legacyConnection: db,
  })
}
