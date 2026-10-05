// RFC-371: the hosted scale entry must exercise original reports, not seed-derived totals.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import { describeEachProvider } from './helpers/eachProvider'
import { scaleOriginalCounts, seedScaleCorpus } from './helpers/rfc371ScaleCorpus'
import {
  qualifyScaleReport,
  qualifyScaleSelfTotals,
  scaleTaskNumber,
} from './helpers/rfc371ScaleQualification'

test('Task-zero aliases cannot replace the actual original Task at EOF', () => {
  expect(scaleTaskNumber('complete-original-task')).toBe(0)
  expect(scaleTaskNumber('scale-task-000001')).toBe(1)
  expect(() => scaleTaskNumber('scale-task-000000')).toThrow('not canonical')
  expect(() => scaleTaskNumber('scale-task-1')).toThrow()
})

describeEachProvider('RFC-371 original full-scale qualification entry', (harness) => {
  const binding = () => {
    const original = harness.applicationBinding
    return original.provider === 'sqlite'
      ? { ...original, generationId: 'synthetic-scale-regression' }
      : { provider: 'postgresql' as const, runtime: original.runtime }
  }

  test('three original Tasks and every six-record identity reconcile through the real retained report', async () => {
    const counts = await seedScaleCorpus({ db: harness.db, taskCount: 3, records: 6 })
    expect(counts).toEqual({
      tasks: '3',
      attempts: '3',
      invocations: '3',
      captures: '3',
      records: '6',
    })
    const source = binding(),
      directory = mkdtempSync(join(tmpdir(), 'aw-scale-original-'))
    const originalSnapshots = originalReportSnapshotSession(source)
    const liveTasks = new Map<string, Set<string>>(),
      seenTasks = new Set<string>()
    let releasedTasks = 0
    const taskScope = (namespace: string) =>
      /^report\/[^/]+\/(task-[a-f0-9]{64})(?:\/|$)/.exec(namespace)?.[1]
    const written = (namespace: string) => {
      const task = taskScope(namespace)
      if (!task) return
      if (!seenTasks.has(task)) {
        expect(liveTasks.size).toBe(0)
        seenTasks.add(task)
      }
      const spaces = liveTasks.get(task) ?? new Set<string>()
      spaces.add(namespace)
      liveTasks.set(task, spaces)
    }
    const snapshots: ReportSnapshotSession = {
      run: (work, signal, lease) =>
        originalSnapshots.run(
          (snapshot) =>
            work({
              ...snapshot,
              workspace: {
                ...snapshot.workspace,
                insert: async (namespace, rows) => {
                  written(namespace)
                  await snapshot.workspace.insert(namespace, rows)
                },
                upsert: async (namespace, rows) => {
                  written(namespace)
                  await snapshot.workspace.upsert(namespace, rows)
                },
                put: async (namespace, row) => {
                  written(namespace)
                  await snapshot.workspace.put(namespace, row)
                },
                clear: async (namespace) => {
                  expect(namespace.endsWith('/report-rows')).toBe(false)
                  await snapshot.workspace.clear(namespace)
                  const task = taskScope(namespace),
                    spaces = task ? liveTasks.get(task) : undefined
                  if (spaces) {
                    spaces.delete(namespace)
                    if (spaces.size === 0) {
                      liveTasks.delete(task!)
                      releasedTasks++
                    }
                  }
                },
              },
            }),
          signal,
          lease,
        ),
    }
    try {
      const result = await qualifyScaleReport({
        db: harness.db,
        snapshots,
        generation:
          source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
        directory,
        taskCount: 3,
        records: 6,
        readySamples: 2,
      })
      expect(result.inventory).toEqual({
        tasks: '3',
        attempts: '3',
        invocations: '3',
        nativeCaptures: '3',
        numericRecords: '6',
      })
      expect(result.metrics).toEqual({
        state: 'ready',
        invocations: '3',
        observedInvocations: '3',
        records: '6',
        tokens: { input: '6', cacheRead: '18', cacheWrite: '30', output: '42', total: '96' },
        cost: { currency: 'CNY', state: 'complete', amount: '0.0003' },
      })
      expect(seenTasks.size).toBe(3)
      expect(liveTasks.size).toBe(0)
      expect(releasedTasks).toBeGreaterThanOrEqual(3)
      expect(result.taskRows).toBe(3)
      expect(result.allocationRows).toBe(6)
      expect(Object.keys(result.readyLatency).sort()).toEqual(['first-page', 'last-page', 'status'])
      for (const sample of Object.values(result.readyLatency)) expect(sample.samples).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)

  test('129 noncovering self totals survive original TEMP selection and allocation EOF', async () => {
    const result = await qualifyScaleSelfTotals(originalReportSnapshotSession(binding()), 129)
    expect(result.allocationRows).toBe(129)
    expect(result.selected).toMatchObject({
      selected: '129',
      excluded: '0',
      unavailableSummaries: '0',
      ambiguousOverlaps: '0',
      allSelectedComplete: true,
      tokens: { input: '129', cacheRead: '387', cacheWrite: '645', output: '903' },
    })
  }, 120_000)

  test('invalid populations and a nonempty original corpus reject before additional writes', async () => {
    const empty = await scaleOriginalCounts(harness.db)
    for (const [taskCount, records] of [
      [0, 6],
      [3, 0],
      [3, 7],
      [1.5, 6],
      [3, 6.5],
    ]) {
      await expect(
        seedScaleCorpus({ db: harness.db, taskCount: taskCount!, records: records! }),
      ).rejects.toThrow('Invalid exact scale population')
      expect(await scaleOriginalCounts(harness.db)).toEqual(empty)
    }
    const original = await seedScaleCorpus({ db: harness.db, taskCount: 1, records: 1 })
    await expect(seedScaleCorpus({ db: harness.db, taskCount: 3, records: 6 })).rejects.toThrow(
      'requires an empty original Task population',
    )
    expect(await scaleOriginalCounts(harness.db)).toEqual(original)
  })
})
