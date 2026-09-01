import { sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { concreteDatabaseTable } from '@/db/providerSchema'
import { tasks } from '@/db/schema'
import type { HealthDatabaseReadModel } from '@/modules/system-operations/public/queries'

/** SQLite health projection. A locked or migrating database is handled by the
 * route's fail-soft liveness policy, not by hiding the provider error here. */
export function createSqliteHealthDatabaseReadModel(db: DbClient): HealthDatabaseReadModel {
  const sqliteTasks = concreteDatabaseTable(tasks, 'sqlite')
  return Object.freeze({
    async countRunningTasks() {
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(sqliteTasks)
        .where(sql`status = 'running'`)
      return Number(rows[0]?.n ?? 0)
    },
  })
}
