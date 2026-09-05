import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { IntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  IntegrationTriggerResourceBinding,
  IntegrationTriggerValidationRuntime,
  ScheduledTaskOperations,
} from '@/services/scheduledTasks'
import type {
  IntegrationOverviewQueries,
  IntegrationTriggerResourceQueries,
} from '../application/ports/scheduledTaskPersistence'
import { createIntegrationTriggerResources } from '../infrastructure/integrationTriggerResources'
import { createScheduledTaskPersistence } from '../infrastructure/scheduledTaskPersistence'

export interface ScheduledTaskRuntime {
  readonly operations: ScheduledTaskOperations
  readonly integrationTriggerResources: IntegrationTriggerResourceBinding
  readonly overview: IntegrationOverviewQueries
}

export function composeScheduledTaskRuntime(input: {
  readonly persistence: ScheduledTaskOperations['persistence']
  readonly integrationTriggerResources: IntegrationTriggerResourceQueries
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: ScheduledTaskOperations['resourceAclChanged']
}): ScheduledTaskRuntime {
  return Object.freeze({
    operations: Object.freeze({
      persistence: input.persistence,
      validation: input.validation,
      resourceAclChanged: input.resourceAclChanged,
    }),
    integrationTriggerResources: input.integrationTriggerResources,
    overview: Object.freeze({
      countScheduled(actor: Actor) {
        return actor.permissions.has('scheduled-tasks:read')
          ? input.persistence.countVisible(actor)
          : Promise.resolve(null)
      },
    }),
  })
}

export interface ScheduledTaskRuntimeInput {
  readonly db: ProviderNeutralDatabase
  readonly resourceSnapshots: IntegrationTriggerResourceSnapshotFactory
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: ScheduledTaskOperations['resourceAclChanged']
}

/**
 * RFC-359 W4-D1：两个 provider 装同一份——Integration 持有事务、装入 Resource Catalog 的快照工厂与自己的
 * 数字员工参与者；持久化与资源查询都是 provider 中立实现。
 */
export function composeScheduledTaskRuntimeFor(
  input: ScheduledTaskRuntimeInput,
): ScheduledTaskRuntime {
  const resources = createIntegrationTriggerResources(input.db, input.resourceSnapshots)
  return composeScheduledTaskRuntime({
    persistence: createScheduledTaskPersistence(input.db, resources),
    integrationTriggerResources: resources,
    validation: input.validation,
    resourceAclChanged: input.resourceAclChanged,
  })
}

/** 只要资源查询面（webhook 路径的 identity access 用）：同一份中立实现，不带持久化。 */
export function composeIntegrationTriggerResourceQueries(
  db: ProviderNeutralDatabase,
  resourceSnapshots: IntegrationTriggerResourceSnapshotFactory,
): IntegrationTriggerResourceQueries {
  return createIntegrationTriggerResources(db, resourceSnapshots)
}

/** RFC-359：旧名保留为装配别名，bootstrap 收敛后删除。 */
export function composeSqliteScheduledTaskRuntime(
  input: Omit<ScheduledTaskRuntimeInput, 'db'> & { readonly db: DbClient },
): ScheduledTaskRuntime {
  return composeScheduledTaskRuntimeFor(input)
}

export function composePostgresqlScheduledTaskRuntime(
  input: Omit<ScheduledTaskRuntimeInput, 'db'> & { readonly db: PostgresqlDatabaseClient },
): ScheduledTaskRuntime {
  return composeScheduledTaskRuntimeFor(input)
}
