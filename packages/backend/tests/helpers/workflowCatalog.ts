// RFC-359 —— 双引擎测试用的工作流目录装配：按客户端品牌选 provider 组合器，用例体本身看不见 provider。

import { buildActor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { composePostgresqlResourceCatalog } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  composePostgresqlWorkflowCatalog,
  composeWorkflowCatalog,
} from '@/modules/resource-catalog/composition/workflowOperations'
import { createPostgresqlWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/postgresqlWorkflowPersistenceSemantics'
import type { WorkflowCatalogModule } from '@/modules/resource-catalog/public/operations'
import type { WorkflowOperationContext } from '@/modules/resource-catalog/public/participants'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export function workflowCatalogFor(db: ProviderNeutralDatabase): WorkflowCatalogModule {
  const provider = databaseSessionFor(db).engine.provider
  if (provider === 'sqlite') return composeWorkflowCatalog({ db: db as unknown as DbClient })
  if (provider === 'postgresql') {
    const pg = db as unknown as PostgresqlDatabaseClient
    const resourceCatalog = composePostgresqlResourceCatalog({ db: pg })
    return composePostgresqlWorkflowCatalog({
      db: pg,
      persistence: createPostgresqlWorkflowPersistenceSemantics({
        authorization: resourceCatalog.authorization,
      }),
      skillContent: { isAvailable: async () => true },
      resourceCatalog,
    })
  }
  return unhandledDatabaseProvider(provider)
}

export function workflowAuthorityFor(
  userId: string,
  role: 'admin' | 'user' = 'admin',
): WorkflowOperationContext {
  const actor = buildActor({
    user: { id: userId, username: `u-${userId}`, displayName: userId, role, status: 'active' },
    source: 'session',
  })
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
}
