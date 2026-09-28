import type { EventObservationInput } from '@/modules/event-center/public/types'
import type { VerifiedWebhookDeliveryPersistencePort } from './verifiedWebhookDeliveryPersistence'
import type { WebhookDeliveryPersistencePort } from './webhookDeliveryPersistence'

export interface VerifiedWebhookIngressDependencies {
  readonly persistence: VerifiedWebhookDeliveryPersistencePort
  readonly audit: Pick<WebhookDeliveryPersistencePort, 'mark' | 'touchEndpointLastDelivery'>
  readonly events: {
    observe(input: EventObservationInput): Promise<{
      readonly deliveryCount: number
      readonly deliveryIds: readonly string[]
    }>
    notify(deliveryId: string): Promise<unknown>
    nudge(): void | Promise<unknown>
  }
  readonly wakeTerminalControl: (effectId: string | null) => void
  readonly now: () => number
}
