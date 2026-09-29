// RFC-371: frozen execution identity selects one ledger, even while CS is offline.
import { expect, test } from 'bun:test'
import type { AcceptObservationInvocation, ObservationMeasurement } from '@agent-workflow/shared'
import { observationInvocations } from '../src/db/schema'
import { createInvocationObservationQuery } from '../src/modules/run-observability/application/invocationObservations'
import { createPlatformObservationSync } from '../src/modules/run-observability/application/platformObservationSync'
import { createUsageIngestion } from '../src/modules/run-observability/application/usageIngestion'
import {
  PlatformObservationSourceError,
  type PlatformObservation,
  type PlatformObservationPage,
  type PlatformObservationV1Page,
} from '../src/modules/run-observability/domain/platformObservation'
import { createObservationInvocationStore } from '../src/modules/run-observability/infrastructure/invocationPersistence'
import { createPlatformObservationStore } from '../src/modules/run-observability/infrastructure/platformObservationPersistence'
import { createUsageLedgerStore } from '../src/modules/run-observability/infrastructure/usageLedgerPersistence'
import type { InvocationObservationQuery } from '../src/modules/run-observability/ports/invocationObservations'
import { describeEachProvider } from './helpers/eachProvider'

const at = '2026-09-28T00:00:00.000Z',
  now = Date.parse(at)
const binding = {
  sourceId: 'cs-installation',
  projectId: '01a0bf5d-8f4b-7793-867c-efd7527b3861',
  taskId: '01a0bf5d-8f4b-7793-867c-efd7527b3862',
}
const identity = {
  projectId: binding.projectId,
  taskId: binding.taskId,
  subtaskId: '01a0bf5d-8f4b-7793-867c-efd7527b3863',
  executionId: '01a0bf5d-8f4b-7793-867c-efd7527b3864',
  executionGeneration: 1,
}
const authority: Extract<AcceptObservationInvocation['authority'], { kind: 'crewstation' }> = {
  kind: 'crewstation',
  ...binding,
  subtaskId: identity.subtaskId,
  executionResourceId: identity.executionId,
  executionGeneration: 1,
}
const acceptance = (invocationId = 'invocation'): AcceptObservationInvocation => ({
  invocationId,
  taskId: 'aw-task',
  nodeRunId: 'aw-node',
  agentId: 'aw-agent',
  agentRevision: 7,
  purpose: 'task',
  authority,
})
const counts = (input: string | null) => ({ input, output: '0', cacheRead: '0', cacheWrite: '0' })
const usage = (
  patch: Partial<Extract<PlatformObservation, { kind: 'usage' }>> = {},
): Extract<PlatformObservation, { kind: 'usage' }> => ({
  kind: 'usage',
  identity,
  sourceId: 'runner-source',
  recordId: 'meter',
  revision: 1,
  occurredAt: null,
  observedAt: at,
  adapterVersion: 'fixture/1',
  modelRef: 'opaque-model-ref',
  reporting: 'cumulative',
  inclusion: 'self',
  coverage: 'complete',
  validity: 'valid',
  scope: null,
  coveredThroughTurn: null,
  basis: { kind: 'native-session', lineageKey: 'lineage', baseline: counts('100') },
  usage: counts('130'),
  projection: {
    projectionRevision: 3,
    observedRevision: 1,
    contribution: counts('30'),
    coveredThrough: null,
    complete: true,
    issues: [],
  },
  ...patch,
})
const valuation = (): Extract<
  PlatformObservation,
  { kind: 'valuation'; availability: 'priced' }
> => ({
  kind: 'valuation',
  identity,
  sourceId: 'runner-source',
  recordId: 'meter',
  revision: 7,
  occurredAt: null,
  observedAt: at,
  valuationId: 'platform-value',
  valuationRevision: 7,
  usageRevision: 3,
  currency: 'CNY',
  completeness: 'complete',
  availability: 'priced',
  priceVersionRef: 'platform-price',
  amountDecimal: '0.000000000001',
})
const snapshot = (items: PlatformObservationV1Page['items']): PlatformObservationPage => ({
  schemaVersion: 1,
  capability: 'executionObservationsV1',
  projectId: binding.projectId,
  taskId: binding.taskId,
  mode: 'snapshot',
  items,
  nextCursor: null,
  persistedThrough: 'committed:1',
  firstAvailableCursor: 'first:0',
  asOf: at,
  visibilityRevision: 0,
  costVisibility: 'project-members-and-services',
  gaps: [],
  snapshotId: 'snapshot-1',
  snapshotThrough: 'committed:1',
  expiresAt: '2026-09-28T00:10:00.000Z',
})
const localMeasurement = (patch: Partial<ObservationMeasurement> = {}): ObservationMeasurement => ({
  schemaVersion: 1,
  invocationId: 'invocation',
  taskId: 'aw-task',
  nodeRunId: 'aw-node',
  agentId: 'aw-agent',
  recordId: 'meter',
  revision: 1,
  occurredAt: null,
  observedAt: now,
  model: null,
  adapterVersion: 'fixture/1',
  reporting: 'delta',
  inclusion: 'self',
  coverage: 'complete',
  validity: 'valid',
  basis: { kind: 'invocation' },
  usage: counts('30'),
  ...patch,
})
async function all(query: InvocationObservationQuery, invocationId = 'invocation') {
  const pages = []
  let after: string | undefined
  for (let step = 0; step < 100; step++) {
    const page = await query.read({ invocationId, limit: 1, ...(after ? { after } : {}) })
    pages.push(page)
    if (!page.nextCursor) return pages
    after = page.nextCursor
  }
  throw new Error('Invocation query did not terminate')
}

describeEachProvider('RFC-371 invocation observation authority routing', (harness) => {
  function fixture() {
    const invocations = createObservationInvocationStore(harness.db, () => now),
      platform = createPlatformObservationStore(harness.db),
      local = createUsageLedgerStore(harness.db)
    return {
      invocations,
      platform,
      local,
      query: createInvocationObservationQuery({ invocations, platform, local }),
      async sync(response: PlatformObservationPage | Error, source = binding) {
        return createPlatformObservationSync({
          store: platform,
          now: () => now,
          source: {
            read: async () => {
              if (response instanceof Error) throw response
              return response
            },
          },
        })(source)
      },
      async ingest(measurements: ObservationMeasurement[]) {
        await createUsageIngestion(local).ingest({
          sourceId: 'local',
          expectedCursor: null,
          nextCursor: 'page:1',
          events: measurements.map((measurement, i) => ({ eventId: String(i), measurement })),
        })
      },
    }
  }

  test('standalone reads only its accepted invocation with no platform dependency', async () => {
    const f = fixture()
    await f.invocations.accept({ ...acceptance(), authority: { kind: 'local', runtime: null } })
    await f.ingest([
      localMeasurement(),
      localMeasurement({ recordId: 'other-invocation', invocationId: 'other' }),
      localMeasurement({ recordId: 'other-agent', agentId: 'other' }),
      localMeasurement({ recordId: 'other-node', nodeRunId: 'other' }),
      localMeasurement({ recordId: 'other-task', taskId: 'other' }),
    ])
    const query = createInvocationObservationQuery({
      ...f,
      platform: {
        records: async () => {
          throw new Error('standalone must not read CS')
        },
      },
    })
    const pages = await all(query)
    const rows = pages.flatMap((p) => [...p.items])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ contribution: counts('30') })
    expect(pages[0]).toMatchObject({
      authority: 'local',
      consistency: 'live-page',
      invocation: { agentId: 'aw-agent', agentRevision: 7 },
    })
    expect(pages.some((p) => p.items.length === 0)).toBe(true)
  })

  test('hosted reads exact installation and execution generation without local fallback or baseline subtraction', async () => {
    const f = fixture()
    await f.invocations.accept(acceptance())
    await f.sync(
      snapshot([
        usage(),
        valuation(),
        usage({ identity: { ...identity, executionGeneration: 2 } }),
        usage({ identity: { ...identity, subtaskId: '01a0bf5d-8f4b-7793-867c-efd7527b3865' } }),
        usage({ identity: { ...identity, executionId: '01a0bf5d-8f4b-7793-867c-efd7527b3866' } }),
      ]),
    )
    await f.sync(
      snapshot([usage({ projection: { ...usage().projection, contribution: counts('999') } })]),
      { ...binding, sourceId: 'other-installation' },
    )
    const query = createInvocationObservationQuery({
      ...f,
      local: {
        records: async () => {
          throw new Error('hosted must not read local usage')
        },
      },
    })
    const pages = await all(query),
      rows = pages.flatMap((p) => [...p.items])
    expect(rows).toHaveLength(2)
    expect(rows).toContainEqual(usage())
    expect(rows).toContainEqual(valuation())
    expect(pages[0]).toMatchObject({
      authority: 'crewstation',
      source: 'bound',
      state: { status: 'ready', binding },
      invocation: { taskId: 'aw-task', agentId: 'aw-agent', agentRevision: 7 },
    })
    expect(pages.reduce((count, page) => count + page.scanned, 0)).toBe(5)
    expect(pages.some((p) => p.items.length === 0)).toBe(true)
    await f.sync(new PlatformObservationSourceError('unavailable', 'offline'))
    const offline = await query.read({ invocationId: 'invocation', limit: 500 })
    expect(offline).toMatchObject({
      authority: 'crewstation',
      state: { status: 'failed', error: 'unavailable', asOf: at },
    })
    expect(offline.items).toEqual(expect.arrayContaining([usage(), valuation()]))
  })

  test('late valuations stay separate; hidden amounts and explicit zero retain platform meanings', async () => {
    const f = fixture()
    await f.invocations.accept(acceptance())
    await f.sync(snapshot([usage()]))
    const incremental = (
      items: PlatformObservationV1Page['items'],
      visibilityRevision = 0,
    ): PlatformObservationPage => ({
      schemaVersion: 1,
      capability: 'executionObservationsV1',
      projectId: binding.projectId,
      taskId: binding.taskId,
      mode: 'incremental',
      items,
      nextCursor: null,
      persistedThrough: 'committed:' + (2 + visibilityRevision),
      firstAvailableCursor: 'first:0',
      asOf: at,
      visibilityRevision,
      costVisibility: visibilityRevision ? 'hidden' : 'project-members-and-services',
      gaps: [],
    })
    expect((await f.query.read({ invocationId: 'invocation', limit: 100 })).items).toEqual([
      usage(),
    ])
    await f.sync(incremental([{ ...valuation(), amountDecimal: '0' }]))
    let page = await f.query.read({ invocationId: 'invocation', limit: 100 })
    expect(page.items).toHaveLength(2)
    expect(page.items).toContainEqual({ ...valuation(), amountDecimal: '0' })
    await f.sync(incremental([], 1))
    page = await f.query.read({ invocationId: 'invocation', limit: 100 })
    expect(page.items).toContainEqual(usage())
    expect(page.items).toContainEqual({
      ...valuation(),
      amountDecimal: null,
      availability: 'not-authorized',
      priceVersionRef: null,
      completeness: 'unknown',
    })
  })

  test('cursors cannot cross invocations or platform revisions', async () => {
    const f = fixture()
    await f.invocations.accept(acceptance())
    await f.invocations.accept({
      ...acceptance('other'),
      authority: { ...authority, executionGeneration: 2 },
    })
    await f.sync(snapshot([usage(), valuation()]))
    const first = await f.query.read({ invocationId: 'invocation', limit: 1 })
    expect(first.nextCursor).toBeDefined()
    await expect(
      f.query.read({ invocationId: 'other', limit: 1, after: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'page-conflict' })
    for (const after of ['', 'not-json', '[1]', JSON.stringify([1, 'different', 'cursor'])])
      await expect(
        f.query.read({ invocationId: 'invocation', limit: 1, after }),
      ).rejects.toMatchObject({ code: 'page-conflict' })
    await f.sync(new PlatformObservationSourceError('unavailable', 'offline'))
    await expect(
      f.query.read({ invocationId: 'invocation', limit: 1, after: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'page-conflict' })
  })

  test('legacy unbound and unsynchronized hosted invocations are explicit unknown states', async () => {
    const f = fixture(),
      { sourceId: _source, ...legacy } = authority
    await harness.db
      .insert(observationInvocations)
      .values({
        id: 'legacy',
        taskId: 'aw-task',
        canonicalExecution: 'legacy-key',
        fingerprint: 'legacy-fingerprint',
        document: JSON.stringify({
          ...acceptance('legacy'),
          authority: legacy,
          acceptedAt: now,
          priceBookRevision: null,
        }),
      })
      .run()
    const query = createInvocationObservationQuery({
      invocations: f.invocations,
      local: {
        records: async () => {
          throw new Error('legacy must not read local data')
        },
      },
      platform: {
        records: async () => {
          throw new Error('legacy must not choose the current platform')
        },
      },
    })
    expect(await query.read({ invocationId: 'legacy', limit: 50 })).toMatchObject({
      authority: 'crewstation',
      source: 'legacy-unbound',
      state: null,
      items: [],
      invocation: { authority: { sourceId: null } },
    })
    await f.invocations.accept(acceptance())
    expect(await f.query.read({ invocationId: 'invocation', limit: 50 })).toMatchObject({
      authority: 'crewstation',
      source: 'bound',
      items: [],
      state: { status: 'initial', asOf: null, generation: null },
    })
  })

  test('missing invocation and invalid page sizes fail without reading a ledger', async () => {
    const f = fixture()
    await expect(f.query.read({ invocationId: 'missing', limit: 100 })).rejects.toMatchObject({
      code: 'invocation-not-found',
    })
    for (const limit of [0, -1, 501, 1.5, NaN])
      await expect(f.query.read({ invocationId: 'missing', limit })).rejects.toBeInstanceOf(
        RangeError,
      )
  })
})
