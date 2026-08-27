import type { DbClient } from '@/db/client'
import type { TaskExecutionReadModels } from '../application/queries/taskExecutionReadModels'
import { createSqliteTaskExecutionReadModels } from '../infrastructure/sqliteTaskExecutionReadModels'

/** RFC-331 compatibility composition; public/queries is the only legacy entry. */
export function createTaskExecutionReadModels(db: DbClient): TaskExecutionReadModels {
  return createSqliteTaskExecutionReadModels(db)
}
