import type { EventObservationInput } from '@/modules/event-center/public/types'
import type { VerifiedWebhookDeliveryInput } from '../acceptVerifiedWebhookDelivery'
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

export type VerifiedWebhookIngressReceipt =
  | Readonly<{ deliveryId: string; status: 'received' }>
  | Readonly<{ deliveryId: string; status: 'duplicate'; attemptCount: number }>

/**
 * RFC-437：自 `public/commands.ts` 移回本模块端口——入站绑定归入本模块后，
 * 已验证投递接收只剩模块内消费者（RFC-294 design §3.3）。
 */
export interface VerifiedWebhookIngressCommands {
  receive(input: VerifiedWebhookDeliveryInput): Promise<VerifiedWebhookIngressReceipt>
}
