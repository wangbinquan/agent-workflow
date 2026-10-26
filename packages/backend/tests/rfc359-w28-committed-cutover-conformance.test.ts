// RFC-395: phase changes retire; W28's receipts, failure atomicity and concurrent-winner assertions move to append.
import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { canonicalJson } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { appendCommittedEvent, readCommittedEventCutover } from '@/platform/events/committed/append'
import { appendCommittedEventProgram } from '@/platform/events/committed/appendProgram'
import { driveAsyncProgram } from '@/platform/persistence/transactionProgram'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { AppendCommittedEventInput } from '@/platform/events/committed/types'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_789_488_100_000
type Input = AppendCommittedEventInput<'fixture.changed.v1', { value: string }>
function event(over: Partial<Input> = {}): Input {
  return {
    producer: 'collaboration',
    family: 'review',
    type: 'fixture.changed.v1',
    aggregate: { kind: 'review-round', id: 'w28', seq: 1 },
    eventId: 'w28-event',
    eventGroupId: 'w28-group',
    eventGroupOrdinal: 0,
    operationRef: 'w28-operation',
    occurredAt: NOW,
    payload: { value: 'original' },
    consumers: [],
    ...over,
  }
}
const family = (db: object) => {
  const { committedEventFamilyCutovers: table } = tablesOf(db)
  return and(eq(table.producer, 'collaboration'), eq(table.family, 'review'))
}
async function seed(h: ProviderHarness) {
  const { committedEventFamilyCutovers: table } = tablesOf(h.db)
  await h.db
    .update(table)
    .set({ epoch: 7, changedAt: 0, changeRef: ' \nraw:雪\t ' })
    .where(family(h.db))
}
async function snapshot(h: ProviderHarness) {
  const { committedEvents, committedEventAggregateHeads, committedEventDeliveries } = tablesOf(h.db)
  return {
    events: await h.db.select().from(committedEvents),
    heads: await h.db.select().from(committedEventAggregateHeads),
    deliveries: await h.db.select().from(committedEventDeliveries),
  }
}
async function failureOf(operation: PromiseLike<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (!(error instanceof Error)) throw error
    let failure = error
    while (failure.cause instanceof Error) failure = failure.cause
    return failure
  }
  throw new Error('expected operation to fail')
}
async function installFailure(h: ProviderHarness): Promise<() => Promise<void>> {
  if (h.capabilities.provider === 'sqlite') {
    await h.executeFixtureDdl(
      `CREATE TRIGGER w28_append_fail BEFORE INSERT ON committed_events BEGIN SELECT RAISE(ABORT, 'w28 append failure'); END`,
    )
    return async () => {
      await h.executeFixtureDdl('DROP TRIGGER w28_append_fail')
    }
  }
  await h.executeFixtureDdl(
    `CREATE FUNCTION agent_workflow.w28_append_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'w28 append failure'; END $$`,
  )
  await h.executeFixtureDdl(
    `CREATE TRIGGER w28_append_fail BEFORE INSERT ON agent_workflow.committed_events FOR EACH ROW EXECUTE FUNCTION agent_workflow.w28_append_fail()`,
  )
  return async () => {
    await h.executeFixtureDdl('DROP TRIGGER w28_append_fail ON agent_workflow.committed_events')
    await h.executeFixtureDdl('DROP FUNCTION agent_workflow.w28_append_fail()')
  }
}

describeEachProvider('RFC-359 W28 retained append transaction boundaries', (h) => {
  test('the receipt preserves epoch, zero time and byte-exact durable reference without a family mode', async () => {
    await seed(h)
    const recording = h.recordStatements()
    const receipt = await h.session
      .transaction((tx) => appendCommittedEvent(tx, event()))
      .finally(() => recording.stop())
    expect(receipt.cutover).toEqual({
      producer: 'collaboration',
      family: 'review',
      epoch: 7,
      changedAt: 0,
      changeRef: ' \nraw:雪\t ',
    })
    expect(receipt.eventRef).toMatchObject({
      producerEpoch: 7,
      deliveryMode: 'dispatchable',
      aggregate: { seq: 1 },
    })
    const routing = recording.statements.filter((row) =>
      row.sql.includes('committed_event_family_cutovers'),
    )
    expect(routing).toHaveLength(1)
    expect(routing[0]!.values).toEqual(['collaboration', 'review', 1])
    expect(routing[0]!.sql).not.toContain('"mode"')
  })
  test.each([0, 1.5, Number.NaN])(
    'invalid sequence %s writes no event or aggregate head',
    async (seq) => {
      await seed(h)
      const before = await snapshot(h)
      await expect(
        h.session.transaction((tx) =>
          appendCommittedEvent(tx, event({ aggregate: { kind: 'review-round', id: 'w28', seq } })),
        ),
      ).rejects.toThrow('aggregate.seq must be a positive safe integer')
      expect(await snapshot(h)).toEqual(before)
    },
  )
  test('missing routing rejects before any business/event write', async () => {
    const { committedEventFamilyCutovers: table } = tablesOf(h.db)
    await h.db.delete(table).where(family(h.db))
    const before = await snapshot(h)
    await expect(h.session.transaction((tx) => appendCommittedEvent(tx, event()))).rejects.toThrow(
      'committed event cutover is missing: collaboration/review',
    )
    expect(await snapshot(h)).toEqual(before)
  })
  test('an obsolete sequence cannot overwrite its committed winner', async () => {
    await seed(h)
    await h.session.transaction((tx) => appendCommittedEvent(tx, event()))
    const before = await snapshot(h)
    await expect(
      h.session.transaction((tx) =>
        appendCommittedEvent(tx, event({ eventId: 'loser', eventGroupId: 'loser' })),
      ),
    ).rejects.toThrow('committed event aggregate sequence did not advance')
    expect(await snapshot(h)).toEqual(before)
  })
  test('physical write failure rolls back the reserved sequence', async () => {
    await seed(h)
    const before = await snapshot(h)
    const remove = await installFailure(h)
    try {
      const error = await failureOf(
        h.session.transaction((tx) => appendCommittedEvent(tx, event())),
      )
      expect(error.message).toBe('w28 append failure')
    } finally {
      await remove()
    }
    expect(await snapshot(h)).toEqual(before)
    expect(
      (await h.session.transaction((tx) => appendCommittedEvent(tx, event()))).eventRef?.aggregate
        .seq,
    ).toBe(1)
  })
  test('missing readback after a real insert rolls the entire append back', async () => {
    await seed(h)
    let removed = false
    await expect(
      h.session.transaction((tx) =>
        driveAsyncProgram(
          appendCommittedEventProgram(tx, event(), (key) => engineOf(tx).advisoryLock(tx, key)),
          async (step) => {
            await step()
            if (removed) return
            const { committedEvents } = tablesOf(tx)
            const [row] = await tx
              .select()
              .from(committedEvents)
              .where(eq(committedEvents.id, 'w28-event'))
            if (row) {
              removed = true
              await tx.delete(committedEvents).where(eq(committedEvents.id, row.id))
            }
          },
        ),
      ),
    ).rejects.toThrow('committed event insert vanished: w28-event')
    expect(removed).toBe(true)
    expect(await snapshot(h)).toEqual({ events: [], heads: [], deliveries: [] })
  })
  test('outer rollback includes the event and companion write', async () => {
    await seed(h)
    const stop = new Error('w28 outer rollback')
    await expect(
      h.session.transaction(async (tx) => {
        const receipt = await appendCommittedEvent(tx, event())
        expect(await readCommittedEventCutover(tx, 'collaboration', 'review')).toEqual(
          receipt.cutover,
        )
        const { maintenanceState } = tablesOf(tx)
        await tx
          .insert(maintenanceState)
          .values({ key: 'w28-companion', value: 'written', updatedAt: NOW })
        throw stop
      }),
    ).rejects.toBe(stop)
    expect(await snapshot(h)).toEqual({ events: [], heads: [], deliveries: [] })
    const { maintenanceState } = tablesOf(h.db)
    expect(
      await h.db.select().from(maintenanceState).where(eq(maintenanceState.key, 'w28-companion')),
    ).toEqual([])
  })
  test('two transactions requiring the same sequence leave one immutable winner', async () => {
    await seed(h)
    const settled = await Promise.allSettled(
      ['a', 'b'].map((name) =>
        h.session.transaction((tx) =>
          appendCommittedEvent(tx, event({ eventId: name, eventGroupId: name })),
        ),
      ),
    )
    const winners = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const failures = settled.filter((result) => result.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBeInstanceOf(Error)
    expect(failures[0]?.reason.message).toBe(
      'committed event aggregate sequence did not advance: collaboration/review/review-round/w28@1',
    )
    const stored = await snapshot(h)
    const winnerId = winners[0]!.eventRef!.eventId
    const payloadJson = canonicalJson({
      eventId: winnerId,
      eventGroupId: winnerId,
      eventGroupOrdinal: 0,
      type: 'fixture.changed.v1',
      schemaVersion: 1,
      producer: 'collaboration',
      family: 'review',
      aggregate: { kind: 'review-round', id: 'w28', seq: 1 },
      operationRef: 'w28-operation',
      correlationRef: null,
      causationRef: null,
      occurredAt: new Date(NOW).toISOString(),
      payload: { value: 'original' },
    })
    expect(stored.events).toEqual([
      {
        id: winnerId,
        eventGroupId: winnerId,
        eventGroupOrdinal: 0,
        producer: 'collaboration',
        family: 'review',
        eventType: 'fixture.changed.v1',
        schemaVersion: 1,
        aggregateKind: 'review-round',
        aggregateId: 'w28',
        aggregateSeq: 1,
        operationRef: 'w28-operation',
        correlationRef: null,
        causationRef: null,
        occurredAt: NOW,
        payloadJson,
        payloadDigest: sha256Hex(payloadJson),
        producerEpoch: 7,
        deliveryMode: 'dispatchable',
        createdAt: NOW,
      },
    ])
    expect(stored.heads).toEqual([
      {
        producer: 'collaboration',
        family: 'review',
        aggregateKind: 'review-round',
        aggregateId: 'w28',
        lastSeq: 1,
        updatedAt: NOW,
      },
    ])
    expect(stored.deliveries).toEqual([])
  })
})
