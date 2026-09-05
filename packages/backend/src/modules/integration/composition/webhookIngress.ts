import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '../application/acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryPersistencePort } from '../application/ports/webhookDeliveryPersistence'
import type { WebhookDeliveryQueries } from '../application/ports/webhookDeliveryQueries'
import type { WebhookEndpointAdministrationPort } from '../application/ports/webhookEndpointAdministration'
import { createVerifiedWebhookDeliveryPersistence } from '../infrastructure/verifiedWebhookDeliveryPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'
import { createWebhookDeliveryQueries } from '../infrastructure/webhookDeliveryQueries'
import { createWebhookEndpointAdministration } from '../infrastructure/webhookEndpointAdministration'

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

/** RFC-359 W4-D2：端点管理 / 投递持久化 / 已验证投递接收都是中立实现，两个 provider 装同一份。 */
export function composeWebhookIngressPersistenceFor(
  db: ProviderNeutralDatabase,
): WebhookIngressPersistence {
  const verified = createVerifiedWebhookDeliveryPersistence(db)
  return composeWebhookIngressPersistence({
    endpoints: createWebhookEndpointAdministration(db),
    deliveries: createWebhookDeliveryPersistence(db),
    acceptVerifiedDelivery: (input) => verified.accept(input),
  })
}

export function composeWebhookDeliveryRuntimeFor(
  db: ProviderNeutralDatabase,
): WebhookDeliveryRuntime {
  const ingress = composeWebhookIngressPersistenceFor(db)
  return Object.freeze({
    ...ingress,
    queries: createWebhookDeliveryQueries(db),
  })
}

/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export function composeSqliteWebhookIngressPersistence(db: DbClient): WebhookIngressPersistence {
  return composeWebhookIngressPersistenceFor(db)
}

export function composeSqliteWebhookDeliveryRuntime(db: DbClient): WebhookDeliveryRuntime {
  return composeWebhookDeliveryRuntimeFor(db)
}

export function composePostgresqlWebhookIngressPersistence(
  db: PostgresqlDatabaseClient,
): WebhookIngressPersistence {
  return composeWebhookIngressPersistenceFor(db)
}

export function composePostgresqlWebhookDeliveryRuntime(
  db: PostgresqlDatabaseClient,
): WebhookDeliveryRuntime {
  return composeWebhookDeliveryRuntimeFor(db)
}
