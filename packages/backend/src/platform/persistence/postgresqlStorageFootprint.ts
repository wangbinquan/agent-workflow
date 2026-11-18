// RFC-505 (RFC-294 S10 step 12): the PostgreSQL storage footprint read, moved verbatim out of
// modules/system-operations/composition/maintenanceDisk.ts. The dialect SQL lives here, the home of
// provider-specific persistence (RFC-359 W5-T17); system operations shapes the footprint into its
// maintenance disk report (`reportMeasuredDiskReclaimable`).
import type { PostgresqlDatabaseRuntime } from './postgresqlRuntime'

function nonNegativeInteger(value: unknown, detail: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`maintenance disk metric is invalid: ${detail}`)
  }
  return parsed
}

/**
 * PostgreSQL owns its storage projection. `n_dead_tup` is a catalog estimate,
 * so the reclaimable byte value is deliberately an estimate too; no VACUUM,
 * SQLite PRAGMA, or local database file is opened by this read path.
 */
export async function readPostgresqlStorageFootprint(runtime: PostgresqlDatabaseRuntime) {
  const rows = await runtime
    .providerPool()
    .unsafe(
      'SELECT pg_database_size(current_database()) AS database_bytes, ' +
        'COALESCE(sum(' +
        'pg_total_relation_size(relid)::numeric * n_dead_tup::numeric / ' +
        'GREATEST(n_live_tup + n_dead_tup, 1)::numeric' +
        '), 0)::bigint AS reclaimable_bytes ' +
        "FROM pg_catalog.pg_stat_user_tables WHERE schemaname = 'agent_workflow'",
    )
  return Object.freeze({
    reclaimableBytes: nonNegativeInteger(
      rows[0]?.reclaimable_bytes,
      'PostgreSQL reclaimable bytes',
    ),
    databaseBytes: nonNegativeInteger(rows[0]?.database_bytes, 'PostgreSQL database bytes'),
  })
}
