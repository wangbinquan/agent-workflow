import { expect, test } from 'bun:test'
import {
  assignLegacySequences,
  planRunSequences,
} from '@/modules/task-execution/infrastructure/migration/run/sequence'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  runSource,
  runValues,
  sourceRow,
  taskFacts,
  taskMounts,
  writeTask,
} from './helpers/rfc395V2/runFixtures'

test('D3 initial all-NULL order is -(n-1)..0 and never consumes an allocation', () => {
  const result = assignLegacySequences(
    [
      { id: 'z', seq: null },
      { id: 'a', seq: null },
      { id: 'b', seq: null },
    ],
    {
      next() {
        throw new Error('must not allocate')
      },
    },
  )
  expect([...result.seqById]).toEqual([
    ['a', -2],
    ['b', -1],
    ['z', 0],
  ])
  expect(result.allocated).toEqual([])
})
test('D3 keeps RFC-374 negatives; older NULLs go below minimum and newer NULLs allocate by id', () => {
  let highWater = 700
  const result = assignLegacySequences(
    [
      { id: 'm', seq: -3 },
      { id: 'a', seq: null },
      { id: 'z', seq: null },
      { id: 'y', seq: null },
    ],
    { next: () => ++highWater },
  )
  expect([...result.seqById]).toEqual([
    ['m', -3],
    ['a', -4],
    ['y', 701],
    ['z', 702],
  ])
  expect([...result.derived]).toEqual(['a', 'y', 'z'])
})
test('D3 global newer allocations are ordered by task_id then id, not source run id order', () => {
  const result = planRunSequences(
    [
      runSource('b-old', { task_id: 'b', seq: 2 }),
      runSource('z-b', { task_id: 'b', seq: null }),
      runSource('a-old', { task_id: 'a', seq: 1 }),
      runSource('z-a', { task_id: 'a', seq: null }),
    ],
    [
      sourceRow('node_run_seq_allocations', {
        seq: 900,
        task_id: 'a',
        node_run_id: 'pruned',
        allocated_at: 100,
      }),
    ],
  )
  expect(result.get('a')!.runs.find((row) => row.id === 'z-a')!.seq).toBe(901)
  expect(result.get('b')!.runs.find((row) => row.id === 'z-b')!.seq).toBe(902)
  expect(result.get('a')!.allocationCount).toBe(2)
})
test('sequence duplicate and integer underflow are explicit failures', () => {
  expect(() =>
    assignLegacySequences(
      [
        { id: 'a', seq: 1 },
        { id: 'b', seq: 1 },
      ],
      { next: () => 2 },
    ),
  ).toThrow('v2-run-sequence-duplicate')
  expect(() =>
    assignLegacySequences(
      [
        { id: 'z', seq: -Number.MAX_SAFE_INTEGER },
        { id: 'a', seq: null },
      ],
      { next: () => 2 },
    ),
  ).toThrow('v2-run-sequence-range')
})

describeV2Providers('RFC-395 V2-N sequence and generation', (h) => {
  test('every task, including no-run tasks, gets generation 0 at TaskFacts.startedAt; pruned high water cannot be reused', async () => {
    await h.install()
    const tasks = [taskFacts('a-empty'), taskFacts('b-runs', 'running')]
    for (const task of tasks) await writeTask(h, task)
    await h.write('node_runs', [
      runValues('m', { task_id: 'b-runs', seq: -3 }),
      runValues('a', { task_id: 'b-runs', seq: null }),
      runValues('z', { task_id: 'b-runs', seq: null }),
    ])
    await h.write('node_run_seq_allocations', [
      { seq: 500, task_id: 'b-runs', node_run_id: 'pruned', allocated_at: 70 },
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: tasks, taskMounts: tasks.map((task) => taskMounts(task.taskId)) },
    })
    const source = input.source
    const elevated = {
      ...input,
      preflight: {
        ...input.preflight,
        identityHighWater: [
          {
            name: 'node_run_seq_allocations_seq',
            table: 'node_run_seq_allocations',
            column: 'seq',
            value: '900',
            isCalled: true,
            increment: '1',
          },
        ],
      },
    }
    // The immutable reader is unchanged; this models the independently captured physical sequence watermark.
    elevated.source = { ...source, assertUnchanged: () => source.assertUnchanged(input.preflight) }
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(elevated, sink)
      expect(summary.blocks).toEqual([])
      expect(sink.rows('task_execution_generations')).toEqual(
        tasks.map((task) => ({
          task_id: task.taskId,
          generation_seq: 0,
          cause: 'legacy-epoch1',
          previous_generation_seq: null,
          operation_ref: null,
          created_at: 100,
        })),
      )
      expect(sink.rows('node_runs').map((row) => [row.id, row.seq])).toEqual([
        ['a', -4],
        ['m', -3],
        ['z', 901],
      ])
      expect(
        [...sink.rows('node_run_seq_allocations')].sort((a, b) => Number(a.seq) - Number(b.seq)),
      ).toEqual([
        { seq: 500, task_id: 'b-runs', node_run_id: 'pruned', allocated_at: 70 },
        { seq: 901, task_id: 'b-runs', node_run_id: 'z', allocated_at: 100 },
      ])
      const records = [...sink.units.values()].flatMap((unit) => unit.records)
      expect(records.filter((record) => record.kind === 'identity-high-water')).toEqual([
        {
          kind: 'identity-high-water',
          table: 'node_run_seq_allocations',
          column: 'seq',
          value: '901',
          basis: 'both',
        },
      ])
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.dispositions)
          .filter((row) => row.kind === 'derived-id')[0]!.allocation,
      ).toEqual({ column: 'seq', value: '901', sourceHighWater: '900' })
    } finally {
      await source.close()
    }
  }, 180_000)
  test('D13 artifacts without allocator state report max-row evidence without inventing pruned allocations', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    await h.write('node_runs', [runValues('m', { seq: 80 })])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(
        {
          ...input,
          preflight: {
            ...input.preflight,
            identityHighWater: [],
            identityEvidence: 'not-recorded-by-epoch1-artifact',
          },
          source: {
            ...input.source,
            assertUnchanged: () => input.source.assertUnchanged(input.preflight),
          },
        },
        sink,
      )
      expect(result.blocks).toEqual([])
      expect(
        [...sink.rows('node_run_seq_allocations')].sort((a, b) => Number(a.seq) - Number(b.seq)),
      ).toEqual([])
      const record = [...sink.units.values()]
        .flatMap((unit) => unit.records)
        .find((record) => record.kind === 'identity-high-water')!
      expect(record).toMatchObject({ value: '80', basis: 'max-row' })
      expect(record.kind === 'identity-high-water' && record.warning).toContain(
        'no pruned allocation invented',
      )
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
