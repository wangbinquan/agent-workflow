import type { DbClient } from '@/db/client'
import { plugins } from '@/db/schema'
import type { PluginGenerationReferenceReadPort } from '../application/ports/pluginGenerationGc'

export function createSqlitePluginGenerationReferenceReadPort(
  db: DbClient,
): PluginGenerationReferenceReadPort {
  return Object.freeze({
    async listReferencedCachedPaths(): Promise<readonly string[]> {
      const rows = await db.select({ cachedPath: plugins.cachedPath }).from(plugins)
      return Object.freeze(rows.map((row) => row.cachedPath))
    },
  })
}
