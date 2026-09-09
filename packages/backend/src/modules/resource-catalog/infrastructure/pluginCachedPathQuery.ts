import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabaseForMode } from '@/db/query'
import { plugins } from '@/db/schema'

export function pluginCachedPathQuery<TMode extends 'sync' | 'async'>(
  db: ProviderNeutralDatabaseForMode<TMode>,
  artifact: { readonly pluginId: string },
) {
  return db
    .select({ cachedPath: plugins.cachedPath })
    .from(plugins)
    .where(eq(plugins.id, artifact.pluginId))
}
