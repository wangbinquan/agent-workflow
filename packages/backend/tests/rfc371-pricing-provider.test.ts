// RFC-371: an accepted invocation keeps its CNY tariff through edits, retries and restart.
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { SaveObservationPrice } from '@agent-workflow/shared'
import { createObservationPricing } from '../src/modules/run-observability/application/pricing'
import { createObservationPriceStore } from '../src/modules/run-observability/infrastructure/pricingPersistence'
import { mountObservationRoutes } from '../src/modules/run-observability/composition/observationRoutes'
import { buildActor } from '../src/auth/actor'
import { errorHandler } from '../src/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { createRuntimeObservationQueries } from '../src/modules/runtime-management/application/runtimeObservationQueries'
import type { PostgresqlReservedConnection } from '../src/platform/persistence/postgresqlRuntime'

const ID = 'observation-runtime-one'
const NOW = Date.parse('2026-09-28T00:00:00Z')
function draft(patch: Partial<SaveObservationPrice> = {}): SaveObservationPrice {
  return {
    expectedRevision: 0,
    requestKey: 'observation-price-1',
    configurationRevision: 0,
    protocol: 'opencode',
    provider: 'provider',
    model: 'model',
    condition: null,
    currency: 'CNY',
    rates: { input: '0.000001', output: '0.1', cacheRead: '0', cacheWrite: null },
    effectiveFrom: new Date(NOW + 60_000).toISOString(),
    sourceNote: 'Example CNY tariff',
    ...patch,
  }
}
describeEachProvider('RFC-371 immutable runtime CNY pricing', (harness) => {
  function fixture() {
    let now = NOW,
      serial = 0
    const entries = [
      {
        registrationId: ID,
        name: 'runtime',
        configurationRevision: 0,
        protocol: 'opencode' as const,
        model: 'model',
        enabled: true,
      },
    ]
    const store = createObservationPriceStore(harness.db)
    const application = createObservationPricing({
      store,
      runtimes: { directory: async () => ({ runtimes: entries }) },
      now: () => now,
      newId: () => 'price-' + ++serial,
    })
    return {
      ...application,
      store,
      entries,
      time: (next: number) => {
        now = next
      },
    }
  }
  test('one concurrent save wins; replay stays idempotent after activation and profile deletion', async () => {
    const f = fixture(),
      input = draft()
    const attempts = await Promise.allSettled([
      f.commands.save(ID, input, 'admin'),
      f.commands.save(ID, { ...input, requestKey: 'observation-price-2' }, 'admin'),
    ])
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1)
    const winner =
      attempts[0]?.status === 'fulfilled' ? input : { ...input, requestKey: 'observation-price-2' }
    const page = await f.queries.history(ID, { limit: 20 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.rates).toEqual(input.rates)
    expect((await f.queries.runtimes()).runtimes[0]?.pricingRevision).toBe(1)
    f.time(NOW + 120_000)
    f.entries.splice(0)
    expect(await f.commands.save(ID, winner, 'admin')).toEqual(page.items[0]!)
    await expect(
      f.commands.save(ID, { ...winner, sourceNote: 'changed' }, 'admin'),
    ).rejects.toMatchObject({ code: 'request-conflict' })
    expect((await f.queries.history(ID, { limit: 20 })).revision).toBe(1)
  })
  test('an existing head serializes competing models and identical retries return the same receipt', async () => {
    const f = fixture()
    await f.commands.save(ID, draft(), 'admin')
    const candidates = [1, 2, 3].map((n) =>
      draft({ expectedRevision: 1, requestKey: 'concurrent-model-' + n, model: 'model-' + n }),
    )
    const results = await Promise.allSettled(
      candidates.map((input) => f.commands.save(ID, input, 'admin')),
    )
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
    for (const row of results)
      if (row.status === 'rejected')
        expect(row.reason).toMatchObject({ code: 'price-conflict', details: { revision: 2 } })
    const same = draft({
      expectedRevision: 2,
      requestKey: 'same-concurrent-key',
      model: 'same-model',
    })
    const receipts = await Promise.all([
      f.commands.save(ID, same, 'admin'),
      f.commands.save(ID, same, 'admin'),
    ])
    expect(receipts[0]).toEqual(receipts[1])
    expect((await f.queries.history(ID, { limit: 20 })).revision).toBe(3)
  })
  test('effective-time matching is exact and history never reprices an accepted invocation', async () => {
    const f = fixture(),
      input = draft()
    const first = await f.commands.save(ID, input, 'admin')
    const query = { ...input, registrationId: ID, acceptedAt: NOW + 60_000 }
    expect(await f.queries.priceAtAcceptance({ ...query, acceptedAt: NOW })).toBeNull()
    expect(await f.queries.priceAtAcceptance(query)).toEqual(first)
    const second = await f.commands.save(
      ID,
      draft({
        expectedRevision: 1,
        requestKey: 'observation-price-2',
        effectiveFrom: new Date(NOW + 120_000).toISOString(),
        rates: { ...input.rates, input: '1.2' },
      }),
      'admin',
    )
    expect(await f.queries.priceAtAcceptance(query)).toEqual(first)
    expect(await f.queries.priceAtAcceptance({ ...query, acceptedAt: NOW + 120_000 })).toEqual(
      second,
    )
    for (const miss of [
      { model: 'another' },
      { provider: 'another' },
      { condition: 'batch' },
      { configurationRevision: 1 },
      { registrationId: 'same-name-new-registration' },
    ]) {
      expect(await f.queries.priceAtAcceptance({ ...query, ...miss })).toBeNull()
    }
    const page = await f.queries.history(ID, { limit: 1 })
    expect(page).toMatchObject({ revision: 2, nextBeforeRevision: 2, items: [second] })
    expect((await f.queries.history(ID, { limit: 1, beforeRevision: 2 })).items).toEqual([first])
    const reopened = createObservationPriceStore(harness.db)
    expect(await reopened.priceAt(ID, input, query.acceptedAt)).toEqual(first)
  })
  test('runtime revisions, CNY rates, activation ordering and transaction rollback are enforced', async () => {
    const f = fixture(),
      first = await f.commands.save(ID, draft(), 'admin')
    await expect(
      f.commands.save(ID, draft({ requestKey: 'stale-price-1' }), 'admin'),
    ).rejects.toMatchObject({ code: 'price-conflict', details: { revision: 1 } })
    f.entries[0]!.configurationRevision = 1
    await expect(
      f.commands.save(ID, draft({ requestKey: 'stale-profile-1', expectedRevision: 1 }), 'admin'),
    ).rejects.toMatchObject({ code: 'runtime-changed', details: { configurationRevision: 1 } })
    const valid = draft({
      requestKey: 'next-profile-1',
      expectedRevision: 1,
      configurationRevision: 1,
    })
    await expect(
      f.commands.save(
        ID,
        { ...valid, currency: 'USD' } as unknown as SaveObservationPrice,
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'invalid-price' })
    await expect(
      f.commands.save(ID, { ...valid, rates: { ...valid.rates, output: '0.0000001' } }, 'admin'),
    ).rejects.toMatchObject({ code: 'invalid-price' })
    await expect(
      f.commands.save(ID, { ...valid, effectiveFrom: new Date(NOW - 1).toISOString() }, 'admin'),
    ).rejects.toMatchObject({ code: 'invalid-price' })
    f.entries[0]!.configurationRevision = 0
    await expect(
      f.commands.save(ID, { ...valid, configurationRevision: 0 }, 'admin'),
    ).rejects.toMatchObject({ code: 'activation-conflict' })
    await expect(
      f.store.change(ID, async (scope) => {
        await scope.append({ ...first, id: 'rollback', revision: 2 }, 'rollback-key', 'rollback')
        throw new Error('fault after price and head writes')
      }),
    ).rejects.toThrow('fault after')
    expect(await f.queries.history(ID, { limit: 10 })).toEqual({ revision: 1, items: [first] })
  })
  test('HTTP routes return CNY versions and mapped conflicts through the ordinary route gate', async () => {
    const f = fixture(),
      app = new Hono()
    const actor = buildActor({
      user: {
        id: 'admin',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    app.use('*', async (c, next) => {
      c.set('actor', actor)
      await next()
    })
    app.onError(errorHandler)
    mountObservationRoutes(app, f)
    const path = '/api/observability/pricing/runtimes/' + ID + '/versions'
    expect((await app.request('/api/observability/pricing/runtimes')).status).toBe(200)
    const save = (input: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    const response = await save(draft())
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      currency: 'CNY',
      revision: 1,
      createdBy: 'admin',
    })
    expect((await save(draft({ requestKey: 'next-price-1' }))).status).toBe(409)
    expect((await save({ ...draft(), currency: 'USD' })).status).toBe(422)
    expect((await save(draft({ effectiveFrom: '2027-01-01T00:00:00+24:00' }))).status).toBe(422)
    expect((await app.request(path + '?limit=9999')).status).toBe(422)
    expect((await app.request(path + '?limit=1')).status).toBe(200)
  })
  // Regression: querying the real runtime directory inside the price transaction
  // waited for a second connection, including when poolMax=1 was valid.
  test('real runtime directory and price persistence save with one available pool connection', async () => {
    const runtimes = createRuntimeObservationQueries(composeRuntimeRegistryOperations(harness.db))
    const runtime = (await runtimes.directory()).runtimes.find(
      (row) => row.protocol === 'opencode',
    )!
    expect(runtime).toBeDefined()
    const application = createObservationPricing({
      store: createObservationPriceStore(harness.db),
      runtimes,
      now: () => NOW,
      newId: () => 'one-connection-price',
    })
    const input = draft({ configurationRevision: runtime.configurationRevision })
    const held: PostgresqlReservedConnection[] = []
    const binding = harness.applicationBinding
    let pending: Promise<unknown> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      if (binding.provider === 'postgresql') {
        // The real provider pool has exactly one slot left for BOTH operations.
        for (let n = 1; n < binding.databaseConfig.poolMax; n++)
          held.push(await binding.runtime.providerPool().reserve())
      }
      pending = application.commands.save(runtime.registrationId, input, 'admin')
      const version = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('price save exhausted the pool')), 3000)
        }),
      ])
      expect(version).toMatchObject({ registrationId: runtime.registrationId, currency: 'CNY' })
    } finally {
      clearTimeout(deadline)
      for (const connection of held) connection.release()
      // If the deadline failed, release the blockers and drain before harness cleanup.
      await pending?.catch(() => undefined)
    }
  }, 15_000)
})
