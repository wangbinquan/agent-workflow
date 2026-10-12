// RFC-371: durable increments, inverse updates, immutable views and bootstrap
// recovery on both real engines. Packet sizes must never terminate statistics.
import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { observationUsageSources } from '@/db/schema'
import {
  observationProjectionBootstrap,
  observationProjectionChanges,
  observationProjectionHeads,
  observationProjectionPrepared,
  observationProjectionWork,
} from '@/db/observationProjection'
import {
  createIncrementalObservationProjection,
  IncrementalObservationSourceChanged,
} from '@/modules/run-observability/application/incrementalObservationProjection'
import {
  emptyCompleteObservationFold,
  addCompleteObservationAllocation,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import { completeIncrementalObservationFold } from '@/modules/run-observability/domain/incrementalObservationFold'
import {
  incrementalObservationPreparedStore,
  preparedObservationContributions,
} from '@/modules/run-observability/infrastructure/incrementalObservationPreparedStore'
import { createIncrementalObservationProjectionStore } from '@/modules/run-observability/infrastructure/incrementalObservationProjectionStore'
import { createIncrementalObservationQueryStore } from '@/modules/run-observability/infrastructure/incrementalObservationQueryStore'
import { enqueueIncrementalObservationWork } from '@/modules/run-observability/infrastructure/incrementalObservationWork'
import { incrementalObservationChangeQueue } from '@/modules/run-observability/infrastructure/incrementalObservationChanges'
import { incrementalObservationBootstrap } from '@/modules/run-observability/infrastructure/incrementalObservationBootstrap'
import type {
  IncrementalObservationContribution,
  IncrementalObservationWork,
} from '@/modules/run-observability/ports/incrementalObservationProjection'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const generation = 'incremental-provider-fixture'
function contribution(
  key: string,
  component = 'A',
  amount = '9007199254740997',
  memberships = ['task/A', 'day/old'],
): IncrementalObservationContribution {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(
    fold,
    { input: amount, cacheRead: '13', cacheWrite: '17', output: '19' },
    { amount: '0.000000000001', complete: true, hidden: false },
  )
  return {
    key,
    component,
    fold,
    aggregates: memberships,
    detail: {
      section: 'invocations',
      parent: null,
      key,
      taskId: 'A',
      cohortAt: 1,
      document: { invocationId: key },
    },
  }
}
function fixture(harness: ProviderHarness) {
  const prepared = incrementalObservationPreparedStore(harness.db),
    adapter = createIncrementalObservationProjectionStore(harness.db, generation),
    query = createIncrementalObservationQueryStore(harness.db)
  const notifications: string[] = []
  const projection = createIncrementalObservationProjection({
    store: adapter.store,
    source: adapter.source(preparedObservationContributions),
    now: () => 1000,
    committed: (version) => notifications.push(version.revision),
  })
  async function stage(
    id: string,
    rows: readonly IncrementalObservationContribution[],
    components: readonly string[] = ['A'],
    retryNative = false,
  ) {
    const work: IncrementalObservationWork = {
      id,
      source: 'original-fixture',
      revision: id,
      components,
      retryNative,
    }
    await harness.session.transaction((tx) => enqueueIncrementalObservationWork(tx, work))
    const claimed = await prepared.begin(work),
      head = await harness.db.select().from(observationProjectionHeads).get()
    await prepared.append(claimed, rows)
    return prepared.seal(
      claimed,
      {
        generation,
        snapshotId: 'original-fixture/' + id,
        asOf: 1000,
        baseRevision: head?.revision ?? '0',
        preparationToken: claimed.preparationToken!,
      },
      components,
    )
  }
  return { stage, prepared, adapter, query, projection, notifications }
}
describeEachProvider('RFC-371 real durable incremental projection', (harness) => {
  test('original I/U/D outbox rolls back with its producer and derived writes do not enqueue themselves', async () => {
    await harness.db.delete(observationProjectionChanges).run()
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.insert(observationUsageSources).values({ sourceId: 'rolled-back' }).run()
        throw new Error('producer rollback')
      }),
    ).rejects.toThrow('producer rollback')
    expect(await harness.db.select().from(observationProjectionChanges).all()).toEqual([])
    await harness.session.transaction(async (tx) => {
      await tx.insert(observationUsageSources).values({ sourceId: 'kept', cursor: 'first' }).run()
      await tx
        .update(observationUsageSources)
        .set({ cursor: 'next' })
        .where(eq(observationUsageSources.sourceId, 'kept'))
        .run()
      await tx
        .delete(observationUsageSources)
        .where(eq(observationUsageSources.sourceId, 'kept'))
        .run()
    })
    const changes = await harness.db.select().from(observationProjectionChanges).all()
    expect(changes.map((row) => row.operation).sort()).toEqual(['delete', 'insert', 'update'])
    expect(changes.every((row) => JSON.parse(row.entityKey).source_id === 'kept')).toBe(true)
    await harness.db
      .insert(observationProjectionBootstrap)
      .values({ generation, channel: 'derived' })
      .run()
    expect(await harness.db.select().from(observationProjectionChanges).all()).toHaveLength(3)
  })
  test('407 contributions across every packet retain four exact buckets and CNY; decrease, move and delete withdraw old values', async () => {
    const f = fixture(harness),
      original = Array.from({ length: 407 }, (_, n) => contribution(String(n).padStart(5, '0')))
    await f.projection.apply(await f.stage('first', original))
    const v1 = (await f.query.snapshot())!,
      fold = completeIncrementalObservationFold((await f.query.aggregate('task/A', v1))!)
    expect(fold.tokens).toEqual({
      input: String(407n * 9007199254740997n),
      cacheRead: String(407n * 13n),
      cacheWrite: String(407n * 17n),
      output: String(407n * 19n),
    })
    expect(fold.picos).toBe('407')
    let count = 0
    for await (const row of f.query.details({ version: v1, section: 'invocations' })) {
      expect(row.detail.key).toBe(String(count++).padStart(5, '0'))
    }
    expect(count).toBe(407)
    await f.projection.apply(
      await f.stage('move', [contribution('00000', 'B', '3', ['task/B', 'day/new'])], ['A', 'B']),
    )
    const v2 = (await f.query.snapshot())!
    expect(
      completeIncrementalObservationFold((await f.query.aggregate('task/A', v2))!).tokens.input,
    ).toBe('0')
    expect(
      completeIncrementalObservationFold((await f.query.aggregate('task/B', v2))!).tokens.input,
    ).toBe('3')
    expect(
      completeIncrementalObservationFold((await f.query.aggregate('task/A', v1))!).tokens.input,
    ).toBe(fold.tokens.input)
    await f.projection.apply(await f.stage('delete', [], ['B']))
    expect(
      completeIncrementalObservationFold(
        (await f.query.aggregate('task/B', (await f.query.snapshot())!))!,
      ).tokens.input,
    ).toBe('0')
    expect(f.notifications).toEqual(['1', '2', '3'])
  }, 60_000)
  test('a second preparation cannot claim an active lease; an older base or forged EOF cannot change any aggregate', async () => {
    const f = fixture(harness),
      a = await f.stage('a', [contribution('a')])
    await expect(f.prepared.begin(a)).rejects.toThrow('claimed')
    const b = await f.stage('b', [contribution('b', 'B')], ['B'])
    await f.projection.apply(b)
    await expect(f.projection.apply(a)).rejects.toBeInstanceOf(IncrementalObservationSourceChanged)
    expect(await f.query.aggregate('task/A', (await f.query.snapshot())!)).toBeNull()
    const c = await f.stage('c', [contribution('c')])
    await harness.db
      .update(observationProjectionPrepared)
      .set({ document: JSON.stringify(contribution('c', 'A', '8')) })
      .where(eq(observationProjectionPrepared.workId, c.id))
      .run()
    await expect(f.projection.apply(c)).rejects.toThrow('EOF changed')
    expect(await f.query.aggregate('task/A', (await f.query.snapshot())!)).toBeNull()
  })
  test('known unavailable native facts stay published and pending for retry without blocking later components', async () => {
    const f = fixture(harness),
      row = contribution('native-known')
    row.fold.gaps.push('historical-native-unavailable')
    await f.projection.apply(await f.stage('native-retry', [row], ['A'], true))
    const work = await harness.db
      .select()
      .from(observationProjectionWork)
      .where(eq(observationProjectionWork.id, 'native-retry'))
      .get()
    expect(work?.completedRevision).toBeNull()
    expect(work?.appliedRevision).toBe('1')
    expect(work?.retryAt).toBeGreaterThan(Date.now())
    await f.projection.apply(await f.stage('unrelated', [contribution('later', 'B')], ['B']))
    expect((await f.query.snapshot())?.revision).toBe('2')
    expect(
      completeIncrementalObservationFold(
        (await f.query.aggregate('task/A', (await f.query.snapshot())!))!,
      ).tokens.input,
    ).toBe('9007199254740997')
  })
  test('one malformed change is retained for retry while a late lexicographically earlier commit remains eligible', async () => {
    await harness.db.delete(observationProjectionChanges).run()
    const source = 'observation_usage_sources'
    await harness.db
      .insert(observationProjectionChanges)
      .values([
        { id: 'zz', source, entityKey: '{', operation: 'insert', nextRoute: null, createdAt: 1 },
        {
          id: 'mm',
          source,
          entityKey: '{"source_id":"good"}',
          operation: 'insert',
          nextRoute: null,
          createdAt: 2,
        },
      ])
      .run()
    const errors: unknown[] = [],
      queue = incrementalObservationChangeQueue(harness.db, (error) => errors.push(error))
    const router = { components: async () => ['A'] }
    expect(await queue.dispatch(router, 100)).toBe(1)
    expect(errors).toHaveLength(1)
    expect(
      (
        await harness.db
          .select()
          .from(observationProjectionChanges)
          .where(eq(observationProjectionChanges.id, 'zz'))
          .get()
      )?.completed,
    ).toBe(false)
    await harness.db
      .insert(observationProjectionChanges)
      .values({
        id: 'aa',
        source,
        entityKey: '{"source_id":"late"}',
        operation: 'insert',
        nextRoute: null,
        createdAt: 0,
      })
      .run()
    expect(await queue.dispatch(router, 100)).toBe(1)
    expect(
      (
        await harness.db
          .select()
          .from(observationProjectionChanges)
          .where(eq(observationProjectionChanges.id, 'aa'))
          .get()
      )?.completed,
    ).toBe(true)
    expect(await harness.db.select().from(observationProjectionWork).all()).toHaveLength(2)
  })
  test('bootstrap restarts at the actual EOF cursor and does not rescan completed pages', async () => {
    const pages: (string | undefined)[] = [],
      channels = [
        {
          id: 'owners',
          async page(after?: string) {
            pages.push(after)
            return {
              items: [
                { identity: after ?? 'first', component: after ?? 'A', components: [after ?? 'A'] },
              ],
              nextCursor: after ? null : 'next',
            }
          },
        },
      ]
    const signal = new AbortController().signal
    expect(await incrementalObservationBootstrap(harness.db, generation, channels)(signal)).toBe(1)
    expect(await incrementalObservationBootstrap(harness.db, generation, channels)(signal)).toBe(1)
    expect(await incrementalObservationBootstrap(harness.db, generation, channels)(signal)).toBe(0)
    expect(pages).toEqual([undefined, 'next'])
    expect(
      (
        await harness.db
          .select()
          .from(observationProjectionBootstrap)
          .where(
            and(
              eq(observationProjectionBootstrap.generation, generation),
              eq(observationProjectionBootstrap.channel, 'owners'),
            ),
          )
          .get()
      )?.done,
    ).toBe(true)
    expect(await harness.db.select().from(observationProjectionWork).all()).toHaveLength(2)
  })
  test('day memberships carry indexed scope and remain correct at a retained version after a clock correction', async () => {
    const f = fixture(harness),
      day = 20000,
      key = 'occurrence-scope-day/' + JSON.stringify(['A', 'A', day])
    await f.projection.apply(await f.stage('day', [contribution('time', 'A', '7', [key])]))
    const first = (await f.query.snapshot())!,
      values = []
    for await (const row of f.query.days({
      version: first,
      taskIds: ['A'],
      components: [],
      from: day * 86400000,
      to: (day + 1) * 86400000,
    }))
      values.push(row)
    expect(values).toHaveLength(1)
    expect(values[0]!.tokens.input).toBe('7')
    await f.projection.apply(
      await f.stage('clock-correction', [
        contribution('time', 'A', '11', [
          'occurrence-scope-day/' + JSON.stringify(['A', 'A', day + 1]),
        ]),
      ]),
    )
    const old = []
    for await (const row of f.query.days({
      version: first,
      taskIds: ['A'],
      components: [],
      from: day * 86400000,
      to: (day + 1) * 86400000,
    }))
      old.push(row)
    expect(old[0]!.tokens.input).toBe('7')
    const current = []
    for await (const row of f.query.days({
      version: (await f.query.snapshot())!,
      taskIds: ['A'],
      components: [],
      from: day * 86400000,
      to: (day + 1) * 86400000,
    }))
      current.push(row)
    expect(current[0]!.tokens.input).toBe('0')
  })
})
