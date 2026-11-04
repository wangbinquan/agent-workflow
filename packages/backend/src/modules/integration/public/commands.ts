import type {
  WebhookDeliveryGcCursorV1,
  WebhookDeliveryGcSliceReceipt,
  WebhookDeliveryRetention,
} from '../application/ports/webhookDeliveryPersistence'

export interface IntegrationMaintenanceCommands {
  recoverInterruptedWebhookDeliveries(): Promise<{ readonly recovered: number }>
  gcWebhookDeliveries(input: {
    readonly now: number
    readonly retention: WebhookDeliveryRetention
    readonly cursor: WebhookDeliveryGcCursorV1 | null
    readonly batchSize: number
  }): Promise<WebhookDeliveryGcSliceReceipt>
}
