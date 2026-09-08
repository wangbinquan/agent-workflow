// Shared committed-event SQL and decision order; callers retain their transaction mechanism.

import { and, eq } from 'drizzle-orm'
import { canonicalJson } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import {
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import { sha256Hex } from '@/util/hash'
import {
  aggregateSequenceLockKey,
  assertPositiveInteger,
  assertProducerFamily,
  cutoverFromRow,
  deterministicEventId,
  eventRefFromRow,
  validateAppendInput,
} from './appendShared'
import type {
  AppendCommittedEventInput,
  AppendCommittedEventReceipt,
  CommittedEventAggregateKind,
  CommittedEventCutover,
  CommittedEventEnvelopeV1,
  CommittedEventFamily,
  CommittedEventProducer,
} from './types'

type AppendProgramDatabase = Pick<ProviderNeutralDatabase, 'select' | 'insert' | 'update'>
type AggregateLock = (key: string) => void | Promise<void>

function changed(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

export function* readCommittedEventCutoverProgram(
  tx: AppendProgramDatabase,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): Generator<TransactionProgramStep, CommittedEventCutover, void> {
  assertProducerFamily(producer, family)
  const row = yield* transactionStep(() =>
    tx
      .select()
      .from(committedEventFamilyCutovers)
      .where(
        and(
          eq(committedEventFamilyCutovers.producer, producer),
          eq(committedEventFamilyCutovers.family, family),
        ),
      )
      .get(),
  )
  if (row === undefined) {
    throw new Error(`committed event cutover is missing: ${producer}/${family}`)
  }
  return cutoverFromRow(row)
}

export function* changeCommittedEventCutoverProgram(
  tx: AppendProgramDatabase,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    expectedMode: CommittedEventCutover['mode']
    expectedEpoch: number
    mode: CommittedEventCutover['mode']
    changedAt: number
    changeRef: string
  }>,
): Generator<TransactionProgramStep, CommittedEventCutover, void> {
  assertProducerFamily(input.producer, input.family)
  assertPositiveInteger(input.expectedEpoch, 'expectedEpoch')
  if (
    !Number.isSafeInteger(input.changedAt) ||
    input.changedAt < 0 ||
    input.changeRef.length === 0
  ) {
    throw new Error('committed event cutover change requires time and durable ref')
  }
  const result = yield* transactionStep(() =>
    tx
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
      .run(),
  )
  if (changed(result) !== 1) {
    throw new Error(
      `committed event cutover changed concurrently: ${input.producer}/${input.family}`,
    )
  }
  return yield* readCommittedEventCutoverProgram(tx, input.producer, input.family)
}

function* sameConsumerManifestProgram(
  tx: AppendProgramDatabase,
  eventId: string,
  consumers: AppendCommittedEventInput<string, unknown>['consumers'],
): Generator<TransactionProgramStep, boolean, void> {
  const expected = [...consumers]
    .map((consumer) => `${consumer.id}\u0000${consumer.deliveryClass}`)
    .sort()
  const actual = (yield* transactionStep(() =>
    tx
      .select({
        consumerId: committedEventDeliveries.consumerId,
        deliveryClass: committedEventDeliveries.deliveryClass,
      })
      .from(committedEventDeliveries)
      .where(eq(committedEventDeliveries.eventId, eventId))
      .all(),
  ))
    .map((consumer) => `${consumer.consumerId}\u0000${consumer.deliveryClass}`)
    .sort()
  return canonicalJson(expected) === canonicalJson(actual)
}

function* reserveAggregateSequenceProgram(
  tx: AppendProgramDatabase,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    aggregateKind: CommittedEventAggregateKind
    aggregateId: string
    requested?: number
    now: number
  }>,
  lockAggregate: AggregateLock,
): Generator<TransactionProgramStep, number, void> {
  if (input.requested !== undefined) assertPositiveInteger(input.requested, 'aggregate.seq')
  // 同一聚合的两个并发 append 必须串行分配序号。SQLite 的 BEGIN IMMEDIATE 已独占；
  // PostgreSQL READ COMMITTED 下两个事务会各读到同一个 head 再各自 +1，所以先取事务级 advisory lock。
  yield* transactionStep(() => lockAggregate(aggregateSequenceLockKey(input)))
  const where = and(
    eq(committedEventAggregateHeads.producer, input.producer),
    eq(committedEventAggregateHeads.family, input.family),
    eq(committedEventAggregateHeads.aggregateKind, input.aggregateKind),
    eq(committedEventAggregateHeads.aggregateId, input.aggregateId),
  )
  const head = yield* transactionStep(() =>
    tx
      .select({ lastSeq: committedEventAggregateHeads.lastSeq })
      .from(committedEventAggregateHeads)
      .where(where)
      .get(),
  )
  const next = input.requested ?? (head?.lastSeq ?? 0) + 1
  if (head !== undefined && next <= head.lastSeq) {
    throw new Error(
      `committed event aggregate sequence did not advance: ${input.producer}/${input.family}/${input.aggregateKind}/${input.aggregateId}@${next}`,
    )
  }
  if (head === undefined) {
    yield* transactionStep(() =>
      tx
        .insert(committedEventAggregateHeads)
        .values({
          producer: input.producer,
          family: input.family,
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          lastSeq: next,
          updatedAt: input.now,
        })
        .run(),
    )
  } else {
    yield* transactionStep(() =>
      tx
        .update(committedEventAggregateHeads)
        .set({ lastSeq: next, updatedAt: input.now })
        .where(where)
        .run(),
    )
  }
  return next
}

/**
 * 在调用方已持有的事务里追加一条 committed event。同一 `(eventGroupId, eventGroupOrdinal)` 的
 * 重放必须逐字节等于已存在的事件（含消费者清单），否则抛错；cutover 处于 legacy 时不落行、
 * 返回空 eventRef。
 */
export function* appendCommittedEventProgram<TType extends string, TPayload>(
  tx: AppendProgramDatabase,
  input: AppendCommittedEventInput<TType, TPayload>,
  lockAggregate: AggregateLock,
): Generator<TransactionProgramStep, AppendCommittedEventReceipt, void> {
  validateAppendInput(input as AppendCommittedEventInput<string, unknown>)
  const cutover = yield* readCommittedEventCutoverProgram(tx, input.producer, input.family)
  const existing = yield* transactionStep(() =>
    tx
      .select()
      .from(committedEvents)
      .where(
        and(
          eq(committedEvents.eventGroupId, input.eventGroupId),
          eq(committedEvents.eventGroupOrdinal, input.eventGroupOrdinal),
        ),
      )
      .get(),
  )
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
    const payloadDigest = sha256Hex(payloadJson)
    if (
      existing.id !== eventId ||
      existing.payloadDigest !== payloadDigest ||
      existing.payloadJson !== payloadJson ||
      !(yield* sameConsumerManifestProgram(
        tx,
        existing.id,
        input.consumers as AppendCommittedEventInput<string, unknown>['consumers'],
      ))
    ) {
      throw new Error(`committed event replay conflicts with immutable event: ${existing.id}`)
    }
    return { cutover, eventRef: eventRefFromRow(existing) }
  }
  if (cutover.mode === 'legacy') return { cutover, eventRef: null }
  const aggregateSeq = yield* reserveAggregateSequenceProgram(
    tx,
    {
      producer: input.producer,
      family: input.family,
      aggregateKind: input.aggregate.kind,
      aggregateId: input.aggregate.id,
      ...(input.aggregate.seq === undefined ? {} : { requested: input.aggregate.seq }),
      now: input.occurredAt,
    },
    lockAggregate,
  )
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
  yield* transactionStep(() =>
    tx
      .insert(committedEvents)
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
      .run(),
  )
  if (input.consumers.length > 0) {
    yield* transactionStep(() =>
      tx
        .insert(committedEventDeliveries)
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
        .run(),
    )
  }
  const inserted = yield* transactionStep(() =>
    tx.select().from(committedEvents).where(eq(committedEvents.id, eventId)).get(),
  )
  if (inserted === undefined) throw new Error(`committed event insert vanished: ${eventId}`)
  return { cutover, eventRef: eventRefFromRow(inserted) }
}
