// RFC-359 W4-B6 —— 工作区维护存储：一份实现，两个 provider 共用。

import { rawRows } from '@/platform/persistence/queryHelpers'
import type { SQLWrapper } from 'drizzle-orm'

import type { RawRowCodecs } from '@/platform/persistence/queryHelpers'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  WorkspaceMaintenanceSqlStore,
  type WorkspaceMaintenanceSqlExecutor,
} from './workspaceMaintenanceSqlStore'

function executor(db: PersistenceDb): WorkspaceMaintenanceSqlExecutor {
  return {
    db,
    async all<T extends Record<string, unknown>>(
      query: SQLWrapper,
      codecs?: RawRowCodecs<T>,
    ): Promise<readonly T[]> {
      return await rawRows<T>(db, query, codecs)
    },
  }
}

export class DrizzleWorkspaceMaintenanceStore extends WorkspaceMaintenanceSqlStore {
  constructor(db: PersistenceDb) {
    super(executor(db))
  }
}
