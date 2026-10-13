import { observationAnomalyHistory, observationAnomalyStates } from '@/db/observationAnalysis'
import {
  observationAnomalyQueries,
  observeStorageAnomalies,
} from '@/modules/run-observability/infrastructure/observationAnomalies'
// RFC-371 long running: exact source retention, MVCC interval anchors and resumable derived GC.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'
import { observationUsageCurrent } from '@/db/schema'
import {
  observationProjectionDescriptors as descriptors,
  observationProjectionCurrent as current,
  observationProjectionHeads as heads,
  observationProjectionVersions as versions,
  observationProjectionHistory as history,
  observationProjectionMemberships as members,
  observationProjectionViews as views,
  observationProjectionWork as work,
  observationProjectionChanges as changes,
} from '@/db/observationProjection'
import {
  observationWorkRetention as workRetention,
  observationReportLeases as leases,
  observationStorageState as state,
  observationStorageSamples as samples,
} from '@/db/observationStorage'
import { observationMaintenanceOperations as maintenance } from '@/db/observationAnalysis'
import { incrementalObservationViews } from '@/modules/run-observability/infrastructure/incrementalObservationViews'
import { collectObservationStorage } from '@/modules/run-observability/infrastructure/observationStorageGc'
import { observationStorageStatus } from '@/modules/run-observability/infrastructure/observationStorageStatus'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
const input = (revision: string) => ({
  actorScope: 'original-admin',
  generation: 'original-db',
  version: { revision, asOf: 100 },
  query: { from: 0, to: 100, timezone: 'UTC' },
})
describeEachProvider('RFC-371 long running derived storage without population truncation', (h) => {
  async function seed() {
    await h.db
      .insert(heads)
      .values({ id: 'incremental-20261012-v1', revision: '12', asOf: 100 })
      .run()
    await h.db
      .insert(versions)
      .values(
        ['3', '7', '12'].map((revision) => ({ revision, asOf: 100, bootstrapComplete: true })),
      )
      .run()
  }
  test('same request reuses an immutable view; active reads renew; a retired ID never resurrects', async () => {
    await seed()
    const store = incrementalObservationViews(h.db),
      a = await store.retain(input('7')),
      b = await store.retain(input('7'))
    expect(a.id).toBe(b.id)
    await h.db.update(leases).set({ expiresAt: 0 }).where(eq(leases.id, a.id)).run()
    await store.get(a.id, a.actorScope)
    await collectObservationStorage(h.db)
    expect(await store.get(a.id, a.actorScope)).toEqual(a)
    await h.db.update(leases).set({ expiresAt: 0 }).where(eq(leases.id, a.id)).run()
    await collectObservationStorage(h.db)
    await expect(store.get(a.id, a.actorScope)).rejects.toMatchObject({ code: 'not-found' })
    const fresh = await store.retain(input('7'))
    expect(fresh.id).not.toBe(a.id)
    expect(fresh.version.revision).toBe('12')
  })
  test('upgrade grants seven days to existing views and retains an interval crossing the protected floor', async () => {
    await seed()
    await h.db
      .insert(views)
      .values({
        id: 'old',
        actorScope: 'original-admin',
        document: JSON.stringify({ ...input('7'), id: 'old' }),
      })
      .run()
    await h.db
      .insert(history)
      .values([
        {
          kind: 'aggregate',
          key: 'sum',
          fromRevision: '3',
          toRevision: '12',
          document: '{"tokens":"17"}',
        },
        { kind: 'aggregate', key: 'sum', fromRevision: '12', document: '{"tokens":"19"}' },
      ])
      .run()
    await h.db
      .insert(members)
      .values({ aggregate: 'sum', key: 'call', fromRevision: '3', toRevision: '12' })
      .run()
    await collectObservationStorage(h.db)
    expect(
      (await h.db.select().from(leases).where(eq(leases.id, 'old')).get())!.expiresAt - Date.now(),
    ).toBeGreaterThan(6 * 86400000)
    expect(await h.db.select().from(history).all()).toHaveLength(2)
    expect(await h.db.select().from(members).all()).toHaveLength(1)
    await h.db.update(leases).set({ expiresAt: 0 }).where(eq(leases.id, 'old')).run()
    for (let n = 0; n < 3; n++) await collectObservationStorage(h.db)
    expect((await h.db.select().from(history).all()).map((x) => x.fromRevision)).toEqual(['12'])
    expect(await h.db.select().from(members).all()).toHaveLength(0)
  })
  test('concurrent renewal and expiry serialize without resurrecting a retired view', async () => {
    await seed()
    const store = incrementalObservationViews(h.db),
      view = await store.retain(input('7'))
    await h.db.update(leases).set({ expiresAt: 0 }).where(eq(leases.id, view.id)).run()
    const [read, gc] = await Promise.allSettled([
      store.get(view.id, view.actorScope),
      collectObservationStorage(h.db),
    ])
    expect(gc.status).toBe('fulfilled')
    if (read.status === 'fulfilled') {
      expect(read.value).toEqual(view)
      expect(await store.get(view.id, view.actorScope)).toEqual(view)
    } else {
      expect(read.reason).toMatchObject({ code: 'not-found' })
      const fresh = await store.retain(input('7'))
      expect(fresh.id).not.toBe(view.id)
    }
  })
  test('unfinished preparation and an explicit maintenance preview protect old data independently of idle expiry', async () => {
    await seed()
    const view = await incrementalObservationViews(h.db).retain(input('7'))
    await h.db
      .insert(work)
      .values({ id: 'preparing', document: '{}', fingerprint: 'original' })
      .run()
    await h.db.insert(workRetention).values({ id: 'preparing', revision: '3', queuedAt: 1 }).run()
    await h.db
      .insert(history)
      .values({
        kind: 'aggregate',
        key: 'protected',
        fromRevision: '1',
        toRevision: '7',
        document: '{}',
      })
      .run()
    await h.db
      .insert(maintenance)
      .values({
        id: 'maintenance',
        requestKey: 'preview',
        actorId: 'admin',
        actorScope: 'scope',
        actorDocument: '{}',
        state: 'preview',
        sourceRevision: '7',
        createdAt: 1,
        document: JSON.stringify({ request: { reportId: view.id } }),
      })
      .run()
    await h.db.update(leases).set({ expiresAt: 0 }).where(eq(leases.id, view.id)).run()
    await collectObservationStorage(h.db)
    expect(await h.db.select().from(views).where(eq(views.id, view.id)).get()).toBeDefined()
    expect(await h.db.select().from(history).all()).toHaveLength(1)
    await h.db
      .update(work)
      .set({ completedRevision: '12', appliedRevision: '12' })
      .where(eq(work.id, 'preparing'))
      .run()
    await h.db
      .update(maintenance)
      .set({ state: 'complete' })
      .where(eq(maintenance.id, 'maintenance'))
      .run()
    for (let n = 0; n < 3; n++) await collectObservationStorage(h.db)
    expect(await h.db.select().from(history).all()).toHaveLength(0)
  })
  test('1201 old revisions drain beyond multiple packets and every original usage identity and four-bin document survives', async () => {
    await seedCompleteTask(h, 2, 211)
    await seed()
    // Independent maintenance ordering is not a projection version and must not pin every history row forever.
    await h.db
      .insert(heads)
      .values({ id: 'maintenance-confirmation', revision: '0', asOf: 100 })
      .run()
    const original = await h.db
      .select()
      .from(observationUsageCurrent)
      .orderBy(observationUsageCurrent.id)
      .all()
    for (let start = 0; start < 1201; start += 200) {
      const rows = Array.from({ length: Math.min(200, 1201 - start) }, (_, i) => ({
        kind: 'aggregate' as const,
        key: 'old-' + String(start + i).padStart(6, '0'),
        fromRevision: '3',
        toRevision: '7',
        document: JSON.stringify({
          input: '9007199254740997',
          cacheRead: '3',
          cacheWrite: '5',
          output: '7',
          cny: '0.000017',
        }),
      }))
      await h.db.insert(history).values(rows).run()
    }
    for (let n = 0; n < 6; n++) await collectObservationStorage(h.db)
    expect(await h.db.select().from(history).all()).toHaveLength(0)
    expect(
      await h.db.select().from(observationUsageCurrent).orderBy(observationUsageCurrent.id).all(),
    ).toEqual(original)
  }, 30000)
  test('an already applied native retry cannot pin unrelated old history while its original facts and pending work remain', async () => {
    await seedCompleteTask(h, 2, 211)
    await seed()
    const original = await h.db
      .select()
      .from(observationUsageCurrent)
      .orderBy(observationUsageCurrent.id)
      .all()
    await h.db
      .insert(work)
      .values({
        id: 'native-awaits-source',
        document: '{}',
        fingerprint: 'original',
        appliedRevision: '12',
      })
      .run()
    await h.db
      .insert(workRetention)
      .values({ id: 'native-awaits-source', revision: '3', queuedAt: 1 })
      .run()
    await h.db
      .insert(history)
      .values({
        kind: 'aggregate',
        key: 'old-applied',
        fromRevision: '1',
        toRevision: '7',
        document: '{}',
      })
      .run()
    const pages: number[] = []
    await collectObservationStorage(h.db, (rows) => {
      pages.push(rows)
    })
    expect(
      await h.db.select().from(history).where(eq(history.key, 'old-applied')).get(),
    ).toBeUndefined()
    expect(
      await h.db.select().from(work).where(eq(work.id, 'native-awaits-source')).get(),
    ).toMatchObject({ appliedRevision: '12', completedRevision: null })
    expect(
      await h.db.select().from(observationUsageCurrent).orderBy(observationUsageCurrent.id).all(),
    ).toEqual(original)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toBeGreaterThan(0)
  }, 30000)

  test('failed cleanup rolls back cursor, history and source acknowledgements before an exact retry', async () => {
    await seed()
    await h.db
      .insert(history)
      .values({ kind: 'aggregate', key: 'row', fromRevision: '3', toRevision: '7', document: '{}' })
      .run()
    await h.db
      .insert(changes)
      .values({
        id: 'pending',
        source: 'test',
        entityKey: 'fact',
        operation: 'update',
        createdAt: 1,
        completed: false,
      })
      .run()
    await expect(
      databaseSessionFor(h.db).transaction(async (tx) => {
        await collectObservationStorage(tx)
        throw Error('injected write failure')
      }),
    ).rejects.toThrow('injected write failure')
    expect(await h.db.select().from(history).all()).toHaveLength(1)
    expect(await h.db.select().from(state).where(eq(state.key, 'gc')).get()).toBeUndefined()
    await collectObservationStorage(h.db)
    expect(await h.db.select().from(history).all()).toHaveLength(0)
    expect(
      (await h.db.select().from(changes).where(eq(changes.id, 'pending')).get())?.completed,
    ).toBe(false)
  })
  test('descriptor GC crosses a live prefix with indexed exact-key probes and keeps both contribution kinds', async () => {
    await seed()
    for (let start = 0; start < 1001; start += 200) {
      const rows = Array.from({ length: Math.min(200, 1001 - start) }, (_, n) => ({
        key: String(start + n).padStart(6, '0'),
        document: '{}',
      }))
      await h.db.insert(descriptors).values(rows).run()
      await h.db
        .insert(history)
        .values(
          rows.map((r, n) => ({
            ...r,
            kind: n % 2 ? ('aggregate' as const) : ('contribution' as const),
            fromRevision: '12',
          })),
        )
        .run()
    }
    await h.db
      .insert(descriptors)
      .values([
        { key: 'y-current', document: '{}' },
        { key: 'z-orphan', document: '{}' },
      ])
      .run()
    await h.db
      .insert(current)
      .values({ kind: 'aggregate', key: 'y-current', revision: '12', document: '{}' })
      .run()
    const recording = h.recordStatements()
    try {
      for (let n = 0; n < 3; n++) await collectObservationStorage(h.db)
    } finally {
      recording.stop()
    }
    expect(
      await h.db.select().from(descriptors).where(eq(descriptors.key, 'z-orphan')).get(),
    ).toBeUndefined()
    expect(await h.db.select().from(descriptors).all()).toHaveLength(1002)
    const probes = recording.statements.filter((r) =>
      /^DELETE FROM (?:"agent_workflow"\.)?["`]?observation_projection_descriptors/.test(r.sql),
    )
    expect(probes).toHaveLength(3)
    if (h.capabilities.isolation === 'exclusive') {
      for (const probe of probes) {
        const plan = await h.explain(probe)
        expect(plan).toMatch(/SEARCH h .*kind=\? AND key=\?/)
        expect(plan).toMatch(/SEARCH c .*kind=\? AND key=\?/)
        expect(plan).not.toMatch(/SCAN [hc]\b/)
      }
    }
  })
  test('storage findings preserve unavailable evidence and append only real transitions', async () => {
    const base = await observationStorageStatus(h.db).read(),
      at = Date.now(),
      value = {
        ...base,
        freeBytes: '1000',
        pending: '12001',
        oldestPendingAt: at - 120000,
        lastError: 'disk full',
      }
    await observeStorageAnomalies(h.db, value, at)
    await observeStorageAnomalies(h.db, value, at + 1000)
    expect(await h.db.select().from(observationAnomalyHistory).all()).toHaveLength(3)
    const query = { from: at - 1, to: at + 4000, pageSize: 2 },
      read = observationAnomalyQueries(h.db, async () => [], true)
    const first = await read(query),
      second = await read({ ...query, after: first.nextCursor! })
    expect(first.total).toBe('3')
    expect([...first.items, ...second.items].map((x) => x.state)).toEqual([
      'firing',
      'firing',
      'firing',
    ])
    expect(second.nextCursor).toBeNull()
    expect((await observationAnomalyQueries(h.db, async () => [])(query)).total).toBe('0')
    await observeStorageAnomalies(h.db, { ...value, freeBytes: null }, at + 2000)
    const capacity = (await h.db.select().from(observationAnomalyStates).all())
      .map((r) => JSON.parse(r.document))
      .find((r) => r.rule === 'storage-capacity')
    expect(capacity).toMatchObject({ state: 'firing', sourceState: 'unavailable' })
    const unavailable = await read({ ...query, pageSize: 10 })
    expect(unavailable.items.find((x) => x.rule === 'storage-capacity')).toMatchObject({
      state: 'firing',
      sourceState: 'unavailable',
    })
    await observeStorageAnomalies(h.db, { ...base, freeBytes: '1099511627776' }, at + 3000)
    expect(
      (await h.db.select().from(observationAnomalyStates).all()).map(
        (r) => JSON.parse(r.document).state,
      ),
    ).toEqual(['resolved', 'resolved', 'resolved'])
    expect((await read({ ...query, pageSize: 10 })).items.map((x) => x.state)).toEqual([
      'resolved',
      'resolved',
      'resolved',
    ])
  })
  test('native engine capacity and hourly sampling preserve decimal counters and never infer a remote volume', async () => {
    const measured = await engineOf(h.db).storageUsage(h.db)
    expect(BigInt(measured.databaseBytes)).toBeGreaterThan(0n)
    if (engineOf(h.db).isolation === 'read-committed') expect(measured.freeBytes).toBeNull()
    let now = Date.now()
    const storage = observationStorageStatus(h.db, () => now)
    storage.cancelSample()
    await storage.sample()
    expect(await h.db.select().from(samples).all()).toHaveLength(0)
    storage.resumeSample()
    await storage.sample()
    const before = await storage.read()
    await storage.sample()
    expect(await h.db.select().from(samples).all()).toHaveLength(1)
    expect((await storage.read()).sampledAt).toBe(before.sampledAt)
    now += 86400000
    await storage.sample()
    expect(await h.db.select().from(samples).all()).toHaveLength(2)
    await storage.failed(Error('database full'))
    expect((await storage.read()).lastError).toBe('database full')
  })
})
