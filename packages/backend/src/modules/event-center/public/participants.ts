import type {
  EventDeliveryEnvelope,
  EventExactRef,
  EventSubjectRef,
  EventSubscriberRef,
  EventSubscriptionReceipt,
} from './types'
import type { EventObservationCommandPort } from './commands'

export interface EventSubscriptionParticipant {
  subscribe(input: {
    readonly eventTypeRef: EventExactRef
    readonly subject: EventSubjectRef
    readonly subscriber: EventSubscriberRef
  }): EventSubscriptionReceipt
  unsubscribe(subscriptionId: string): EventSubscriptionReceipt
}

export interface EventObserverControlParticipant {
  /** Passive hint for a hybrid source; facts still come only from its observer program. */
  nudgeSource(sourceRef: EventExactRef): boolean
}

export interface EventDeliveryParticipant {
  pendingDeliveries(subscriber: EventSubscriberRef, limit: number): readonly EventDeliveryEnvelope[]
  acceptDelivery(deliveryId: string): void
}

/**
 * Exact Case-facing protocol. Observer scheduling is deliberately separate so
 * webhook ingress cannot acquire subscription or delivery authority.
 */
export type EventCenterParticipant = EventSubscriptionParticipant &
  EventDeliveryParticipant &
  EventObservationCommandPort
