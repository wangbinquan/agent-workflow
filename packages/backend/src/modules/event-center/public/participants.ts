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
  observe(input: EventObservationInput): Promise<EventObservationReceipt>
}

export interface EventSubscriptionParticipant {
  subscribe(input: {
    readonly eventTypeRef: EventExactRef
    readonly subject: EventSubjectRef
    readonly subscriber: EventSubscriberRef
    /** Defaults to true. Reactivated durable consumers may start from new facts only. */
    readonly replayLatest?: boolean
  }): Promise<EventSubscriptionReceipt>
  unsubscribe(subscriptionId: string): Promise<EventSubscriptionReceipt>
}

export interface EventObserverControlParticipant {
  /** Passive hint for a hybrid source; facts still come only from its observer program. */
  nudgeSource(sourceRef: EventExactRef): Promise<boolean>
}

export interface EventDeliveryParticipant {
  pendingDeliveries(
    subscriber: EventSubscriberRef,
    limit: number,
  ): Promise<readonly EventDeliveryEnvelope[]>
  acceptDelivery(deliveryId: string): Promise<void>
}

/**
 * Exact Case-facing protocol. Observer scheduling is deliberately separate so
 * webhook ingress cannot acquire subscription or delivery authority.
 */
export type EventCenterParticipant = EventSubscriptionParticipant &
  EventDeliveryParticipant &
  EventObservationParticipant
