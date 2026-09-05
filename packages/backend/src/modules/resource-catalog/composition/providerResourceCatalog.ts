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
import { createResourceCatalogSummaryReadPort } from '../infrastructure/catalogQuery'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createResourceAclReadPort,
  createResourceCatalogAclIdentityReadPort,
} from '../infrastructure/aclReadRepository'
import {
  createResourceAclMutationPort,
  type ResourceAclMutationLifecycle,
} from '../infrastructure/resourceAclRepository'
import { createResourceGrantReadPort } from '../infrastructure/resourceVisibility'

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

/**
 * RFC-359 W4-D3：目录自有 ACL 类型的读 / 写 / owner-name 预检端口只有一份中立实现，两个 provider 装同一份。
 * 非自有类型（development_adapter / employee_*）仍由各 owner 的 identity persistence 经 composition/resourceAcl.ts 承担。
 */
export function composeResourceCatalogFor(input: {
  readonly db: ProviderNeutralDatabase
  readonly lifecycle?: ResourceAclMutationLifecycle
}): ProviderResourceCatalogComposition {
  return composeProviderResourceCatalog(
    Object.freeze({
      grants: createResourceGrantReadPort(input.db),
      reads: createResourceAclReadPort(input.db),
      mutations: createResourceAclMutationPort(input.db, input.lifecycle),
      identities: createResourceCatalogAclIdentityReadPort(input.db),
    }),
    createResourceCatalogSummaryReadPort(input.db),
  )
}

/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export function composeSqliteResourceCatalog(input: {
  readonly db: DbClient
  readonly lifecycle?: ResourceAclMutationLifecycle
}): ProviderResourceCatalogComposition {
  return composeResourceCatalogFor(input)
}

export function composePostgresqlResourceCatalog(input: {
  readonly db: PostgresqlDatabaseClient
  readonly lifecycle?: ResourceAclMutationLifecycle
}): ProviderResourceCatalogComposition {
  return composeResourceCatalogFor(input)
}
