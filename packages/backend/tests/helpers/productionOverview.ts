// RFC-359 W12：性能用例按各 provider 的实际生产入口查询同一个真库。
// SQLite server 仍使用 buildOverview；PG daemon 使用五个 owner 的查询组合。
import type { OverviewResponse } from '@agent-workflow/shared'

import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import { composePostgresqlScheduledTaskRuntime } from '../../src/modules/integration/composition/scheduledTasks'
import { composeMemoryCatalogOperations } from '../../src/modules/memory/composition'
import { composePostgresqlIntegrationTriggerResourceSnapshotFactory } from '../../src/modules/resource-catalog/composition/integrationTrigger'
import { composePostgresqlResourceCatalogOverviewQuery } from '../../src/modules/resource-catalog/composition/resourceCatalogOverview'
import {
  composePostgresqlRepositoryWorkspaceStore,
  composeRepositoryWorkspaceOperations,
  composeSqliteRepositoryWorkspaceStore,
} from '../../src/modules/source-control/composition'
import { composeSystemOverviewQuery } from '../../src/modules/system-operations/application/overview'
import { createTaskOverviewQuery } from '../../src/modules/task-execution/composition/taskOverview'
import type { PostgresqlDatabaseClient } from '../../src/platform/persistence/postgresqlDatabaseClient'
import { buildOverview } from '../../src/services/overview'
import { assertNotBuiltin } from '../../src/services/systemResources'
import { memoryCatalogOf } from './memoryCatalog'
import { resourceScopeAuthority, TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'

function isPostgresql(db: ProviderNeutralDatabase): db is PostgresqlDatabaseClient {
  return '$provider' in db && db.$provider === 'postgresql'
}

function assertSqlite(db: ProviderNeutralDatabase): asserts db is DbClient {
  if ('$provider' in db) throw new Error('unsupported-overview-test-provider')
}

function unusedCapability(): never {
  throw new Error('overview-query-invoked-unused-write-capability')
}

export function runProductionOverview(
  db: ProviderNeutralDatabase,
  actor: Actor,
): Promise<OverviewResponse> {
  if (isPostgresql(db)) {
    const identityAccess = composeIdentityAccess(db)
    const context = identityAccess.contexts.fromAuthenticatedPrincipal(
      { userId: actor.user.id, source: actor.source },
      'http',
    )
    const request = { actor, authority: context.authority }
    const overviewActors = new WeakMap<object, Actor>()
    const resourceCatalog = composePostgresqlResourceCatalogOverviewQuery(db, {
      resolve(authority) {
        const resolved = overviewActors.get(authority)
        if (resolved === undefined) throw new Error('foreign-overview-authority')
        return resolved
      },
    })
    const store = composePostgresqlRepositoryWorkspaceStore(db)
    const scheduledTaskRuntime = composePostgresqlScheduledTaskRuntime({
      db,
      resourceSnapshots: composePostgresqlIntegrationTriggerResourceSnapshotFactory({
        assertNotBuiltin,
      }),
      validation: {
        assertWorkflowLaunchable: unusedCapability,
        assertAgentIntegrity: unusedCapability,
      },
      resourceAclChanged: unusedCapability,
    })
    const memories = composeMemoryCatalogOperations({
      db,
      contexts: identityAccess.contexts,
      authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
    })
    overviewActors.set(request.authority, request.actor)
    return composeSystemOverviewQuery({
      resourceCatalog,
      repositories: composeRepositoryWorkspaceOperations(store, undefined).overviewQueries,
      integration: scheduledTaskRuntime.overview,
      memories,
      tasks: createTaskOverviewQuery(db),
    }).execute(request)
  }

  assertSqlite(db)
  const store = composeSqliteRepositoryWorkspaceStore(db)
  return buildOverview(
    db,
    resourceScopeAuthority(db, actor),
    composeRepositoryWorkspaceOperations(store, undefined).overviewQueries,
    memoryCatalogOf(db),
  )
}
