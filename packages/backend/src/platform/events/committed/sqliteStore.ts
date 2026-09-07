// RFC-341 / RFC-359 W7 —— committed-event 的**同步** append 半区（仅剩过渡期的 `dbTxSync` 调用方用）。
//
// 这个文件曾经同时装着 append 与出站投递两半。RFC-359 W7 把投递那一半合成
// `deliveryPersistence.ts`（一份实现两个引擎共用），这里只剩 append 半区，而 append 本身
// **也已经**在 `append.ts` 里有一份 provider-中立的异步实现。留下这一份同步版本的唯一理由：
// `modules/collaboration/infrastructure/collaborationCommittedEventParticipant.ts` 与
// `modules/task-execution/infrastructure/taskLifecycleEventParticipant.ts` 的调用方还在
// `dbTxSync` 里。那两个参与者的头注释已写明：调用方迁到 `DatabaseSession` 之后，它们连同本文件
// 一起删除，`append.ts` 是唯一实现。**不要**往这里加新东西。

import { canonicalJson } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { sha256Hex } from '@/util/hash'
import {
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

function changed(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
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
