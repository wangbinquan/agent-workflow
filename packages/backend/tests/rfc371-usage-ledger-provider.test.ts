// RFC-371: a failed page must never advance its durable cursor or partially add tokens.
import { expect, test } from 'bun:test'
import type { ObservationIngest, ObservationMeasurement } from '@agent-workflow/shared'
import { createUsageIngestion } from '../src/modules/run-observability/application/usageIngestion'
import { createUsageLedgerStore } from '../src/modules/run-observability/infrastructure/usageLedgerPersistence'
import { describeEachProvider } from './helpers/eachProvider'

function usage(patch: Partial<ObservationMeasurement> = {}): ObservationMeasurement {
  return {
    schemaVersion: 1,
    invocationId: 'attempt',
    recordId: 'step',
    revision: 1,
    taskId: 'task',
    nodeRunId: null,
    agentId: null,
    occurredAt: null,
    observedAt: 1,
    model: null,
    adapterVersion: 'fixture-v1',
    reporting: 'cumulative',
    inclusion: 'self',
    coverage: 'complete',
    validity: 'valid',
    basis: { kind: 'invocation' },
    usage: { input: '100', output: '10', cacheRead: '0', cacheWrite: '0' },
    ...patch,
  }
}
function page(patch: Partial<ObservationIngest> = {}): ObservationIngest {
  return {
    sourceId: 'stream',
    expectedCursor: null,
    nextCursor: 'committed:1',
    events: [{ eventId: 'event-1', measurement: usage() }],
    ...patch,
  }
}

describeEachProvider('RFC-371 durable usage ledger', (harness) => {
  for (const example of [
    {
      name: 'late actual model',
      patch: { model: { provider: 'native', id: 'actual' } },
      expected: '100',
      complete: true,
    },
    {
      name: 'actual model with rejected decrease',
      patch: {
        model: { provider: 'native', id: 'actual' },
        usage: { input: '90', output: '10', cacheRead: '0', cacheWrite: '0' },
      },
      expected: '100',
      complete: false,
    },
    {
      name: 'invalid final',
      patch: {
        validity: 'invalid-final' as const,
        usage: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
      },
      expected: '100',
      complete: false,
    },
    {
      name: 'missing count',
      patch: { usage: { input: null, output: '10', cacheRead: '0', cacheWrite: '0' } },
      expected: '100',
      complete: false,
    },
    {
      name: 'unexplained decrease',
      patch: { usage: { input: '90', output: '10', cacheRead: '0', cacheWrite: '0' } },
      expected: '100',
      complete: false,
    },
    {
      name: 'explicit correction',
      patch: {
        validity: 'correction' as const,
        usage: { input: '90', output: '10', cacheRead: '0', cacheWrite: '0' },
      },
      expected: '90',
      complete: true,
    },
  ]) {
    test('reverse delivery matches revision order for ' + example.name, async () => {
      const store = createUsageLedgerStore(harness.db),
        ingest = createUsageIngestion(store)
      const evidence = [usage(), usage({ ...example.patch, revision: 2 })]
      for (const [sourceId, order] of [
        ['forward', evidence],
        ['reverse', [...evidence].reverse()],
      ] as const) {
        let cursor: string | null = null
        for (const item of order) {
          const nextCursor = 'page:' + item.revision
          await ingest.ingest(
            page({
              sourceId,
              expectedCursor: cursor,
              nextCursor,
              events: [{ eventId: 'event:' + item.revision, measurement: item }],
            }),
          )
          cursor = nextCursor
        }
      }
      const rows = (await store.records('task', { limit: 20 })).items
      expect(
        (await createUsageLedgerStore(harness.db).records('task', { limit: 20 })).items,
      ).toEqual(rows)
      const forward = rows.find((row) => row.sourceId === 'forward')!,
        reverse = rows.find((row) => row.sourceId === 'reverse')!
      expect({ ...forward, sourceId: 'same' }).toEqual({ ...reverse, sourceId: 'same' })
      if (example.patch.model) {
        expect(reverse.measurement.model).toEqual(example.patch.model)
        expect(reverse.modelRevision).toBe(2)
      }
      expect(reverse).toMatchObject({
        contribution: { input: example.expected },
        complete: example.complete,
        observedRevision: 2,
      })
    })
  }

  test('restart and reverse delivery never reuse rejected initial counters', async () => {
    const evidence = [
      usage({
        validity: 'invalid-final',
        usage: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
      }),
      usage({
        revision: 2,
        coverage: 'partial',
        usage: { input: null, output: '8', cacheRead: '0', cacheWrite: '0' },
      }),
    ]
    for (const [sourceId, order] of [
      ['forward', evidence],
      ['reverse', [...evidence].reverse()],
    ] as const) {
      let cursor: string | null = null
      for (const item of order) {
        const reopened = createUsageLedgerStore(harness.db)
        const nextCursor = 'page:' + item.revision
        await createUsageIngestion(reopened).ingest(
          page({
            sourceId,
            expectedCursor: cursor,
            nextCursor,
            events: [{ eventId: 'event:' + item.revision, measurement: item }],
          }),
        )
        cursor = nextCursor
      }
    }
    const rows = (await createUsageLedgerStore(harness.db).records('task', { limit: 20 })).items
    const forward = rows.find((row) => row.sourceId === 'forward')!,
      reverse = rows.find((row) => row.sourceId === 'reverse')!
    expect({ ...forward, sourceId: 'same' }).toEqual({ ...reverse, sourceId: 'same' })
    expect(reverse).toMatchObject({
      contribution: { input: null, output: '8' },
      complete: false,
      observedRevision: 2,
    })
  })

  test('replay, revision replacement and restart keep a single contribution', async () => {
    const store = createUsageLedgerStore(harness.db),
      ingest = createUsageIngestion(store)
    expect(await ingest.ingest(page())).toMatchObject({ applied: 1, cursor: 'committed:1' })
    expect(await ingest.ingest(page())).toMatchObject({ duplicate: 1, applied: 0 })
    const updated = page({
      expectedCursor: 'committed:1',
      nextCursor: 'committed:2',
      events: [
        {
          eventId: 'event-2',
          measurement: usage({
            revision: 2,
            usage: { input: '130', output: '10', cacheRead: '0', cacheWrite: '0' },
          }),
        },
      ],
    })
    await ingest.ingest(updated)
    const reopened = createUsageLedgerStore(harness.db)
    expect(await reopened.cursor('stream')).toBe('committed:2')
    expect((await reopened.records('task', { limit: 20 })).items).toHaveLength(1)
    expect((await reopened.records('task', { limit: 20 })).items[0]?.contribution.input).toBe('130')
    expect((await reopened.records('unrelated', { limit: 20 })).items).toHaveLength(0)
  })

  test('conflicting event or revision rolls back the entire page and leaves the cursor', async () => {
    const store = createUsageLedgerStore(harness.db),
      ingest = createUsageIngestion(store)
    await ingest.ingest(page())
    for (const eventId of ['event-1', 'different-event-same-revision']) {
      const batch = page({
        expectedCursor: 'committed:1',
        nextCursor: 'committed:2',
        events: [
          { eventId: 'another-meter', measurement: usage({ recordId: 'another' }) },
          {
            eventId,
            measurement: usage({
              usage: { input: '999', output: null, cacheRead: null, cacheWrite: null },
            }),
          },
        ],
      })
      await expect(ingest.ingest(batch)).rejects.toMatchObject({
        code: eventId === 'event-1' ? 'event-conflict' : 'revision-conflict',
      })
      expect(await store.cursor('stream')).toBe('committed:1')
      expect((await store.records('task', { limit: 20 })).items).toHaveLength(1)
    }
  })

  test('a fault after checkpoint write rolls back both audit and contribution', async () => {
    const store = createUsageLedgerStore(harness.db)
    const broken = createUsageIngestion({
      ...store,
      change: (id, work) =>
        store.change(id, (scope) =>
          work({
            ...scope,
            advance: async (cursor) => {
              await scope.advance(cursor)
              throw new Error('checkpoint fault')
            },
          }),
        ),
    })
    await expect(broken.ingest(page())).rejects.toThrow('checkpoint fault')
    expect(await store.cursor('stream')).toBeNull()
    expect((await store.records('task', { limit: 20 })).items).toHaveLength(0)
    expect(await createUsageIngestion(store).ingest(page())).toMatchObject({
      applied: 1,
      duplicate: 0,
    })
  })

  test('competing pages serialize their source checkpoint and remain separately replayable', async () => {
    const store = createUsageLedgerStore(harness.db),
      ingest = createUsageIngestion(store)
    const pages = [
      page(),
      page({
        nextCursor: 'other:1',
        events: [{ eventId: 'other', measurement: usage({ recordId: 'other' }) }],
      }),
    ]
    const results = await Promise.allSettled(pages.map((input) => ingest.ingest(input)))
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
    for (const row of results)
      if (row.status === 'rejected') expect(row.reason).toMatchObject({ code: 'cursor-conflict' })
    const loser = results[0]!.status === 'rejected' ? pages[0]! : pages[1]!
    await ingest.ingest({
      ...loser,
      expectedCursor: await store.cursor('stream'),
      nextCursor: 'both:2',
    })
    const first = await store.records('task', { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeDefined()
    const second = await store.records('task', { limit: 1, after: first.nextCursor })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(first.items[0]?.measurement.recordId).not.toBe(second.items[0]?.measurement.recordId)
  })
})
