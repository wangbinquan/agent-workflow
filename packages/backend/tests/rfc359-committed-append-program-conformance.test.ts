import { describe, expect, test } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'

import { canonicalJson } from '@agent-workflow/shared'
import {
  committedEventAggregateHeads,
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
  workflows,
} from '@/db/schema'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import type { AppendCommittedEventInput } from '@/platform/events/committed/types'
import {
  driveAsyncProgram,
  driveSyncProgram,
  executeTransactionStepSync,
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const NOW = 1_789_488_100_000
type Input = AppendCommittedEventInput<'fixture.changed.v1', { readonly value: string }>
const family = and(
  eq(committedEventFamilyCutovers.producer, 'collaboration'),
  eq(committedEventFamilyCutovers.family, 'review'),
)

function event(operation: string, changes: Partial<Input> = {}): Input {
  return {
    producer: 'collaboration',
    family: 'review',
    type: 'fixture.changed.v1',
    aggregate: { kind: 'review-round', id: 'append-aggregate' },
    eventGroupId: `fixture:${operation}`,
    eventGroupOrdinal: 0,
    operationRef: operation,
    occurredAt: NOW,
    payload: { value: operation },
    consumers: [
      { id: 'z-consumer', deliveryClass: 'rebuildable' },
      { id: 'a-consumer', deliveryClass: 'critical' },
    ],
    ...changes,
  }
}

async function enable(harness: ProviderHarness): Promise<void> {
  await harness.db
    .update(committedEventFamilyCutovers)
    .set({ mode: 'shadow', epoch: 7, changedAt: NOW - 1, changeRef: 'fixture:shadow' })
    .where(family)
    .run()
}

function eventSql(statements: readonly RecordedStatement[]): readonly string[] {
  const tables = [
    'committed_event_family_cutovers',
    'committed_event_aggregate_heads',
    'committed_event_deliveries',
    'committed_events',
  ]
  return statements.flatMap(({ sql }) => {
    const verb = /^\s*(select|insert|update|delete)\b/i.exec(sql)?.[1]?.toLowerCase()
    const table = tables.find((name) => sql.includes(`"${name}"`))
    return verb === undefined || table === undefined ? [] : [`${verb}:${table}`]
  })
}

async function rows(harness: ProviderHarness) {
  return {
    events: await harness.db.select().from(committedEvents).orderBy(asc(committedEvents.id)).all(),
    deliveries: await harness.db
      .select()
      .from(committedEventDeliveries)
      .orderBy(asc(committedEventDeliveries.eventId), asc(committedEventDeliveries.consumerId))
      .all(),
    heads: await harness.db
      .select()
      .from(committedEventAggregateHeads)
      .orderBy(asc(committedEventAggregateHeads.aggregateId))
      .all(),
  }
}

describeEachProvider(
  'RFC-359 committed append program preserves the physical transaction',
  (harness) => {
    test('exact envelope, deliveries, head, insertion order and explicit/automatic sequence', async () => {
      await enable(harness)
      const input = event('first', { eventId: 'event:first', correlationRef: 'correlation' })
      const recording = harness.recordStatements()
      const receipt = await harness.session
        .transaction(async (tx) => await appendCommittedEvent(tx, input))
        .finally(() => recording.stop())
      expect(eventSql(recording.statements)).toEqual([
        'select:committed_event_family_cutovers',
        'select:committed_events',
        'select:committed_event_aggregate_heads',
        'insert:committed_event_aggregate_heads',
        'insert:committed_events',
        'insert:committed_event_deliveries',
        'select:committed_events',
      ])
      const deliveryInsert = recording.statements.find(
        (row) => /^insert/i.test(row.sql) && row.sql.includes('committed_event_deliveries'),
      )!
      expect(deliveryInsert.values.indexOf('z-consumer')).toBeLessThan(
        deliveryInsert.values.indexOf('a-consumer'),
      )
      const payloadJson = canonicalJson({
        eventId: 'event:first',
        eventGroupId: 'fixture:first',
        eventGroupOrdinal: 0,
        type: 'fixture.changed.v1',
        schemaVersion: 1,
        producer: 'collaboration',
        family: 'review',
        aggregate: { kind: 'review-round', id: 'append-aggregate', seq: 1 },
        operationRef: 'first',
        correlationRef: 'correlation',
        causationRef: null,
        occurredAt: new Date(NOW).toISOString(),
        payload: { value: 'first' },
      })
      const physical = await rows(harness)
      expect(physical.events).toEqual([
        {
          id: 'event:first',
          eventGroupId: 'fixture:first',
          eventGroupOrdinal: 0,
          producer: 'collaboration',
          family: 'review',
          eventType: 'fixture.changed.v1',
          schemaVersion: 1,
          aggregateKind: 'review-round',
          aggregateId: 'append-aggregate',
          aggregateSeq: 1,
          operationRef: 'first',
          correlationRef: 'correlation',
          causationRef: null,
          occurredAt: NOW,
          payloadJson,
          payloadDigest: sha256Hex(payloadJson),
          deliveryMode: 'shadow',
          producerEpoch: 7,
          createdAt: NOW,
        },
      ])
      expect(physical.deliveries).toEqual(
        [input.consumers[1]!, input.consumers[0]!].map((consumer) => ({
          eventId: 'event:first',
          consumerId: consumer.id,
          deliveryClass: consumer.deliveryClass,
          state: 'pending',
          attemptCount: 0,
          nextAttemptAt: NOW,
          claimedBy: null,
          leaseEpoch: 0,
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          replayGeneration: 0,
          createdAt: NOW,
          updatedAt: NOW,
          acceptedAt: null,
          deadLetterAt: null,
        })),
      )
      expect(physical.heads).toEqual([
        {
          producer: 'collaboration',
          family: 'review',
          aggregateKind: 'review-round',
          aggregateId: 'append-aggregate',
          lastSeq: 1,
          updatedAt: NOW,
        },
      ])
      expect(receipt.cutover).toEqual({
        producer: 'collaboration',
        family: 'review',
        mode: 'shadow',
        epoch: 7,
        changedAt: NOW - 1,
        changeRef: 'fixture:shadow',
      })
      const explicit = await harness.session.transaction(
        async (tx) =>
          await appendCommittedEvent(
            tx,
            event('explicit', {
              aggregate: { kind: 'review-round', id: 'append-aggregate', seq: 7 },
              consumers: [],
              occurredAt: NOW + 1,
            }),
          ),
      )
      const automatic = await harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, event('automatic', { consumers: [] })),
      )
      expect(explicit.eventRef?.aggregate.seq).toBe(7)
      expect(automatic.eventRef?.aggregate.seq).toBe(8)
      expect((await rows(harness)).deliveries).toEqual(physical.deliveries)
      expect((await rows(harness)).heads[0]).toMatchObject({ lastSeq: 8, updatedAt: NOW })
    })

    test('equivalent replay sorts copies; byte conflicts short-circuit the consumer query', async () => {
      await enable(harness)
      const input = event('replay')
      const first = await harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, input),
      )
      const before = await rows(harness)
      const reversed = [...input.consumers].reverse()
      const recording = harness.recordStatements()
      const replay = await harness.session
        .transaction(
          async (tx) => await appendCommittedEvent(tx, { ...input, consumers: reversed }),
        )
        .finally(() => recording.stop())
      expect(replay).toEqual(first)
      expect(reversed.map((consumer) => consumer.id)).toEqual(['a-consumer', 'z-consumer'])
      expect(input.consumers.map((consumer) => consumer.id)).toEqual(['z-consumer', 'a-consumer'])
      expect(eventSql(recording.statements)).toEqual([
        'select:committed_event_family_cutovers',
        'select:committed_events',
        'select:committed_event_deliveries',
      ])
      const conflictRecording = harness.recordStatements()
      await expect(
        harness.session
          .transaction(
            async (tx) =>
              await appendCommittedEvent(tx, { ...input, payload: { value: 'changed' } }),
          )
          .finally(() => conflictRecording.stop()),
      ).rejects.toThrow(
        `committed event replay conflicts with immutable event: ${first.eventRef!.eventId}`,
      )
      expect(eventSql(conflictRecording.statements)).toEqual([
        'select:committed_event_family_cutovers',
        'select:committed_events',
      ])
      await expect(
        harness.session.transaction(
          async (tx) =>
            await appendCommittedEvent(tx, {
              ...input,
              consumers: input.consumers.map((consumer) => ({
                ...consumer,
                deliveryClass: 'critical',
              })),
            }),
        ),
      ).rejects.toThrow('committed event replay conflicts with immutable event')
      expect(await rows(harness)).toEqual(before)
    })

    test('legacy cutover still checks prior replay and leaves a fresh invalid sequence inert', async () => {
      await enable(harness)
      const input = event('before-legacy')
      const first = await harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, input),
      )
      const before = await rows(harness)
      await harness.db
        .update(committedEventFamilyCutovers)
        .set({ mode: 'legacy' })
        .where(family)
        .run()
      const replay = await harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, input),
      )
      expect(replay.cutover.mode).toBe('legacy')
      expect(replay.eventRef).toEqual(first.eventRef)
      const recording = harness.recordStatements()
      const fresh = await harness.session
        .transaction(
          async (tx) =>
            await appendCommittedEvent(
              tx,
              event('legacy-fresh', {
                aggregate: { kind: 'review-round', id: 'new-aggregate', seq: 0 },
              }),
            ),
        )
        .finally(() => recording.stop())
      expect(fresh.eventRef).toBeNull()
      expect(eventSql(recording.statements)).toEqual([
        'select:committed_event_family_cutovers',
        'select:committed_events',
      ])
      expect(await rows(harness)).toEqual(before)
    })

    test('validation and missing cutover keep their original SQL and exception order', async () => {
      await enable(harness)
      for (const [input, message, expectedSql] of [
        [
          event('invalid', { eventGroupOrdinal: -1 }),
          'eventGroupOrdinal must be a non-negative safe integer',
          [],
        ],
        [
          event('invalid-seq', { aggregate: { kind: 'review-round', id: 'a', seq: 0 } }),
          'aggregate.seq must be a positive safe integer',
          ['select:committed_event_family_cutovers', 'select:committed_events'],
        ],
      ] as const) {
        const recording = harness.recordStatements()
        await expect(
          harness.session
            .transaction(async (tx) => await appendCommittedEvent(tx, input))
            .finally(() => recording.stop()),
        ).rejects.toThrow(message)
        expect(eventSql(recording.statements)).toEqual(expectedSql)
      }
      await harness.db.delete(committedEventFamilyCutovers).where(family).run()
      const recording = harness.recordStatements()
      await expect(
        harness.session
          .transaction(async (tx) => await appendCommittedEvent(tx, event('missing')))
          .finally(() => recording.stop()),
      ).rejects.toThrow('committed event cutover is missing: collaboration/review')
      expect(eventSql(recording.statements)).toEqual(['select:committed_event_family_cutovers'])
    })

    test('a real unique failure after head reservation rolls back the business row and all append rows', async () => {
      await enable(harness)
      await harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, event('occupied', { eventId: 'occupied-id' })),
      )
      const before = await rows(harness)
      await expect(
        harness.session.transaction(async (tx) => {
          await tx
            .insert(workflows)
            .values({ id: 'append-business', name: 'append-business', definition: '{}' })
            .run()
          await appendCommittedEvent(
            tx,
            event('collision', {
              eventId: 'occupied-id',
              aggregate: { kind: 'review-round', id: 'rolled-back-head' },
            }),
          )
        }),
      ).rejects.toThrow()
      expect(
        await harness.db.select().from(workflows).where(eq(workflows.id, 'append-business')).all(),
      ).toEqual([])
      expect(await rows(harness)).toEqual(before)
    })

    test('outer rollback reuses the first sequence; a non-advancing sequence leaves its winner intact', async () => {
      await enable(harness)
      const failure = new Error('business failure after append')
      await expect(
        harness.session.transaction(async (tx) => {
          await appendCommittedEvent(tx, event('rolled-back'))
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(await rows(harness)).toEqual({ events: [], deliveries: [], heads: [] })
      const committed = await harness.session.transaction(
        async (tx) => await appendCommittedEvent(tx, event('winner')),
      )
      expect(committed.eventRef?.aggregate.seq).toBe(1)
      const before = await rows(harness)
      await expect(
        harness.session.transaction(
          async (tx) =>
            await appendCommittedEvent(
              tx,
              event('stale-seq', {
                aggregate: { kind: 'review-round', id: 'append-aggregate', seq: 1 },
              }),
            ),
        ),
      ).rejects.toThrow(
        'committed event aggregate sequence did not advance: collaboration/review/review-round/append-aggregate@1',
      )
      expect(await rows(harness)).toEqual(before)
    })

    test('two real transactions allocate distinct monotonic sequences for one aggregate', async () => {
      await enable(harness)
      const receipts = await Promise.all(
        ['concurrent-a', 'concurrent-b'].map((operation) =>
          harness.session.transaction(
            async (tx) => await appendCommittedEvent(tx, event(operation)),
          ),
        ),
      )
      expect(receipts.map((receipt) => receipt.eventRef!.aggregate.seq).sort()).toEqual([1, 2])
      const physical = await rows(harness)
      expect(physical.events).toHaveLength(2)
      expect(physical.deliveries).toHaveLength(4)
      expect(physical.heads).toHaveLength(1)
      expect(physical.heads[0]!.lastSeq).toBe(2)
    })
  },
)

describe('RFC-359 typed transaction program mechanics', () => {
  test('rejecting an asynchronous sync step also settles its rejected promise', async () => {
    expect(() =>
      driveSyncProgram(
        transactionStep(async () => {
          throw new Error('rejected asynchronous operation')
        }),
        executeTransactionStepSync,
      ),
    ).toThrow('synchronous transaction program received an asynchronous step')
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  test('sync steps retain receivers, undefined values and immediate return', () => {
    const receiver = {
      value: 42,
      read() {
        return this.value
      },
    }
    function* sequence(): Generator<TransactionProgramStep, readonly [number, undefined], void> {
      const value = yield* transactionStep(() => receiver.read())
      const empty = yield* transactionStep(() => undefined)
      return [value, empty]
    }
    expect(driveSyncProgram(sequence(), executeTransactionStepSync)).toEqual([42, undefined])
  })

  test('async driver awaits a structural thenable before advancing and propagates rejection', async () => {
    const trace: string[] = []
    const thenable: PromiseLike<number> = {
      then: (resolve, reject) => Promise.resolve(7).then(resolve, reject),
    }
    function* sequence(): Generator<TransactionProgramStep, number, void> {
      const value = yield* transactionStep(() => thenable)
      trace.push(`resolved:${value}`)
      return value
    }
    expect(await driveAsyncProgram(sequence(), (step) => step())).toBe(7)
    expect(trace).toEqual(['resolved:7'])
    const failure = new Error('step rejected')
    function* rejected(): Generator<TransactionProgramStep, void, void> {
      yield* transactionStep(async () => {
        throw failure
      })
      trace.push('unreachable')
    }
    await expect(driveAsyncProgram(rejected(), (step) => step())).rejects.toBe(failure)
    expect(trace).toEqual(['resolved:7'])
  })

  test('sync driver refuses async operations and both generic loops preserve step errors', async () => {
    expect(() =>
      driveSyncProgram(
        transactionStep(async () => 1),
        executeTransactionStepSync,
      ),
    ).toThrow('synchronous transaction program received an asynchronous step')
    const premature = transactionStep(() => 1)
    premature.next()
    expect(() => premature.next()).toThrow('transaction program resumed before its step completed')
    const failure = new Error('execution failed')
    const trace: string[] = []
    function* program(): Generator<number, number, number> {
      try {
        return yield 1
      } finally {
        trace.push('generator finally')
      }
    }
    expect(() =>
      driveSyncProgram(program(), () => {
        throw failure
      }),
    ).toThrow(failure)
    await expect(
      driveAsyncProgram(program(), async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(trace).toEqual([])
  })
})
