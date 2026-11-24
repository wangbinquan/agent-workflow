// RFC-568 — Resource Catalog's execution resource reads as Task Execution takes them: factory references. Each call site
// passes the handle it holds (a read inside a transaction stays inside it), exactly as it did when it imported the
// factories; bootstrap hands over the owner's from resource-catalog's composition. The reads they return are the closed
// contracts Resource Catalog keeps on its public.
import type {
  AgentExecutionQueries,
  WorkflowExecutionQueries,
} from '@/modules/resource-catalog/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export type AgentExecutionQueriesFactory = (db: PersistenceDb) => AgentExecutionQueries
export type WorkflowExecutionQueriesFactory = (db: PersistenceDb) => WorkflowExecutionQueries

/** What a read that names a task's workflow takes: the handle it reads on, and the workflow read factory. */
export type WorkflowReadSource = Readonly<{
  db: PersistenceDb
  createWorkflowExecutionQueries: WorkflowExecutionQueriesFactory
}>
