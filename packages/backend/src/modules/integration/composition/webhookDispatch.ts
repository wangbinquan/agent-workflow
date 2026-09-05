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
import { createSqliteWebhookDispatchPersistence } from '../infrastructure/sqliteWebhookDispatchPersistence'
import { createWebhookTriggerAdministration } from '../infrastructure/webhookTriggerAdministration'
import { createSqliteWebhookTriggerValidation } from '../infrastructure/sqliteWebhookTriggerValidation'
import { createWebhookLaunchAdmission } from '../infrastructure/webhookDispatchRuntime'
import { createSqliteWebhookRepositoryResolver } from '../infrastructure/webhookRepositoryResolver'

export type { WebhookTaskExecutionParticipant } from '../application/ports/webhookExecution'
// RFC-359 W4-B4：执行运行时只有一份；两个 bootstrap 仍经各自的具名绑定装配。
export {
  createWebhookDispatchExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime,
  createWebhookDispatchExecutionRuntime as createSqliteWebhookExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime as createSqliteWebhookOrchestrationRuntime,
  createWebhookDispatchExecutionRuntime as createPostgresqlWebhookExecutionRuntime,
  createWebhookDispatchOrchestrationRuntime as createPostgresqlWebhookOrchestrationRuntime,
} from '../infrastructure/webhookDispatchRuntime'

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
  return createWebhookTriggerAdministration(db)
}

export function composePostgresqlWebhookTriggerAdministration(
  db: PostgresqlDatabaseClient,
): WebhookTriggerAdministrationPort {
  return createWebhookTriggerAdministration(db)
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
    administration: createWebhookTriggerAdministration(db),
    dispatchPersistence: createSqliteWebhookDispatchPersistence(db),
    validateSaveable: createSqliteWebhookTriggerValidation(scheduledTasks, configPath),
  })
}

export function composePostgresqlWebhookTriggerServiceDependencies(
  db: PostgresqlDatabaseClient,
  validateSaveable: WebhookTriggerServiceDeps['validateSaveable'],
): WebhookTriggerServiceDeps {
  return composeWebhookTriggerServiceDependencies({
    administration: createWebhookTriggerAdministration(db),
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
    admitLaunch: createWebhookLaunchAdmission(scheduledTasks),
  }
}
