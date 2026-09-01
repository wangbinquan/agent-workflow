// RFC-349 — provider-owned proof used before filesystem plugin-generation GC.
// The maintenance application receives only a closed clear/busy answer; neither
// database client nor task rows cross this infrastructure boundary.

import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import { inArray, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'

export type MaintenanceExecutionFence = () => Promise<'clear' | 'busy'>

export function createSqliteMaintenanceExecutionFence(db: DbClient): MaintenanceExecutionFence {
  return async () => {
    // The full-scale maintenance corpus has millions of terminal node runs.
    // Pin this existence probe to the covering status index: SQLite may choose
    // a table scan after ANALYZE because the IN-list spans most enum values,
    // even when the live dataset contains no matching row.
    const statuses = sql.join(
      CANCELABLE_TASK_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )
    const active = db.all<{ readonly present: number }>(sql`
      SELECT 1 AS present
      FROM node_runs INDEXED BY idx_node_runs_status_active
      WHERE status IN (${statuses})
      LIMIT 1
    `)
    return active.length === 0 ? 'clear' : 'busy'
  }
}

export function createPostgresqlMaintenanceExecutionFence(
  db: PostgresqlDatabaseClient,
): MaintenanceExecutionFence {
  return async () => {
    const active = await db
      .select({ present: sql<number>`1` })
      .from(nodeRuns)
      .where(inArray(nodeRuns.status, [...CANCELABLE_TASK_STATUSES]))
      .limit(1)
    return active.length === 0 ? 'clear' : 'busy'
  }
}
