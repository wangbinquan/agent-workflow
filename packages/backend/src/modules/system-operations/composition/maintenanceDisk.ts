import type { DbClient } from '@/db/client'
import type { MaintenanceDiskOperations } from '@/modules/system-operations/public/operations'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  cleanupRetiredStores,
  reportDiskReclaimable,
  reportRetiredRuntimeStores,
} from '@/platform/persistence/sqlite/systemMaintenanceDisk'
import { Paths } from '@/util/paths'

function nonNegativeInteger(value: unknown, detail: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`maintenance disk metric is invalid: ${detail}`)
  }
  return parsed
}

export function composeSqliteMaintenanceDiskOperations(
  db: DbClient,
  appHome: string = Paths.root,
): MaintenanceDiskOperations {
  return Object.freeze({
    async report() {
      return reportDiskReclaimable(db, appHome)
    },
    async cleanupRetiredStores() {
      return cleanupRetiredStores(appHome)
    },
  })
}

/**
 * PostgreSQL owns its storage projection. `n_dead_tup` is a catalog estimate,
 * so the reclaimable byte value is deliberately an estimate too; no VACUUM,
 * SQLite PRAGMA, or local database file is opened by this read path.
 */
export function composePostgresqlMaintenanceDiskOperations(
  runtime: PostgresqlDatabaseRuntime,
  appHome: string = Paths.root,
): MaintenanceDiskOperations {
  return Object.freeze({
    async report() {
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
        items: Object.freeze([reportRetiredRuntimeStores(appHome)]),
        dbFreelistBytes: nonNegativeInteger(
          rows[0]?.reclaimable_bytes,
          'PostgreSQL reclaimable bytes',
        ),
        dbFileBytes: nonNegativeInteger(rows[0]?.database_bytes, 'PostgreSQL database bytes'),
      })
    },
    async cleanupRetiredStores() {
      return cleanupRetiredStores(appHome)
    },
  })
}
