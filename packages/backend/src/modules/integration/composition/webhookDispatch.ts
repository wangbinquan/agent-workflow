import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import type { WebhookTriggerServiceDeps } from '@/services/webhookTriggers'
import type { ScheduledTaskOperations } from '@/services/scheduledTasks'
import type { WebhookDispatchPersistencePort } from '../application/ports/webhookDispatchPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'
import { createWebhookDispatchPersistence } from '../infrastructure/webhookDispatchPersistence'
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

export function composePostgresqlWebhookDispatchPersistence(
  db: PostgresqlDatabaseClient,
): WebhookDispatchPersistencePort {
  return composeWebhookDispatchPersistence(createWebhookDispatchPersistence(db))
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
    dispatchPersistence: createWebhookDispatchPersistence(db),
    validateSaveable: createSqliteWebhookTriggerValidation(scheduledTasks, configPath),
  })
}

export function composePostgresqlWebhookTriggerServiceDependencies(
  db: PostgresqlDatabaseClient,
  validateSaveable: WebhookTriggerServiceDeps['validateSaveable'],
): WebhookTriggerServiceDeps {
  return composeWebhookTriggerServiceDependencies({
    administration: createWebhookTriggerAdministration(db),
    dispatchPersistence: createWebhookDispatchPersistence(db),
    validateSaveable,
  })
}

// RFC-359 AC-6：形参放宽到中立客户端——它转交的四件（dispatch/delivery 持久化、仓库解析、
// 启动准入）形参都已中立，其中仓库解析这一对本轮刚合一（见 `webhookRepositoryResolver.ts`）。
export function composeSqliteWebhookDispatchCore(
  db: ProviderNeutralDatabase,
  secretBox: SecretBox,
  scheduledTasks: ScheduledTaskOperations,
): Pick<
  WebhookDispatchDeps,
  'persistence' | 'deliveryPersistence' | 'resolveRepo' | 'admitLaunch'
> {
  return {
    persistence: createWebhookDispatchPersistence(db),
    deliveryPersistence: createWebhookDeliveryPersistence(db),
    resolveRepo: createSqliteWebhookRepositoryResolver(db, secretBox),
    admitLaunch: createWebhookLaunchAdmission(scheduledTasks),
  }
}
