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
    readonly replayLatest: boolean
    readonly now: number
  }): SubscriptionStoreReceipt
  cancelSubscription(id: string, now: number): SubscriptionStoreReceipt | null
  nudgeObserver(sourceRef: EventExactRef, now: number): boolean
  listSubscriptions(subscriberRef?: string): EventSubscriptionRecord[]
  listSubscriptionPage(input: {
    readonly limit: number
    readonly offset: number
    readonly subscriberRef?: string
  }): { readonly items: EventSubscriptionRecord[]; readonly total: number }
  activeSubscriptionCountsBySource(): ReadonlyMap<string, number>
  recordObservation(input: {
    readonly eventId: string
    readonly observation: EventObservation
    readonly eventType: EventTypeDescriptor
    readonly observedAt: number
    readonly nextId: () => string
    readonly routingSubscriptions: readonly MatchedFilteredEventSubscription[]
    readonly triggerContext: TriggerContext | null
  }): ObservationStoreReceipt
  listPendingDeliveries(subscriber: EventSubscriber, limit: number): EventDeliveryRecord[]
  listDeliveryStatusPage(input: {
    readonly limit: number
    readonly offset: number
    readonly state?: EventDeliveryStatusRecord['state']
    readonly subscriberRef?: string
  }): { readonly items: EventDeliveryStatusRecord[]; readonly total: number }
  listEventRecordPage(input: {
    readonly limit: number
    readonly offset: number
    readonly sourceId?: string
  }): { readonly items: EventRecordAuditRecord[]; readonly total: number }
  acceptDelivery(deliveryId: string, now: number): boolean
  claimNotificationDelivery(input: {
    readonly deliveryId?: string
    readonly subscriberKinds: readonly EventSubscriber['kind'][]
    readonly now: number
    readonly leaseOwner: string
    readonly leaseMs: number
  }): EventDeliveryRecord | null
  settleNotificationDelivery(input: {
    readonly deliveryId: string
    readonly leaseOwner: string
    readonly now: number
    readonly state: 'accepted' | 'pending' | 'dead-letter'
    readonly nextAttemptAt: number
    readonly error: string | null
  }): boolean
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
      readonly routingSubscriptions: readonly MatchedFilteredEventSubscription[]
      readonly triggerContext: TriggerContext | null
    }[]
    readonly nextId: () => string
    readonly errorCode: string | null
    readonly errorDetail: string | null
  }): 'completed' | 'failed' | 'obsolete'
}
