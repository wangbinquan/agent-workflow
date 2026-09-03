import { count, sql } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { HealthDatabaseReadModel } from '../public/queries'

/** PostgreSQL health projection over the verified live-generation client. The
 * client owns the external pool and provider SQL compilation. */
export function createPostgresqlHealthDatabaseReadModel(
  db: PostgresqlDatabaseClient,
): HealthDatabaseReadModel {
  return Object.freeze({
    async countRunningTasks() {
      const rows = await db
        .select({ n: count() })
        .from(tasks)
        .where(sql`status = 'running'`)
      return Number(rows[0]?.n ?? 0)
    },
  })
}
