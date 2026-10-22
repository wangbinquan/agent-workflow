import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
/**
 * Test-only adapter for fixtures whose "cached repository" is an intentionally
 * local, already-prepared Git directory. Production composition must use the
 * credential-aware fetch adapter from developmentDeliveryDeps.
 */
export function staticCachedRepositoryPreparation(db: PersistenceDb): {
  readonly prepare: (input: { readonly repositoryId: string }) => Promise<{
    readonly id: string
    readonly localPath: string
    readonly defaultBranch: string | null
  }>
} {
  return {
    async prepare(input) {
      const { cachedRepos } = tablesOf(db)
      const row = (
        await db
          .select({
            id: cachedRepos.id,
            localPath: cachedRepos.localPath,
            defaultBranch: cachedRepos.defaultBranch,
          })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, input.repositoryId))
      )[0]
      if (row === undefined) {
        throw new Error(`cached repository is unavailable: ${input.repositoryId}`)
      }
      return row
    },
  }
}
