import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { cachedRepos } from '@/db/schema'

/**
 * Test-only adapter for fixtures whose "cached repository" is an intentionally
 * local, already-prepared Git directory. Production composition must use the
 * credential-aware fetch adapter from developmentDeliveryDeps.
 */
export function staticCachedRepositoryPreparation(db: DbClient): {
  readonly prepare: (input: { readonly repositoryId: string }) => Promise<{
    readonly id: string
    readonly localPath: string
    readonly defaultBranch: string | null
  }>
} {
  return {
    async prepare(input) {
      const row = db
        .select({
          id: cachedRepos.id,
          localPath: cachedRepos.localPath,
          defaultBranch: cachedRepos.defaultBranch,
        })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, input.repositoryId))
        .get()
      if (row === undefined) {
        throw new Error(`cached repository is unavailable: ${input.repositoryId}`)
      }
      return row
    },
  }
}
