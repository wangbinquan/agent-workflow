import { plugins } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { PluginGenerationReferenceReadPort } from '../application/ports/pluginGenerationGc'

export function createPostgresqlPluginGenerationReferenceReadPort(
  db: PostgresqlDatabaseClient,
): PluginGenerationReferenceReadPort {
  return Object.freeze({
    async listReferencedCachedPaths(): Promise<readonly string[]> {
      const rows = await db.select({ cachedPath: plugins.cachedPath }).from(plugins).all()
      return Object.freeze(rows.map((row) => row.cachedPath))
    },
  })
}
