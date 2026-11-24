import { eq, exists, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

export async function existingRepositoryIds(
  db: PersistenceDb,
  ids: readonly string[],
): Promise<readonly string[]> {
  if (ids.length === 0) return []
  const { cachedRepos } = tablesOf(db)
  return (
    await db
      .select({ id: cachedRepos.id })
      .from(cachedRepos)
      .where(inArray(cachedRepos.id, [...ids]))
      .limit(ids.length)
  ).map((row) => row.id)
}

export function repositoryExistsExpression(
  db: PersistenceDb,
  repositoryId: SQLWrapper,
): SQL<boolean> {
  const { cachedRepos } = tablesOf(db)
  return sql<boolean>`${exists(
    db
      .select({ one: sql`1` })
      .from(cachedRepos)
      .where(eq(cachedRepos.id, repositoryId)),
  )}`.mapWith(Boolean)
}

/**
 * RFC-565: the repository identity read other contexts take, bound to one handle. Bootstrap builds it on the root handle
 * and hands it over (the public no longer offers a function that takes a database handle).
 */
export function createRepositoryIdentityQueries(db: PersistenceDb) {
  return Object.freeze({
    existingIds: (ids: readonly string[]) => existingRepositoryIds(db, ids),
  })
}
