// RFC-359 W4-B6 —— 工作区维护存储：一份实现，两个 provider 共用。

import type { SQLWrapper } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  WorkspaceMaintenanceSqlStore,
  type WorkspaceMaintenanceSqlExecutor,
} from './workspaceMaintenanceSqlStore'

function executor(db: ProviderNeutralDatabase): WorkspaceMaintenanceSqlExecutor {
  return {
    async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
      return (await db.all(query)) as readonly T[]
    },
  }
}

export class DrizzleWorkspaceMaintenanceStore extends WorkspaceMaintenanceSqlStore {
  constructor(db: ProviderNeutralDatabase) {
    super(executor(db))
  }
}
