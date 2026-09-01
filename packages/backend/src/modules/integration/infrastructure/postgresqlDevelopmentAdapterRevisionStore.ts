import { and, eq } from 'drizzle-orm'

import { developmentAdapterDefinitionRevisions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export interface AsyncDevelopmentAdapterRevisionStore {
  getRevision(
    id: string,
    revision: number,
  ): Promise<{ readonly contentJson: string; readonly contentDigest: string } | null>
}

/** Read-only published adapter surface used by remote execution runners. */
export function createPostgresqlDevelopmentAdapterRevisionStore(
  db: PostgresqlDatabaseClient,
): AsyncDevelopmentAdapterRevisionStore {
  return {
    async getRevision(id, revision) {
      const row = await db
        .select({
          contentJson: developmentAdapterDefinitionRevisions.contentJson,
          contentDigest: developmentAdapterDefinitionRevisions.contentDigest,
        })
        .from(developmentAdapterDefinitionRevisions)
        .where(
          and(
            eq(developmentAdapterDefinitionRevisions.adapterId, id),
            eq(developmentAdapterDefinitionRevisions.revision, revision),
          ),
        )
        .limit(1)
        .get()
      return row ?? null
    },
  }
}
