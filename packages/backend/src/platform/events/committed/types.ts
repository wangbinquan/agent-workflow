// RFC-341 — producer-neutral committed-event contracts.

export const COMMITTED_EVENT_PRODUCERS = ['task-execution', 'collaboration'] as const
export type CommittedEventProducer = (typeof COMMITTED_EVENT_PRODUCERS)[number]

export const COMMITTED_EVENT_FAMILIES = [
  'task-lifecycle',
  'review',
  'clarify',
  'questions',
] as const
export type CommittedEventFamily = (typeof COMMITTED_EVENT_FAMILIES)[number]

export const COMMITTED_EVENT_AGGREGATE_KINDS = [
  'task',
  'review-round',
  'clarify-round',
  'question-gate',
] as const
export type CommittedEventAggregateKind = (typeof COMMITTED_EVENT_AGGREGATE_KINDS)[number]

export type CommittedEventCutoverMode = 'legacy' | 'shadow' | 'dispatchable'
export type CommittedEventDeliveryMode = Exclude<CommittedEventCutoverMode, 'legacy'>
export type CommittedEventDeliveryClass = 'critical' | 'rebuildable'
export type CommittedEventDeliveryState = 'pending' | 'claimed' | 'accepted' | 'dead-letter'

export type CommittedEventAggregateRef = Readonly<{
  kind: CommittedEventAggregateKind
  id: string
  seq: number
}>

export type CommittedEventEnvelopeV1<TType extends string = string, TPayload = unknown> = Readonly<{
  eventId: string
  eventGroupId: string
  eventGroupOrdinal: number
  type: TType
  schemaVersion: 1
  producer: CommittedEventProducer
  family: CommittedEventFamily
  aggregate: CommittedEventAggregateRef
  operationRef: string
  correlationRef: string | null
  causationRef: string | null
  occurredAt: string
  payload: TPayload
}>

export type CommittedEventRef = Readonly<{
  eventId: string
  payloadDigest: string
  producer: CommittedEventProducer
  family: CommittedEventFamily
  aggregate: CommittedEventAggregateRef
  eventGroupId: string
  eventGroupOrdinal: number
  deliveryMode: CommittedEventDeliveryMode
  producerEpoch: number
}>

export type CommittedEventCutover = Readonly<{
  producer: CommittedEventProducer
  family: CommittedEventFamily
  mode: CommittedEventCutoverMode
  epoch: number
  changedAt: number
  changeRef: string
}>

export type DurableCommittedEventConsumer = Readonly<{
  id: string
  deliveryClass: CommittedEventDeliveryClass
}>

export type AppendCommittedEventInput<TType extends string, TPayload> = Readonly<{
  producer: CommittedEventProducer
  family: CommittedEventFamily
  type: TType
  aggregate: Readonly<{
    kind: CommittedEventAggregateKind
    id: string
    /** Task lifecycle supplies its existing durable revision; other aggregates allocate. */
    seq?: number
  }>
  eventId?: string
  eventGroupId: string
  eventGroupOrdinal: number
  operationRef: string
  correlationRef?: string | null
  causationRef?: string | null
  occurredAt: number
  payload: TPayload
  consumers: readonly DurableCommittedEventConsumer[]
}>

export type AppendCommittedEventReceipt = Readonly<{
  cutover: CommittedEventCutover
  eventRef: CommittedEventRef | null
}>

export type StoredCommittedEvent = Readonly<{
  envelope: CommittedEventEnvelopeV1
  payloadJson: string
  payloadDigest: string
  deliveryMode: CommittedEventDeliveryMode
  producerEpoch: number
  createdAt: number
}>

/** Process-local attempt ledger shared by the immediate pump and durable
 * dispatcher. It suppresses normal-path duplicate WS invalidations while a
 * new process can still retry an ephemeral projection after a crash. */
export interface CommittedEventProjectionLedger {
  begin(input: Readonly<{ eventId: string; consumerId: string; payloadDigest: string }>): boolean
}

export function createCommittedEventProjectionLedger(
  limit = 4_096,
): CommittedEventProjectionLedger {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('committed event projection ledger limit must be a positive integer')
  }
  const attempted = new Map<string, string>()
  return {
    begin(input) {
      const key = `${input.eventId}\u0000${input.consumerId}`
      const previous = attempted.get(key)
      if (previous !== undefined) {
        if (previous !== input.payloadDigest) {
          throw new Error(`committed event digest changed in projection ledger: ${input.eventId}`)
        }
        return false
      }
      attempted.set(key, input.payloadDigest)
      while (attempted.size > limit) {
        const oldest = attempted.keys().next().value as string | undefined
        if (oldest === undefined) break
        attempted.delete(oldest)
      }
      return true
    },
  }
}

export type ClaimedCommittedEventDelivery = Readonly<{
  event: StoredCommittedEvent
  consumerId: string
  deliveryClass: CommittedEventDeliveryClass
  attemptCount: number
  leaseEpoch: number
  claimedBy: string
  claimExpiresAt: number
}>

export type CommittedEventConsumerDefinition = Readonly<{
  id: string
  eventTypes: readonly string[]
  deliveryClass: CommittedEventDeliveryClass | 'ephemeral'
  settle: 'delivery-accepted' | 'durable-effect-recorded' | 'projection-attempted'
  handle(event: CommittedEventEnvelopeV1): Promise<void> | void
}>

export type CommittedEventDeliveryView = Readonly<{
  eventId: string
  stage: 'producer-publication' | 'consumer-delivery'
  producer: CommittedEventProducer
  family: CommittedEventFamily
  eventType: string
  aggregateKind: CommittedEventAggregateKind
  aggregateId: string
  aggregateSeq: number
  consumerId: string
  mode: CommittedEventDeliveryMode
  state: CommittedEventDeliveryState
  attemptCount: number
  nextAttemptAt: string | null
  leaseEpoch: number
  lastErrorSummary: string | null
  updatedAt: string
  canRetry: boolean
}>

export type CommittedEventDeliveryPage = Readonly<{
  items: readonly CommittedEventDeliveryView[]
  page: number
  limit: number
  total: number
  pageCount: number
}>

export type ManualCommittedEventRetryInput = Readonly<{
  eventId: string
  consumerId: string
  observedLeaseEpoch: number
  observedUpdatedAt: number
  now?: number
}>

export type ManualCommittedEventRetryReceipt = Readonly<{
  eventId: string
  consumerId: string
  replayGeneration: number
  state: 'pending'
  updatedAt: number
}>

export function committedEventGroupId(
  producer: CommittedEventProducer,
  operationRef: string,
): string {
  if (operationRef.length === 0) throw new Error('committed event operationRef must not be empty')
  return `committed-event-group:${producer}:${operationRef}`
}
