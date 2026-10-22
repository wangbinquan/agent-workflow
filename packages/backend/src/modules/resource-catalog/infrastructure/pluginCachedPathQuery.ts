import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
export function pluginCachedPathQuery(db: PersistenceDb, artifact: { readonly pluginId: string }) {
  const { plugins } = tablesOf(db)
  return db
    .select({ cachedPath: plugins.cachedPath })
    .from(plugins)
    .where(eq(plugins.id, artifact.pluginId))
}
