// RFC-341 — source-neutral SQLite committed-event store.

import { canonicalJson } from '@agent-workflow/shared'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  like,
  lt,
  lte,
  ne,
  notLike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { sha256Hex } from '@/util/hash'
import type {
  AppendCommittedEventInput,
  AppendCommittedEventReceipt,
  ClaimedCommittedEventDelivery,
  CommittedEventAggregateKind,
  CommittedEventCutover,
  CommittedEventDeliveryClass,
  CommittedEventDeliveryPage,
  CommittedEventDeliveryState,
  CommittedEventEnvelopeV1,
  CommittedEventFamily,
  CommittedEventProducer,
  CommittedEventRef,
  ManualCommittedEventRetryInput,
  ManualCommittedEventRetryReceipt,
  StoredCommittedEvent,
} from './types'

const MIGRATED_CANONICAL_HEX_DIGEST_PREFIX = 'canonical-hex-v1:'

function payloadDigestMatches(payloadJson: string, payloadDigest: string): boolean {
  if (payloadDigest.startsWith(MIGRATED_CANONICAL_HEX_DIGEST_PREFIX)) {
    const expected = Array.from(new TextEncoder().encode(payloadJson), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return payloadDigest === `${MIGRATED_CANONICAL_HEX_DIGEST_PREFIX}${expected}`
  }
  return payloadDigest === sha256Hex(payloadJson)
}

function changed(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
}

function assertProducerFamily(
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): void {
  const valid =
    (producer === 'task-execution' && family === 'task-lifecycle') ||
    (producer === 'collaboration' && family !== 'task-lifecycle')
  if (!valid) throw new Error(`committed event producer/family mismatch: ${producer}/${family}`)
}

function cutoverFromRow(
  row: typeof committedEventFamilyCutovers.$inferSelect,
): CommittedEventCutover {
  return {
    producer: row.producer,
    family: row.family,
    mode: row.mode,
    epoch: row.epoch,
    changedAt: row.changedAt,
    changeRef: row.changeRef,
  }
}

export function readCommittedEventCutoverTx(
  tx: DbTxSync,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): CommittedEventCutover {
  assertProducerFamily(producer, family)
  const row = tx
    .select()
    .from(committedEventFamilyCutovers)
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, producer),
        eq(committedEventFamilyCutovers.family, family),
      ),
    )
    .get()
  if (row === undefined) {
    throw new Error(`committed event cutover is missing: ${producer}/${family}`)
  }
  return cutoverFromRow(row)
}

export function readCommittedEventCutover(
  db: DbClient,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): CommittedEventCutover {
  return dbTxSync(db, (tx) => readCommittedEventCutoverTx(tx, producer, family))
}

export function changeCommittedEventCutoverTx(
  tx: DbTxSync,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    expectedMode: CommittedEventCutover['mode']
    expectedEpoch: number
    mode: CommittedEventCutover['mode']
    changedAt: number
    changeRef: string
  }>,
): CommittedEventCutover {
  assertProducerFamily(input.producer, input.family)
  assertPositiveInteger(input.expectedEpoch, 'expectedEpoch')
  if (
    !Number.isSafeInteger(input.changedAt) ||
    input.changedAt < 0 ||
    input.changeRef.length === 0
  ) {
    throw new Error('committed event cutover change requires time and durable ref')
  }
  const result = tx
    .update(committedEventFamilyCutovers)
    .set({
      mode: input.mode,
      epoch: input.expectedEpoch + 1,
      changedAt: input.changedAt,
      changeRef: input.changeRef,
    })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, input.producer),
        eq(committedEventFamilyCutovers.family, input.family),
        eq(committedEventFamilyCutovers.mode, input.expectedMode),
        eq(committedEventFamilyCutovers.epoch, input.expectedEpoch),
      ),
    )
    .run()
  if (changed(result) !== 1) {
    throw new Error(
      `committed event cutover changed concurrently: ${input.producer}/${input.family}`,
    )
  }
  return readCommittedEventCutoverTx(tx, input.producer, input.family)
}

function eventRefFromRow(row: typeof committedEvents.$inferSelect): CommittedEventRef {
  return {
    eventId: row.id,
    payloadDigest: row.payloadDigest,
    producer: row.producer,
    family: row.family,
    aggregate: {
      kind: row.aggregateKind,
      id: row.aggregateId,
      seq: row.aggregateSeq,
    },
    eventGroupId: row.eventGroupId,
    eventGroupOrdinal: row.eventGroupOrdinal,
    deliveryMode: row.deliveryMode,
    producerEpoch: row.producerEpoch,
  }
}

function storedEventFromRow(row: typeof committedEvents.$inferSelect): StoredCommittedEvent {
  if (!payloadDigestMatches(row.payloadJson, row.payloadDigest)) {
    throw new Error(`committed event payload digest does not match: ${row.id}`)
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(row.payloadJson) as unknown
  } catch {
    throw new Error(`committed event payload is not JSON: ${row.id}`)
  }
  if (envelope === null || typeof envelope !== 'object') {
    throw new Error(`committed event payload is not an envelope: ${row.id}`)
  }
  return {
    envelope: envelope as CommittedEventEnvelopeV1,
    payloadJson: row.payloadJson,
    payloadDigest: row.payloadDigest,
    deliveryMode: row.deliveryMode,
    producerEpoch: row.producerEpoch,
    createdAt: row.createdAt,
  }
}

function sameConsumerManifest(
  tx: DbTxSync,
  eventId: string,
  consumers: AppendCommittedEventInput<string, unknown>['consumers'],
): boolean {
  const expected = [...consumers]
    .map((consumer) => `${consumer.id}\u0000${consumer.deliveryClass}`)
    .sort()
  const actual = tx
    .select({
      consumerId: committedEventDeliveries.consumerId,
      deliveryClass: committedEventDeliveries.deliveryClass,
    })
    .from(committedEventDeliveries)
    .where(eq(committedEventDeliveries.eventId, eventId))
    .all()
    .map((consumer) => `${consumer.consumerId}\u0000${consumer.deliveryClass}`)
    .sort()
  return canonicalJson(expected) === canonicalJson(actual)
}

function reserveAggregateSequenceTx(
  tx: DbTxSync,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    aggregateKind: CommittedEventAggregateKind
    aggregateId: string
    requested?: number
    now: number
  }>,
): number {
  if (input.requested !== undefined) assertPositiveInteger(input.requested, 'aggregate.seq')
  const where = and(
    eq(committedEventAggregateHeads.producer, input.producer),
    eq(committedEventAggregateHeads.family, input.family),
    eq(committedEventAggregateHeads.aggregateKind, input.aggregateKind),
    eq(committedEventAggregateHeads.aggregateId, input.aggregateId),
  )
  const head = tx
    .select({ lastSeq: committedEventAggregateHeads.lastSeq })
    .from(committedEventAggregateHeads)
    .where(where)
    .get()
  const next = input.requested ?? (head?.lastSeq ?? 0) + 1
  if (head !== undefined && next <= head.lastSeq) {
    throw new Error(
      `committed event aggregate sequence did not advance: ${input.producer}/${input.family}/${input.aggregateKind}/${input.aggregateId}@${next}`,
    )
  }
  if (head === undefined) {
    tx.insert(committedEventAggregateHeads)
      .values({
        producer: input.producer,
        family: input.family,
        aggregateKind: input.aggregateKind,
        aggregateId: input.aggregateId,
        lastSeq: next,
        updatedAt: input.now,
      })
      .run()
  } else {
    tx.update(committedEventAggregateHeads)
      .set({ lastSeq: next, updatedAt: input.now })
      .where(where)
      .run()
  }
  return next
}

function deterministicEventId(input: {
  producer: CommittedEventProducer
  family: CommittedEventFamily
  aggregateKind: CommittedEventAggregateKind
  aggregateId: string
  aggregateSeq: number
  type: string
  operationRef: string
}): string {
  return `committed-event:${sha256Hex(canonicalJson(input))}`
}

function validateAppendInput(input: AppendCommittedEventInput<string, unknown>): void {
  assertProducerFamily(input.producer, input.family)
  assertNonNegativeInteger(input.eventGroupOrdinal, 'eventGroupOrdinal')
  if (
    input.type.length === 0 ||
    input.aggregate.id.length === 0 ||
    input.eventGroupId.length === 0 ||
    input.operationRef.length === 0 ||
    !Number.isSafeInteger(input.occurredAt) ||
    input.occurredAt < 0
  ) {
    throw new Error('committed event append requires complete immutable identity')
  }
  const seen = new Set<string>()
  for (const consumer of input.consumers) {
    if (consumer.id.length === 0 || seen.has(consumer.id)) {
      throw new Error(`committed event consumer manifest is invalid: '${consumer.id}'`)
    }
    seen.add(consumer.id)
  }
}

export function appendCommittedEventTx<TType extends string, TPayload>(
  tx: DbTxSync,
  input: AppendCommittedEventInput<TType, TPayload>,
): AppendCommittedEventReceipt {
  validateAppendInput(input as AppendCommittedEventInput<string, unknown>)
  const cutover = readCommittedEventCutoverTx(tx, input.producer, input.family)
  const existing = tx
    .select()
    .from(committedEvents)
    .where(
      and(
        eq(committedEvents.eventGroupId, input.eventGroupId),
        eq(committedEvents.eventGroupOrdinal, input.eventGroupOrdinal),
      ),
    )
    .get()

  if (existing !== undefined) {
    const eventId = input.eventId ?? existing.id
    const envelope: CommittedEventEnvelopeV1<TType, TPayload> = {
      eventId,
      eventGroupId: input.eventGroupId,
      eventGroupOrdinal: input.eventGroupOrdinal,
      type: input.type,
      schemaVersion: 1,
      producer: input.producer,
      family: input.family,
      aggregate: {
        kind: input.aggregate.kind,
        id: input.aggregate.id,
        seq: input.aggregate.seq ?? existing.aggregateSeq,
      },
      operationRef: input.operationRef,
      correlationRef: input.correlationRef ?? null,
      causationRef: input.causationRef ?? null,
      occurredAt: new Date(input.occurredAt).toISOString(),
      payload: input.payload,
    }
    const payloadJson = canonicalJson(envelope)
    const digest = sha256Hex(payloadJson)
    if (
      existing.id !== eventId ||
      existing.payloadDigest !== digest ||
      existing.payloadJson !== payloadJson ||
      !sameConsumerManifest(
        tx,
        existing.id,
        input.consumers as AppendCommittedEventInput<string, unknown>['consumers'],
      )
    ) {
      throw new Error(`committed event replay conflicts with immutable event: ${existing.id}`)
    }
    return { cutover, eventRef: eventRefFromRow(existing) }
  }

  if (cutover.mode === 'legacy') return { cutover, eventRef: null }

  const aggregateSeq = reserveAggregateSequenceTx(tx, {
    producer: input.producer,
    family: input.family,
    aggregateKind: input.aggregate.kind,
    aggregateId: input.aggregate.id,
    ...(input.aggregate.seq === undefined ? {} : { requested: input.aggregate.seq }),
    now: input.occurredAt,
  })
  const eventId =
    input.eventId ??
    deterministicEventId({
      producer: input.producer,
      family: input.family,
      aggregateKind: input.aggregate.kind,
      aggregateId: input.aggregate.id,
      aggregateSeq,
      type: input.type,
      operationRef: input.operationRef,
    })
  const envelope: CommittedEventEnvelopeV1<TType, TPayload> = {
    eventId,
    eventGroupId: input.eventGroupId,
    eventGroupOrdinal: input.eventGroupOrdinal,
    type: input.type,
    schemaVersion: 1,
    producer: input.producer,
    family: input.family,
    aggregate: { kind: input.aggregate.kind, id: input.aggregate.id, seq: aggregateSeq },
    operationRef: input.operationRef,
    correlationRef: input.correlationRef ?? null,
    causationRef: input.causationRef ?? null,
    occurredAt: new Date(input.occurredAt).toISOString(),
    payload: input.payload,
  }
  const payloadJson = canonicalJson(envelope)
  const payloadDigest = sha256Hex(payloadJson)
  const deliveryMode = cutover.mode
  tx.insert(committedEvents)
    .values({
      id: eventId,
      eventGroupId: input.eventGroupId,
      eventGroupOrdinal: input.eventGroupOrdinal,
      producer: input.producer,
      family: input.family,
      eventType: input.type,
      schemaVersion: 1,
      aggregateKind: input.aggregate.kind,
      aggregateId: input.aggregate.id,
      aggregateSeq,
      operationRef: input.operationRef,
      correlationRef: input.correlationRef ?? null,
      causationRef: input.causationRef ?? null,
      occurredAt: input.occurredAt,
      payloadJson,
      payloadDigest,
      deliveryMode,
      producerEpoch: cutover.epoch,
      createdAt: input.occurredAt,
    })
    .run()
  if (input.consumers.length > 0) {
    tx.insert(committedEventDeliveries)
      .values(
        input.consumers.map((consumer) => ({
          eventId,
          consumerId: consumer.id,
          deliveryClass: consumer.deliveryClass,
          state: 'pending' as const,
          attemptCount: 0,
          nextAttemptAt: input.occurredAt,
          leaseEpoch: 0,
          replayGeneration: 0,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        })),
      )
      .run()
  }
  const inserted = tx.select().from(committedEvents).where(eq(committedEvents.id, eventId)).get()
  if (inserted === undefined) throw new Error(`committed event insert vanished: ${eventId}`)
  return { cutover, eventRef: eventRefFromRow(inserted) }
}

export function getStoredCommittedEvent(
  db: DbClient,
  eventId: string,
): StoredCommittedEvent | null {
  const row = db.select().from(committedEvents).where(eq(committedEvents.id, eventId)).get()
  return row === undefined ? null : storedEventFromRow(row)
}

export function getStoredCommittedEvents(
  db: DbClient,
  eventIds: readonly string[],
): readonly StoredCommittedEvent[] {
  if (eventIds.length === 0) return []
  return db
    .select()
    .from(committedEvents)
    .where(inArray(committedEvents.id, [...eventIds]))
    .orderBy(asc(committedEvents.eventGroupId), asc(committedEvents.eventGroupOrdinal))
    .all()
    .map(storedEventFromRow)
}

function priorDeliveryBlocks(
  tx: DbTxSync,
  candidate: {
    producer: CommittedEventProducer
    family: CommittedEventFamily
    aggregateKind: CommittedEventAggregateKind
    aggregateId: string
    aggregateSeq: number
    producerEpoch: number
    consumerId: string
  },
): boolean {
  const priorIds = tx
    .select({ id: committedEvents.id })
    .from(committedEvents)
    .where(
      and(
        eq(committedEvents.producer, candidate.producer),
        eq(committedEvents.family, candidate.family),
        eq(committedEvents.aggregateKind, candidate.aggregateKind),
        eq(committedEvents.aggregateId, candidate.aggregateId),
        eq(committedEvents.deliveryMode, 'dispatchable'),
        eq(committedEvents.producerEpoch, candidate.producerEpoch),
        lt(committedEvents.aggregateSeq, candidate.aggregateSeq),
      ),
    )
    .all()
    .map((row) => row.id)
  if (priorIds.length === 0) return false
  return (
    tx
      .select({ eventId: committedEventDeliveries.eventId })
      .from(committedEventDeliveries)
      .where(
        and(
          inArray(committedEventDeliveries.eventId, priorIds),
          eq(committedEventDeliveries.consumerId, candidate.consumerId),
          ne(committedEventDeliveries.state, 'accepted'),
        ),
      )
      .limit(1)
      .get() !== undefined
  )
}

export function claimNextCommittedEventDelivery(input: {
  readonly db: DbClient
  readonly workerId: string
  readonly now?: number
  readonly leaseMs?: number
  readonly scanLimit?: number
}): ClaimedCommittedEventDelivery | null {
  const at = input.now ?? Date.now()
  const leaseMs = input.leaseMs ?? 60_000
  const scanLimit = input.scanLimit ?? 64
  if (input.workerId.length === 0) throw new Error('committed event claim requires workerId')
  assertPositiveInteger(leaseMs, 'leaseMs')
  assertPositiveInteger(scanLimit, 'scanLimit')

  return dbTxSync(input.db, (tx) => {
    const candidates = tx
      .select({
        event: committedEvents,
        consumerId: committedEventDeliveries.consumerId,
        deliveryClass: committedEventDeliveries.deliveryClass,
        state: committedEventDeliveries.state,
        attemptCount: committedEventDeliveries.attemptCount,
        leaseEpoch: committedEventDeliveries.leaseEpoch,
      })
      .from(committedEventDeliveries)
      .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
      .innerJoin(
        committedEventFamilyCutovers,
        and(
          eq(committedEventFamilyCutovers.producer, committedEvents.producer),
          eq(committedEventFamilyCutovers.family, committedEvents.family),
        ),
      )
      .where(
        and(
          eq(committedEvents.deliveryMode, 'dispatchable'),
          eq(committedEventFamilyCutovers.mode, 'dispatchable'),
          eq(committedEvents.producerEpoch, committedEventFamilyCutovers.epoch),
          lte(committedEventDeliveries.nextAttemptAt, at),
          or(
            eq(committedEventDeliveries.state, 'pending'),
            and(
              eq(committedEventDeliveries.state, 'claimed'),
              lte(committedEventDeliveries.claimExpiresAt, at),
            ),
          ),
        ),
      )
      .orderBy(
        asc(committedEvents.createdAt),
        asc(committedEvents.eventGroupOrdinal),
        asc(committedEventDeliveries.consumerId),
      )
      .limit(scanLimit)
      .all()

    for (const candidate of candidates) {
      if (
        priorDeliveryBlocks(tx, {
          producer: candidate.event.producer,
          family: candidate.event.family,
          aggregateKind: candidate.event.aggregateKind,
          aggregateId: candidate.event.aggregateId,
          aggregateSeq: candidate.event.aggregateSeq,
          producerEpoch: candidate.event.producerEpoch,
          consumerId: candidate.consumerId,
        })
      ) {
        continue
      }
      const nextLeaseEpoch = candidate.leaseEpoch + 1
      const result = tx
        .update(committedEventDeliveries)
        .set({
          state: 'claimed',
          attemptCount: candidate.attemptCount + 1,
          claimedBy: input.workerId,
          leaseEpoch: nextLeaseEpoch,
          claimExpiresAt: at + leaseMs,
          updatedAt: at,
        })
        .where(
          and(
            eq(committedEventDeliveries.eventId, candidate.event.id),
            eq(committedEventDeliveries.consumerId, candidate.consumerId),
            eq(committedEventDeliveries.state, candidate.state),
            eq(committedEventDeliveries.leaseEpoch, candidate.leaseEpoch),
          ),
        )
        .run()
      if (changed(result) !== 1) continue
      return {
        event: storedEventFromRow(candidate.event),
        consumerId: candidate.consumerId,
        deliveryClass: candidate.deliveryClass,
        attemptCount: candidate.attemptCount + 1,
        leaseEpoch: nextLeaseEpoch,
        claimedBy: input.workerId,
        claimExpiresAt: at + leaseMs,
      }
    }
    return null
  })
}

export function acceptCommittedEventDelivery(input: {
  readonly db: DbClient
  readonly claim: ClaimedCommittedEventDelivery
  readonly now?: number
}): void {
  const at = input.now ?? Date.now()
  const result = input.db
    .update(committedEventDeliveries)
    .set({
      state: 'accepted',
      claimedBy: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      acceptedAt: at,
      deadLetterAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(committedEventDeliveries.eventId, input.claim.event.envelope.eventId),
        eq(committedEventDeliveries.consumerId, input.claim.consumerId),
        eq(committedEventDeliveries.state, 'claimed'),
        eq(committedEventDeliveries.claimedBy, input.claim.claimedBy),
        eq(committedEventDeliveries.leaseEpoch, input.claim.leaseEpoch),
      ),
    )
    .run()
  if (changed(result) !== 1) {
    throw new Error(
      `committed event delivery lease lost: ${input.claim.event.envelope.eventId}/${input.claim.consumerId}`,
    )
  }
}

export function rejectCommittedEventDelivery(input: {
  readonly db: DbClient
  readonly claim: ClaimedCommittedEventDelivery
  readonly errorCode: string
  readonly errorSummary: string
  readonly maxAttempts: number
  readonly now?: number
}): 'retried' | 'dead-letter' {
  const at = input.now ?? Date.now()
  assertPositiveInteger(input.maxAttempts, 'maxAttempts')
  const terminal = input.claim.attemptCount >= input.maxAttempts
  const result = input.db
    .update(committedEventDeliveries)
    .set({
      state: terminal ? 'dead-letter' : 'pending',
      claimedBy: null,
      claimExpiresAt: null,
      nextAttemptAt: terminal
        ? at
        : at + Math.min(30_000, 1_000 * 2 ** Math.max(0, input.claim.attemptCount - 1)),
      lastErrorCode: input.errorCode.slice(0, 200),
      lastErrorSummary: input.errorSummary.slice(0, 2_000),
      ...(terminal ? { deadLetterAt: at } : { deadLetterAt: null }),
      updatedAt: at,
    })
    .where(
      and(
        eq(committedEventDeliveries.eventId, input.claim.event.envelope.eventId),
        eq(committedEventDeliveries.consumerId, input.claim.consumerId),
        eq(committedEventDeliveries.state, 'claimed'),
        eq(committedEventDeliveries.claimedBy, input.claim.claimedBy),
        eq(committedEventDeliveries.leaseEpoch, input.claim.leaseEpoch),
      ),
    )
    .run()
  if (changed(result) !== 1) {
    throw new Error(
      `committed event delivery lease lost: ${input.claim.event.envelope.eventId}/${input.claim.consumerId}`,
    )
  }
  return terminal ? 'dead-letter' : 'retried'
}

export function retryCommittedEventDelivery(
  db: DbClient,
  input: ManualCommittedEventRetryInput,
): ManualCommittedEventRetryReceipt {
  assertNonNegativeInteger(input.observedLeaseEpoch, 'observedLeaseEpoch')
  assertNonNegativeInteger(input.observedUpdatedAt, 'observedUpdatedAt')
  const at = input.now ?? Date.now()
  const rows = db
    .update(committedEventDeliveries)
    .set({
      state: 'pending',
      nextAttemptAt: at,
      claimedBy: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      deadLetterAt: null,
      replayGeneration: sql`${committedEventDeliveries.replayGeneration} + 1`,
      updatedAt: at,
    })
    .where(
      and(
        eq(committedEventDeliveries.eventId, input.eventId),
        eq(committedEventDeliveries.consumerId, input.consumerId),
        eq(committedEventDeliveries.state, 'dead-letter'),
        eq(committedEventDeliveries.leaseEpoch, input.observedLeaseEpoch),
        eq(committedEventDeliveries.updatedAt, input.observedUpdatedAt),
      ),
    )
    .returning({
      replayGeneration: committedEventDeliveries.replayGeneration,
      updatedAt: committedEventDeliveries.updatedAt,
    })
    .all()
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`committed event delivery retry lost CAS: ${input.eventId}/${input.consumerId}`)
  }
  return {
    eventId: input.eventId,
    consumerId: input.consumerId,
    replayGeneration: row.replayGeneration,
    state: 'pending',
    updatedAt: row.updatedAt,
  }
}

export function committedEventDeliveryPage(
  db: DbClient,
  input: Readonly<{
    page: number
    limit: number
    stage?: 'producer-publication' | 'consumer-delivery' | null
    state?: CommittedEventDeliveryState | null
    producer?: CommittedEventProducer | null
    family?: CommittedEventFamily | null
    aggregateId?: string | null
    consumerId?: string | null
  }>,
): CommittedEventDeliveryPage {
  assertPositiveInteger(input.page, 'page')
  assertPositiveInteger(input.limit, 'limit')
  const conditions: SQL[] = []
  if (input.stage === 'producer-publication') {
    conditions.push(like(committedEventDeliveries.consumerId, 'event-center.%'))
  } else if (input.stage === 'consumer-delivery') {
    conditions.push(notLike(committedEventDeliveries.consumerId, 'event-center.%'))
  }
  if (input.state != null) conditions.push(eq(committedEventDeliveries.state, input.state))
  if (input.producer != null) conditions.push(eq(committedEvents.producer, input.producer))
  if (input.family != null) conditions.push(eq(committedEvents.family, input.family))
  if (input.aggregateId != null && input.aggregateId.length > 0) {
    conditions.push(eq(committedEvents.aggregateId, input.aggregateId))
  }
  if (input.consumerId != null && input.consumerId.length > 0) {
    conditions.push(eq(committedEventDeliveries.consumerId, input.consumerId))
  }
  const where = conditions.length === 0 ? undefined : and(...conditions)
  const countRow = db
    .select({ count: sql<number>`count(*)` })
    .from(committedEventDeliveries)
    .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
    .where(where)
    .get()
  const total = Number(countRow?.count ?? 0)
  const rows = db
    .select({ event: committedEvents, delivery: committedEventDeliveries })
    .from(committedEventDeliveries)
    .innerJoin(committedEvents, eq(committedEvents.id, committedEventDeliveries.eventId))
    .where(where)
    .orderBy(desc(committedEventDeliveries.updatedAt), desc(committedEvents.id))
    .limit(input.limit)
    .offset((input.page - 1) * input.limit)
    .all()
  return {
    items: rows.map(({ event, delivery }) => ({
      eventId: event.id,
      stage: delivery.consumerId.startsWith('event-center.')
        ? 'producer-publication'
        : 'consumer-delivery',
      producer: event.producer,
      family: event.family,
      eventType: event.eventType,
      aggregateKind: event.aggregateKind,
      aggregateId: event.aggregateId,
      aggregateSeq: event.aggregateSeq,
      consumerId: delivery.consumerId,
      mode: event.deliveryMode,
      state: delivery.state,
      attemptCount: delivery.attemptCount,
      nextAttemptAt:
        delivery.state === 'accepted' || delivery.state === 'dead-letter'
          ? null
          : new Date(delivery.nextAttemptAt).toISOString(),
      leaseEpoch: delivery.leaseEpoch,
      lastErrorSummary: delivery.lastErrorSummary,
      updatedAt: new Date(delivery.updatedAt).toISOString(),
      canRetry: event.deliveryMode === 'dispatchable' && delivery.state === 'dead-letter',
    })),
    page: input.page,
    limit: input.limit,
    total,
    pageCount: Math.max(1, Math.ceil(total / input.limit)),
  }
}

export function committedEventDeliveryHealth(db: DbClient): Readonly<{
  pending: number
  claimed: number
  deadLetter: number
  oldestPendingAt: number | null
  lastErrorSummary: string | null
}> {
  const rows = db
    .select({
      state: committedEventDeliveries.state,
      createdAt: committedEventDeliveries.createdAt,
      updatedAt: committedEventDeliveries.updatedAt,
      lastErrorSummary: committedEventDeliveries.lastErrorSummary,
    })
    .from(committedEventDeliveries)
    .all()
  const pendingRows = rows.filter((row) => row.state === 'pending')
  const lastError = [...rows]
    .filter((row) => row.lastErrorSummary !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return {
    pending: pendingRows.length,
    claimed: rows.filter((row) => row.state === 'claimed').length,
    deadLetter: rows.filter((row) => row.state === 'dead-letter').length,
    oldestPendingAt:
      pendingRows.length === 0 ? null : Math.min(...pendingRows.map((row) => row.createdAt)),
    lastErrorSummary: lastError?.lastErrorSummary ?? null,
  }
}

export function committedEventDeliveryManifest(
  db: DbClient,
  eventId: string,
): readonly Readonly<{
  consumerId: string
  deliveryClass: CommittedEventDeliveryClass
  state: CommittedEventDeliveryState
}>[] {
  return db
    .select({
      consumerId: committedEventDeliveries.consumerId,
      deliveryClass: committedEventDeliveries.deliveryClass,
      state: committedEventDeliveries.state,
    })
    .from(committedEventDeliveries)
    .where(eq(committedEventDeliveries.eventId, eventId))
    .orderBy(asc(committedEventDeliveries.consumerId))
    .all()
}
