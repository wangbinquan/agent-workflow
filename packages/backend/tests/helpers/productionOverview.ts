// RFC-359 W12：性能用例按各 provider 的实际生产入口查询同一个真库。
// SQLite server 仍使用 buildOverview；PG daemon 使用五个 owner 的查询组合。
import type { OverviewResponse } from '@agent-workflow/shared'

import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import {
  composeIdentityAccess,
  type IdentityAccessRuntime,
} from '../../src/modules/identity-access/composition'
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
import type { SystemOverviewQuery } from '../../src/modules/system-operations/public/queries'
import { createTaskOverviewQuery } from '../../src/modules/task-execution/composition/taskOverview'
import type { PostgresqlDatabaseClient } from '../../src/platform/persistence/postgresqlDatabaseClient'
import { buildOverview } from '../../src/services/overview'
import { assertNotBuiltin } from '../../src/services/systemResources'
import { memoryCatalogOf } from './memoryCatalog'
import { resourceScopeAuthority, TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'

function isPostgresql(db: ProviderNeutralDatabase): db is PostgresqlDatabaseClient {
  return Reflect.get(db, '$provider') === 'postgresql'
}

function assertSqlite(db: ProviderNeutralDatabase): asserts db is DbClient {
  if (isPostgresql(db)) throw new Error('unsupported-overview-test-provider')
}

function unusedCapability(): never {
  throw new Error('overview-query-invoked-unused-write-capability')
}

function postgresqlOverviewParts(
  db: PostgresqlDatabaseClient,
  identityAccess: IdentityAccessRuntime,
) {
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
  return { overviewActors, resourceCatalog, store, scheduledTaskRuntime, memories }
}

function postgresqlOverviewDependencies(
  db: PostgresqlDatabaseClient,
  {
    resourceCatalog,
    store,
    scheduledTaskRuntime,
    memories,
  }: ReturnType<typeof postgresqlOverviewParts>,
) {
  return {
    resourceCatalog,
    repositories: composeRepositoryWorkspaceOperations(store, undefined).overviewQueries,
    integration: scheduledTaskRuntime.overview,
    memories,
    tasks: createTaskOverviewQuery(db),
  }
}

/** Construct once before HTTP timing; each request still reads the current database. */
export function createProductionOverviewQuery(
  db: ProviderNeutralDatabase,
  identityAccess: IdentityAccessRuntime,
): SystemOverviewQuery {
  if (isPostgresql(db)) {
    const parts = postgresqlOverviewParts(db, identityAccess)
    const query = composeSystemOverviewQuery(postgresqlOverviewDependencies(db, parts))
    return {
      execute(request) {
        parts.overviewActors.set(request.authority, request.actor)
        return query.execute(request)
      },
    }
  }

  assertSqlite(db)
  const store = composeSqliteRepositoryWorkspaceStore(db)
  const repositories = composeRepositoryWorkspaceOperations(store, undefined).overviewQueries
  const memories = composeMemoryCatalogOperations({
    db,
    contexts: identityAccess.contexts,
    authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
  })
  return { execute: (request) => buildOverview(db, request, repositories, memories) }
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
    const parts = postgresqlOverviewParts(db, identityAccess)
    parts.overviewActors.set(request.authority, request.actor)
    return composeSystemOverviewQuery(postgresqlOverviewDependencies(db, parts)).execute(request)
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
