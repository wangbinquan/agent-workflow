// RFC-565 — Task Execution's knowledge read as bootstrap builds it: on the given handle, with Source Control's
// same-statement repository existence fragment. Memory's stores take it as a constructor input (it left the public).
import { repositoryExistsExpression } from '@/modules/source-control/infrastructure/repositoryIdentityQueries'
import { createTaskKnowledgeQueries } from '@/modules/task-execution/infrastructure/taskKnowledgeQueries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export function taskKnowledgeQueriesFor(db: PersistenceDb) {
  return createTaskKnowledgeQueries(db, repositoryExistsExpression)
}
