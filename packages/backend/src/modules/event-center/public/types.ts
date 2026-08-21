export interface EventExactRef {
  readonly id: string
  readonly revision: number
}

export interface EventSubjectRef {
  readonly typeId: string
  readonly subjectRef: string
}

export interface EventSubscriberRef {
  readonly kind: 'employee-case' | 'employee-invocation' | 'automation' | 'system'
  readonly subscriberRef: string
}

export interface EventObservationInput {
  readonly sourceRef: EventExactRef
  readonly eventTypeRef: EventExactRef
  readonly subject: EventSubjectRef
  readonly occurredAt: number
  readonly dedupeKey: string
  readonly summary: string
  readonly payloadArtifactRef: string | null
  /**
   * Bounded JSON document interpreted only inside Event Center. Keeping the
   * transport serialized prevents an open object graph from becoming a
   * cross-context public contract.
   */
  readonly routingFactsJson?: string | null
  readonly triggerParameters?: Readonly<Record<string, string>> | null
}

export interface EventObservationReceipt {
  readonly eventId: string
  readonly duplicate: boolean
  readonly deliveryCount: number
  readonly deliveryIds: readonly string[]
}

export interface EventSubscriptionReceipt {
  readonly subscriptionId: string
  readonly created: boolean
  readonly observerTransition: 'none' | 'started' | 'stopped'
}

export interface EventDeliveryEnvelope {
  readonly deliveryId: string
  readonly eventId: string
  readonly subscriptionId: string
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubjectRef
  readonly deliveryClass: string
  readonly occurredAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
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

export interface EventDeliveryStatusPageDocument {
  readonly items: readonly EventDeliveryStatusDocument[]
  readonly total: number
  readonly page: number
  readonly pageCount: number
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

export type { EventResponseTarget } from '../domain/responseRule'
