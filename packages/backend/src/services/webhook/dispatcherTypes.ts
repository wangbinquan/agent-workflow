// RFC-257 — provider-neutral dispatcher contract.
import type { WebhookEndpointRecord } from '@/modules/integration/application/ports/webhookDispatchPersistence'
import type { CodeHostEvent, TriggerContext } from '@agent-workflow/shared'

export type WebhookEndpointRow = WebhookEndpointRecord

export interface WebhookSubscriptionDispatchInput {
  readonly deliveryId: string
  readonly eventDeliveryId: string
  readonly eventSubscriptionId: string
  readonly triggerId: string
  readonly triggerContext: TriggerContext
}

/** Pre-Event-Center compatibility surface; production ingress must not call it. */
export interface LegacyWebhookDispatcher {
  dispatch(input: {
    deliveryId: string
    endpoint: WebhookEndpointRow
    event: CodeHostEvent
  }): Promise<void>
}

/**
 * App injection shape retained for old embedders. The optional notification
 * method is feature-detected before Event Center routes are mounted.
 */
export interface WebhookDispatcher extends LegacyWebhookDispatcher {
  /**
   * Event Center consumer entrypoint. One durable delivery names exactly one
   * matched response rule, so this method must never rescan or fan out to the
   * other rules on the endpoint.
   */
  dispatchSubscription?(input: WebhookSubscriptionDispatchInput): Promise<void>
}

/** Compatibility consumer port: receives one already-matched code-host delivery. */
export interface EventCenterCodeHostDeliveryDispatcher {
  dispatchSubscription(input: WebhookSubscriptionDispatchInput): Promise<void>
}

export function supportsEventCenterCodeHostDelivery(
  dispatcher: WebhookDispatcher,
): dispatcher is WebhookDispatcher & EventCenterCodeHostDeliveryDispatcher {
  return dispatcher.dispatchSubscription !== undefined
}
