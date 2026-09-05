import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceRequestContext } from '../public/participants'
import type { ResourceCatalogOverviewQuery } from '../public/queries'
import { createResourceCatalogOverviewQuery } from '../application/resourceCatalogOverview'
import { createResourceCatalogOverviewCountPort } from '../infrastructure/resourceCatalogOverview'

export interface ResourceCatalogOverviewAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

export function composeSqliteResourceCatalogOverviewQuery(
  db: DbClient,
  authority: ResourceCatalogOverviewAuthorityResolver,
): ResourceCatalogOverviewQuery {
  return createResourceCatalogOverviewQuery({
    authority,
    counts: createResourceCatalogOverviewCountPort(db),
  })
}

export function composePostgresqlResourceCatalogOverviewQuery(
  db: PostgresqlDatabaseClient,
  authority: ResourceCatalogOverviewAuthorityResolver,
): ResourceCatalogOverviewQuery {
  return createResourceCatalogOverviewQuery({
    authority,
    counts: createResourceCatalogOverviewCountPort(db),
  })
}
