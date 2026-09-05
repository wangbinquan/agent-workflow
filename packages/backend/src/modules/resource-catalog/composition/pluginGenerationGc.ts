import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPluginGenerationGcCommand } from '../application/pluginGenerationGc'
import type { PluginGenerationFilesystemGcPort } from '../application/ports/pluginGenerationGc'
import type { PluginGenerationGcCommand } from '../public/commands'
import { createPluginGenerationReferenceReadPort } from '../infrastructure/pluginGenerationGc'

export function composeSqlitePluginGenerationGcCommand(
  db: DbClient,
  filesystem: PluginGenerationFilesystemGcPort,
): PluginGenerationGcCommand {
  return createPluginGenerationGcCommand({
    references: createPluginGenerationReferenceReadPort(db),
    filesystem,
  })
}

export function composePostgresqlPluginGenerationGcCommand(
  db: PostgresqlDatabaseClient,
  filesystem: PluginGenerationFilesystemGcPort,
): PluginGenerationGcCommand {
  return createPluginGenerationGcCommand({
    references: createPluginGenerationReferenceReadPort(db),
    filesystem,
  })
}
