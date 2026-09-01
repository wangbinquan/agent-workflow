import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { DynamicWorkflowPersistence } from '../application/ports/dynamicWorkflowPersistence'
import { PostgresqlDynamicWorkflowPersistence } from '../infrastructure/postgresqlDynamicWorkflowPersistence'
import { SqliteDynamicWorkflowPersistence } from '../infrastructure/sqliteDynamicWorkflowPersistence'

export function composeSqliteDynamicWorkflowPersistence(db: DbClient): DynamicWorkflowPersistence {
  return new SqliteDynamicWorkflowPersistence(db)
}

export function composePostgresqlDynamicWorkflowPersistence(
  db: PostgresqlDatabaseClient,
): DynamicWorkflowPersistence {
  return new PostgresqlDynamicWorkflowPersistence(db)
}
