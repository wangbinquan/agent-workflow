import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskSubjectQueries } from '../application/ports/taskSubjectQueries'
import { DatabaseTaskSubjectQueries } from '../infrastructure/taskSubjectQueries'

export function createTaskSubjectQueries(db: PersistenceDb): TaskSubjectQueries {
  return new DatabaseTaskSubjectQueries(db)
}
