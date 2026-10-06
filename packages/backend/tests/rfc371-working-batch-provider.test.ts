// RFC-371: batching is transport only; every original key remains on the same private TEMP connection.
import { expect, test } from 'bun:test'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import {
  privateReportWorkspace,
  type ReportWorkspace,
} from '@/platform/persistence/reportWorkspace'
import { completeWorkingScope } from '@/modules/run-observability/application/completeWorkingScope'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 original native workspace batches', (harness) => {
  test('1201 exact keys cross all original packets, preserve namespaces and release the same Task scope', async () => {
    const original = originalReportSnapshotSession({
      ...harness.applicationBinding,
      generationId: 'original-batch-key-proof',
    })
    let retained: ReportWorkspace | undefined
    await original.run(async ({ workspace }) => {
      retained = workspace
      const scoped = completeWorkingScope(workspace, 'task/original-batch')
      const namespace = 'task/original-batch/input'
      for (let first = 0; first < 1201; first += 500)
        await scoped.rows.insert(
          namespace,
          Array.from({ length: Math.min(500, 1201 - first) }, (_, i) => ({
            key: 'actual-' + (first + i),
            document: { original: first + i },
          })),
        )
      await workspace.put('task/other/input', { key: 'actual-0', document: 'other' })
      const found = await scoped.rows.getMany<{ original: number }>(namespace, [
        'actual-1000',
        'actual-0',
        'missing',
        'actual-1000',
      ])
      expect(found instanceof Map).toBe(true)
      expect(found.size).toBe(2)
      expect(found.get('actual-0')).toEqual({ original: 0 })
      expect(found.get('actual-1000')).toEqual({ original: 1000 })
      expect(found.has('missing')).toBe(false)
      let count = 0
      for (let first = 0; first < 1201; first += 500) {
        const keys = Array.from(
          { length: Math.min(500, 1201 - first) },
          (_, i) => 'actual-' + (first + i),
        )
        const batch = await scoped.rows.getMany<{ original: number }>(namespace, keys)
        expect(batch.size).toBe(keys.length)
        for (const key of keys) expect(batch.get(key)).toEqual({ original: count++ })
      }
      expect(count).toBe(1201)
      await scoped.rows.put(namespace, { key: 'actual-0', document: { original: -1 } })
      expect(
        (await scoped.rows.getMany<{ original: number }>(namespace, ['actual-0'])).get('actual-0'),
      ).toEqual({ original: -1 })
      await scoped.rows.put(namespace, { key: 'null-value', document: null })
      const nullable = await scoped.rows.getMany(namespace, ['null-value', 'missing'])
      expect(nullable.has('null-value')).toBe(true)
      expect(nullable.get('null-value')).toBeNull()
      expect(await scoped.rows.getMany(namespace, [])).toEqual(new Map())
      await expect(scoped.rows.getMany(namespace, [''])).rejects.toThrow('key invalid')
      await expect(
        scoped.rows.getMany(
          namespace,
          Array.from({ length: 501 }, (_, i) => String(i)),
        ),
      ).rejects.toThrow('batch is too large')
      await expect(scoped.rows.getMany('task/other/input', ['actual-0'])).rejects.toThrow(
        'outside its scope',
      )
      await scoped.release()
      await expect(scoped.rows.getMany(namespace, [])).rejects.toThrow('scope is released')
      expect(await workspace.getMany(namespace, ['actual-0'])).toEqual(new Map())
      expect((await workspace.getMany('task/other/input', ['actual-0'])).get('actual-0')).toBe(
        'other',
      )
    })
    await expect(retained!.getMany('task/other/input', [])).rejects.toThrow('closed')
    const failure = new Error('original batch work failed')
    await expect(
      original.run(async ({ workspace }) => {
        await workspace.put('failed-batch', { key: 'actual', document: 'discarded' })
        expect((await workspace.getMany('failed-batch', ['actual'])).get('actual')).toBe(
          'discarded',
        )
        throw failure
      }),
    ).rejects.toBe(failure)
    await original.run(async ({ workspace }) => {
      expect(await workspace.getMany('failed-batch', ['actual'])).toEqual(new Map())
    })
  }, 30000)

  test('cancellation keeps its original reason and cannot leak a partial native batch', async () => {
    const original = originalReportSnapshotSession({
      ...harness.applicationBinding,
      generationId: 'original-batch-cancel',
    })
    const controller = new AbortController()
    const reason = new Error('original batch cancelled')
    await expect(
      original.run(async ({ workspace }) => {
        await workspace.put('cancelled-batch', { key: 'actual', document: 'discarded' })
        controller.abort(reason)
        await workspace.getMany('cancelled-batch', ['actual'])
      }, controller.signal),
    ).rejects.toBe(reason)
    await original.run(async ({ workspace }) => {
      expect(await workspace.getMany('cancelled-batch', ['actual'])).toEqual(new Map())
    })
  }, 30000)
})

test('the actual native batch primitive rejects changed physical identities, malformed JSON and query failures', async () => {
  for (const physical of [
    [{ key: 'outside', document: '"value"' }],
    [
      { key: 'actual', document: '"first"' },
      { key: 'actual', document: '"second"' },
    ],
    [{ key: 'actual', document: 'not-json' }],
  ]) {
    const workspace = privateReportWorkspace(
      { all: async () => physical, run: async () => {} },
      () => true,
    )
    await expect(workspace.getMany('original', ['actual'])).rejects.toThrow()
  }
  const reason = new Error('actual original query failed')
  const workspace = privateReportWorkspace(
    {
      all: async () => {
        throw reason
      },
      run: async () => {},
    },
    () => true,
  )
  await expect(workspace.getMany('original', ['actual'])).rejects.toBe(reason)
  let active = true
  const closed = privateReportWorkspace(
    {
      all: async () => {
        active = false
        return [{ key: 'actual', document: '"late"' }]
      },
      run: async () => {},
    },
    () => active,
  )
  await expect(closed.getMany('original', ['actual'])).rejects.toThrow('closed')
})
