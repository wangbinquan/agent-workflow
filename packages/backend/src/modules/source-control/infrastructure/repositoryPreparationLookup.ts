import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

export function createRepositoryPreparationLookup(db: PersistenceDb) {
  return {
    async findLocalPath(cachedRepoId: string): Promise<string | null> {
      const { cachedRepos } = tablesOf(db)
      const row = (
        await db.select().from(cachedRepos).where(eq(cachedRepos.id, cachedRepoId)).limit(1)
      )[0]
      return row?.localPath ?? null
    },
  }
}
