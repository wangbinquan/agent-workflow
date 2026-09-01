import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createResourceAclApplication,
  type ResourceAclApplication,
} from '../application/resourceAcl'
import {
  createResourceAuthorizationApplication,
  type ResourceAuthorizationApplication,
} from '../application/resourceAuthorization'
import { createResourceCatalogQueryApplication } from '../application/resourceCatalogQuery'
import type {
  ResourceCatalogAclPersistence,
  ResourceCatalogSummaryReadPort,
} from '../application/ports/providerResourceCatalogPersistence'
import type { ResourceCatalogQuery } from '../public/queries'
import { createSqliteResourceCatalogAclIdentityReadPort } from '../infrastructure/sqliteAclReadRepository'
import { createSqliteResourceCatalogSummaryReadPort } from '../infrastructure/sqliteCatalogQuery'
import {
  createSqliteResourceAclMutationPort,
  createSqliteResourceAclReadPort,
  type SqliteResourceAclMutationLifecycle,
} from '../infrastructure/sqliteResourceAclRepository'
import { createSqliteResourceGrantReadPort } from '../infrastructure/sqliteResourceGrantRepository'
import {
  createPostgresqlResourceAclReadPort,
  createPostgresqlResourceCatalogAclIdentityReadPort,
} from '../infrastructure/postgresqlAclReadRepository'
import {
  createPostgresqlResourceAclMutationPort,
  type PostgresqlResourceAclMutationLifecycle,
} from '../infrastructure/postgresqlResourceAclRepository'
import { createPostgresqlResourceGrantReadPort } from '../infrastructure/postgresqlResourceGrantRepository'
import { createPostgresqlResourceCatalogSummaryReadPort } from '../infrastructure/postgresqlCatalogQuery'

export interface ResourceCatalogQueryFactory {
  createQuery(input: {
    readonly resolveActor: (context: QueryContext) => Actor
  }): ResourceCatalogQuery
}

export interface ProviderResourceCatalogComposition extends ResourceCatalogQueryFactory {
  readonly persistence: ResourceCatalogAclPersistence
  readonly authorization: ResourceAuthorizationApplication
  readonly acl: ResourceAclApplication
}

/** Pure application composition over one provider-selected persistence bundle. */
export function composeProviderResourceCatalog(
  persistence: ResourceCatalogAclPersistence,
  summaries: ResourceCatalogSummaryReadPort,
): ProviderResourceCatalogComposition {
  const authorization = createResourceAuthorizationApplication(persistence.grants)
  return Object.freeze({
    persistence,
    authorization,
    acl: createResourceAclApplication({
      authorization,
      mutation: persistence.mutations,
      read: persistence.reads,
    }),
    createQuery(input: { readonly resolveActor: (context: QueryContext) => Actor }) {
      return createResourceCatalogQueryApplication({
        summaries,
        resolveActor: input.resolveActor,
      })
    },
  })
}

export function composeSqliteResourceCatalog(input: {
  readonly db: DbClient
  readonly lifecycle?: SqliteResourceAclMutationLifecycle
}): ProviderResourceCatalogComposition {
  return composeProviderResourceCatalog(
    Object.freeze({
      grants: createSqliteResourceGrantReadPort(input.db),
      reads: createSqliteResourceAclReadPort(input.db),
      mutations: createSqliteResourceAclMutationPort(input.db, input.lifecycle),
      identities: createSqliteResourceCatalogAclIdentityReadPort(input.db),
    }),
    createSqliteResourceCatalogSummaryReadPort(input.db),
  )
}

export function composePostgresqlResourceCatalog(input: {
  readonly db: PostgresqlDatabaseClient
  readonly lifecycle?: PostgresqlResourceAclMutationLifecycle
}): ProviderResourceCatalogComposition {
  return composeProviderResourceCatalog(
    Object.freeze({
      grants: createPostgresqlResourceGrantReadPort(input.db),
      reads: createPostgresqlResourceAclReadPort(input.db),
      mutations: createPostgresqlResourceAclMutationPort(input.db, input.lifecycle),
      identities: createPostgresqlResourceCatalogAclIdentityReadPort(input.db),
    }),
    createPostgresqlResourceCatalogSummaryReadPort(input.db),
  )
}
