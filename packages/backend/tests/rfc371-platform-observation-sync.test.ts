// RFC-371: CS pages are durable canonical projections, never a second native usage stream.
import { expect, test } from 'bun:test'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { createPlatformObservationSync } from '../src/modules/run-observability/application/platformObservationSync'
import {
  PlatformObservationPageSchema,
  PlatformObservationSourceError,
  type PlatformObservation,
  type PlatformObservationPage,
} from '../src/modules/run-observability/domain/platformObservation'
import { hidePlatformAmount } from '../src/modules/run-observability/domain/platformSync'
import { createPlatformObservationStore } from '../src/modules/run-observability/infrastructure/platformObservationPersistence'
import type { PlatformObservationRequest } from '../src/modules/run-observability/ports/platformObservationSource'
import { describeEachProvider } from './helpers/eachProvider'
import nativeCapture from '../../shared/tests/fixtures/crewstation-native-capture-v2.json'

const binding = {
  sourceId: 'cs-installation-1',
  projectId: '01a0bf5d-8f4b-7793-867c-efd7527b3861',
  taskId: '01a0bf5d-8f4b-7793-867c-efd7527b3862',
}
const identity = {
  projectId: binding.projectId,
  taskId: binding.taskId,
  subtaskId: '01a0bf5d-8f4b-7793-867c-efd7527b3863',
  executionId: '01a0bf5d-8f4b-7793-867c-efd7527b3864',
  executionGeneration: 2,
}
const at = '2026-09-28T00:00:00.000Z',
  now = Date.parse(at)
const counts = (input: string | null) => ({ input, output: '0', cacheRead: '0', cacheWrite: '0' })
function usage(revision = 3, input = '30'): Extract<PlatformObservation, { kind: 'usage' }> {
  return {
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
    basis: { kind: 'native-session', lineageKey: 'lineage', baseline: counts('100') },
    projection: {
      projectionRevision: revision,
      observedRevision: 5,
      modelRevision: 5,
      contribution: counts(input),
      coveredThrough: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      complete: false,
      issues: ['unexplained-decrease'],
    },
  }
}
function valuation(
  revision = 7,
  usageRevision = 3,
  amount = '1.000009',
): Extract<PlatformObservation, { kind: 'valuation' }> {
  return {
    kind: 'valuation',
    identity,
    sourceId: 'runner',
    recordId: 'meter',
    revision,
    occurredAt: null,
    observedAt: at,
    valuationId: 'value',
    valuationRevision: revision,
    usageRevision,
    currency: 'CNY',
    completeness: 'partial',
    availability: 'priced',
    priceVersionRef: 'frozen-price',
    amountDecimal: amount,
  }
}
function page(
  items: PlatformObservation[] = [usage(), valuation()],
  patch: Record<string, unknown> = {},
): PlatformObservationPage {
  return PlatformObservationPageSchema.parse({
    schemaVersion: 1,
    capability: 'executionObservationsV1',
    mode: 'incremental',
    projectId: binding.projectId,
    taskId: binding.taskId,
    items,
    nextCursor: null,
    persistedThrough: 'committed:1',
    firstAvailableCursor: 'first:0',
    asOf: at,
    visibilityRevision: 3,
    costVisibility: 'project-members-and-services',
    gaps: [],
    ...patch,
  })
}
function snapshot(
  items: PlatformObservation[] = [usage(), valuation()],
  patch: Record<string, unknown> = {},
): PlatformObservationPage {
  return page(items, {
    mode: 'snapshot',
    snapshotId: 'snapshot-1',
    snapshotThrough: 'committed:1',
    expiresAt: '2026-09-28T00:10:00.000Z',
    ...patch,
  })
}
function fixture(db: ProviderNeutralDatabase) {
  let response: PlatformObservationPage | Error = snapshot()
  const requests: PlatformObservationRequest[] = []
  const store = createPlatformObservationStore(db)
  const sync = createPlatformObservationSync({
    store,
    now: () => now,
    source: {
      read: async (request) => {
        requests.push(request)
        if (response instanceof Error) throw response
        return response
      },
    },
  })
  return {
    store,
    sync: () => sync(binding),
    requests,
    set: (value: PlatformObservationPage | Error) => {
      response = value
    },
    rows: () => createPlatformObservationStore(db).records(binding, { limit: 100 }),
  }
}

describeEachProvider('RFC-371 durable platform observation sync', (harness) => {
  test('v1 upgrade, proof revisions and v2 rollback publish only complete generations', async () => {
    const f = fixture(harness.db)
    await f.sync()
    const cap = page([], {
      schemaVersion: 2,
      capability: 'executionObservationsV2',
      items: [nativeCapture as PlatformObservation],
    }).items.find((item) => item.kind === 'capture')
    if (!cap || cap.kind !== 'capture') throw new Error('Fixture must retain capture kind')
    const v2 = { schemaVersion: 2 as const, capability: 'executionObservationsV2' as const }
    f.set(page([cap], { ...v2, persistedThrough: 'committed:2' }))
    expect((await f.sync()).state).toMatchObject({
      mode: 'snapshot',
      status: 'syncing',
      schemaVersion: 2,
      costsReady: false,
    })
    expect((await f.rows()).items.some((item) => item.kind === 'capture')).toBe(false)
    f.set(snapshot([usage()], { ...v2, snapshotId: 'v2-snapshot', nextCursor: 'v2:next' }))
    await f.sync()
    expect((await f.rows()).items).toHaveLength(2)
    f.set(snapshot([cap, valuation()], { ...v2, snapshotId: 'v2-snapshot' }))
    expect((await f.sync()).state).toMatchObject({
      mode: 'incremental',
      status: 'ready',
      schemaVersion: 2,
    })
    expect(f.requests.at(-1)).toMatchObject({ expectedSchemaVersion: 2, cursor: 'v2:next' })
    expect((await f.rows()).items.find((item) => item.kind === 'capture')).toEqual(cap)
    f.set(
      page([{ ...cap, revision: cap.revision - 1 }], { ...v2, persistedThrough: 'committed:3' }),
    )
    await f.sync()
    expect((await f.rows()).items.find((item) => item.kind === 'capture')).toEqual(cap)
    const changed = {
      ...nativeCapture,
      capture: { ...nativeCapture.capture, state: 'partial', issues: ['native-owner-unresolved'] },
    }
    f.set(page([changed as PlatformObservation], { ...v2, persistedThrough: 'committed:4' }))
    expect((await f.sync()).state.error).toBe('revision-conflict')
    expect((await f.rows()).items.find((item) => item.kind === 'capture')).toEqual(cap)
    f.set(page([], { persistedThrough: 'committed:5' }))
    expect((await f.sync()).state).toMatchObject({ mode: 'snapshot', schemaVersion: 1 })
    expect((await f.rows()).items.some((item) => item.kind === 'capture')).toBe(true)
    f.set(snapshot([], { snapshotId: 'v1-again' }))
    expect((await f.sync()).state.status).toBe('ready')
    expect((await f.rows()).items).toEqual([])
  })

  test('snapshot downgrade errors discard staging but preserve the last published generation', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(page([], { schemaVersion: 2, capability: 'executionObservationsV2' }))
    await f.sync()
    f.set(
      snapshot([], {
        schemaVersion: 2,
        capability: 'executionObservationsV2',
        nextCursor: 'v2:next',
      }),
    )
    await f.sync()
    f.set(
      new PlatformObservationSourceError(
        'snapshot-required',
        'old server rejected v2 continuation',
      ),
    )
    expect((await f.sync()).state).toMatchObject({
      staging: null,
      mode: 'snapshot',
      schemaVersion: 2,
    })
    expect((await f.rows()).items).toHaveLength(2)
    f.set(snapshot([], { snapshotId: 'old-server-snapshot' }))
    expect((await f.sync()).state).toMatchObject({ schemaVersion: 1, status: 'ready' })
    expect(f.requests.at(-1)).not.toHaveProperty('cursor')
    expect(f.requests.at(-1)).not.toHaveProperty('snapshotId')
    expect((await f.rows()).items).toEqual([])
  })
  test('snapshot pages remain staging across reopen and commit one complete generation', async () => {
    const f = fixture(harness.db)
    f.set(snapshot([usage()], { nextCursor: 'snapshot:page2' }))
    expect((await f.sync()).state).toMatchObject({ cursor: null, status: 'syncing' })
    expect((await f.rows()).items).toEqual([])
    f.set(snapshot([valuation()]))
    const reopened = createPlatformObservationSync({
      store: createPlatformObservationStore(harness.db),
      now: () => now,
      source: {
        read: async (request) => {
          expect(request).toMatchObject({
            mode: 'snapshot',
            snapshotId: 'snapshot-1',
            cursor: 'snapshot:page2',
          })
          return snapshot([valuation()])
        },
      },
    })
    expect((await reopened(binding)).state).toMatchObject({
      cursor: 'committed:1',
      status: 'ready',
      staging: null,
    })
    const rows = (await f.rows()).items
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.kind === 'usage')).toEqual(usage())
    expect(rows.find((r) => r.kind === 'valuation')).toEqual(valuation())
  })

  test('usage and valuation revisions update independently; missing value never becomes zero', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(page([usage(4, '40')], { persistedThrough: 'committed:2' }))
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      availability: 'pending',
      amountDecimal: null,
      valuationRevision: 7,
    })
    f.set(page([valuation(8, 4, '0')], { persistedThrough: 'committed:3' }))
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      availability: 'priced',
      amountDecimal: '0',
      valuationRevision: 8,
    })
    // A repeated and late older projection cannot lower the accepted revision or add tokens.
    f.set(page([usage(), usage(4, '40'), valuation()], { persistedThrough: 'committed:4' }))
    await f.sync()
    const rows = (await f.rows()).items
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.kind === 'usage')).toMatchObject({
      usage: counts('130'),
      projection: { contribution: counts('40'), projectionRevision: 4 },
    })
    expect(rows.find((r) => r.kind === 'valuation')).toMatchObject({
      amountDecimal: '0',
      valuationRevision: 8,
    })
    expect(f.requests[1]).toMatchObject({ mode: 'incremental', after: 'committed:1' })
  })

  test('a future valuation is pending until its exact usage projection arrives', async () => {
    const f = fixture(harness.db)
    f.set(snapshot([valuation(9, 4)]))
    await f.sync()
    expect((await f.rows()).items[0]).toMatchObject({
      availability: 'pending',
      amountDecimal: null,
    })
    f.set(page([usage(4)], { persistedThrough: 'committed:2' }))
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toEqual(valuation(9, 4))
  })

  test('conflicting same-revision content rolls back the complete page and cursor', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(page([usage(4, '50'), valuation(7, 3, '99')], { persistedThrough: 'committed:2' }))
    expect((await f.sync()).state).toMatchObject({
      cursor: 'committed:1',
      error: 'revision-conflict',
    })
    expect((await f.rows()).items.find((r) => r.kind === 'usage')).toEqual(usage())
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toEqual(valuation())
  })

  test('a storage failure after writing state and items leaves no partial durable page', async () => {
    const f = fixture(harness.db)
    await expect(
      f.store.change(binding, async (tx) => {
        await tx.put('generation', usage())
        await tx.save({ ...tx.state, revision: 1, generation: 'generation', cursor: 'bad' })
        throw new Error('fault after cursor write')
      }),
    ).rejects.toThrow('fault after cursor write')
    expect(await f.store.state(binding)).toMatchObject({
      revision: 0,
      cursor: null,
      generation: null,
    })
    expect((await f.rows()).items).toEqual([])
  })

  test('empty visibility changes immediately hide old money and force a complete refresh', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(
      page([], {
        visibilityRevision: 4,
        costVisibility: 'hidden',
        persistedThrough: 'committed:2',
      }),
    )
    await f.sync()
    expect((await f.rows()).state).toMatchObject({
      mode: 'snapshot',
      cursor: 'committed:1',
      costsReady: false,
    })
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      amountDecimal: null,
      availability: 'not-authorized',
    })
    f.set(
      snapshot([usage(), hidePlatformAmount(valuation(), 'not-authorized')], {
        visibilityRevision: 4,
        costVisibility: 'hidden',
        snapshotId: 'hidden',
      }),
    )
    await f.sync()
    f.set(page([], { visibilityRevision: 5 }))
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      amountDecimal: null,
      availability: 'pending',
    })
    f.set(snapshot([usage()], { visibilityRevision: 5, snapshotId: 'visible', nextCursor: 'last' }))
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      amountDecimal: null,
    })
    f.set(snapshot([valuation()], { visibilityRevision: 5, snapshotId: 'visible' }))
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toEqual(valuation())
  })

  test('a visibility change midway through a snapshot discards staging and keeps the old usage view', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(new PlatformObservationSourceError('snapshot-required', 'expired cursor'))
    await f.sync()
    f.set(snapshot([usage(4, '90')], { snapshotId: 'new', nextCursor: 'page2' }))
    await f.sync()
    f.set(snapshot([], { snapshotId: 'new', visibilityRevision: 4, costVisibility: 'hidden' }))
    await f.sync()
    expect((await f.rows()).state).toMatchObject({ mode: 'snapshot', staging: null })
    expect((await f.rows()).items.find((r) => r.kind === 'usage')).toEqual(usage())
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      amountDecimal: null,
    })
    f.set(
      snapshot([usage(5, '12')], {
        snapshotId: 'replacement',
        visibilityRevision: 4,
        costVisibility: 'hidden',
      }),
    )
    await f.sync()
    expect((await f.rows()).items).toEqual([usage(5, '12')])
  })

  test('offline retains the last view and cursor; access recovery requires a new snapshot', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(new PlatformObservationSourceError('unavailable', 'offline'))
    await f.sync()
    expect((await f.rows()).state).toMatchObject({
      status: 'failed',
      cursor: 'committed:1',
      error: 'unavailable',
    })
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toEqual(valuation())
    f.set(new PlatformObservationSourceError('access-unavailable', 'changed'))
    await f.sync()
    expect((await f.rows()).state).toMatchObject({ mode: 'snapshot', costsReady: false })
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toMatchObject({
      amountDecimal: null,
    })
    f.set(snapshot())
    await f.sync()
    expect((await f.rows()).items.find((r) => r.kind === 'valuation')).toEqual(valuation())
  })

  test('expired snapshots and committed gaps restart without clearing the last complete view', async () => {
    const f = fixture(harness.db)
    await f.sync()
    f.set(page([], { gaps: [{ after: 'committed:1', through: 'committed:2', reason: 'expired' }] }))
    await f.sync()
    f.set(snapshot([], { expiresAt: at }))
    await f.sync()
    expect((await f.rows()).state).toMatchObject({
      mode: 'snapshot',
      staging: null,
      error: 'snapshot-expired',
      cursor: 'committed:1',
    })
    expect((await f.rows()).items.find((r) => r.kind === 'usage')).toEqual(usage())
  })

  test('a missing staged snapshot restarts after reopen without treating a missing task as unsupported', async () => {
    const f = fixture(harness.db)
    f.set(snapshot([usage()], { nextCursor: 'page2' }))
    await f.sync()
    const reopened = createPlatformObservationSync({
      store: createPlatformObservationStore(harness.db),
      now: () => now,
      source: {
        read: async (request) => {
          expect(request).toMatchObject({ snapshotId: 'snapshot-1', cursor: 'page2' })
          throw new PlatformObservationSourceError('source-not-found', 'snapshot no longer exists')
        },
      },
    })
    expect((await reopened(binding)).state).toMatchObject({
      mode: 'snapshot',
      staging: null,
      error: 'source-not-found',
    })
    f.set(snapshot([usage(), valuation()], { snapshotId: 'replacement' }))
    await f.sync()
    expect(f.requests.at(-1)).not.toHaveProperty('snapshotId')
    expect((await f.rows()).items).toHaveLength(2)
    const missing = fixture(harness.db)
    const other = { ...binding, sourceId: 'fresh-missing-task' }
    const unavailable = createPlatformObservationSync({
      store: missing.store,
      source: {
        read: async () => {
          throw new PlatformObservationSourceError('source-not-found', 'task not found')
        },
      },
    })
    expect((await unavailable(other)).state).toMatchObject({
      status: 'failed',
      error: 'source-not-found',
      staging: null,
    })
  })

  test('snapshot identity and watermark changes never publish a mixed view', async () => {
    const f = fixture(harness.db)
    f.set(snapshot([usage()], { nextCursor: 'page2' }))
    await f.sync()
    f.set(snapshot([valuation()], { snapshotId: 'other' }))
    await f.sync()
    expect((await f.rows()).state).toMatchObject({ error: 'page-conflict', generation: null })
    expect((await f.rows()).items).toEqual([])
  })

  test('query continuation belongs to one source generation and state revision', async () => {
    const f = fixture(harness.db)
    await f.sync()
    const first = await f.store.records(binding, { limit: 1 })
    const second = await f.store.records(binding, { limit: 1, after: first.nextCursor })
    expect([...first.items, ...second.items]).toHaveLength(2)
    f.set(page([], { persistedThrough: 'committed:2' }))
    await f.sync()
    await expect(f.store.records(binding, { limit: 1, after: first.nextCursor })).rejects.toThrow(
      'restart pagination',
    )
  })

  test('cold readers and generation replacement always return a single complete view', async () => {
    const f = fixture(harness.db)
    const expected: Record<string, string> = {
      'committed:1': '30',
      'committed:2': '40',
      'committed:3': '50',
    }
    const read = async () => {
      const value = await f.rows()
      if (value.state.generation === null) {
        expect(value.items).toEqual([])
        return
      }
      expect(value.items).toHaveLength(2)
      const count = expected[value.state.cursor!]
      expect(count).toBeDefined()
      expect(value.items.find((r) => r.kind === 'usage')).toMatchObject({
        projection: { contribution: counts(count!) },
      })
      expect(value.items.find((r) => r.kind === 'valuation')).toMatchObject({
        amountDecimal: count,
      })
    }
    const write = async () => {
      for (const [index, count] of ['30', '40', '50'].entries()) {
        if (index !== 0) {
          f.set(new PlatformObservationSourceError('snapshot-required', 'refresh'))
          await f.sync()
        }
        f.set(
          snapshot([usage(index + 3, count), valuation(index + 7, index + 3, count)], {
            snapshotId: 'generation-' + index,
            snapshotThrough: 'committed:' + (index + 1),
            persistedThrough: 'committed:' + (index + 1),
          }),
        )
        await f.sync()
        await read()
      }
    }
    await Promise.all([
      write(),
      ...Array.from({ length: 8 }, async () => {
        for (let n = 0; n < 4; n++) await read()
      }),
    ])
    await read()
  })

  test('installation identities separate otherwise identical native executions', async () => {
    const f = fixture(harness.db)
    await f.sync()
    expect(
      (await f.store.records({ ...binding, sourceId: 'different-installation' }, { limit: 20 }))
        .items,
    ).toEqual([])
  })

  test('a slower request cannot overwrite a newer committed page', async () => {
    const f = fixture(harness.db)
    await f.sync()
    let release!: (page: PlatformObservationPage) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<PlatformObservationPage>((resolve) => {
      release = resolve
    })
    const slow = createPlatformObservationSync({
      store: f.store,
      now: () => now,
      source: {
        read: async () => {
          started()
          return pending
        },
      },
    })(binding)
    await entered
    f.set(page([usage(4, '40')], { persistedThrough: 'committed:2' }))
    await f.sync()
    release(page([usage(4, '90')], { persistedThrough: 'obsolete' }))
    expect((await slow).outcome).toBe('concurrent')
    expect((await f.rows()).state.cursor).toBe('committed:2')
    expect((await f.rows()).items.find((r) => r.kind === 'usage')).toMatchObject({
      projection: { contribution: counts('40') },
    })
  })

  test('cancellation does not record a source failure or advance the cursor', async () => {
    const f = fixture(harness.db)
    await f.sync()
    const before = await f.store.state(binding),
      controller = new AbortController(),
      reason = new Error('stop')
    const sync = createPlatformObservationSync({
      store: f.store,
      source: {
        read: async () => {
          controller.abort(reason)
          return page()
        },
      },
    })
    await expect(sync(binding, { signal: controller.signal })).rejects.toBe(reason)
    expect(await f.store.state(binding)).toEqual(before)
  })
})
