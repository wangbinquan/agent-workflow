import type {
  EventDeliveryRecord,
  EventExactRef,
  EventObservation,
  EventSourceDescriptor,
  EventSubject,
  EventSubscriber,
  EventSubscriptionRecord,
  EventTypeDescriptor,
  ObserverActivationRecord,
} from '../../domain/model'

export interface ObservationStoreReceipt {
  readonly eventId: string
  readonly duplicate: boolean
  readonly deliveryCount: number
}

export interface SubscriptionStoreReceipt {
  readonly record: EventSubscriptionRecord
  readonly created: boolean
  readonly observerTransition: 'none' | 'started' | 'stopped'
}

export interface ClaimedObserverRun {
  readonly runId: string
  readonly source: EventSourceDescriptor
  readonly generation: number
  readonly leaseOwner: string
  readonly leaseEpoch: number
  readonly wakeEpoch: number
  readonly cursorJson: string | null
  readonly subjects: readonly EventSubject[]
}

export interface EventStorePort {
  registerSource(descriptor: EventSourceDescriptor, digest: string, now: number): void
  registerEventType(descriptor: EventTypeDescriptor, digest: string, now: number): void
  getSource(ref: EventExactRef): EventSourceDescriptor | null
  getEventType(ref: EventExactRef): EventTypeDescriptor | null
  listSources(): EventSourceDescriptor[]
  listEventTypes(): EventTypeDescriptor[]
  subscribe(input: {
    readonly id: string
    readonly eventType: EventTypeDescriptor
    readonly source: EventSourceDescriptor
    readonly subject: EventSubject
    readonly subscriber: EventSubscriber
    readonly identityKey: string
    readonly now: number
  }): SubscriptionStoreReceipt
  cancelSubscription(id: string, now: number): SubscriptionStoreReceipt | null
  nudgeObserver(sourceRef: EventExactRef, now: number): boolean
  listSubscriptions(subscriberRef?: string): EventSubscriptionRecord[]
  recordObservation(input: {
    readonly eventId: string
    readonly observation: EventObservation
    readonly eventType: EventTypeDescriptor
    readonly observedAt: number
    readonly nextId: () => string
  }): ObservationStoreReceipt
  listPendingDeliveries(subscriber: EventSubscriber, limit: number): EventDeliveryRecord[]
  acceptDelivery(deliveryId: string, now: number): boolean
  listObserverActivations(): ObserverActivationRecord[]
  claimDueObserver(input: {
    readonly now: number
    readonly leaseOwner: string
    readonly leaseMs: number
    readonly runId: string
  }): ClaimedObserverRun | null
  settleObserver(input: {
    readonly run: ClaimedObserverRun
    readonly now: number
    readonly cursorJson: string | null
    readonly observations: readonly {
      readonly eventId: string
      readonly observation: EventObservation
      readonly eventType: EventTypeDescriptor
    }[]
    readonly nextId: () => string
    readonly errorCode: string | null
    readonly errorDetail: string | null
  }): 'completed' | 'failed' | 'obsolete'
}
