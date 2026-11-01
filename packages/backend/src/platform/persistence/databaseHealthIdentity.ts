// RFC-398 §2.7: inspect the selected connection, including pointer-derived databases.
import { sql } from 'drizzle-orm'
import type { PersistenceDb } from './persistenceDb'
import type { DatabaseProvider } from './databaseProviders'
import { engineOf } from './databaseTransaction'

export function createDatabaseHealthIdentity(db: PersistenceDb, provider: DatabaseProvider) {
  return async (): Promise<{ provider: DatabaseProvider; databaseName: string | null }> => {
    const databaseName = engineOf(db).databaseName()
    if (databaseName === null) return { provider, databaseName: null }
    const rows = await db.select({ databaseName }).from(sql`(SELECT 1) AS health_identity`)
    if (!rows[0]?.databaseName) throw new Error('Database identity query returned no name')
    return { provider, databaseName: rows[0].databaseName }
  }
}
