// RFC-370 H8 / v3 V8 — the durable inbox behind hosted event ingress.
//
// CrewStation delivers each producer event at least once, possibly to several
// deliveries. The inbox records every delivery before it is acknowledged,
// freezes the routing of an event at its first sighting (later configuration
// changes do not re-route it), and keeps one target per routed endpoint until
// that target is admitted and its observations are published. Targets are
// independent: one endpoint's state never holds back another's.
import type {
  EventObservationInput,
  EventObservationReceipt,
} from '@/modules/event-center/public/types'
import type { NormalizeResult } from '../../domain/codeHostNormalization'
import type { VerifiedWebhookDeliveryInput } from '../acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryOutcome } from '../webhookDeliveryOutcome'

/** `crewstation` admits the event; `shadow` only records what would have been admitted. */
export type CrewStationEventChannel = 'crewstation' | 'shadow'

export interface CrewStationEventTarget {
  readonly endpointId: string
  readonly bindingRevision: number
  readonly channel: CrewStationEventChannel
}

/** Where the deployment's event sources route an event at its first sighting. */
export type CrewStationEventRoute =
  | {
      readonly kind: 'routed'
      /** Empty when no binding covers the event's repository: recorded as ignored. */
      readonly targets: readonly CrewStationEventTarget[]
      /** The source configuration frozen with the route, for later admission. */
      readonly frozenSource: string
      readonly sourceRevision: number
    }
  | { readonly kind: 'unroutable'; readonly status: 400 | 422; readonly code: string }

/** One verified platform delivery, as the ingress records it. */
export interface CrewStationInboundDelivery {
  readonly deliveryId: string
  readonly attempt: number
  readonly producerId: string
  readonly eventId: string
  readonly eventTypeId: string
  /** Equal for every delivery of the same event content. */
  readonly factDigest: string
  /** The envelope as received, kept for audit and for admission. */
  readonly envelopeJson: string
  /** Evaluated only at the event's first sighting. */
  readonly route: () => CrewStationEventRoute
}

export type CrewStationRecordOutcome =
  | { readonly kind: 'recorded' }
  /** The delivery or event identity was seen before with other content (counted for audit). */
  | { readonly kind: 'conflict' }
  /** A first sighting the configuration cannot route; nothing was recorded. */
  | { readonly kind: 'unroutable'; readonly status: 400 | 422; readonly code: string }

/** A frozen target due for admission, read inside the admission transaction. */
export interface CrewStationPendingTarget {
  readonly endpointId: string
  readonly channel: CrewStationEventChannel
  /** The endpoint as it is now; null once it was deleted. */
  readonly endpoint: { readonly enabled: boolean; readonly provider: string } | null
  /** The code host the frozen source names. */
  readonly provider: string
  /** The frozen envelope under AW's provider normalization. */
  readonly normalized: NormalizeResult
  /** What a verified delivery records besides its endpoint and event. */
  readonly delivery: Pick<
    VerifiedWebhookDeliveryInput,
    'rawBodyBytes' | 'rawBodyText' | 'eventHeader' | 'objectKind' | 'transportReceiptRef'
  >
  readonly occurredAt: number
}

export type CrewStationTargetDecision =
  | {
      readonly kind: 'close'
      readonly stage: 'source-deleted' | 'rejected' | 'ignored' | 'shadow'
      readonly reason: string
    }
  | {
      readonly kind: 'admit'
      readonly delivery: VerifiedWebhookDeliveryInput
      /** The observations to publish once the delivery fact exists. */
      readonly observations: (deliveryId: string) => readonly EventObservationInput[]
    }

export interface CrewStationAdmittedTarget {
  readonly effectId: string | null
  readonly observations: readonly EventObservationInput[]
  /** Observation indexes whose receipts are already recorded. */
  readonly published: readonly number[]
}

export interface CrewStationEventInboxPort {
  /** Durably record a delivery; the first sighting of its event freezes `route()`. */
  record(delivery: CrewStationInboundDelivery): Promise<CrewStationRecordOutcome>
  /** Targets due for admission or publication, oldest first. */
  due(limit: number): Promise<readonly string[]>
  /**
   * In one transaction under the execution fence: decide a pending target
   * (admitting it records the verified delivery fact atomically), or return the
   * target already admitted. Null once the target is closed.
   */
  admit(
    targetId: string,
    decide: (target: CrewStationPendingTarget) => CrewStationTargetDecision,
  ): Promise<CrewStationAdmittedTarget | null>
  /**
   * Record one observation's receipt. When every observation has one, the
   * target completes and its delivery is finalized with `finalize`, atomically.
   */
  recordPublication(input: {
    readonly targetId: string
    readonly index: number
    readonly receipt: EventObservationReceipt
    readonly finalize: (
      receipts: readonly EventObservationReceipt[],
      effectId: string | null,
    ) => WebhookDeliveryOutcome
  }): Promise<void>
  /** Retry a target later after a failure, while it is still due. */
  defer(targetId: string, error: string): Promise<void>
}
