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
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  appendCommittedEvent,
  changeCommittedEventCutover,
} from '@/platform/events/committed/append'
import { createCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  committedEventGroupId,
  type AppendCommittedEventInput,
  type CommittedEventEnvelopeV1,
} from '@/platform/events/committed/types'
import { recordStatements } from './helpers/statementRecorder'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
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

/** The preflight case instruments bun:sqlite statements, so it stays on one engine;
 *  the writes themselves still go through the neutral append/cutover port. */
async function sqliteCutover(
  session: ReturnType<typeof databaseSessionFor>,
  expectedMode: 'legacy' | 'shadow',
  expectedEpoch: number,
  mode: 'shadow' | 'dispatchable',
): Promise<void> {
  await session.transaction(
    async (tx) =>
      await changeCommittedEventCutover(tx, {
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

async function createProviderLegacyStoreDb(
  harness: ProviderHarness,
): Promise<ProviderNeutralDatabase> {
  const db = harness.db
  await db
    .update(committedEventFamilyCutovers)
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

async function cutoverForProvider(
  harness: ProviderHarness,
  expectedMode: 'legacy' | 'shadow',
  expectedEpoch: number,
  mode: 'shadow' | 'dispatchable',
): Promise<void> {
  await harness.session.transaction(
    async (tx) =>
      await changeCommittedEventCutover(tx, {
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

  test('preflights an idle queue without reserving the writer and rechecks due work in the claim transaction', async () => {
    const db = createLegacyStoreDb()
    const session = databaseSessionFor(db)
    await sqliteCutover(session, 'legacy', 1, 'shadow')
    await sqliteCutover(session, 'shadow', 2, 'dispatchable')

    const persistence = createCommittedEventDeliveryPersistence(db)
    const idleRecording = recordStatements(db.$client)
    const idleClaim = await (async () => {
      try {
        return await persistence.claimNext({ workerId: 'idle-worker', now: NOW + 100 })
      } finally {
        idleRecording.stop()
      }
    })()
    expect(idleClaim).toBeNull()
    expect(idleRecording.statements.filter((row) => row.sql === 'BEGIN IMMEDIATE')).toEqual([])
    expect(
      idleRecording.selects().filter((row) => row.sql.includes('committed_event_deliveries')),
    ).toHaveLength(1)

    const appended = await session.transaction(
      async (tx) =>
        await appendCommittedEvent(tx, eventInput({ operation: 'preflight-then-claim' })),
    )
    const dueRecording = recordStatements(db.$client)
    const dueClaim = await (async () => {
      try {
        return await persistence.claimNext({ workerId: 'due-worker', now: NOW + 200 })
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
})

describeEachProvider('RFC-341 committed-event store', (harness) => {
  // RFC-359：这条判据此前钉在 SQLite 上（`dbTxSync` + `appendCommittedEventTx`）。它锁的是
  // **产品行为**——legacy 期不落行、shadow 期原子追加、同一 operationRef 重放幂等、改了 payload
  // 的重放必须被拒——与引擎无关，改走中立追加口后两个引擎各跑一遍。
  test('keeps legacy inert, appends shadow atomically and rejects conflicting replay', async () => {
    const db = await createProviderLegacyStoreDb(harness)
    const legacy = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, eventInput({ operation: 'legacy' })),
    )
    expect(legacy.eventRef).toBeNull()
    expect(await db.select().from(committedEvents).all()).toEqual([])

    await cutoverForProvider(harness, 'legacy', 1, 'shadow')
    const input = eventInput({ operation: 'shadow' })
    const first = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, input),
    )
    expect(first.eventRef).toMatchObject({
      family: 'review',
      aggregate: { id: 'review-1', seq: 1 },
      deliveryMode: 'shadow',
      producerEpoch: 2,
    })
    const replay = await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, input),
    )
    expect(replay.eventRef).toEqual(first.eventRef)
    expect(await db.select().from(committedEvents).all()).toHaveLength(1)
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
    const db = await createProviderLegacyStoreDb(harness)
    await cutoverForProvider(harness, 'legacy', 1, 'shadow')
    await harness.session.transaction(
      async (tx) => await appendCommittedEvent(tx, eventInput({ operation: 'shadow' })),
    )
    await cutoverForProvider(harness, 'shadow', 2, 'dispatchable')
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
    const db = await createProviderLegacyStoreDb(harness)
    await cutoverForProvider(harness, 'legacy', 1, 'shadow')
    await cutoverForProvider(harness, 'shadow', 2, 'dispatchable')
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
      maxAttempts: () => 1,
      now: () => NOW + 100,
    })
    expect(await dispatcher.runOne()).toBe('dead-letter')
    const dead = (await db
      .select()
      .from(committedEventDeliveries)
      .where(
        and(
          eq(committedEventDeliveries.eventId, appended.eventRef!.eventId),
          eq(committedEventDeliveries.consumerId, CONSUMER.id),
        ),
      )
      .get())!
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
