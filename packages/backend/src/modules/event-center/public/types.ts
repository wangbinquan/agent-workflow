export interface EventExactRef {
  readonly id: string
  readonly revision: number
}

export interface EventSubjectRef {
  readonly typeId: string
  readonly subjectRef: string
}

export interface EventSubscriberRef {
  readonly kind: 'employee-case' | 'employee-invocation' | 'system'
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
}

export interface EventObservationReceipt {
  readonly eventId: string
  readonly duplicate: boolean
  readonly deliveryCount: number
}

export interface EventSubscriptionReceipt {
  readonly subscriptionId: string
  readonly created: boolean
  readonly observerTransition: 'none' | 'started' | 'stopped'
}

export interface EventDeliveryEnvelope {
  readonly deliveryId: string
  readonly eventId: string
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubjectRef
  readonly deliveryClass: string
  readonly priority: number
  readonly occurredAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
}

export interface ObserverHealthDocument {
  readonly sourceRef: EventExactRef
  readonly subscriberCount: number
  readonly state: 'idle' | 'active' | 'draining' | 'blocked'
  readonly nextScanAt: number | null
  readonly lastSuccessAt: number | null
  readonly lastErrorCode: string | null
}
