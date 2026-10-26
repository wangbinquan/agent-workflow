import { tablesOf } from '@/platform/persistence/sessionTables'
import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import { createCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import {
  committedEventGroupId,
  type AppendCommittedEventInput,
  type CommittedEventEnvelopeV1,
} from '@/platform/events/committed/types'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_789_488_100_000
const CONSUMER = { id: 'event-center.fixture', deliveryClass: 'critical' as const }

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

async function createProviderStoreDb(harness: ProviderHarness): Promise<PersistenceDb> {
  const db = harness.db
  const { committedEventFamilyCutovers } = tablesOf(db)
  await db
    .update(committedEventFamilyCutovers)
    .set({ epoch: 1, changedAt: NOW, changeRef: 'test:routing-baseline' })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.family, 'review'),
      ),
    )

  return db
}

async function setRoutingEpoch(harness: ProviderHarness, epoch: number): Promise<void> {
  const { committedEventFamilyCutovers } = tablesOf(harness.db)
  await harness.db
    .update(committedEventFamilyCutovers)
    .set({ epoch, changedAt: NOW + epoch, changeRef: `fixture:${epoch}` })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, 'collaboration'),
        eq(committedEventFamilyCutovers.family, 'review'),
      ),
    )
}

describe('RFC-341 committed-event store', () => {
  test('Event Center maps retry CAS loss to the stable route error code', () => {
    const route = readFileSync(resolve(import.meta.dir, '../src/routes/eventCenter.ts'), 'utf8')
    expect(route).toContain("'committed-event-retry-conflict'")
    expect(route).toContain('/api/event-center/committed-deliveries/:eventId/:consumerId/retry')
  })
})

describeEachProvider('RFC-341 committed-event store', (harness) => {
  test('preflights an idle queue without reserving the writer and rechecks due work in the claim transaction', async () => {
    const db = await createProviderStoreDb(harness)
    const session = harness.session

    const persistence = createCommittedEventDeliveryPersistence(db)
    const idleRecording = harness.recordStatements()
    const idleClaim = await (async () => {
      try {
        return await persistence.claimNext({ workerId: 'idle-worker', now: NOW + 100 })
      } finally {
        idleRecording.stop()
      }
    })()
    expect(idleClaim).toBeNull()
    expect(
      idleRecording.statements.filter((row) => /^(BEGIN IMMEDIATE|begin)$/i.test(row.sql)),
    ).toEqual([])
    expect(
      idleRecording.selects().filter((row) => row.sql.includes('committed_event_deliveries')),
    ).toHaveLength(1)

    const appended = await session.transaction(
      async (tx) =>
        await appendCommittedEvent(tx, eventInput({ operation: 'preflight-then-claim' })),
    )
    const dueRecording = harness.recordStatements()
    const dueClaim = await (async () => {
      try {
        return await persistence.claimNext({ workerId: 'due-worker', now: NOW + 200 })
      } finally {
        dueRecording.stop()
      }
    })()
    expect(dueClaim?.event.envelope.eventId).toBe(appended.eventRef?.eventId)
    expect(
      dueRecording.statements.filter((row) => /^(BEGIN IMMEDIATE|begin)$/i.test(row.sql)),
    ).toHaveLength(1)
    expect(
      dueRecording.selects().filter((row) => row.sql.includes('committed_event_deliveries')),
    ).toHaveLength(2)
  })

  // RFC-359：这条判据此前钉在 SQLite 上（`dbTxSync` + `appendCommittedEventTx`）。它锁的是
  // **产品行为**——原子追加、同一 operationRef 重放幂等、改了 payload 的重放必须被拒；
  // 历史 shadow 事件仍不派发。两个引擎通过相同中立追加口验证。
  test('appends dispatchable events atomically and rejects conflicting replay', async () => {
    const db = await createProviderStoreDb(harness)
    const { committedEvents } = tablesOf(db)
    await setRoutingEpoch(harness, 2)
    const input = eventInput({ operation: 'shadow' })
    const first = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, input),
    )
    expect(first.eventRef).toMatchObject({
      family: 'review',
      aggregate: { id: 'review-1', seq: 1 },
      deliveryMode: 'dispatchable',
      producerEpoch: 2,
    })
    const replay = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, input),
    )
    expect(replay.eventRef).toEqual(first.eventRef)
    expect(await db.select().from(committedEvents)).toHaveLength(1)
    await db
      .update(committedEvents)
      .set({ deliveryMode: 'shadow' })
      .where(eq(committedEvents.id, first.eventRef!.eventId))
    expect(
      (await harness.session.transaction((tx) => appendCommittedEvent(tx, input))).eventRef
        ?.deliveryMode,
    ).toBe('shadow')
    expect(
      await createCommittedEventDeliveryPersistence(db).claimNext({
        workerId: 'worker',
        now: NOW + 100,
      }),
    ).toBeNull()
    await expect(
      harness.session.transaction(
        async (tx) =>
          await appendCommittedEvent(tx, eventInput({ operation: 'shadow', value: 'different' })),
      ),
    ).rejects.toThrow('conflicts with immutable event')
  })

  test('claims only current dispatchable epoch and preserves per-consumer aggregate FIFO', async () => {
    const db = await createProviderStoreDb(harness)
    await setRoutingEpoch(harness, 2)
    await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, eventInput({ operation: 'shadow' })),
    )
    await setRoutingEpoch(harness, 3)
    const second = await harness.session.transaction(
      async (tx) =>
        await appendCommittedEvent(tx, eventInput({ operation: 'second', occurredAt: NOW + 10 })),
    )
    const third = await harness.session.transaction(
      async (tx) =>
        await appendCommittedEvent(tx, eventInput({ operation: 'third', occurredAt: NOW + 20 })),
    )
    await harness.session.transaction(
      async (tx) =>
        await appendCommittedEvent(
          tx,
          eventInput({ operation: 'other', aggregate: 'review-2', occurredAt: NOW + 30 }),
        ),
    )

    const persistence = createCommittedEventDeliveryPersistence(db)
    const claimedSecond = await persistence.claimNext({ workerId: 'worker-a', now: NOW + 100 })
    expect(claimedSecond?.event.envelope.eventId).toBe(second.eventRef?.eventId)
    const claimedOther = await persistence.claimNext({ workerId: 'worker-b', now: NOW + 100 })
    expect(claimedOther?.event.envelope.aggregate.id).toBe('review-2')
    expect(await persistence.claimNext({ workerId: 'worker-c', now: NOW + 100 })).toBeNull()
    await persistence.accept({ claim: claimedSecond!, now: NOW + 101 })
    const claimedThird = await persistence.claimNext({ workerId: 'worker-c', now: NOW + 102 })
    expect(claimedThird?.event.envelope.eventId).toBe(third.eventRef?.eventId)
  })

  test('dead-letters bounded consumer failure and manual retry is a single-winner CAS', async () => {
    const db = await createProviderStoreDb(harness)
    await setRoutingEpoch(harness, 2)
    await setRoutingEpoch(harness, 3)
    const appended = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, eventInput({ operation: 'poison' })),
    )
    const persistence = createCommittedEventDeliveryPersistence(db)
    const dispatcher = createCommittedEventDispatcher({
      persistence,
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
      maxAttempts: async () => 1,
      now: () => NOW + 100,
    })
    expect(await dispatcher.runOne()).toBe('dead-letter')
    const { committedEventDeliveries } = tablesOf(db)
    const dead = (await (
      await db
        .select()
        .from(committedEventDeliveries)
        .where(
          and(
            eq(committedEventDeliveries.eventId, appended.eventRef!.eventId),
            eq(committedEventDeliveries.consumerId, CONSUMER.id),
          ),
        )
    )[0])!
    expect(dead).toMatchObject({
      state: 'dead-letter',
      attemptCount: 1,
      lastErrorSummary: 'fixture-poison',
    })
    expect(
      (await persistence.deliveryPage({ page: 1, limit: 20, state: 'dead-letter' })).items[0],
    ).toMatchObject({ canRetry: true, stage: 'producer-publication' })
    expect(
      (await persistence.deliveryPage({ page: 1, limit: 20, stage: 'consumer-delivery' })).items,
    ).toEqual([])
    expect(
      await persistence.retry({
        eventId: dead.eventId,
        consumerId: dead.consumerId,
        observedLeaseEpoch: dead.leaseEpoch,
        observedUpdatedAt: dead.updatedAt,
        now: NOW + 200,
      }),
    ).toMatchObject({ state: 'pending', replayGeneration: 1 })
    await expect(
      persistence.retry({
        eventId: dead.eventId,
        consumerId: dead.consumerId,
        observedLeaseEpoch: dead.leaseEpoch,
        observedUpdatedAt: dead.updatedAt,
        now: NOW + 201,
      }),
    ).rejects.toThrow('lost CAS')
  })
})
