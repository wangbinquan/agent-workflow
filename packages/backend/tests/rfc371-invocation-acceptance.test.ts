// RFC-371: retries and newly published prices must never change an accepted execution.
import { expect, test } from 'bun:test'
import {
  AcceptObservationInvocationSchema,
  AcceptedObservationInvocationSchema,
  type AcceptObservationInvocation,
  type SaveObservationPrice,
} from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { createObservationPricing } from '../src/modules/run-observability/application/pricing'
import { createObservationPriceStore } from '../src/modules/run-observability/infrastructure/pricingPersistence'
import { createObservationInvocationStore } from '../src/modules/run-observability/infrastructure/invocationPersistence'
import { createInvocationValuation } from '../src/modules/run-observability/application/invocationValuation'

const NOW = Date.parse('2026-09-28T00:00:00Z')
const acceptance = (id: string): AcceptObservationInvocation => ({
  invocationId: id,
  taskId: 'task',
  nodeRunId: 'run',
  agentId: 'agent',
  agentRevision: 7,
  purpose: 'task',
  authority: {
    kind: 'local',
    runtime: { registrationId: 'runtime', configurationRevision: 3, protocol: 'opencode' },
  },
})
const inputPrice = (patch: Partial<SaveObservationPrice> = {}): SaveObservationPrice => ({
  expectedRevision: 0,
  requestKey: 'tariff-request-1',
  configurationRevision: 3,
  protocol: 'opencode',
  provider: 'gateway',
  model: 'model',
  condition: null,
  currency: 'CNY',
  rates: { input: '1.2', cacheRead: '0', cacheWrite: '0', output: '2.4' },
  effectiveFrom: new Date(NOW + 1000).toISOString(),
  sourceNote: 'CNY example',
  ...patch,
})
const platform = {
  kind: 'crewstation' as const,
  sourceId: 'cs-installation',
  projectId: 'cs-project',
  taskId: 'cs-task',
  subtaskId: 'cs-subtask',
  executionResourceId: 'cs-execution',
  executionGeneration: 1,
}

describeEachProvider('RFC-371 accepted invocation authority and price catalogue', (harness) => {
  test('new span capability cannot upgrade a legacy replay or downgrade a new acceptance', async () => {
    const store = createObservationInvocationStore(harness.db, () => NOW)
    const old = acceptance('legacy-spans'),
      original = await store.accept(old)
    const upgraded = {
      ...old,
      spanCaptureContract: 'runtime-span-facts-v1' as const,
      spanCaptureSource: 'native-source',
    }
    expect(await store.accept(upgraded)).toEqual(original)
    expect(await Promise.all([store.accept(upgraded), store.accept(upgraded)])).toEqual([
      original,
      original,
    ])
    expect((await store.get(old.invocationId))!.spanCaptureContract).toBeUndefined()
    await expect(store.accept({ ...upgraded, agentRevision: 99 })).rejects.toThrow('changed')
    const current = { ...upgraded, invocationId: 'new-spans' },
      accepted = await store.accept(current)
    expect(accepted.spanCaptureContract).toBe('runtime-span-facts-v1')
    await expect(store.accept({ ...old, invocationId: 'new-spans' })).rejects.toThrow('changed')
  })
  function fixture() {
    let serial = 0,
      clock = NOW
    const prices = createObservationPriceStore(harness.db)
    const entries = [
      {
        registrationId: 'runtime',
        configurationRevision: 3,
        name: 'runtime',
        protocol: 'opencode' as const,
        model: 'model',
        enabled: true,
      },
    ]
    const pricing = createObservationPricing({
      store: prices,
      runtimes: { directory: async () => ({ runtimes: entries }) },
      now: () => NOW,
      newId: () => 'tariff-' + ++serial,
    })
    const invocations = createObservationInvocationStore(harness.db, () => clock)
    return {
      prices,
      entries,
      pricing,
      invocations,
      value: createInvocationValuation(invocations, prices),
      time: (next: number) => {
        clock = next
      },
    }
  }
  const valuation = (
    id: string,
    patch: Partial<Parameters<ReturnType<typeof createInvocationValuation>>[0]> = {},
  ) => ({
    invocationId: id,
    model: { provider: 'gateway', id: 'model' },
    condition: null,
    usage: { input: '1000000', output: '1000000', cacheRead: '0', cacheWrite: '0' },
    ...patch,
  })
  test('first acceptance fixes timestamp and catalogue across restart, deletion and identical concurrent retries', async () => {
    const f = fixture()
    await f.pricing.commands.save('runtime', inputPrice(), 'admin')
    f.time(NOW + 2000)
    const input = acceptance('local-one')
    const results = await Promise.all([f.invocations.accept(input), f.invocations.accept(input)])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ acceptedAt: NOW + 2000, priceBookRevision: 1 })
    f.entries.splice(0)
    const reopened = createObservationInvocationStore(harness.db, () => NOW + 999999)
    expect(await reopened.accept(input)).toEqual(results[0])
    expect(await reopened.get(input.invocationId)).toEqual(results[0])
    expect(await f.value(valuation(input.invocationId))).toMatchObject({
      currency: 'CNY',
      availability: 'priced',
      amountDecimal: '3.6',
      priceVersionId: 'tariff-1',
      completeness: 'complete',
    })
  })
  test('late publication cannot enter a frozen catalogue even if its effective time would match', async () => {
    const f = fixture()
    await f.pricing.commands.save('runtime', inputPrice(), 'admin')
    f.time(NOW + 5000)
    await f.invocations.accept(acceptance('frozen'))
    // Separate clocks model delayed publication/import and prove the revision cap,
    // independent of the normal UI restriction against past effective dates.
    await f.pricing.commands.save(
      'runtime',
      inputPrice({
        expectedRevision: 1,
        requestKey: 'tariff-request-2',
        effectiveFrom: new Date(NOW + 3000).toISOString(),
        rates: { input: '20', output: '30', cacheRead: '0', cacheWrite: '0' },
      }),
      'admin',
    )
    expect((await f.value(valuation('frozen'))).amountDecimal).toBe('3.6')
    await f.invocations.accept(acceptance('next'))
    expect((await f.value(valuation('next'))).amountDecimal).toBe('50')
  })
  test('an explicitly empty catalogue and unmatched models stay unpriced', async () => {
    const f = fixture()
    f.time(NOW + 5000)
    expect(await f.invocations.accept(acceptance('empty'))).toMatchObject({ priceBookRevision: 0 })
    await f.pricing.commands.save('runtime', inputPrice(), 'admin')
    expect(await f.value(valuation('empty'))).toMatchObject({
      availability: 'unpriced',
      amountDecimal: null,
    })
    await f.invocations.accept(acceptance('priced'))
    for (const patch of [{ model: null }, { model: { provider: null, id: 'model' } }]) {
      expect(await f.value(valuation('priced', patch))).toMatchObject({
        availability: 'model-unknown',
        amountDecimal: null,
      })
    }
    for (const patch of [
      { model: { provider: 'gateway', id: 'other-model' } },
      { condition: 'batch' },
      { model: { provider: 'other', id: 'model' } },
    ]) {
      expect(await f.value(valuation('priced', patch))).toMatchObject({
        availability: 'unpriced',
        amountDecimal: null,
      })
    }
    const changed = acceptance('changed')
    if (changed.authority.kind === 'local') changed.authority.runtime!.configurationRevision++
    await f.invocations.accept(changed)
    expect(await f.value(valuation('changed'))).toMatchObject({
      availability: 'unpriced',
      amountDecimal: null,
    })
  })
  test('CS execution authority is immutable and never reads local prices, including disconnected cases', async () => {
    const f = fixture(),
      input = { ...acceptance('hosted'), authority: platform }
    await f.pricing.commands.save('runtime', inputPrice(), 'admin')
    f.time(NOW + 2000)
    expect(await f.invocations.accept(input)).toMatchObject({
      authority: platform,
      priceBookRevision: null,
    })
    const noLocalPrice = createInvocationValuation(f.invocations, {
      ...f.prices,
      priceAt: async () => {
        throw new Error('hosted must never query local price')
      },
    })
    expect(await noLocalPrice(valuation('hosted'))).toEqual({
      currency: 'CNY',
      availability: 'platform-managed',
      amountDecimal: null,
      priceVersionId: null,
    })
    await expect(f.invocations.accept(acceptance('hosted'))).rejects.toMatchObject({
      code: 'invocation-conflict',
    })
    await expect(
      f.invocations.accept({ ...input, invocationId: 'duplicate-hosted-mapping' }),
    ).rejects.toMatchObject({ code: 'execution-already-mapped' })
    expect(await f.invocations.get('duplicate-hosted-mapping')).toBeUndefined()
    expect(
      await f.invocations.accept({
        ...input,
        invocationId: 'next-generation',
        authority: { ...platform, executionGeneration: 2 },
      }),
    ).toMatchObject({ priceBookRevision: null })
    expect(
      await f.invocations.accept({
        ...input,
        invocationId: 'other-installation',
        authority: { ...platform, sourceId: 'different-installation' },
      }),
    ).toMatchObject({ authority: { sourceId: 'different-installation' } })
    await expect(
      f.invocations.accept({ ...input, authority: { ...platform, sourceId: 'changed' } }),
    ).rejects.toMatchObject({ code: 'invocation-conflict' })
  })
  test('unknown registration stays unknown; explicit zero price and partial usage retain different meanings', async () => {
    const f = fixture()
    await f.invocations.accept({
      ...acceptance('unknown'),
      authority: { kind: 'local', runtime: null },
    })
    expect(await f.value(valuation('unknown'))).toMatchObject({
      availability: 'registration-unknown',
      amountDecimal: null,
    })
    await f.pricing.commands.save(
      'runtime',
      inputPrice({ rates: { input: '0', output: null, cacheRead: null, cacheWrite: null } }),
      'admin',
    )
    f.time(NOW + 2000)
    await f.invocations.accept(acceptance('zero'))
    expect(
      await f.value(
        valuation('zero', {
          usage: { input: '100', output: '0', cacheRead: '0', cacheWrite: '0' },
        }),
      ),
    ).toMatchObject({ amountDecimal: '0', completeness: 'complete' })
    expect(
      await f.value(
        valuation('zero', {
          usage: { input: '100', output: null, cacheRead: '0', cacheWrite: '0' },
        }),
      ),
    ).toMatchObject({ amountDecimal: '0', completeness: 'partial', missing: ['output'] })
  })
  test('changed acceptance and invalid metadata fail without replacing the original record', async () => {
    const f = fixture(),
      original = await f.invocations.accept(acceptance('stable'))
    await expect(
      f.invocations.accept({ ...acceptance('stable'), taskId: 'changed' }),
    ).rejects.toMatchObject({ code: 'invocation-conflict' })
    expect(await f.invocations.get('stable')).toEqual(original)
    for (const generation of [-1, 0]) {
      const id = 'invalid-' + generation
      await expect(
        f.invocations.accept({
          ...acceptance(id),
          authority: { ...platform, executionGeneration: generation },
        }),
      ).rejects.toMatchObject({ code: 'invalid-invocation' })
      expect(await f.invocations.get(id)).toBeUndefined()
    }
    await expect(f.value(valuation('missing'))).rejects.toMatchObject({
      code: 'invocation-not-found',
    })
  })
})
test('accepted contract never represents a local price catalogue for CS execution', () => {
  const raw = {
    ...acceptance('contract'),
    authority: platform,
    acceptedAt: NOW,
    priceBookRevision: 4,
  }
  expect(AcceptedObservationInvocationSchema.safeParse(raw).success).toBe(false)
  expect(
    AcceptedObservationInvocationSchema.safeParse({ ...raw, priceBookRevision: null }).success,
  ).toBe(true)
  expect(
    AcceptObservationInvocationSchema.safeParse({
      ...acceptance('contract'),
      authority: { kind: 'unknown' },
    }).success,
  ).toBe(false)
  const { sourceId: _source, ...legacyAuthority } = platform
  expect(
    AcceptObservationInvocationSchema.safeParse({
      ...acceptance('new'),
      authority: legacyAuthority,
    }).success,
  ).toBe(false)
  expect(
    AcceptedObservationInvocationSchema.parse({
      ...raw,
      authority: legacyAuthority,
      priceBookRevision: null,
    }).authority,
  ).toMatchObject({ kind: 'crewstation', sourceId: null })
})
