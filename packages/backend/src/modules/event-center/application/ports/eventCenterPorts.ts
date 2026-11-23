// RFC-550 (RFC-294 S9): the module ports this context's application wires, with the delivery-status, audit and observer
// health documents only they return. They were declared on `public/commands`, `public/queries`, `public/participants`
// and `public/types` without any other module consuming them.
import type { EventObservationParticipant } from '../../public/participants'
import type { EventExactRef, EventSubjectRef, EventSubscriberRef } from '../../public/types'

/** Verified webhook/internal ingress narrows to this one idempotent command. */
export type EventObservationCommandPort = EventObservationParticipant

export interface EventObserverControlParticipant {
  /** Passive hint for a hybrid source; facts still come only from its observer program. */
  nudgeSource(sourceRef: EventExactRef): Promise<boolean>
}

export interface EventCenterCatalogQueryPort {
  catalogJson(): Promise<string>
  subscriptionsJson(subscriberRef: string | null): Promise<string>
  subscriptionPageJson(input: {
    readonly page: number
    readonly limit: number
    readonly subscriberRef: string | null
  }): Promise<string>
}

export interface EventCenterOperationsQueryPort {
  deliveryStatuses(): Promise<readonly EventDeliveryStatusDocument[]>
  deliveryStatusPage(input: {
    readonly page: number
    readonly limit: number
    readonly state: EventDeliveryStatusDocument['state'] | null
    readonly subscriberRef: string | null
  }): Promise<EventDeliveryStatusPageDocument>
  eventRecordPage(input: {
    readonly page: number
    readonly limit: number
    readonly sourceId: string | null
  }): Promise<EventRecordAuditPageDocument>
  observerHealth(): Promise<readonly ObserverHealthDocument[]>
}

export interface EventDeliveryStatusPageDocument {
  readonly items: readonly EventDeliveryStatusDocument[]
  readonly total: number
  readonly page: number
  readonly pageCount: number
}

export interface EventRecordAuditPageDocument {
  readonly items: readonly EventRecordAuditDocument[]
  readonly total: number
  readonly page: number
  readonly pageCount: number
}

export interface ObserverHealthDocument {
  readonly sourceRef: EventExactRef
  readonly subscriberCount: number
  readonly state: 'idle' | 'active' | 'draining' | 'blocked'
  readonly nextScanAt: number | null
  readonly lastSuccessAt: number | null
  readonly lastErrorCode: string | null
}

export interface EventDeliveryStatusDocument {
  readonly deliveryId: string
  readonly eventId: string
  readonly subscriptionId: string
  readonly subscriber: EventSubscriberRef
  readonly eventTypeRef: EventExactRef
  readonly subject: EventSubjectRef
  readonly state: 'pending' | 'claimed' | 'accepted' | 'dead-letter'
  readonly attemptCount: number
  readonly nextAttemptAt: number
  readonly lastError: string | null
  readonly createdAt: number
}

export interface EventRecordAuditDocument {
  readonly eventId: string
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubjectRef
  readonly occurredAt: number
  readonly observedAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
}
