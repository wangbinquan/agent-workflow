import type { SQLWrapper } from 'drizzle-orm'

import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  WorkspaceMaintenanceSqlStore,
  type WorkspaceMaintenanceSqlExecutor,
} from './workspaceMaintenanceSqlStore'

function postgresqlExecutor(db: PostgresqlDatabaseClient): WorkspaceMaintenanceSqlExecutor {
  return {
    async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
      return await db.all<T>(query)
    },
  }
}

export class PostgresqlWorkspaceMaintenanceStore extends WorkspaceMaintenanceSqlStore {
  constructor(db: PostgresqlDatabaseClient) {
    super(postgresqlExecutor(db))
  }
}
