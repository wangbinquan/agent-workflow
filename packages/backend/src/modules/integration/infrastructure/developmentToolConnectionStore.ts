import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentAdapterDefinitionRevisions,
  developmentAdapterDefinitions,
  resourceGrants,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { DevelopmentAdapterIdentityRow } from '../application/developmentAdapterCommands'

interface DevelopmentToolConnectionStore {
  identity(id: string): Promise<DevelopmentAdapterIdentityRow | null>
  identities(): Promise<readonly DevelopmentAdapterIdentityRow[]>
  revision(
    id: string,
    revision: number,
  ): Promise<{ readonly contentJson: string; readonly contentDigest: string } | null>
  grantedUserIds(id: string): Promise<ReadonlySet<string>>
}

function identityRow(
  row: typeof developmentAdapterDefinitions.$inferSelect,
): DevelopmentAdapterIdentityRow {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    draftJson: row.draftJson,
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

export function createSqliteDevelopmentToolConnectionStore(
  db: DbClient,
): DevelopmentToolConnectionStore {
  return {
    async identity(id) {
      const row = db
        .select()
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, id))
        .get()
      return row === undefined ? null : identityRow(row)
    },
    async identities() {
      return db.select().from(developmentAdapterDefinitions).all().map(identityRow)
    },
    async revision(id, revision) {
      return (
        db
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
          .get() ?? null
      )
    },
    async grantedUserIds(id) {
      return new Set(
        db
          .select({ userId: resourceGrants.userId })
          .from(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, 'development_adapter'),
              eq(resourceGrants.resourceId, id),
            ),
          )
          .all()
          .map((row) => row.userId),
      )
    },
  }
}

export function createPostgresqlDevelopmentToolConnectionStore(
  db: PostgresqlDatabaseClient,
): DevelopmentToolConnectionStore {
  return {
    async identity(id) {
      const row = await db
        .select()
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, id))
        .limit(1)
        .get()
      return row === undefined ? null : identityRow(row)
    },
    async identities() {
      return (await db.select().from(developmentAdapterDefinitions).all()).map(identityRow)
    },
    async revision(id, revision) {
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
    async grantedUserIds(id) {
      return new Set(
        (
          await db
            .select({ userId: resourceGrants.userId })
            .from(resourceGrants)
            .where(
              and(
                eq(resourceGrants.resourceType, 'development_adapter'),
                eq(resourceGrants.resourceId, id),
              ),
            )
            .all()
        ).map((row) => row.userId),
      )
    },
  }
}

export type { DevelopmentToolConnectionStore }
