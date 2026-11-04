import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebhookDeliveryPersistencePort } from '../application/ports/webhookDeliveryPersistence'
import { createWebhookDeliveryPersistence } from '../infrastructure/webhookDeliveryPersistence'

// RFC-437：启动恢复经此取用投递存储（原 `services/webhook/deliveryStore`）。
export { recoverInterruptedDeliveries } from '../application/webhookDeliveryStore'

/** Provider-neutral seam used by ingress, recovery, retention, and diagnostics. */
export function composeWebhookDeliveryPersistence(
  persistence: WebhookDeliveryPersistencePort,
): WebhookDeliveryPersistencePort {
  return persistence
}

/** RFC-359 W4-D2：两个 provider 装同一份中立实现。 */
export function composeWebhookDeliveryPersistenceFor(
  db: PersistenceDb,
): WebhookDeliveryPersistencePort {
  return composeWebhookDeliveryPersistence(createWebhookDeliveryPersistence(db))
}
