import type {
  EventDeliveryRecord,
  EventDeliveryStatusRecord,
  EventRecordAuditRecord,
  EventExactRef,
  EventObservation,
  EventSourceDescriptor,
  EventSubject,
  EventSubscriber,
  EventSubscriptionRecord,
  EventTypeDescriptor,
  MatchedFilteredEventSubscription,
  ObserverActivationRecord,
} from '../../domain/model'
import type { TriggerContext } from '@agent-workflow/shared'

export interface ObservationStoreReceipt {
  readonly eventId: string
  readonly duplicate: boolean
  readonly deliveryCount: number
  readonly deliveryIds: readonly string[]
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
  registerSource(descriptor: EventSourceDescriptor, digest: string, now: number): Promise<void>
  registerEventType(descriptor: EventTypeDescriptor, digest: string, now: number): Promise<void>
  getSource(ref: EventExactRef): Promise<EventSourceDescriptor | null>
  getEventType(ref: EventExactRef): Promise<EventTypeDescriptor | null>
  listSources(): Promise<EventSourceDescriptor[]>
  listEventTypes(): Promise<EventTypeDescriptor[]>
  subscribe(input: {
    readonly id: string
    readonly eventType: EventTypeDescriptor
    readonly source: EventSourceDescriptor
    readonly subject: EventSubject
    readonly subscriber: EventSubscriber
    readonly identityKey: string
    readonly replayLatest: boolean
    readonly now: number
  }): Promise<SubscriptionStoreReceipt>
  cancelSubscription(id: string, now: number): Promise<SubscriptionStoreReceipt | null>
  nudgeObserver(sourceRef: EventExactRef, now: number): Promise<boolean>
  listSubscriptions(subscriberRef?: string): Promise<EventSubscriptionRecord[]>
  listSubscriptionPage(input: {
    readonly limit: number
    readonly offset: number
    readonly subscriberRef?: string
  }): Promise<{ readonly items: EventSubscriptionRecord[]; readonly total: number }>
  activeSubscriptionCountsBySource(): Promise<ReadonlyMap<string, number>>
  recordObservation(input: {
    readonly eventId: string
    readonly observation: EventObservation
    readonly eventType: EventTypeDescriptor
    readonly observedAt: number
    readonly nextId: () => string
    readonly routingSubscriptions: readonly MatchedFilteredEventSubscription[]
    readonly triggerContext: TriggerContext | null
  }): Promise<ObservationStoreReceipt>
  listPendingDeliveries(subscriber: EventSubscriber, limit: number): Promise<EventDeliveryRecord[]>
  listDeliveryStatusPage(input: {
    readonly limit: number
    readonly offset: number
    readonly state?: EventDeliveryStatusRecord['state']
    readonly subscriberRef?: string
  }): Promise<{ readonly items: EventDeliveryStatusRecord[]; readonly total: number }>
  listEventRecordPage(input: {
    readonly limit: number
    readonly offset: number
    readonly sourceId?: string
  }): Promise<{ readonly items: EventRecordAuditRecord[]; readonly total: number }>
  acceptDelivery(deliveryId: string, now: number): Promise<boolean>
  claimNotificationDelivery(input: {
    readonly deliveryId?: string
    readonly subscriberKinds: readonly EventSubscriber['kind'][]
    readonly now: number
    readonly leaseOwner: string
    readonly leaseMs: number
  }): Promise<EventDeliveryRecord | null>
  settleNotificationDelivery(input: {
    readonly deliveryId: string
    readonly leaseOwner: string
    readonly attemptCount: number
    readonly now: number
    readonly state: 'accepted' | 'pending' | 'dead-letter'
    readonly nextAttemptAt: number
    readonly error: string | null
  }): Promise<boolean>
  listObserverActivations(): Promise<ObserverActivationRecord[]>
  claimDueObserver(input: {
    readonly now: number
    readonly leaseOwner: string
    readonly leaseMs: number
    readonly runId: string
  }): Promise<ClaimedObserverRun | null>
  settleObserver(input: {
    readonly run: ClaimedObserverRun
    readonly now: number
    readonly cursorJson: string | null
    readonly observations: readonly {
      readonly eventId: string
      readonly observation: EventObservation
      readonly eventType: EventTypeDescriptor
      readonly routingSubscriptions: readonly MatchedFilteredEventSubscription[]
      readonly triggerContext: TriggerContext | null
    }[]
    readonly nextId: () => string
    readonly errorCode: string | null
    readonly errorDetail: string | null
  }): Promise<'completed' | 'failed' | 'obsolete'>
}
