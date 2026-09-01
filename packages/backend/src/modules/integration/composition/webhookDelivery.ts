import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookDeliveryPersistencePort } from '../application/ports/webhookDeliveryPersistence'
import { createPostgresqlWebhookDeliveryPersistence } from '../infrastructure/postgresqlWebhookDeliveryPersistence'
import { createSqliteWebhookDeliveryPersistence } from '../infrastructure/sqliteWebhookDeliveryPersistence'

/** Provider-neutral seam used by ingress, recovery, retention, and diagnostics. */
export function composeWebhookDeliveryPersistence(
  persistence: WebhookDeliveryPersistencePort,
): WebhookDeliveryPersistencePort {
  return persistence
}

export function composeSqliteWebhookDeliveryPersistence(
  db: DbClient,
): WebhookDeliveryPersistencePort {
  return composeWebhookDeliveryPersistence(createSqliteWebhookDeliveryPersistence(db))
}

export function composePostgresqlWebhookDeliveryPersistence(
  db: PostgresqlDatabaseClient,
): WebhookDeliveryPersistencePort {
  return composeWebhookDeliveryPersistence(createPostgresqlWebhookDeliveryPersistence(db))
}
