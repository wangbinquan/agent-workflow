import type { SQLWrapper } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  WorkspaceMaintenanceSqlStore,
  type WorkspaceMaintenanceSqlExecutor,
} from './workspaceMaintenanceSqlStore'

function sqliteExecutor(db: DbClient): WorkspaceMaintenanceSqlExecutor {
  return {
    async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
      return db.all(query) as T[]
    },
  }
}

export class SqliteWorkspaceMaintenanceStore extends WorkspaceMaintenanceSqlStore {
  constructor(db: DbClient) {
    super(sqliteExecutor(db))
  }
}
