// RFC-359 W12 / W57：性能用例按**生产入口**查询真库——现在两个 provider 是同一个入口。
//
// W12 落地时这里有一条 `if (isPostgresql(db))` 硬分叉：SQLite 走
// `platform/persistence/sqlite/systemOverviewReadModel.ts::buildOverview`，PG 走
// `composeSystemOverviewQuery`。那是**两份完整实现**（逐个聚合键对过语义等价，对账见
// RFC-359 plan §5i），是 RFC-359 要消灭的形状本身；而 `rfc311-perf-guards` 当时还用 AST
// 断言把这条分叉钉住了。W57 删掉 `buildOverview`，这里也就只剩一条路。
import type { OverviewResponse } from '@agent-workflow/shared'

import type { Actor } from '../../src/auth/actor'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import {
  composeIdentityAccess,
  type IdentityAccessRuntime,
} from '../../src/modules/identity-access/composition'
import { composeScheduledTaskRuntimeFor } from '../../src/modules/integration/composition/scheduledTasks'
import { composeMemoryCatalogOperations } from '../../src/modules/memory/composition'
import { composeIntegrationTriggerResourceSnapshotFactory } from '../../src/modules/resource-catalog/composition/integrationTrigger'
import { composeResourceCatalogOverviewQuery } from '../../src/modules/resource-catalog/composition/resourceCatalogOverview'
import {
  composeRepositoryWorkspaceOperations,
  composeRepositoryWorkspaceStore,
} from '../../src/modules/source-control/composition'
import { composeSystemOverviewQuery } from '../../src/modules/system-operations/application/overview'
import type { SystemOverviewQuery } from '../../src/modules/system-operations/public/queries'
import { createTaskOverviewQuery } from '../../src/modules/task-execution/composition/taskOverview'
import { assertNotBuiltin } from '../../src/services/systemResources'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'

/** 概览是纯读端口；调度任务 runtime 的写能力在这条路径上永远不会被触到。 */
function unusedCapability(): never {
  throw new Error('overview-query-invoked-unused-write-capability')
}

/** Construct once before HTTP timing; each request still reads the current database. */
export function createProductionOverviewQuery(
  db: ProviderNeutralDatabase,
  identityAccess: IdentityAccessRuntime,
): SystemOverviewQuery {
  const scheduledTaskRuntime = composeScheduledTaskRuntimeFor({
    db,
    resourceSnapshots: composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin }),
    validation: {
      assertWorkflowLaunchable: unusedCapability,
      assertAgentIntegrity: unusedCapability,
    },
    resourceAclChanged: unusedCapability,
  })
  return composeSystemOverviewQuery({
    resourceCatalog: composeResourceCatalogOverviewQuery(db),
    repositories: composeRepositoryWorkspaceOperations(
      composeRepositoryWorkspaceStore(db),
      undefined,
    ).overviewQueries,
    integration: scheduledTaskRuntime.overview,
    memories: composeMemoryCatalogOperations({
      db,
      contexts: identityAccess.contexts,
      authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
    }),
    tasks: createTaskOverviewQuery(db),
  })
}

export function runProductionOverview(
  db: ProviderNeutralDatabase,
  actor: Actor,
): Promise<OverviewResponse> {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return createProductionOverviewQuery(db, identityAccess).execute({
    actor,
    authority: context.authority,
  })
}
