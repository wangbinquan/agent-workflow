import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceRequestContext } from '../public/participants'
import type { ResourceCatalogOverviewQuery } from '../public/queries'
import { createResourceCatalogOverviewQuery } from '../application/resourceCatalogOverview'
import { createPostgresqlResourceCatalogOverviewCountPort } from '../infrastructure/postgresqlResourceCatalogOverview'
import { createSqliteResourceCatalogOverviewCountPort } from '../infrastructure/sqliteResourceCatalogOverview'

export interface ResourceCatalogOverviewAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

export function composeSqliteResourceCatalogOverviewQuery(
  db: DbClient,
  authority: ResourceCatalogOverviewAuthorityResolver,
): ResourceCatalogOverviewQuery {
  return createResourceCatalogOverviewQuery({
    authority,
    counts: createSqliteResourceCatalogOverviewCountPort(db),
  })
}

export function composePostgresqlResourceCatalogOverviewQuery(
  db: PostgresqlDatabaseClient,
  authority: ResourceCatalogOverviewAuthorityResolver,
): ResourceCatalogOverviewQuery {
  return createResourceCatalogOverviewQuery({
    authority,
    counts: createPostgresqlResourceCatalogOverviewCountPort(db),
  })
}
