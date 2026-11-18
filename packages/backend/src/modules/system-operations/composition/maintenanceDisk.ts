import type { DbClient } from '@/db/client'
import type { MaintenanceDiskOperations } from '@/modules/system-operations/public/operations'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { readPostgresqlStorageFootprint } from '@/platform/persistence/postgresqlStorageFootprint'
import {
  cleanupRetiredStores,
  reportDiskReclaimable,
  reportMeasuredDiskReclaimable,
} from '@/modules/system-operations/infrastructure/local/systemMaintenanceDisk'
import { Paths } from '@/util/paths'

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

/** PostgreSQL measures its own storage in platform/persistence; system operations shapes the report (RFC-505). */
export function composePostgresqlMaintenanceDiskOperations(
  runtime: PostgresqlDatabaseRuntime,
  appHome: string = Paths.root,
): MaintenanceDiskOperations {
  return Object.freeze({
    async report() {
      return reportMeasuredDiskReclaimable(await readPostgresqlStorageFootprint(runtime), appHome)
    },
    async cleanupRetiredStores() {
      return cleanupRetiredStores(appHome)
    },
  })
}
