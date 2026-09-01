import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger, type Logger } from '@/util/log'
import {
  createResourcePackageApplyActivityQuery,
  createResourcePackageApplyActivityRegistry,
  createResourcePackageApplyMaintenanceCommand,
  type ResourcePackageApplyActivitySource,
  type ResourcePackageApplyActivityTracker,
  type ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'
import {
  createPostgresqlResourcePackageApplyArtifactRecovery,
  createPostgresqlResourcePackageApplyJournalPort,
} from '../infrastructure/postgresqlResourcePackageMaintenance'
import {
  createSqliteResourcePackageApplyArtifactRecovery,
  createSqliteResourcePackageApplyJournalPort,
} from '../infrastructure/sqliteResourcePackageMaintenance'
import type { ResourcePackageApplyMaintenanceCommand } from '../public/commands'
import type { ResourcePackageApplyActivityQuery } from '../public/queries'

export interface ResourcePackageApplyMaintenance {
  readonly command: ResourcePackageApplyMaintenanceCommand
  readonly activity: ResourcePackageApplyActivityQuery
}

export interface PostgresqlResourcePackageApplyMaintenance extends ResourcePackageApplyMaintenance {
  /** Provider-private writer used by the PostgreSQL apply owner around a claimed journal. */
  readonly activityTracker: ResourcePackageApplyActivityTracker
}

function maintenanceLog(log: Logger): ResourcePackageApplyMaintenanceLog {
  return Object.freeze({
    warn(message: string, fields: Readonly<Record<string, string>>) {
      log.warn(message, fields)
    },
  })
}

export function composeSqliteResourcePackageApplyMaintenance(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly pluginsDir: string
  readonly activitySource: ResourcePackageApplyActivitySource
  readonly now?: () => number
  readonly log?: Logger
}): ResourcePackageApplyMaintenance {
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  return Object.freeze({
    command: createResourcePackageApplyMaintenanceCommand({
      journal: createSqliteResourcePackageApplyJournalPort(input.db),
      artifacts: createSqliteResourcePackageApplyArtifactRecovery({
        db: input.db,
        appHome: input.appHome,
        pluginsDir: input.pluginsDir,
        log: maintenanceLog(log),
      }),
      ...(input.now === undefined ? {} : { now: input.now }),
      log: maintenanceLog(log),
    }),
    activity: createResourcePackageApplyActivityQuery(input.activitySource),
  })
}

export function composePostgresqlResourcePackageApplyMaintenance(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly pluginsDir: string
  readonly now?: () => number
  readonly log?: Logger
}): PostgresqlResourcePackageApplyMaintenance {
  const activity = createResourcePackageApplyActivityRegistry()
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  return Object.freeze({
    command: createResourcePackageApplyMaintenanceCommand({
      journal: createPostgresqlResourcePackageApplyJournalPort(input.db),
      artifacts: createPostgresqlResourcePackageApplyArtifactRecovery({
        db: input.db,
        appHome: input.appHome,
        pluginsDir: input.pluginsDir,
      }),
      ...(input.now === undefined ? {} : { now: input.now }),
      log: maintenanceLog(log),
    }),
    activity: activity.query,
    activityTracker: activity.tracker,
  })
}
