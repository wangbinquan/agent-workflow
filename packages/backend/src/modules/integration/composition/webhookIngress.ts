import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '../application/acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryPersistencePort } from '../application/ports/webhookDeliveryPersistence'
import type { WebhookDeliveryQueries } from '../application/ports/webhookDeliveryQueries'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { createPostgresqlVerifiedWebhookDeliveryPersistence } from '../infrastructure/postgresqlVerifiedWebhookDeliveryPersistence'
import { createPostgresqlWebhookDeliveryPersistence } from '../infrastructure/postgresqlWebhookDeliveryPersistence'
import { createPostgresqlWebhookDeliveryQueries } from '../infrastructure/postgresqlWebhookDeliveryQueries'
import { createPostgresqlWebhookEndpointAdministration } from '../infrastructure/postgresqlWebhookEndpointAdministration'
import { createSqliteVerifiedWebhookDeliveryPersistence } from '../infrastructure/sqliteVerifiedWebhookDeliveryStore'
import { createSqliteWebhookDeliveryPersistence } from '../infrastructure/sqliteWebhookDeliveryPersistence'
import { createSqliteWebhookDeliveryQueries } from '../infrastructure/sqliteWebhookDeliveryQueries'
import { createSqliteWebhookEndpointAdministration } from '../infrastructure/sqliteWebhookEndpointAdministration'

export interface WebhookIngressPersistence {
  readonly endpoints: Pick<WebhookEndpointAdministrationPort, 'get' | 'getByUrlToken'>
  readonly deliveries: WebhookDeliveryPersistencePort
  acceptVerifiedDelivery(input: VerifiedWebhookDeliveryInput): Promise<AcceptedVerifiedDelivery>
}

/** Provider-neutral audit/replay seam; transports never select or inspect a database provider. */
export interface WebhookDeliveryRuntime extends WebhookIngressPersistence {
  readonly queries: WebhookDeliveryQueries
}

export function composeWebhookIngressPersistence(
  persistence: WebhookIngressPersistence,
): WebhookIngressPersistence {
  return persistence
}

export function composeSqliteWebhookIngressPersistence(db: DbClient): WebhookIngressPersistence {
  const verified = createSqliteVerifiedWebhookDeliveryPersistence(db)
  return composeWebhookIngressPersistence({
    endpoints: createSqliteWebhookEndpointAdministration(db),
    deliveries: createSqliteWebhookDeliveryPersistence(db),
    acceptVerifiedDelivery: (input) => verified.accept(input),
  })
}

export function composeSqliteWebhookDeliveryRuntime(db: DbClient): WebhookDeliveryRuntime {
  const ingress = composeSqliteWebhookIngressPersistence(db)
  return Object.freeze({
    ...ingress,
    queries: createSqliteWebhookDeliveryQueries(db),
  })
}

export function composePostgresqlWebhookIngressPersistence(
  db: PostgresqlDatabaseClient,
): WebhookIngressPersistence {
  const verified = createPostgresqlVerifiedWebhookDeliveryPersistence(db)
  return composeWebhookIngressPersistence({
    endpoints: createPostgresqlWebhookEndpointAdministration(db),
    deliveries: createPostgresqlWebhookDeliveryPersistence(db),
    acceptVerifiedDelivery: (input) => verified.accept(input),
  })
}

export function composePostgresqlWebhookDeliveryRuntime(
  db: PostgresqlDatabaseClient,
): WebhookDeliveryRuntime {
  const ingress = composePostgresqlWebhookIngressPersistence(db)
  return Object.freeze({
    ...ingress,
    queries: createPostgresqlWebhookDeliveryQueries(db),
  })
}
