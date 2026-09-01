// RFC-349 — provider-neutral Promise surface for committed-event delivery.
// Producer-owned append atoms remain separate; this port owns recovery reads,
// lease/CAS settlement, operator retry/page projections, and health.
import type {
  ClaimedCommittedEventDelivery,
  CommittedEventDeliveryPage,
  CommittedEventDeliveryState,
  CommittedEventFamily,
  CommittedEventProducer,
  ManualCommittedEventRetryInput,
  ManualCommittedEventRetryReceipt,
  StoredCommittedEvent,
} from './types'

export type CommittedEventDeliveryHealth = Readonly<{
  pending: number
  claimed: number
  deadLetter: number
  oldestPendingAt: number | null
  lastErrorSummary: string | null
}>

export type CommittedEventDeliveryPageInput = Readonly<{
  page: number
  limit: number
  stage?: 'producer-publication' | 'consumer-delivery' | null
  state?: CommittedEventDeliveryState | null
  producer?: CommittedEventProducer | null
  family?: CommittedEventFamily | null
  aggregateId?: string | null
  consumerId?: string | null
}>

export interface CommittedEventDeliveryPersistencePort {
  getStored(eventIds: readonly string[]): Promise<readonly StoredCommittedEvent[]>
  claimNext(input: {
    readonly workerId: string
    readonly now: number
    readonly leaseMs?: number
    readonly scanLimit?: number
  }): Promise<ClaimedCommittedEventDelivery | null>
  accept(input: {
    readonly claim: ClaimedCommittedEventDelivery
    readonly now: number
  }): Promise<void>
  reject(input: {
    readonly claim: ClaimedCommittedEventDelivery
    readonly errorCode: string
    readonly errorSummary: string
    readonly maxAttempts: number
    readonly now: number
  }): Promise<'retried' | 'dead-letter'>
  retry(input: ManualCommittedEventRetryInput): Promise<ManualCommittedEventRetryReceipt>
  deliveryPage(input: CommittedEventDeliveryPageInput): Promise<CommittedEventDeliveryPage>
  health(): Promise<CommittedEventDeliveryHealth>
}
