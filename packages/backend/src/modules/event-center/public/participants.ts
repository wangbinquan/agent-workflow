import type {
  EventDeliveryEnvelope,
  EventExactRef,
  EventObservationInput,
  EventObservationReceipt,
  EventSubjectRef,
  EventSubscriberRef,
  EventSubscriptionReceipt,
} from './types'
export interface EventObservationParticipant {
  observe(input: EventObservationInput): EventObservationReceipt
}

export interface EventSubscriptionParticipant {
  subscribe(input: {
    readonly eventTypeRef: EventExactRef
    readonly subject: EventSubjectRef
    readonly subscriber: EventSubscriberRef
    /** Defaults to true. Reactivated durable consumers may start from new facts only. */
    readonly replayLatest?: boolean
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
  EventObservationParticipant
