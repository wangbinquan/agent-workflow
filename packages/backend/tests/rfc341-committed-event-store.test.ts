import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import {
  committedEventDeliveries,
  committedEventFamilyCutovers,
  committedEvents,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { createCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import { createSqliteCommittedEventDeliveryPersistence } from '@/platform/events/committed/sqlitePersistence'
import {
  acceptCommittedEventDelivery,
  appendCommittedEventTx,
  changeCommittedEventCutoverTx,
  claimNextCommittedEventDelivery,
  committedEventDeliveryPage,
  retryCommittedEventDelivery,
} from '@/platform/events/committed/sqliteStore'
import {
  committedEventGroupId,
  type AppendCommittedEventInput,
  type CommittedEventEnvelopeV1,
} from '@/platform/events/committed/types'
import { recordStatements } from './helpers/statementRecorder'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_789_488_100_000
const CONSUMER = { id: 'event-center.fixture', deliveryClass: 'critical' as const }

function createLegacyStoreDb(): ReturnType<typeof createInMemoryDb> {
  const db = createInMemoryDb(MIGRATIONS)
  db.update(committedEventFamilyCutovers)
    .set({ mode: 'legacy', epoch: 1, changedAt: NOW, changeRef: 'test:legacy-baseline' })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.family, 'review'),
      ),
    )
    .run()
  return db
}

function eventInput(input: {
  operation: string
  aggregate?: string
  value?: string
  occurredAt?: number
}): AppendCommittedEventInput<'fixture.changed.v1', { value: string }> {
  return {
    producer: 'collaboration',
    family: 'review',
    type: 'fixture.changed.v1',
    aggregate: { kind: 'review-round', id: input.aggregate ?? 'review-1' },
    eventGroupId: committedEventGroupId('collaboration', input.operation),
    eventGroupOrdinal: 0,
    operationRef: input.operation,
    occurredAt: input.occurredAt ?? NOW,
    payload: { value: input.value ?? input.operation },
    consumers: [CONSUMER],
  }
}

function cutover(
  db: ReturnType<typeof createInMemoryDb>,
  expectedMode: 'legacy' | 'shadow',
  expectedEpoch: number,
  mode: 'shadow' | 'dispatchable',
): void {
  dbTxSync(db, (tx) =>
    changeCommittedEventCutoverTx(tx, {
      producer: 'collaboration',
      family: 'review',
      expectedMode,
      expectedEpoch,
      mode,
      changedAt: NOW + expectedEpoch,
      changeRef: `test:${mode}`,
    }),
  )
}

describe('RFC-341 committed-event store', () => {
  test('Event Center maps retry CAS loss to the stable route error code', () => {
    const route = readFileSync(resolve(import.meta.dir, '../src/routes/eventCenter.ts'), 'utf8')
    expect(route).toContain("'committed-event-retry-conflict'")
    expect(route).toContain('/api/event-center/committed-deliveries/:eventId/:consumerId/retry')
  })

  test('keeps legacy inert, appends shadow atomically and rejects conflicting replay', () => {
    const db = createLegacyStoreDb()
    const legacy = dbTxSync(db, (tx) =>
      appendCommittedEventTx(tx, eventInput({ operation: 'legacy' })),
    )
    expect(legacy.eventRef).toBeNull()
    expect(db.select().from(committedEvents).all()).toEqual([])

    cutover(db, 'legacy', 1, 'shadow')
    const input = eventInput({ operation: 'shadow' })
    const first = dbTxSync(db, (tx) => appendCommittedEventTx(tx, input))
    expect(first.eventRef).toMatchObject({
      family: 'review',
      aggregate: { id: 'review-1', seq: 1 },
      deliveryMode: 'shadow',
      producerEpoch: 2,
    })
    const replay = dbTxSync(db, (tx) => appendCommittedEventTx(tx, input))
    expect(replay.eventRef).toEqual(first.eventRef)
    expect(db.select().from(committedEvents).all()).toHaveLength(1)
    expect(claimNextCommittedEventDelivery({ db, workerId: 'worker', now: NOW + 100 })).toBeNull()
    expect(() =>
      dbTxSync(db, (tx) =>
        appendCommittedEventTx(tx, eventInput({ operation: 'shadow', value: 'different' })),
      ),
    ).toThrow('conflicts with immutable event')
  })

  test('preflights an idle queue without reserving the writer and rechecks due work in the claim transaction', () => {
    const db = createLegacyStoreDb()
    cutover(db, 'legacy', 1, 'shadow')
    cutover(db, 'shadow', 2, 'dispatchable')

    const idleRecording = recordStatements(db.$client)
    const idleClaim = (() => {
      try {
        return claimNextCommittedEventDelivery({ db, workerId: 'idle-worker', now: NOW + 100 })
      } finally {
        idleRecording.stop()
      }
    })()
    expect(idleClaim).toBeNull()
    expect(idleRecording.statements.filter((row) => row.sql === 'BEGIN IMMEDIATE')).toEqual([])
    expect(
      idleRecording.selects().filter((row) => row.sql.includes('committed_event_deliveries')),
    ).toHaveLength(1)

    const appended = dbTxSync(db, (tx) =>
      appendCommittedEventTx(tx, eventInput({ operation: 'preflight-then-claim' })),
    )
    const dueRecording = recordStatements(db.$client)
    const dueClaim = (() => {
      try {
        return claimNextCommittedEventDelivery({ db, workerId: 'due-worker', now: NOW + 200 })
      } finally {
        dueRecording.stop()
      }
    })()
    expect(dueClaim?.event.envelope.eventId).toBe(appended.eventRef?.eventId)
    expect(dueRecording.statements.filter((row) => row.sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
    expect(
      dueRecording.selects().filter((row) => row.sql.includes('committed_event_deliveries')),
    ).toHaveLength(2)
  })

  test('claims only current dispatchable epoch and preserves per-consumer aggregate FIFO', () => {
    const db = createLegacyStoreDb()
    cutover(db, 'legacy', 1, 'shadow')
    dbTxSync(db, (tx) => appendCommittedEventTx(tx, eventInput({ operation: 'shadow' })))
    cutover(db, 'shadow', 2, 'dispatchable')
    const second = dbTxSync(db, (tx) =>
      appendCommittedEventTx(tx, eventInput({ operation: 'second', occurredAt: NOW + 10 })),
    )
    const third = dbTxSync(db, (tx) =>
      appendCommittedEventTx(tx, eventInput({ operation: 'third', occurredAt: NOW + 20 })),
    )
    dbTxSync(db, (tx) =>
      appendCommittedEventTx(
        tx,
        eventInput({ operation: 'other', aggregate: 'review-2', occurredAt: NOW + 30 }),
      ),
    )

    const claimedSecond = claimNextCommittedEventDelivery({
      db,
      workerId: 'worker-a',
      now: NOW + 100,
    })
    expect(claimedSecond?.event.envelope.eventId).toBe(second.eventRef?.eventId)
    const claimedOther = claimNextCommittedEventDelivery({
      db,
      workerId: 'worker-b',
      now: NOW + 100,
    })
    expect(claimedOther?.event.envelope.aggregate.id).toBe('review-2')
    expect(claimNextCommittedEventDelivery({ db, workerId: 'worker-c', now: NOW + 100 })).toBeNull()
    acceptCommittedEventDelivery({ db, claim: claimedSecond!, now: NOW + 101 })
    const claimedThird = claimNextCommittedEventDelivery({
      db,
      workerId: 'worker-c',
      now: NOW + 102,
    })
    expect(claimedThird?.event.envelope.eventId).toBe(third.eventRef?.eventId)
  })

  test('dead-letters bounded consumer failure and manual retry is a single-winner CAS', async () => {
    const db = createLegacyStoreDb()
    cutover(db, 'legacy', 1, 'shadow')
    cutover(db, 'shadow', 2, 'dispatchable')
    const appended = dbTxSync(db, (tx) =>
      appendCommittedEventTx(tx, eventInput({ operation: 'poison' })),
    )
    const dispatcher = createCommittedEventDispatcher({
      persistence: createSqliteCommittedEventDeliveryPersistence(db),
      workerId: 'dispatcher',
      codecs: {
        eventTypes: ['fixture.changed.v1'],
        decode(value) {
          const envelope = value as CommittedEventEnvelopeV1
          if (envelope.type !== 'fixture.changed.v1') throw new Error('wrong-fixture-type')
          return envelope
        },
      },
      consumers: [
        {
          ...CONSUMER,
          eventTypes: ['fixture.changed.v1'],
          settle: 'delivery-accepted',
          handle() {
            throw new Error('fixture-poison')
          },
        },
      ],
      maxAttempts: () => 1,
      now: () => NOW + 100,
    })
    expect(await dispatcher.runOne()).toBe('dead-letter')
    const dead = db
      .select()
      .from(committedEventDeliveries)
      .where(
        and(
          eq(committedEventDeliveries.eventId, appended.eventRef!.eventId),
          eq(committedEventDeliveries.consumerId, CONSUMER.id),
        ),
      )
      .get()!
    expect(dead).toMatchObject({
      state: 'dead-letter',
      attemptCount: 1,
      lastErrorSummary: 'fixture-poison',
    })
    expect(
      committedEventDeliveryPage(db, { page: 1, limit: 20, state: 'dead-letter' }).items[0],
    ).toMatchObject({ canRetry: true, stage: 'producer-publication' })
    expect(
      committedEventDeliveryPage(db, {
        page: 1,
        limit: 20,
        stage: 'consumer-delivery',
      }).items,
    ).toEqual([])
    expect(
      retryCommittedEventDelivery(db, {
        eventId: dead.eventId,
        consumerId: dead.consumerId,
        observedLeaseEpoch: dead.leaseEpoch,
        observedUpdatedAt: dead.updatedAt,
        now: NOW + 200,
      }),
    ).toMatchObject({ state: 'pending', replayGeneration: 1 })
    expect(() =>
      retryCommittedEventDelivery(db, {
        eventId: dead.eventId,
        consumerId: dead.consumerId,
        observedLeaseEpoch: dead.leaseEpoch,
        observedUpdatedAt: dead.updatedAt,
        now: NOW + 201,
      }),
    ).toThrow('lost CAS')
  })
})
