import type { DbClient } from '@/db/client'
import type { Actor } from '@/auth/actor'
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
import { createPostgresqlScheduledTaskPersistence } from '../infrastructure/postgresqlScheduledTaskPersistence'
import { createPostgresqlIntegrationTriggerResources } from '../infrastructure/postgresqlIntegrationTriggerResources'
import { createSqliteIntegrationTriggerResources } from '../infrastructure/sqliteIntegrationTriggerResources'
import type { PostgresqlIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import {
  createSqliteScheduledTaskPersistence,
  type SqliteIntegrationTriggerTransactionBinding,
} from '../infrastructure/sqliteScheduledTaskPersistence'

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

export function composeSqliteScheduledTaskRuntime(input: {
  readonly db: DbClient
  readonly resources: SqliteIntegrationTriggerTransactionBinding
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: ScheduledTaskOperations['resourceAclChanged']
}): ScheduledTaskRuntime {
  const queries = createSqliteIntegrationTriggerResources(input.db, input.resources)
  return composeScheduledTaskRuntime({
    persistence: createSqliteScheduledTaskPersistence(input.db, input.resources),
    integrationTriggerResources: queries,
    validation: input.validation,
    resourceAclChanged: input.resourceAclChanged,
  })
}

export function composePostgresqlScheduledTaskRuntime(input: {
  readonly db: PostgresqlDatabaseClient
  readonly resourceSnapshots: PostgresqlIntegrationTriggerResourceSnapshotFactory
  readonly validation: IntegrationTriggerValidationRuntime
  readonly resourceAclChanged: ScheduledTaskOperations['resourceAclChanged']
}): ScheduledTaskRuntime {
  const resources = createPostgresqlIntegrationTriggerResources(input.db, input.resourceSnapshots)
  return composeScheduledTaskRuntime({
    persistence: createPostgresqlScheduledTaskPersistence(input.db, resources),
    integrationTriggerResources: resources,
    validation: input.validation,
    resourceAclChanged: input.resourceAclChanged,
  })
}
