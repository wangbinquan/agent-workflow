// RFC-341 / RFC-359 —— committed-event 的纯函数（校验 / 行投影 / 确定性事件 id）。
//
// 这些以前在 `sqliteStore.ts` 与 `postgresqlPersistence.ts` 各抄一份。RFC-359 把 append 路径
// 合成一份实现（`append.ts`），纯函数随之只剩这一份，两个引擎的存储层都从这里取。

import { canonicalJson } from '@agent-workflow/shared'

import type { committedEventFamilyCutovers, committedEvents } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type {
  AppendCommittedEventInput,
  CommittedEventAggregateKind,
  CommittedEventCutover,
  CommittedEventEnvelopeV1,
  CommittedEventFamily,
  CommittedEventProducer,
  CommittedEventRef,
  StoredCommittedEvent,
} from './types'

export const MIGRATED_CANONICAL_HEX_DIGEST_PREFIX = 'canonical-hex-v1:'

export function payloadDigestMatches(payloadJson: string, payloadDigest: string): boolean {
  if (payloadDigest.startsWith(MIGRATED_CANONICAL_HEX_DIGEST_PREFIX)) {
    const expected = Array.from(new TextEncoder().encode(payloadJson), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return payloadDigest === `${MIGRATED_CANONICAL_HEX_DIGEST_PREFIX}${expected}`
  }
  return payloadDigest === sha256Hex(payloadJson)
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
}

export function assertProducerFamily(
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): void {
  const valid =
    (producer === 'task-execution' && family === 'task-lifecycle') ||
    (producer === 'collaboration' && family !== 'task-lifecycle')
  if (!valid) throw new Error(`committed event producer/family mismatch: ${producer}/${family}`)
}

export function validateAppendInput(input: AppendCommittedEventInput<string, unknown>): void {
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

export function cutoverFromRow(
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

export function eventRefFromRow(row: typeof committedEvents.$inferSelect): CommittedEventRef {
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

export function storedEventFromRow(row: typeof committedEvents.$inferSelect): StoredCommittedEvent {
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

export function deterministicEventId(input: {
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

/** 聚合序号的进程外互斥键（PostgreSQL 上给 advisory lock 用；SQLite 独占事务下无需）。 */
export function aggregateSequenceLockKey(input: {
  producer: CommittedEventProducer
  family: CommittedEventFamily
  aggregateKind: CommittedEventAggregateKind
  aggregateId: string
}): string {
  // 锁键不是 PATH 列表（RFC-254 guard 只认 `.join(':')` 形态），模板字面量拼出同一串。
  return `${input.producer}:${input.family}:${input.aggregateKind}:${input.aggregateId}`
}
