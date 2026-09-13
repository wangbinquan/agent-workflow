import type { ProviderNeutralDatabase } from '@/db/query'
import type { WebhookDeliveryPersistencePort } from '../application/ports/webhookDeliveryPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'

/** Provider-neutral seam used by ingress, recovery, retention, and diagnostics. */
export function composeWebhookDeliveryPersistence(
  persistence: WebhookDeliveryPersistencePort,
): WebhookDeliveryPersistencePort {
  return persistence
}

/** RFC-359 W4-D2：两个 provider 装同一份中立实现。 */
export function composeWebhookDeliveryPersistenceFor(
  db: ProviderNeutralDatabase,
): WebhookDeliveryPersistencePort {
  return composeWebhookDeliveryPersistence(createWebhookDeliveryPersistence(db))
}
