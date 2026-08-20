import type { DbClient } from '@/db/client'
import { developmentAdapterContentSchema } from '../domain/developmentAdapterDefinition'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'

/**
 * Bootstrap adapter for the Digital Employee consumer-owned connection catalog
 * port. Only exact identity/purpose/availability crosses the boundary; provider
 * executable, connection details and secret projections stay in Integration.
 */
export function composeDevelopmentToolConnectionCatalog(db: DbClient) {
  const store = createSqliteDevelopmentAdapterStore(db)
  return {
    async resolve(ref: { readonly id: string; readonly revision: number }) {
      const identity = store.getById(ref.id)
      const revision = store.getRevision(ref.id, ref.revision)
      if (identity === null || revision === null) return null
      const content = developmentAdapterContentSchema.parse(JSON.parse(revision.contentJson))
      const available = identity.archivedAt === null
      return {
        ref,
        purpose: content.purpose,
        available,
        closureSummary: `${identity.name}; ${content.purpose}; exact revision ${ref.revision}; ${available ? 'available' : 'archived'}`,
      }
    },
  }
}
