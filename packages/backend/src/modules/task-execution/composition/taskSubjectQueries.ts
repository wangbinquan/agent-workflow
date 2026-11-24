import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskSubjectQueries } from '../application/ports/taskSubjectQueries'
import type { WorkflowExecutionQueriesFactory } from '../infrastructure/executionResourceReads'
import { DatabaseTaskSubjectQueries } from '../infrastructure/taskSubjectQueries'

/**
 * RFC-568: the task subject query factory collaboration takes through its participant bindings, bound with Resource
 * Catalog's workflow read factory (bootstrap hands it over). The returned factory keeps the old shape — each call site
 * still passes the handle it holds.
 */
export function bindTaskSubjectQueries(
  createWorkflowExecutionQueries: WorkflowExecutionQueriesFactory,
): (db: PersistenceDb) => TaskSubjectQueries {
  return (db) => new DatabaseTaskSubjectQueries(db, createWorkflowExecutionQueries)
}
