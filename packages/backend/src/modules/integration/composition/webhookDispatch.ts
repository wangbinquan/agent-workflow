import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import type { WebhookTriggerServiceDeps } from '@/services/webhookTriggers'
import type { ScheduledTaskOperations } from '@/services/scheduledTasks'
import type { WebhookDispatchPersistencePort } from '../application/ports/webhookDispatchPersistence'
import type { WebhookTriggerAdministrationPort } from '../application/ports/webhookTriggerAdministration'
import { createSqliteWebhookDeliveryPersistence } from '../infrastructure/sqliteWebhookDeliveryPersistence'
import { createPostgresqlWebhookDispatchPersistence } from '../infrastructure/postgresqlWebhookDispatchPersistence'
import { createPostgresqlWebhookTriggerAdministration } from '../infrastructure/postgresqlWebhookTriggerAdministration'
import { createSqliteWebhookDispatchPersistence } from '../infrastructure/sqliteWebhookDispatchPersistence'
import { createSqliteWebhookTriggerAdministration } from '../infrastructure/sqliteWebhookTriggerAdministration'
import { createSqliteWebhookTriggerValidation } from '../infrastructure/sqliteWebhookTriggerValidation'
import { createSqliteWebhookLaunchAdmission } from '../infrastructure/sqliteWebhookDispatchRuntime'
import { createSqliteWebhookRepositoryResolver } from '../infrastructure/webhookRepositoryResolver'

export type { WebhookTaskExecutionParticipant } from '../application/ports/webhookExecution'
export {
  createSqliteWebhookExecutionRuntime,
  createSqliteWebhookOrchestrationRuntime,
} from '../infrastructure/sqliteWebhookDispatchRuntime'
export {
  createPostgresqlWebhookExecutionRuntime,
  createPostgresqlWebhookOrchestrationRuntime,
} from '../infrastructure/postgresqlWebhookDispatchRuntime'

export function composeWebhookDispatchPersistence(
  persistence: WebhookDispatchPersistencePort,
): WebhookDispatchPersistencePort {
  return persistence
}

export function composeSqliteWebhookDispatchPersistence(
  db: DbClient,
): WebhookDispatchPersistencePort {
  return composeWebhookDispatchPersistence(createSqliteWebhookDispatchPersistence(db))
}

export function composePostgresqlWebhookDispatchPersistence(
  db: PostgresqlDatabaseClient,
): WebhookDispatchPersistencePort {
  return composeWebhookDispatchPersistence(createPostgresqlWebhookDispatchPersistence(db))
}

export function composeSqliteWebhookTriggerAdministration(
  db: DbClient,
): WebhookTriggerAdministrationPort {
  return createSqliteWebhookTriggerAdministration(db)
}

export function composePostgresqlWebhookTriggerAdministration(
  db: PostgresqlDatabaseClient,
): WebhookTriggerAdministrationPort {
  return createPostgresqlWebhookTriggerAdministration(db)
}

export function composeWebhookTriggerServiceDependencies(
  dependencies: WebhookTriggerServiceDeps,
): WebhookTriggerServiceDeps {
  return dependencies
}

export function composeSqliteWebhookTriggerServiceDependencies(
  db: DbClient,
  configPath: string,
  scheduledTasks: ScheduledTaskOperations,
): WebhookTriggerServiceDeps {
  return composeWebhookTriggerServiceDependencies({
    administration: createSqliteWebhookTriggerAdministration(db),
    dispatchPersistence: createSqliteWebhookDispatchPersistence(db),
    validateSaveable: createSqliteWebhookTriggerValidation(scheduledTasks, configPath),
  })
}

export function composePostgresqlWebhookTriggerServiceDependencies(
  db: PostgresqlDatabaseClient,
  validateSaveable: WebhookTriggerServiceDeps['validateSaveable'],
): WebhookTriggerServiceDeps {
  return composeWebhookTriggerServiceDependencies({
    administration: createPostgresqlWebhookTriggerAdministration(db),
    dispatchPersistence: createPostgresqlWebhookDispatchPersistence(db),
    validateSaveable,
  })
}

export function composeSqliteWebhookDispatchCore(
  db: DbClient,
  secretBox: SecretBox,
  scheduledTasks: ScheduledTaskOperations,
): Pick<
  WebhookDispatchDeps,
  'persistence' | 'deliveryPersistence' | 'resolveRepo' | 'admitLaunch'
> {
  return {
    persistence: createSqliteWebhookDispatchPersistence(db),
    deliveryPersistence: createSqliteWebhookDeliveryPersistence(db),
    resolveRepo: createSqliteWebhookRepositoryResolver(db, secretBox),
    admitLaunch: createSqliteWebhookLaunchAdmission(scheduledTasks),
  }
}
