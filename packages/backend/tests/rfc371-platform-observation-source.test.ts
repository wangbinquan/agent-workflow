// RFC-371: hosted observations preserve CS projections and CNY values without local pricing.
import { expect, spyOn, test } from 'bun:test'
import { createCrewStationObservationSource } from '../src/modules/run-observability/infrastructure/crewstation/observationSource'
import { PlatformObservationPageSchema } from '../src/modules/run-observability/domain/platformObservation'
import nativeCapture from '../../shared/tests/fixtures/crewstation-native-capture-v2.json'

const projectId = '01a0bf5d-8f4b-7793-867c-efd7527b3861',
  taskId = '01a0bf5d-8f4b-7793-867c-efd7527b3862'
const identity = {
  projectId,
  taskId,
  subtaskId: '01a0bf5d-8f4b-7793-867c-efd7527b3863',
  executionId: '01a0bf5d-8f4b-7793-867c-efd7527b3864',
  executionGeneration: 2,
}
const at = '2026-09-28T00:00:00.000Z'
const counts = (input: string | null) => ({ input, cacheRead: '0', cacheWrite: '0', output: '0' })
const usage = {
  kind: 'usage',
  identity,
  sourceId: 'runner',
  recordId: 'meter',
  revision: 4,
  occurredAt: null,
  observedAt: at,
  adapterVersion: 'native-v1',
  modelRef: 'actual',
  reporting: 'cumulative',
  inclusion: 'self',
  coverage: 'complete',
  validity: 'valid',
  scope: {
    root: 'session',
    session: 'session',
    parentSession: null,
    ancestors: [],
    turn: 'turn',
    turnIndex: 0,
    level: 'self-total',
  },
  coveredThroughTurn: 0,
  usage: counts('130'),
  basis: { kind: 'native-session', lineageKey: 'native', baseline: counts('100') },
  projection: {
    projectionRevision: 3,
    observedRevision: 5,
    modelRevision: 5,
    contribution: counts('30'),
    coveredThrough: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    complete: false,
    issues: ['unexplained-decrease'],
  },
}
const valuation = {
  kind: 'valuation',
  identity,
  sourceId: 'runner',
  recordId: 'meter',
  revision: 7,
  occurredAt: null,
  observedAt: at,
  valuationId: 'value',
  valuationRevision: 7,
  usageRevision: 3,
  currency: 'CNY',
  completeness: 'partial',
  availability: 'priced',
  priceVersionRef: 'price-frozen',
  amountDecimal: '1.000009',
}
const page = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  capability: 'executionObservationsV1',
  mode: 'incremental',
  projectId,
  taskId,
  items: [usage, valuation],
  nextCursor: null,
  persistedThrough: 'opaque:committed',
  firstAvailableCursor: 'opaque:first',
  asOf: at,
  visibilityRevision: 3,
  costVisibility: 'project-members-and-services',
  gaps: [],
  ...patch,
})
const query = {
  projectId,
  taskId,
  mode: 'incremental' as const,
  after: 'opaque:+cursor/one',
  limit: 200,
}
function fixture(value: unknown, status = 200) {
  const seen: Array<{ url: URL; init: RequestInit }> = []
  let headers = 0
  return {
    seen,
    headers: () => headers,
    source: createCrewStationObservationSource({
      baseUrl: 'https://cs.example',
      headers: async () => {
        headers++
        return { 'x-fixture-identity': 'project' }
      },
      request: async (url, init) => {
        seen.push({ url, init })
        return Response.json(value, { status })
      },
    }),
  }
}

test('hosted usage keeps the reconciled contribution and independent authorized CNY revision', async () => {
  const f = fixture(page())
  const result = await f.source.read(query)
  expect(result as unknown).toEqual(page())
  expect(result.items[0]).toMatchObject({
    usage: counts('130'),
    projection: { contribution: counts('30'), modelRevision: 5 },
  })
  expect(result.items[1]).toMatchObject({
    amountDecimal: '1.000009',
    currency: 'CNY',
    valuationRevision: 7,
    usageRevision: 3,
  })
  expect(f.seen[0]!.url.pathname).toBe('/v3/business-tasks/' + taskId + '/observations')
  expect(f.seen[0]!.url.searchParams.get('after')).toBe(query.after)
  expect(f.seen[0]!.init.method).toBe('GET')
  expect(f.seen[0]!.init.signal).toBeInstanceOf(AbortSignal)
  const headers = new Headers(f.seen[0]!.init.headers)
  expect(headers.get('Accept')).toBe('application/vnd.crewstation.execution-observations.v2+json')
  expect(headers.get('x-fixture-identity')).toBe('project')
  await f.source.read(query)
  expect(f.headers()).toBe(2)
})

test('v2 preserves the raw CS capture projection and v1 rejects it', async () => {
  const body = page({
    schemaVersion: 2,
    capability: 'executionObservationsV2',
    items: [usage, nativeCapture, valuation],
  })
  expect((await fixture(body).source.read(query)) as unknown).toEqual(body)
  await expect(fixture(page({ items: [nativeCapture] })).source.read(query)).rejects.toMatchObject({
    code: 'invalid-response',
  })
  const mismatched = { ...nativeCapture, recordId: 'different-capture' }
  await expect(fixture({ ...body, items: [mismatched] }).source.read(query)).rejects.toMatchObject({
    code: 'invalid-response',
  })
  await expect(fixture({ ...body, schemaVersion: 3 }).source.read(query)).rejects.toMatchObject({
    code: 'invalid-response',
  })
})

test('only known v2 snapshot continuations restart after an old server rejects the cursor', async () => {
  for (const status of [400, 422]) {
    const source = fixture({}, status).source
    const continuation = {
      projectId,
      taskId,
      limit: 100,
      mode: 'snapshot' as const,
      snapshotId: 'v2:one',
      cursor: 'v2:next',
    }
    await expect(source.read({ ...continuation, expectedSchemaVersion: 2 })).rejects.toMatchObject({
      code: 'snapshot-required',
    })
    await expect(source.read({ ...continuation, expectedSchemaVersion: 1 })).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(source.read(continuation)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      source.read({ projectId, taskId, limit: 100, mode: 'snapshot', expectedSchemaVersion: 2 }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(source.read({ ...query, expectedSchemaVersion: 2 })).rejects.toMatchObject({
      code: 'unavailable',
    })
  }
})

test('opaque snapshot continuation is preserved and cannot silently become another snapshot', async () => {
  const snapshot = page({
    mode: 'snapshot',
    snapshotId: 'snapshot:one',
    snapshotThrough: 'opaque:committed',
    nextCursor: 'meter:two',
    expiresAt: '2026-09-28T00:30:00.000Z',
  })
  const f = fixture(snapshot)
  const request = {
    projectId,
    taskId,
    mode: 'snapshot' as const,
    snapshotId: 'snapshot:one',
    cursor: 'meter:one',
    limit: 100,
  }
  expect((await f.source.read(request)) as unknown).toEqual(snapshot)
  expect(f.seen[0]!.url.searchParams.get('snapshot')).toBe('true')
  expect(f.seen[0]!.url.searchParams.get('snapshotId')).toBe('snapshot:one')
  expect(f.seen[0]!.url.searchParams.get('cursor')).toBe('meter:one')
  expect(f.seen[0]!.url.searchParams.has('after')).toBe(false)
  await expect(f.source.read({ ...request, snapshotId: 'other' })).rejects.toMatchObject({
    code: 'invalid-response',
  })
  await expect(f.source.read({ ...request, cursor: undefined })).rejects.toThrow(
    'Snapshot continuation',
  )
  expect(
    PlatformObservationPageSchema.safeParse({ ...snapshot, snapshotThrough: 'drift' }).success,
  ).toBe(false)
})

test('empty pages carry visibility updates and unknown amounts remain null', async () => {
  const hidden = page({ costVisibility: 'hidden', visibilityRevision: 4, items: [] })
  expect((await fixture(hidden).source.read(query)) as unknown).toEqual(hidden)
  for (const availability of ['unpriced', 'not-authorized', 'pending']) {
    const value = page({
      items: [{ ...valuation, availability, priceVersionRef: null, amountDecimal: null }],
    })
    expect((await fixture(value).source.read(query)).items as unknown).toEqual(value.items)
  }
  expect(
    (await fixture(page({ items: [{ ...valuation, amountDecimal: '0' }] })).source.read(query))
      .items[0],
  ).toMatchObject({ amountDecimal: '0' })
})

for (const patch of [
  { items: [{ ...valuation, currency: 'USD' }] },
  { costVisibility: 'hidden' },
  { taskId: identity.subtaskId, items: [] },
  { projectId: identity.subtaskId, items: [] },
  { items: [{ ...usage, identity: { ...identity, taskId: identity.subtaskId } }] },
  { items: [{ ...usage, projection: { ...usage.projection, observedRevision: 3 } }] },
  { items: [{ ...usage, projection: { ...usage.projection, modelRevision: 6 } }] },
  {
    items: [
      { ...usage, projection: { ...usage.projection, contribution: counts(null), complete: true } },
    ],
  },
  {
    items: [{ ...valuation, availability: 'unpriced', priceVersionRef: null, amountDecimal: '0' }],
  },
])
  test(
    'invalid platform page cannot become locally priced data: ' + JSON.stringify(patch),
    async () => {
      await expect(fixture(page(patch)).source.read(query)).rejects.toMatchObject({
        code: 'invalid-response',
      })
    },
  )

for (const [status, code] of [
  [401, 'access-unavailable'],
  [403, 'access-unavailable'],
  [404, 'source-not-found'],
  [409, 'snapshot-required'],
  [410, 'snapshot-required'],
  [501, 'capability-unavailable'],
  [503, 'unavailable'],
] as const)
  test('platform HTTP failure remains explicit: ' + status, async () => {
    await expect(fixture({}, status).source.read(query)).rejects.toMatchObject({ code })
  })

test('network errors and malformed responses never return a manufactured zero page', async () => {
  const input = { baseUrl: 'https://cs.example', headers: async () => ({}) }
  await expect(
    createCrewStationObservationSource({
      ...input,
      request: async () => {
        throw new Error('offline')
      },
    }).read(query),
  ).rejects.toMatchObject({ code: 'unavailable' })
  await expect(
    createCrewStationObservationSource({
      ...input,
      request: async () => new Response('not json'),
    }).read(query),
  ).rejects.toMatchObject({ code: 'invalid-response' })
  const f = fixture(page()),
    controller = new AbortController()
  controller.abort(new Error('stop polling'))
  await expect(f.source.read({ ...query, signal: controller.signal })).rejects.toThrow(
    'stop polling',
  )
  expect(f.seen).toEqual([])
  await expect(f.source.read({ ...query, limit: 501 })).rejects.toThrow('page limit')
  expect(f.seen).toEqual([])
})

for (const stage of ['headers', 'request', 'body'] as const) {
  test(
    'caller cancellation interrupts a hanging ' + stage + ' phase with its original reason',
    async () => {
      const controller = new AbortController(),
        reason = new Error('cancel-' + stage)
      let calls = 0
      const hang = <T>(): Promise<T> => {
        controller.abort(reason)
        return new Promise(() => {})
      }
      const source = createCrewStationObservationSource({
        baseUrl: 'https://cs.example',
        headers: () =>
          stage === 'headers' ? hang<NonNullable<RequestInit['headers']>>() : Promise.resolve({}),
        request: async () => {
          calls++
          if (stage === 'request') return hang<Response>()
          const response = Response.json(page())
          if (stage === 'body')
            Object.defineProperty(response, 'json', { value: () => hang<unknown>() })
          return response
        },
      })
      await expect(source.read({ ...query, signal: controller.signal })).rejects.toBe(reason)
      expect(calls).toBe(stage === 'headers' ? 0 : 1)
    },
  )
  test('one deadline covers a hanging ' + stage + ' phase', async () => {
    const hang = <T>(): Promise<T> => new Promise(() => {})
    const source = createCrewStationObservationSource({
      baseUrl: 'https://cs.example',
      timeoutMs: 1,
      headers: () =>
        stage === 'headers' ? hang<NonNullable<RequestInit['headers']>>() : Promise.resolve({}),
      request: async () => {
        if (stage === 'request') return hang<Response>()
        const response = Response.json(page())
        if (stage === 'body')
          Object.defineProperty(response, 'json', { value: () => hang<unknown>() })
        return response
      },
    })
    await expect(source.read(query)).rejects.toMatchObject({ code: 'unavailable' })
  })
}

test('network failure during response body consumption stays unavailable', async () => {
  const source = createCrewStationObservationSource({
    baseUrl: 'https://cs.example',
    headers: async () => ({}),
    request: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('socket closed'))
          },
        }),
      ),
  })
  await expect(source.read(query)).rejects.toMatchObject({ code: 'unavailable' })
})

test('the referenced deadline is cancelled after success, HTTP failure and invalid body', async () => {
  const cancel = spyOn(globalThis, 'clearTimeout')
  try {
    await fixture(page()).source.read(query)
    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(fixture({}, 503).source.read(query)).rejects.toMatchObject({ code: 'unavailable' })
    expect(cancel).toHaveBeenCalledTimes(2)
    await expect(fixture({}).source.read(query)).rejects.toMatchObject({ code: 'invalid-response' })
    expect(cancel).toHaveBeenCalledTimes(3)
  } finally {
    cancel.mockRestore()
  }
})
