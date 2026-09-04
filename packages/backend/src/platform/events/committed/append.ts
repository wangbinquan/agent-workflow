// RFC-359 —— committed-event 的**唯一** append 实现：一份代码，两个引擎。
//
// 以前 `sqliteStore.ts`（同步，dbTxSync 体内）与 `postgresqlPersistence.ts`（异步，自带
// advisory lock）各抄一份同样的逻辑。这里只按能力提需求：聚合序号的进程外互斥走
// `engineOf(tx).advisoryLock`（PostgreSQL：pg_advisory_xact_lock；SQLite：独占事务，no-op），
// 其余全是两边完全相同的 drizzle 语句。调用方在 `DatabaseSession.transaction` 体内传 `tx`，
// 事件与业务写入一起提交或一起回滚。

import { and, eq } from 'drizzle-orm'

import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import { canonicalJson } from '@agent-workflow/shared'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
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

export async function readCommittedEventCutover(
  tx: DatabaseTransaction,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): Promise<CommittedEventCutover> {
  assertProducerFamily(producer, family)
  const row = await tx
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

async function sameConsumerManifest(
  tx: DatabaseTransaction,
  eventId: string,
  consumers: AppendCommittedEventInput<string, unknown>['consumers'],
): Promise<boolean> {
  const expected = [...consumers]
    .map((consumer) => `${consumer.id}\u0000${consumer.deliveryClass}`)
    .sort()
  const actual = (
    await tx
      .select({
        consumerId: committedEventDeliveries.consumerId,
        deliveryClass: committedEventDeliveries.deliveryClass,
      })
      .from(committedEventDeliveries)
      .where(eq(committedEventDeliveries.eventId, eventId))
  )
    .map((consumer) => `${consumer.consumerId}\u0000${consumer.deliveryClass}`)
    .sort()
  return canonicalJson(expected) === canonicalJson(actual)
}

async function reserveAggregateSequence(
  tx: DatabaseTransaction,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    aggregateKind: CommittedEventAggregateKind
    aggregateId: string
    requested?: number
    now: number
  }>,
): Promise<number> {
  if (input.requested !== undefined) assertPositiveInteger(input.requested, 'aggregate.seq')
  // 同一聚合的两个并发 append 必须串行分配序号。SQLite 的 BEGIN IMMEDIATE 已独占；
  // PostgreSQL READ COMMITTED 下两个事务会各读到同一个 head 再各自 +1，所以先取事务级 advisory lock。
  await engineOf(tx).advisoryLock(tx, aggregateSequenceLockKey(input))
  const where = and(
    eq(committedEventAggregateHeads.producer, input.producer),
    eq(committedEventAggregateHeads.family, input.family),
    eq(committedEventAggregateHeads.aggregateKind, input.aggregateKind),
    eq(committedEventAggregateHeads.aggregateId, input.aggregateId),
  )
  const head = await tx
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
    await tx
      .insert(committedEventAggregateHeads)
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
    await tx
      .update(committedEventAggregateHeads)
      .set({ lastSeq: next, updatedAt: input.now })
      .where(where)
      .run()
  }
  return next
}

/**
 * 在调用方已持有的事务里追加一条 committed event。同一 `(eventGroupId, eventGroupOrdinal)` 的
 * 重放必须逐字节等于已存在的事件（含消费者清单），否则抛错；cutover 处于 legacy 时不落行、
 * 返回空 eventRef。
 */
export async function appendCommittedEvent<TType extends string, TPayload>(
  tx: DatabaseTransaction,
  input: AppendCommittedEventInput<TType, TPayload>,
): Promise<AppendCommittedEventReceipt> {
  validateAppendInput(input as AppendCommittedEventInput<string, unknown>)
  const cutover = await readCommittedEventCutover(tx, input.producer, input.family)
  const existing = await tx
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
    const payloadDigest = sha256Hex(payloadJson)
    if (
      existing.id !== eventId ||
      existing.payloadDigest !== payloadDigest ||
      existing.payloadJson !== payloadJson ||
      !(await sameConsumerManifest(
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

  const aggregateSeq = await reserveAggregateSequence(tx, {
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
  await tx
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
      deliveryMode: cutover.mode,
      producerEpoch: cutover.epoch,
      createdAt: input.occurredAt,
    })
    .run()
  if (input.consumers.length > 0) {
    await tx
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
      .run()
  }
  const inserted = await tx
    .select()
    .from(committedEvents)
    .where(eq(committedEvents.id, eventId))
    .get()
  if (inserted === undefined) throw new Error(`committed event insert vanished: ${eventId}`)
  return { cutover, eventRef: eventRefFromRow(inserted) }
}
