import type {
  WebhookDeliveryGcCursorV1,
  WebhookDeliveryGcSliceReceipt,
  WebhookDeliveryRetention,
} from '../application/ports/webhookDeliveryPersistence'
import type { VerifiedWebhookDeliveryInput } from '../application/acceptVerifiedWebhookDelivery'

export interface VerifiedWebhookIngressCommands {
  receive(
    input: VerifiedWebhookDeliveryInput,
  ): Promise<
    | Readonly<{ deliveryId: string; status: 'received' }>
    | Readonly<{ deliveryId: string; status: 'duplicate'; attemptCount: number }>
  >
}

export interface IntegrationMaintenanceCommands {
  recoverInterruptedWebhookDeliveries(): Promise<{ readonly recovered: number }>
  gcWebhookDeliveries(input: {
    readonly now: number
    readonly retention: WebhookDeliveryRetention
    readonly cursor: WebhookDeliveryGcCursorV1 | null
    readonly batchSize: number
  }): Promise<WebhookDeliveryGcSliceReceipt>
}
