// RFC-371: finished Task intermediates must not accumulate across a complete report.
import { expect, test } from 'bun:test'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { completeWorkingScope } from '@/modules/run-observability/application/completeWorkingScope'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 original Task TEMP lifetime', (harness) => {
  const snapshots = () => {
    const source = harness.applicationBinding
    return originalReportSnapshotSession(
      source.provider === 'sqlite'
        ? { ...source, generationId: 'task-temporary-lifetime' }
        : { provider: 'postgresql', runtime: source.runtime },
    )
  }

  test('release preserves complete cohort output and another Task on the original TEMP', async () => {
    await snapshots().run(async ({ workspace }) => {
      const first = completeWorkingScope(workspace, 'task/first')
      const other = completeWorkingScope(workspace, 'task/other')
      const output = { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', amount: '0.00005' }
      await workspace.insert('cohort/report-rows', [{ key: 'allocation', document: output }])
      await first.rows.insert('task/first/input', [
        { key: 'a', document: { value: 'first' } },
        { key: 'b', document: { value: 'second' } },
      ])
      await first.rows.upsert('task/first/input', [{ key: 'a', document: { value: 'revised' } }])
      await first.rows.put('task/first/fold', { key: 'total', document: output })
      await other.rows.insert('task/other/input', [{ key: 'other', document: 'retained' }])
      expect(await first.rows.get<{ value: string }>('task/first/input', 'a')).toEqual({
        value: 'revised',
      })
      const initial = await first.rows.page('task/first/input', null, 1)
      expect(initial.items.map((row) => row.key)).toEqual(['a'])
      expect(initial.nextCursor).toBe('a')
      const final = await first.rows.page('task/first/input', initial.nextCursor, 1)
      expect(final.items.map((row) => row.key)).toEqual(['b'])
      expect(final.nextCursor).toBeNull()
      await first.rows.clear('task/first/fold')
      await first.release()
      await first.release()
      expect((await workspace.page('task/first/input', null)).items).toEqual([])
      expect((await workspace.page('task/first/fold', null)).items).toEqual([])
      expect(await workspace.get<typeof output>('cohort/report-rows', 'allocation')).toEqual(output)
      expect(await other.rows.get<string>('task/other/input', 'other')).toBe('retained')
      await expect(first.rows.get('task/first/input', 'a')).rejects.toThrow('scope is released')
      await expect(first.rows.insert('task/first/input', [])).rejects.toThrow('scope is released')
      await other.release()
    })
  })

  test('original duplicate rejection ends its snapshot before further TEMP work', async () => {
    const original = snapshots()
    await expect(
      original.run(async ({ workspace }) => {
        return completeWorkingScope(workspace, 'task/duplicate').run(async (rows) => {
          await rows.insert('task/duplicate/input', [{ key: 'a', document: 'original' }])
          await rows.insert('task/duplicate/input', [{ key: 'a', document: 'duplicate' }])
        })
      }),
    ).rejects.toThrow()
    // PostgreSQL cannot continue querying an aborted transaction; use the original next snapshot.
    await original.run(async ({ workspace }) => {
      expect((await workspace.page('task/duplicate/input', null)).items).toEqual([])
    })
  })

  test('namespace boundaries preserve similarly named Tasks and original outside rows', async () => {
    await snapshots().run(async ({ workspace }) => {
      const scope = completeWorkingScope(workspace, 'task/a')
      await workspace.put('task/ab/input', { key: 'other', document: 'unchanged' })
      for (const name of ['cohort/report-rows', 'task/ab/input', 'task/other']) {
        await expect(scope.rows.insert(name, [])).rejects.toThrow('outside its scope')
        await expect(scope.rows.clear(name)).rejects.toThrow('outside its scope')
      }
      await scope.rows.put('task/a', { key: 'own', document: 'temporary' })
      await scope.release()
      expect(await workspace.get<string>('task/ab/input', 'other')).toBe('unchanged')
      expect(await workspace.get('task/a', 'own')).toBeUndefined()
    })
  })

  test('an original Task error is preserved while the active TEMP is released', async () => {
    await snapshots().run(async ({ workspace }) => {
      const scope = completeWorkingScope(workspace, 'task/failure')
      const error = new Error('original Task population mismatch')
      await expect(
        scope.run(async (rows) => {
          await rows.put('task/failure/input', { key: 'record', document: 'original' })
          throw error
        }),
      ).rejects.toBe(error)
      expect((await workspace.page('task/failure/input', null)).items).toEqual([])
    })
  })

  test('cancellation preserves its original reason and the original snapshot closes TEMP', async () => {
    const abort = new AbortController()
    const reason = new Error('original report cancelled')
    const original = snapshots()
    await expect(
      original.run(async ({ workspace }) => {
        const scope = completeWorkingScope(workspace, 'task/cancelled')
        return scope.run(async (rows) => {
          await rows.put('task/cancelled/input', { key: 'record', document: 'original' })
          abort.abort(reason)
          abort.signal.throwIfAborted()
        })
      }, abort.signal),
    ).rejects.toBe(reason)
    await original.run(async ({ workspace }) => {
      expect((await workspace.page('task/cancelled/input', null)).items).toEqual([])
    })
  })

  test('an original clear failure fails a successful Task without changing its output', async () => {
    await snapshots().run(async ({ workspace }) => {
      const reason = new Error('original TEMP clear failed')
      const scope = completeWorkingScope(
        {
          ...workspace,
          clear: async () => {
            throw reason
          },
        },
        'task/clear-failure',
      )
      const output = { input: '1', cacheRead: '3', cacheWrite: '5', output: '7' }
      await expect(
        scope.run(async (rows) => {
          await rows.put('task/clear-failure/input', { key: 'record', document: output })
          await workspace.put('cohort/report-rows', { key: 'allocation', document: output })
        }),
      ).rejects.toBe(reason)
      expect(await workspace.get<typeof output>('cohort/report-rows', 'allocation')).toEqual(output)
      // The original snapshot owns final cleanup; a clear error cannot publish a ready report.
      await workspace.clear('task/clear-failure/input')
    })
  })
})
