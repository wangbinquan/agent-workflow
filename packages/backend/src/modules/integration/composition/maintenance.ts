import type {
  WebhookDeliveryGcCursorV1,
  WebhookDeliveryPersistencePort,
  WebhookDeliveryRetention,
} from '../application/ports/webhookDeliveryPersistence'
import type { IntegrationMaintenanceCommands } from '../public/commands'

export function composeIntegrationMaintenanceCommands(
  persistence: WebhookDeliveryPersistencePort,
): IntegrationMaintenanceCommands {
  return Object.freeze({
    async recoverInterruptedWebhookDeliveries() {
      return { recovered: await persistence.recoverInterrupted() }
    },
    gcWebhookDeliveries: (input: {
      readonly now: number
      readonly retention: WebhookDeliveryRetention
      readonly cursor: WebhookDeliveryGcCursorV1 | null
      readonly batchSize: number
    }) => persistence.gcSlice(input),
  })
}
