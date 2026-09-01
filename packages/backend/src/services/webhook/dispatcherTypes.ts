// RFC-257 — provider-neutral dispatcher contract.
import type { WebhookEndpointRecord } from '@/modules/integration/application/ports/webhookDispatchPersistence'
import type { CodeHostEvent, TriggerContext } from '@agent-workflow/shared'
import type { EventResponseTarget } from '@/modules/event-center/public/types'
import type { WorkStartReceipt } from '@/modules/integration/public/participants'

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

/** Source-neutral work-start port used by standard Event Center response rules. */
export interface EventCenterAutomationWorkStarter {
  dispatchEventTarget(input: {
    readonly ownerUserId: string
    readonly target: EventResponseTarget
    readonly eventSubscriptionId: string
    readonly eventDeliveryId: string
    readonly triggerContext: TriggerContext
  }): Promise<WorkStartReceipt>
}

export function supportsEventCenterCodeHostDelivery(
  dispatcher: WebhookDispatcher,
): dispatcher is WebhookDispatcher & EventCenterCodeHostDeliveryDispatcher {
  return dispatcher.dispatchSubscription !== undefined
}

export function supportsEventCenterWorkStart(
  dispatcher: WebhookDispatcher,
): dispatcher is WebhookDispatcher & EventCenterAutomationWorkStarter {
  return 'dispatchEventTarget' in dispatcher && typeof dispatcher.dispatchEventTarget === 'function'
}
