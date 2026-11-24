// RFC-568 — the task detail read as the suites use it: `getTask(db, id)`. The production read takes Resource Catalog's
// workflow read factory next to the handle (bootstrap hands it over); this helper binds the owner's factory the same way,
// so the suites keep reading a task by handle and id.
import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/infrastructure/executionResourceQueries'
import { getTask as readTaskDetail } from '@/modules/task-execution/infrastructure/taskDetailRead'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export function getTask(db: PersistenceDb, id: string) {
  return readTaskDetail({ db, createWorkflowExecutionQueries }, id)
}
